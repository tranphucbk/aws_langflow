#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { LangflowStack } from "../lib/langflow-stack";

const app = new cdk.App();

const region = app.node.tryGetContext("region") || process.env.CDK_DEFAULT_REGION || "us-east-1";
const account = process.env.CDK_DEFAULT_ACCOUNT;

new LangflowStack(app, "LangflowStack", {
  env: { account, region },
  allowedIpV4Cidrs: (app.node.tryGetContext("allowedIpV4Cidrs") as string) || "0.0.0.0/1,128.0.0.0/1",
  allowedIpV6Cidrs: (app.node.tryGetContext("allowedIpV6Cidrs") as string) || "::/1,8000::/1",
  langflowVersion: (app.node.tryGetContext("langflowVersion") as string) || "latest",
  embeddingDimension: parseInt(app.node.tryGetContext("embeddingDimension") as string) || 1536,
  superuserEmail: (app.node.tryGetContext("superuserEmail") as string) || "admin@example.com",
  componentsBucket: (app.node.tryGetContext("componentsBucket") as string) || "",
});
