# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project provides CloudFormation templates for one-click deployment of generative AI solutions on AWS. Users click "Launch Stack", fill in parameters (primarily an email address), and the stack auto-deploys complex applications without any local tooling.

Current solutions (each in `deployments/<name>/`): genu, dify, brchat, comfyui, genstudio, langflow, rapid, ai-persona, sdpm, d360, c360, kiro-ide, cursor, aiagentdev, remote-swe-agents, roleplay, langfuse.

## Development Commands

### Documentation (MkDocs)
```bash
uv sync                # Install Python dependencies
uv run mkdocs serve    # Preview docs locally at http://127.0.0.1:8000
```

### Testing
```bash
pytest tests/                                     # Run all template validation tests
pytest tests/ -k "GenU"                           # Run tests for a specific solution
pytest tests/test_cloudformation.py::test_template_validates_with_aws_cli  # Run specific test function
```

Note: The test suite currently covers only 6 of the 17 solutions (GenU, Dify, BrChat, AIPersona, SDPM, Langflow). When adding a new solution, add it to the `TEMPLATES` list in `tests/test_cloudformation.py`.

### Template Validation
```bash
aws cloudformation validate-template --template-body file://deployments/<name>/<Template>.yaml
```

### Deploy / Monitor / Teardown
```bash
# Deploy (use JSON for multiple parameters)
aws cloudformation create-stack \
  --stack-name my-stack \
  --template-body file://deployments/<name>/<Template>.yaml \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameters '[
    {"ParameterKey": "NotificationEmailAddress", "ParameterValue": "user@example.com"}
  ]'

# Monitor CodeBuild logs
aws logs tail /aws/codebuild/<PROJECT_NAME> --follow

# Check outputs
aws cloudformation describe-stacks --stack-name <STACK_NAME> --query "Stacks[0].Outputs"

# Teardown
aws cloudformation delete-stack --stack-name <STACK_NAME>
```

## Deployment Architecture

Every CloudFormation template creates this pipeline automatically on stack creation:

```
User → CloudFormation Stack
         ├── SNS Topic (email notifications)
         ├── Lambda Custom Resource → triggers CodeBuild immediately
         └── CodeBuild Project
               ├── install:    clone app repo, install Node.js/CDK
               ├── pre_build:  write app config from CF parameters
               ├── build:      cdk bootstrap + cdk deploy
               └── post_build: query CF outputs, send SNS notification with app URL
```

The application's own CDK stack is deployed **inside** CodeBuild — the CloudFormation template is just the orchestration shell.

## CloudFormation Template Rules

### Required Components
Every template must have:
- **SNS Topic** with email subscription and KMS encryption
- **CodeBuild Project** with inline BuildSpec and environment variables from CF parameters
- **Lambda Custom Resource** that calls `StartBuild` on CodeBuild (handles only `Create` events)
- **IAM Roles** for both CodeBuild and Lambda

### Parameter Conventions
- `NotificationEmailAddress`: always required, validated with email regex pattern
- IP restriction parameters: default to `127.0.0.1/32` (restrictive) with a warning in `ConstraintDescription` that `0.0.0.0/0` opens to all
- Self-signup: disabled by default; when enabled, require domain restriction parameters
- Use `AllowedValues` for enum-type parameters, `AllowedPattern` + `ConstraintDescription` for formatted strings

### Extracting App URLs in post_build
**Do this** — query CloudFormation outputs:
```bash
STACK_NAME=$(aws cloudformation describe-stacks \
  --query "Stacks[?contains(StackName, 'AppPattern')].StackName" --output text)
APP_URL=$(aws cloudformation describe-stacks --stack-name $STACK_NAME \
  --query "Stacks[0].Outputs[?contains(OutputKey, 'FrontendUrl')].OutputValue" --output text)
```
**Avoid** parsing temporary files like `.cdk-outputs.json`.

## Adding a New Solution

1. Copy an existing template (e.g., `deployments/genu/GenUDeploymentStack.yaml`) as the closest architectural match
2. Update `Parameters`, environment variables, and the inline BuildSpec for the new application
3. Add a solution page under `docs/solutions/` — one `.md` (Japanese) and one `.en.md` (English) per solution
4. Add a "Launch Stack" button entry to `docs/index.md`
5. Add an entry to the `nav:` section in `mkdocs.yml` under `Supported Solutions:`
6. Add the template to the `TEMPLATES` list in `tests/test_cloudformation.py`
7. Run `pytest tests/` and `aws cloudformation validate-template` before opening a PR

## Documentation Structure

Docs use MkDocs Material with `mkdocs-static-i18n`. Every solution has two files:
- `docs/solutions/<name>.md` — Japanese (primary)  
- `docs/solutions/<name>.en.md` — English

Config is in `mkdocs.yml`; CI publishes via `.github/workflows/deploy-docs.yml`. The `nav:` section in `mkdocs.yml` must be updated when adding a new solution — pages omitted from `nav:` won't appear in the sidebar.

## Notable Variant: Langflow

`deployments/langflow/` bundles its CDK app directly in the repo under `deployments/langflow/cdk/` (TypeScript), rather than cloning an external repo in CodeBuild. The `LangflowDeploymentStack.yaml` still follows the standard CF + CodeBuild shell pattern, but the `build` phase references the local CDK code instead of a remote repository. To iterate on the CDK app directly, run `npm install` and `cdk deploy` within `deployments/langflow/cdk/`.

## Notable Variant: Kiro IDE

`deployments/kiro-ide/` contains two templates for different OS choices:
- `KiroIDEDeploymentStack.yaml` — Amazon Linux 2023 (RPM/DNF)
- `KiroIDEUbuntuDeploymentStack.yaml` — Ubuntu 24.04 LTS (APT, pre-configured GNOME)
