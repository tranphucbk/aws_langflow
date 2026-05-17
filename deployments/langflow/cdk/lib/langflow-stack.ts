import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export interface LangflowStackProps extends cdk.StackProps {
  allowedIpV4Cidrs: string;
  allowedIpV6Cidrs: string;
  langflowVersion: string;
  embeddingDimension: number;
  superuserEmail: string;
  componentsBucket: string;
}

export class LangflowStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LangflowStackProps) {
    super(scope, id, props);

    // ── 1. VPC ──────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, "LangflowVpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // ── 2. RDS PostgreSQL (app metadata only) ───────────────────────────────
    const dbSecret = new secretsmanager.Secret(this, "LangflowDbSecret", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "langflow" }),
        generateStringKey: "password",
        excludeCharacters: '"@/\\',
      },
    });

    const dbSg = new ec2.SecurityGroup(this, "DbSg", { vpc, allowAllOutbound: false });

    const db = new rds.DatabaseInstance(this, "LangflowDb", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: "langflow",
      multiAz: false,
      storageEncrypted: true,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── 3. S3 bucket for custom components ──────────────────────────────────
    const componentsBucket = new s3.Bucket(this, "ComponentsBucket", {
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── 4. S3 Vectors Bucket (vector database) ──────────────────────────────
    // Using L1 CfnResource — no L2 construct for AWS::S3Vectors::VectorBucket yet
    const vectorsBucketName = `langflow-vectors-${this.account}-${this.region}`;
    const vectorsBucket = new cdk.CfnResource(this, "LangflowVectorsBucket", {
      type: "AWS::S3Vectors::VectorBucket",
      properties: {
        VectorBucketName: vectorsBucketName,
      },
    });

    // ── 5. Lambda: create vector index on first deploy ───────────────────────
    const createIndexRole = new iam.Role(this, "CreateIndexRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    createIndexRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3vectors:CreateIndex", "s3vectors:ListIndexes"],
        resources: [
          `arn:aws:s3vectors:${this.region}:${this.account}:bucket/${vectorsBucketName}`,
          `arn:aws:s3vectors:${this.region}:${this.account}:bucket/${vectorsBucketName}/*`,
        ],
      })
    );

    const createIndexFn = new lambda.Function(this, "CreateVectorIndex", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "index.handler",
      timeout: cdk.Duration.minutes(5),
      role: createIndexRole,
      logRetention: logs.RetentionDays.ONE_WEEK,
      code: lambda.Code.fromInline(`
import json, urllib.request, boto3

def send_response(event, context, status, data={}):
    body = json.dumps({
        'Status': status,
        'Reason': data.get('Reason', ''),
        'PhysicalResourceId': event.get('PhysicalResourceId', 'VectorIndex'),
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data,
    }).encode()
    req = urllib.request.Request(event['ResponseURL'], data=body,
        headers={'Content-Type': '', 'Content-Length': len(body)}, method='PUT')
    urllib.request.urlopen(req)

def handler(event, context):
    try:
        if event['RequestType'] == 'Delete':
            send_response(event, context, 'SUCCESS')
            return
        props = event['ResourceProperties']
        client = boto3.client('s3vectors', region_name=props['Region'])
        try:
            client.create_index(
                vectorBucketName=props['BucketName'],
                indexName=props['IndexName'],
                dataType='float32',
                dimension=int(props['Dimension']),
                distanceMetric='cosine',
            )
        except client.exceptions.ConflictException:
            pass  # Index already exists
        send_response(event, context, 'SUCCESS', {'IndexName': props['IndexName']})
    except Exception as e:
        send_response(event, context, 'FAILED', {'Reason': str(e)})
`),
    });

    // Custom resource to trigger index creation after bucket is ready
    const indexProvider = new cr.Provider(this, "VectorIndexProvider", {
      onEventHandler: createIndexFn,
    });

    const vectorIndex = new cdk.CustomResource(this, "VectorIndex", {
      serviceToken: indexProvider.serviceToken,
      properties: {
        BucketName: vectorsBucketName,
        IndexName: "langflow-index",
        Region: this.region,
        Dimension: props.embeddingDimension.toString(),
      },
    });
    vectorIndex.node.addDependency(vectorsBucket);

    // ── 6. ECS Cluster ──────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, "LangflowCluster", {
      vpc,
      containerInsights: true,
    });

    // ── 7. ECS Task Role (includes S3 Vectors permissions) ──────────────────
    const taskRole = new iam.Role(this, "LangflowTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // S3 Vectors — read/write vectors
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3vectors:PutVectors",
          "s3vectors:QueryVectors",
          "s3vectors:GetVectors",
          "s3vectors:ListVectors",
          "s3vectors:DeleteVectors",
        ],
        resources: [
          `arn:aws:s3vectors:${this.region}:${this.account}:bucket/${vectorsBucketName}/index/*`,
        ],
      })
    );

    // S3 — download custom component on startup
    componentsBucket.grantRead(taskRole);

    // RDS secret — read credentials
    dbSecret.grantRead(taskRole);

    // ── 8. ECS Task Execution Role ───────────────────────────────────────────
    const executionRole = new iam.Role(this, "LangflowExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
      ],
    });
    dbSecret.grantRead(executionRole);

    // ── 9. ECS Security Groups ───────────────────────────────────────────────
    const ecsSg = new ec2.SecurityGroup(this, "EcsSg", { vpc, allowAllOutbound: true });
    dbSg.addIngressRule(ecsSg, ec2.Port.tcp(5432), "Langflow ECS to RDS");

    // ── 10. Database URL (assembled from secret) ─────────────────────────────
    const dbUrl = `postgresql://${dbSecret.secretValueFromJson("username").unsafeUnwrap()}:${dbSecret.secretValueFromJson("password").unsafeUnwrap()}@${db.dbInstanceEndpointAddress}:5432/langflow`;

    // ── 11. Fargate Service ──────────────────────────────────────────────────
    const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      "LangflowService",
      {
        cluster,
        cpu: 1024,
        memoryLimitMiB: 2048,
        desiredCount: 1,
        taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [ecsSg],
        taskImageOptions: {
          image: ecs.ContainerImage.fromRegistry(`langflowai/langflow:${props.langflowVersion}`),
          containerPort: 7860,
          taskRole,
          executionRole,
          logDriver: ecs.LogDrivers.awsLogs({
            streamPrefix: "langflow",
            logRetention: logs.RetentionDays.ONE_WEEK,
          }),
          environment: {
            LANGFLOW_AUTO_LOGIN: "false",
            LANGFLOW_SUPERUSER: props.superuserEmail,
            LANGFLOW_WORKERS: "2",
            LANGFLOW_LOG_LEVEL: "info",
            LANGFLOW_COMPONENTS_PATH: "/app/custom_components",
            // S3 Vectors config
            S3_VECTORS_BUCKET_NAME: vectorsBucketName,
            S3_VECTORS_INDEX_NAME: "langflow-index",
            AWS_DEFAULT_REGION: this.region,
            // Custom component source
            CUSTOM_COMPONENTS_S3_BUCKET: componentsBucket.bucketName,
          },
          secrets: {
            LANGFLOW_DATABASE_URL: ecs.Secret.fromSecretsManager(dbSecret, "password"),
          },
        },
        publicLoadBalancer: true,
        listenerPort: 80,
      }
    );

    // Health check — Langflow readiness endpoint
    fargateService.targetGroup.configureHealthCheck({
      path: "/api/v1/version",
      healthyHttpCodes: "200",
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(10),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // ── 12. WAF — IP restriction ─────────────────────────────────────────────
    const ipV4Rules: wafv2.CfnWebACL.RuleProperty[] = props.allowedIpV4Cidrs
      .split(",")
      .filter((c) => c.trim())
      .map((cidr, i) => ({
        name: `AllowIpV4-${i}`,
        priority: i + 1,
        statement: {
          ipSetReferenceStatement: {
            arn: new wafv2.CfnIPSet(this, `IpV4Set${i}`, {
              addresses: [cidr.trim()],
              ipAddressVersion: "IPV4",
              scope: "REGIONAL",
            }).attrArn,
          },
        },
        action: { allow: {} },
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: `AllowIpV4-${i}`,
        },
      }));

    const webAcl = new wafv2.CfnWebACL(this, "LangflowWaf", {
      scope: "REGIONAL",
      defaultAction: { block: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "LangflowWaf",
      },
      rules: ipV4Rules,
    });

    new wafv2.CfnWebACLAssociation(this, "WafAssociation", {
      resourceArn: fargateService.loadBalancer.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // ── 13. Outputs ──────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "LangflowUrl", {
      value: `http://${fargateService.loadBalancer.loadBalancerDnsName}`,
      description: "Langflow UI URL",
    });

    new cdk.CfnOutput(this, "VectorsBucketName", {
      value: vectorsBucketName,
      description: "S3 Vectors bucket name",
    });

    new cdk.CfnOutput(this, "ComponentsBucketName", {
      value: componentsBucket.bucketName,
      description: "S3 bucket for custom Langflow components",
    });
  }
}
