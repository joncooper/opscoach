# Ops Coach on Platform (mono-playground)

Deploy Ops Coach into the shared platform without recreating VPC, ALB, or ECS cluster.

**Local dev (no AWS):** see [`docs/local-dev-without-aws.md`](../docs/local-dev-without-aws.md) (deferred); production path below.

## Quick deploy

Prerequisites: AWS SSO/credentials for account `123456789012`, region `us-east-1`, Docker with `buildx`, and mono-playground `Dev-Network` / `Dev-Cluster` / `Dev-Edge` already deployed.

```bash
aws login   # or export a profile with access to 123456789012
./scripts/deploy-platform.sh
```

This script:

1. Discovers VPC, ALB, HTTPS listener from CloudFormation (`scripts/discover-platform-context.sh` → `infra/cdk.context.json`)
2. Creates ECR repo `your-org/opscoach-web` if missing
3. Builds and pushes the web image (`linux/arm64`)
4. Runs `cdk deploy` for `Dev-OpsCoachLabHost` and `Dev-OpsCoach`

After deploy, open `https://opscoach.ops.example.com` and smoke:

```bash
curl -fsS https://opscoach.ops.example.com/api/labs | jq '.packs // .labs | length'
```

Skip steps when iterating:

```bash
OPSCOACH_SKIP_DISCOVER=1 OPSCOACH_SKIP_IMAGE_PUSH=1 ./scripts/deploy-platform.sh   # CDK only
OPSCOACH_SKIP_IMAGE_PUSH=1 ./scripts/deploy-platform.sh                            # refresh context + CDK
```

## Prerequisites

1. `Dev-Network`, `Dev-Cluster`, and `Dev-Edge` stacks deployed from [mono-playground/infra](../mono-playground/infra).
2. AWS CLI profile for account `123456789012`, region `us-east-1`.
3. ECR repository `your-org/opscoach-web` (add to mono-playground CI when ready).

## Collect platform IDs

**Automated:** `./scripts/discover-platform-context.sh` (preferred).

**Manual:** after mono-playground deploy, gather outputs:

```bash
# VPC
aws ec2 describe-vpcs --filters "Name=tag:Name,Values=*platform*" --query 'Vpcs[0].VpcId' --output text

# ECS cluster name
aws ecs list-clusters

# ALB + listener (from Dev-Edge stack outputs or console)
aws elbv2 describe-load-balancers --query 'LoadBalancers[?contains(LoadBalancerName, `platform`)].{Arn:LoadBalancerArn,SG:SecurityGroups[0]}'
aws elbv2 describe-listeners --load-balancer-arn <ALB_ARN> --query 'Listeners[?Port==`443`].ListenerArn'
```

## CDK context (linux-coach-web)

Pass IDs via `-c` flags or add to `cdk.context` in [infra/cdk.json](cdk.json). Example shape: [cdk.context.example.json](cdk.context.example.json). Runtime file `cdk.context.json` is gitignored and written by the discover script.

```json
{
  "envs": {
    "dev": { "account": "123456789012", "region": "us-east-1" }
  },
  "platformVpcId": "vpc-xxxxxxxx",
  "platformClusterName": "your-cluster",
  "platformAlbArn": "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/...",
  "platformAlbSecurityGroupId": "sg-xxxxxxxx",
  "platformHttpsListenerArn": "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/.../.../...",
  "dnsZoneName": "ops.example.com",
  "opscoachHostLabel": "opscoach",
  "opscoachListenerPriority": 40,
  "opscoachEcrRepository": "your-org/opscoach-web",
  "region": "us-east-1",
  "idleTimeoutMinutes": 10
}
```

## Deploy

```bash
./scripts/deploy-platform.sh
```

Or manually:

```bash
cd infra
npm install
npm run build
npm run deploy:platform
```

Stacks created:

| Stack | Purpose |
|-------|---------|
| `Dev-OpsCoachLabHost` | Lab EC2 launch template, SG (public SSH + VPC grader SSH), session janitor Lambda |
| `Dev-OpsCoach` | Fargate service on shared cluster, RDS Postgres, ALB host rule `opscoach.ops.example.com` |

## Optional: wire into mono-playground `platform.ts`

When you want first-class platform integration, add to [mono-playground/infra/bin/platform.ts](../mono-playground/infra/bin/platform.ts):

```typescript
import { OpsCoachLabHostStack } from 'opscoach/infra/lib/lab-host-stack'; // or copy stacks
import { OpsCoachServiceStack } from 'opscoach/infra/lib/opscoach-service-stack';
import { loadPlatformOpsCoachConfig } from 'opscoach/infra/lib/web-config';

const opsCoachConfig = loadPlatformOpsCoachConfig(app, zoneName);

const opsCoachLabHost = new OpsCoachLabHostStack(app, 'Dev-OpsCoachLabHost', {
  env: devEnv,
  config: opsCoachConfig,
  vpc: network.vpc,
});

const publicSubnet = network.vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnets[0];

new OpsCoachServiceStack(app, 'Dev-OpsCoach', {
  env: devEnv,
  platform: {
    env: devEnv,
    vpc: network.vpc,
    cluster: cluster.cluster,
    alb: edge.alb,
    httpsListener: edge.httpsListener,
    zoneName,
  },
  config: opsCoachConfig,
  launchTemplateId: opsCoachLabHost.launchTemplate.launchTemplateId,
  publicSubnetId: publicSubnet.subnetId,
});
```

Until then, standalone deploy via `bin/opscoach-platform.ts` imports the same platform resources by ID.

## ECR / CI

Add to mono-playground `IMAGE_REPOS` and `.github/workflows/images.yml`:

```yaml
- your-org/opscoach-web
```

Build from [web/Dockerfile](../web/Dockerfile); push `latest` before first Fargate deploy.

## DNS

`opscoach.ops.example.com` is covered by the existing `*.ops.example.com` ACM cert on the shared ALB. Add a Route53 alias record pointing to the ALB if not using wildcard resolution.

## Google Workspace SSO (ALB + shared Cognito)

Ops Coach reuses the Platform **WorkspaceAuth** Cognito user pool (same Google federation as `play.ops.example.com`). No mono-playground code changes:

1. `discover-platform-context.sh` reads `Dev-WorkspaceAuth` outputs (`PLATFORM_AUTH_STACK` override) into `platformCognitoUserPoolId` and `platformCognitoDomainName`.
2. `Dev-OpsCoach` creates a dedicated ALB OAuth client (`alb-opscoach-web`) and wires `authenticate-cognito` on listener priority 40.
3. Priority **39** bypasses only `/api/health` (ALB target health). Session callbacks use **Cloud Map** at `http://opscoach-web.ops.internal:3000` from lab EC2 and the terminator Lambda (VPC-only; SG-restricted to Fargate :3000).

Disable without redeploying mono-playground: `-c opscoachCognitoAuth=false` or omit Cognito context keys.

**Google Cloud Console:** if play login already works, **no changes needed**. Google’s authorized redirect URI is the Cognito hosted UI (`*.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`), not the Ops Coach hostname. Only Cognito/ALB callback URLs are host-specific.

If Workspace SSO was never configured, follow mono-playground ADR `0001-google-workspace-sso-via-cognito.md` first (OAuth client + Secrets Manager secret on the shared pool).

## Standalone deploy (greenfield)

For a self-contained VPC + ALB (not Platform), use:

```bash
npm run deploy:web -c labAccountId=YOUR_ACCOUNT_ID
```

See [lib/web-stack.ts](lib/web-stack.ts) and [bin/opscoach-web.ts](bin/opscoach-web.ts).

## Leak prevention (defense in depth)

Three independent teardown paths:

| Layer | Trigger | Action |
|-------|---------|--------|
| **SSH idle watcher** | No established connections on host `:22` for `sshIdleGraceSeconds` (default 120s) after learner connected | `POST /api/sessions/:id/shutdown` with `reason=ssh_idle` |
| **Max TTL schedule** | EventBridge Scheduler one-time at `maxLifetimeMinutes` (default 60) after `RunInstances` | `OpsCoachSessionTerminator` Lambda terminates EC2 + calls shutdown API |
| **ExpiresAt sweep** | Every 5 minutes | Same Lambda sweeps instances past `ExpiresAt` tag |

Context keys: `maxLifetimeMinutes`, `sshIdleGraceSeconds`, `idleTimeoutMinutes` (legacy label; max lifetime drives `ExpiresAt`).

Manual **Stop lab** cancels the scheduler and terminates immediately.

Full rationale, tradeoffs, and sequence diagrams: [`docs/lab-lifecycle-design.md`](../docs/lab-lifecycle-design.md).

- Learner SSH: public IP, pubkey-only, `fail2ban` on hardened AMI (future Packer pipeline).
- Grader SSH: private IP from Fargate tasks inside VPC.
- Lab instances tagged `OpsCoach=true` + `ExpiresAt`; janitor Lambda terminates expired instances.
- Ready/progress/shutdown callbacks: per-session token from EC2 user-data; global secret for terminator Lambda only. Reachable on **`INTERNAL_CALLBACK_BASE_URL`** (Cloud Map), not the public ALB hostname.
