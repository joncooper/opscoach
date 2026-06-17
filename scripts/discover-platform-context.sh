#!/usr/bin/env bash
# Discover platform resource IDs and write infra/cdk.context.json for Ops Coach deploy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/infra/cdk.context.json"
REGION="${AWS_REGION:-us-east-1}"
export AWS_PROFILE="${AWS_PROFILE:-platform}"
export AWS_REGION="$REGION"
ACCOUNT="${OPSCOACH_AWS_ACCOUNT:-123456789012}"
NETWORK_STACK="${PLATFORM_NETWORK_STACK:-Dev-Network}"
EDGE_STACK="${PLATFORM_EDGE_STACK:-Dev-Edge}"
AUTH_STACK="${PLATFORM_AUTH_STACK:-Dev-WorkspaceAuth}"
CLUSTER_NAME="${PLATFORM_CLUSTER_NAME:-your-cluster}"
CLOUD_MAP_NAMESPACE_NAME="${PLATFORM_CLOUD_MAP_NAMESPACE_NAME:-ops.internal}"

log() {
  printf '[discover-platform-context] %s\n' "$*" >&2
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require_cmd aws
require_cmd jq

log "checking AWS identity"
ACTUAL_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$ACTUAL_ACCOUNT" != "$ACCOUNT" ]]; then
  log "warning: expected account $ACCOUNT, got $ACTUAL_ACCOUNT"
fi

log "reading VPC from stack $NETWORK_STACK"
VPC_ID="$(aws cloudformation describe-stack-resources \
  --region "$REGION" \
  --stack-name "$NETWORK_STACK" \
  --query "StackResources[?ResourceType=='AWS::EC2::VPC'].PhysicalResourceId" \
  --output text)"
[[ -n "$VPC_ID" && "$VPC_ID" != "None" ]] || {
  echo "could not find VPC in $NETWORK_STACK" >&2
  exit 1
}

log "reading ALB from stack $EDGE_STACK"
ALB_ARN="$(aws cloudformation describe-stack-resources \
  --region "$REGION" \
  --stack-name "$EDGE_STACK" \
  --query "StackResources[?ResourceType=='AWS::ElasticLoadBalancingV2::LoadBalancer'].PhysicalResourceId" \
  --output text)"
[[ -n "$ALB_ARN" && "$ALB_ARN" != "None" ]] || {
  echo "could not find ALB in $EDGE_STACK" >&2
  exit 1
}

ALB_SG="$(aws elbv2 describe-load-balancers \
  --region "$REGION" \
  --load-balancer-arns "$ALB_ARN" \
  --query 'LoadBalancers[0].SecurityGroups[0]' \
  --output text)"

HTTPS_LISTENER_ARN="$(aws elbv2 describe-listeners \
  --region "$REGION" \
  --load-balancer-arn "$ALB_ARN" \
  --query 'Listeners[?Port==`443`].ListenerArn | [0]' \
  --output text)"

[[ -n "$ALB_SG" && "$ALB_SG" != "None" ]] || {
  echo "could not resolve ALB security group" >&2
  exit 1
}
[[ -n "$HTTPS_LISTENER_ARN" && "$HTTPS_LISTENER_ARN" != "None" ]] || {
  echo "could not find HTTPS listener on ALB" >&2
  exit 1
}

log "reading Cloud Map namespace $CLOUD_MAP_NAMESPACE_NAME"
CLOUD_MAP_JSON="$(aws servicediscovery list-namespaces \
  --region "$REGION" \
  --filters "Name=NAME,Values=$CLOUD_MAP_NAMESPACE_NAME" \
  --output json)"
CLOUD_MAP_NAMESPACE_ID="$(echo "$CLOUD_MAP_JSON" | jq -r '.Namespaces[0].Id // empty')"
CLOUD_MAP_NAMESPACE_ARN="$(echo "$CLOUD_MAP_JSON" | jq -r '.Namespaces[0].Arn // empty')"
[[ -n "$CLOUD_MAP_NAMESPACE_ID" && -n "$CLOUD_MAP_NAMESPACE_ARN" ]] || {
  echo "could not find Cloud Map namespace $CLOUD_MAP_NAMESPACE_NAME (is Dev-Cluster deployed?)" >&2
  exit 1
}

COGNITO_USER_POOL_ID=""
COGNITO_DOMAIN_NAME=""
if aws cloudformation describe-stacks --region "$REGION" --stack-name "$AUTH_STACK" >/dev/null 2>&1; then
  log "reading Cognito from stack $AUTH_STACK"
  AUTH_OUTPUTS="$(aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$AUTH_STACK" \
    --query 'Stacks[0].Outputs' \
    --output json)"
  COGNITO_DOMAIN_NAME="$(echo "$AUTH_OUTPUTS" | jq -r '.[] | select(.OutputKey=="CognitoDomain") | .OutputValue // empty')"
  USER_POOL_ARN="$(echo "$AUTH_OUTPUTS" | jq -r '.[] | select(.OutputKey | test("UserPool.*Arn")) | .OutputValue' | head -1)"
  if [[ -n "$USER_POOL_ARN" && "$USER_POOL_ARN" != "None" ]]; then
    COGNITO_USER_POOL_ID="${USER_POOL_ARN##*/}"
  fi
  if [[ -n "$COGNITO_USER_POOL_ID" && -n "$COGNITO_DOMAIN_NAME" ]]; then
    log "cognito pool=$COGNITO_USER_POOL_ID domain=$COGNITO_DOMAIN_NAME"
  else
    log "warning: $AUTH_STACK missing Cognito outputs; opscoach ALB auth will be skipped until configured"
  fi
else
  log "warning: auth stack $AUTH_STACK not found; set PLATFORM_AUTH_STACK or deploy WorkspaceAuth"
fi

jq -n \
  --arg account "$ACTUAL_ACCOUNT" \
  --arg region "$REGION" \
  --arg vpc "$VPC_ID" \
  --arg cluster "$CLUSTER_NAME" \
  --arg alb "$ALB_ARN" \
  --arg albSg "$ALB_SG" \
  --arg listener "$HTTPS_LISTENER_ARN" \
  --arg cloudMapId "$CLOUD_MAP_NAMESPACE_ID" \
  --arg cloudMapArn "$CLOUD_MAP_NAMESPACE_ARN" \
  --arg cloudMapName "$CLOUD_MAP_NAMESPACE_NAME" \
  --arg cognitoPool "$COGNITO_USER_POOL_ID" \
  --arg cognitoDomain "$COGNITO_DOMAIN_NAME" \
  '{
    envs: { dev: { account: $account, region: $region } },
    platformVpcId: $vpc,
    platformClusterName: $cluster,
    platformAlbArn: $alb,
    platformAlbSecurityGroupId: $albSg,
    platformHttpsListenerArn: $listener,
    platformCloudMapNamespaceId: $cloudMapId,
    platformCloudMapNamespaceArn: $cloudMapArn,
    platformCloudMapNamespaceName: $cloudMapName,
    dnsZoneName: "ops.example.com",
    opscoachHostLabel: "opscoach",
    opscoachListenerPriority: 40,
    opscoachListenerBypassPriority: 39,
    opscoachEcrRepository: "your-org/opscoach-web",
    region: $region,
    idleTimeoutMinutes: 10,
    maxLifetimeMinutes: 60,
    sshIdleGraceSeconds: 120
  } + (if $cognitoPool != "" then { platformCognitoUserPoolId: $cognitoPool } else {} end)
    + (if $cognitoDomain != "" then { platformCognitoDomainName: $cognitoDomain } else {} end)' >"$OUT"

log "wrote $OUT"
log "vpc=$VPC_ID cluster=$CLUSTER_NAME listener priority=40 host=opscoach.ops.example.com"
