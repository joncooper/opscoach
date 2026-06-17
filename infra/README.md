# Ops Coach AWS Lab Infrastructure

This directory contains the first real-AWS lab scaffold for Ops Coach.

The design is intentionally conservative:

- one dedicated AWS lab account,
- CDK-managed platform and scenario resources,
- short-lived candidate credentials,
- candidate permissions are allowlisted,
- sample JSON files are provided for CLI operations that would otherwise require hand-written AWS request bodies,
- janitor cleanup runs after sessions and nightly.

The initial scenario is `aws-security-basics`. It tests command-line AWS orientation and small security remediations without launching EC2 instances, NAT gateways, RDS, or other expensive resources.

## What You Must Do By Hand

### 1. Create or Choose a Dedicated Lab Account

Recommended: use AWS Organizations and create a member account named `opscoach-lab`.

You can do this from the AWS console, or from the management account CLI:

```bash
aws organizations create-account \
  --account-name opscoach-lab \
  --email opscoach-lab+YOUR_UNIQUE_SUFFIX@example.com \
  --role-name OrganizationAccountAccessRole \
  --iam-user-access-to-billing DENY
```

Wait until account creation completes:

```bash
aws organizations describe-create-account-status \
  --create-account-request-id <request-id>
```

You need the new lab account ID.

### 2. Decide the Admin Principal

Pick the principal in your management/admin account that is allowed to assume Ops Coach roles in the lab account.

The simplest initial value is the management account root principal:

```text
arn:aws:iam::<MANAGEMENT_ACCOUNT_ID>:root
```

That does not give everyone access by itself. The caller in the management account still needs `sts:AssumeRole` permission for the target role.

### 3. Configure Your AWS CLI Profile

Create or choose a profile that can assume the lab account's admin bootstrap role.

Example:

```bash
aws sts assume-role \
  --profile <management-profile> \
  --role-arn arn:aws:iam::<LAB_ACCOUNT_ID>:role/OrganizationAccountAccessRole \
  --role-session-name opscoach-bootstrap
```

For CDK, it is usually easier to configure a named profile such as `opscoach-lab-admin` that lands in the lab account with admin rights.

### 4. Optional: Add an Organizations SCP

The candidate role is already allowlisted. An SCP is optional defense in depth.

If you add one, attach it only to the dedicated lab account or a dedicated lab OU. Do not test SCPs on your organization root.

A good first SCP is a region guardrail and high-risk-service deny. Keep it simple until the lab works end to end.

### 5. Choose a Budget Alert Email

The platform stack can create an AWS Budget if you pass `notificationEmail`. You will receive an AWS confirmation email for budget notifications.
The budget is created in the management account and filtered to the lab account, because AWS linked accounts cannot always create their own budgets directly.

Budgets are a backstop, not the primary safety control. Cost data can lag, so the janitor and allowlisted candidate role still matter.

## Install

```bash
cd infra
npm install
```

## CDK Context Values

Required:

- `labAccountId`: dedicated lab account ID.
- `adminPrincipalArn`: principal allowed to assume Ops Coach roles.

Optional:

- `managementAccountId`: management account ID; defaults to the account ID parsed from `adminPrincipalArn`.
- `managementRegion`: region for the Organizations guardrail stack; defaults to `us-east-1`.
- `allowedRegion`: defaults to `us-east-1`.
- `sessionId`: defaults to `dev`.
- `expiresAt`: ISO timestamp for janitor cleanup; defaults to roughly six hours from synth time.
- `maxSessionHours`: defaults to `3`.
- `budgetLimitUsd`: defaults to `25`.
- `notificationEmail`: if set, creates budget notifications.
- `labName`: defaults to `aws-security-basics`.

Use a shell variable for repeatability:

```bash
export LAB_ACCOUNT_ID=123456789012
export MANAGEMENT_ACCOUNT_ID=111122223333
export ADMIN_PRINCIPAL_ARN=arn:aws:iam::111122223333:root
export AWS_REGION=us-east-1
export SESSION_ID=dev-001
export EXPIRES_AT="$(date -u -v+6H '+%Y-%m-%dT%H:%M:%SZ')"
```

For the current `opscoach-lab` account:

```bash
export LAB_ACCOUNT_ID=210987654321
export MANAGEMENT_ACCOUNT_ID=123456789012
export ADMIN_PRINCIPAL_ARN=arn:aws:iam::123456789012:role/YourAdminRole
export AWS_REGION=us-east-1
export SESSION_ID=dev-001
export EXPIRES_AT="$(date -u -v+6H '+%Y-%m-%dT%H:%M:%SZ')"
```

On GNU date, use:

```bash
export EXPIRES_AT="$(date -u -d '+6 hours' '+%Y-%m-%dT%H:%M:%SZ')"
```

## Configure Lab Admin Profile

Create a local profile that enters the lab account through the Organizations bootstrap role:

```bash
aws configure set profile.opscoach-lab-admin.role_arn "arn:aws:iam::${LAB_ACCOUNT_ID}:role/OrganizationAccountAccessRole"
aws configure set profile.opscoach-lab-admin.source_profile platform
aws configure set profile.opscoach-lab-admin.region "${AWS_REGION}"
```

Verify it lands in the lab account:

```bash
aws sts get-caller-identity --profile opscoach-lab-admin
```

## Deploy Organization Guardrails

Run this from the management account profile. It attaches the cost-control policy only to the lab account.

```bash
npx cdk deploy OpsCoachOrgGuardrails \
  --profile platform \
  -c labAccountId="${LAB_ACCOUNT_ID}" \
  -c managementAccountId="${MANAGEMENT_ACCOUNT_ID}" \
  -c adminPrincipalArn="${ADMIN_PRINCIPAL_ARN}" \
  -c allowedRegion="${AWS_REGION}" \
  -c notificationEmail="you@example.com" \
  -c budgetLimitUsd=20
```

## Bootstrap

Run this once per lab account/region:

```bash
npx cdk bootstrap "aws://${LAB_ACCOUNT_ID}/${AWS_REGION}" \
  --profile opscoach-lab-admin
```

## Deploy Platform

The platform stack creates:

- `OpsCoachCandidateRole`
- `OpsCoachGraderRole`
- `OpsCoachProvisionerRole`
- `OpsCoachJanitorRole`
- `OpsCoachJanitor` Lambda
- nightly EventBridge Scheduler cleanup

```bash
npx cdk deploy OpsCoachAwsPlatform \
  --profile opscoach-lab-admin \
  -c labAccountId="${LAB_ACCOUNT_ID}" \
  -c managementAccountId="${MANAGEMENT_ACCOUNT_ID}" \
  -c adminPrincipalArn="${ADMIN_PRINCIPAL_ARN}" \
  -c allowedRegion="${AWS_REGION}"
```

## Deploy Scenario

The scenario stack creates intentionally flawed but cheap lab resources:

- S3 bucket with versioning disabled and public access block off.
- VPC security group with public SSH ingress.
- Launch template with public IP, IMDSv1 allowed, and unencrypted root volume.
- CloudTrail with log file validation disabled.
- SNS topic for the root-account-use alarm.
- IAM role with an intentionally broad inline S3 policy for read-only audit.

```bash
npx cdk deploy OpsCoachAwsSecurityBasicsScenario \
  --profile opscoach-lab-admin \
  --outputs-file cdk-outputs.json \
  -c labAccountId="${LAB_ACCOUNT_ID}" \
  -c managementAccountId="${MANAGEMENT_ACCOUNT_ID}" \
  -c adminPrincipalArn="${ADMIN_PRINCIPAL_ARN}" \
  -c allowedRegion="${AWS_REGION}" \
  -c sessionId="${SESSION_ID}" \
  -c expiresAt="${EXPIRES_AT}"
```

The outputs file contains the resource names and IDs that Ops Coach can inject into the lab container.

## Candidate Workspace Files

The files in `templates/aws-security-basics/` are meant to be copied into the candidate workspace:

```text
~/work/aws/
  findings.md
  templates/
    launch-template-data.json
    public-access-block.json
    root-account-alarm.json
    revoke-public-ssh-rule.json
```

The candidate should not have to write dense AWS JSON from memory. They inspect real AWS state, edit or use these templates, apply narrow changes, and verify.

## Candidate Credential Smoke Test

Assume the candidate role:

```bash
CANDIDATE_ROLE_ARN="arn:aws:iam::${LAB_ACCOUNT_ID}:role/OpsCoachCandidateRole"

aws sts assume-role \
  --profile opscoach-lab-admin \
  --role-arn "${CANDIDATE_ROLE_ARN}" \
  --role-session-name "opscoach-${SESSION_ID}" \
  > /tmp/opscoach-candidate-creds.json
```

Export temporary credentials:

```bash
export AWS_ACCESS_KEY_ID="$(jq -r '.Credentials.AccessKeyId' /tmp/opscoach-candidate-creds.json)"
export AWS_SECRET_ACCESS_KEY="$(jq -r '.Credentials.SecretAccessKey' /tmp/opscoach-candidate-creds.json)"
export AWS_SESSION_TOKEN="$(jq -r '.Credentials.SessionToken' /tmp/opscoach-candidate-creds.json)"
export AWS_DEFAULT_REGION="${AWS_REGION}"
```

Check identity:

```bash
aws sts get-caller-identity
```

Expected useful reads:

```bash
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=OpsCoach,Values=true

aws s3api get-bucket-versioning \
  --bucket "$(jq -r '.OpsCoachAwsSecurityBasicsScenario.DataBucketName' cdk-outputs.json)"

aws ec2 describe-security-groups \
  --group-ids "$(jq -r '.OpsCoachAwsSecurityBasicsScenario.SecurityGroupId' cdk-outputs.json)"
```

Expected useful writes:

```bash
aws s3api put-bucket-versioning \
  --bucket "$(jq -r '.OpsCoachAwsSecurityBasicsScenario.DataBucketName' cdk-outputs.json)" \
  --versioning-configuration Status=Enabled

aws s3api put-public-access-block \
  --bucket "$(jq -r '.OpsCoachAwsSecurityBasicsScenario.DataBucketName' cdk-outputs.json)" \
  --public-access-block-configuration file://templates/aws-security-basics/public-access-block.json
```

If a reasonable command for the intended task gets `AccessDenied`, treat that as a lab bug and tighten the allowlist after fixing the workflow.

## Manual Janitor Run

Dry run:

```bash
aws lambda invoke \
  --profile opscoach-lab-admin \
  --function-name OpsCoachJanitor \
  --payload '{"dryRun": true, "reason": "manual-check"}' \
  /tmp/opscoach-janitor.json

jq . /tmp/opscoach-janitor.json
```

Delete expired resources:

```bash
aws lambda invoke \
  --profile opscoach-lab-admin \
  --function-name OpsCoachJanitor \
  --payload '{"dryRun": false, "reason": "manual-cleanup"}' \
  /tmp/opscoach-janitor.json
```

## Destroy Scenario

For normal development cleanup:

```bash
npx cdk destroy OpsCoachAwsSecurityBasicsScenario \
  --profile opscoach-lab-admin \
  -c labAccountId="${LAB_ACCOUNT_ID}" \
  -c managementAccountId="${MANAGEMENT_ACCOUNT_ID}" \
  -c adminPrincipalArn="${ADMIN_PRINCIPAL_ARN}" \
  -c allowedRegion="${AWS_REGION}" \
  -c sessionId="${SESSION_ID}" \
  -c expiresAt="${EXPIRES_AT}"
```

Keep the platform stack deployed between sessions.

## Next Ops Coach App Integration

The Swift app still needs an `AWSLabManager` layer. The intended app flow is:

1. Deploy/reset the scenario for a generated `SessionId`.
2. Read `cdk-outputs.json`.
3. Assume `OpsCoachCandidateRole`.
4. Write temporary AWS credentials into the lab container.
5. Copy `templates/aws-security-basics/` into `~/work/aws/`.
6. Grade final state using `OpsCoachGraderRole`.
7. Invoke `OpsCoachJanitor` after the session.
