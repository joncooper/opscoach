#!/usr/bin/env bash
# Build Ops Coach web image, push to ECR, deploy Dev-OpsCoachLabHost + Dev-OpsCoach on Platform.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REGION="${AWS_REGION:-us-east-1}"
export AWS_PROFILE="${AWS_PROFILE:-platform}"
export AWS_REGION="$REGION"
ECR_REPO="${OPSCOACH_ECR_REPOSITORY:-your-org/opscoach-web}"
IMAGE_TAG="${OPSCOACH_IMAGE_TAG:-latest}"
SKIP_IMAGE="${OPSCOACH_SKIP_IMAGE_PUSH:-0}"
SKIP_DISCOVER="${OPSCOACH_SKIP_DISCOVER:-0}"
# Non-TTY shells (CI, agents) cannot answer CDK IAM prompts — use never unless overridden.
if [[ -t 1 && "${OPSCOACH_REQUIRE_APPROVAL:-}" == "" ]]; then
  CDK_APPROVAL="broadening"
else
  CDK_APPROVAL="${OPSCOACH_REQUIRE_APPROVAL:-never}"
fi

log() {
  printf '[deploy-platform] %s\n' "$*" >&2
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require_cmd aws
require_cmd docker
require_cmd jq

if [[ "$SKIP_DISCOVER" != "1" ]]; then
  log "discovering platform context"
  "${ROOT}/scripts/discover-platform-context.sh"
else
  log "skipping context discovery (OPSCOACH_SKIP_DISCOVER=1)"
  [[ -f "${ROOT}/infra/cdk.context.json" ]] || {
    echo "infra/cdk.context.json missing; run discover-platform-context.sh first" >&2
    exit 1
  }
fi

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ECR_URI="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}"

if [[ "$SKIP_IMAGE" != "1" ]]; then
  log "ensuring ECR repository $ECR_REPO"
  aws ecr describe-repositories --region "$REGION" --repository-names "$ECR_REPO" >/dev/null 2>&1 \
    || aws ecr create-repository --region "$REGION" --repository-name "$ECR_REPO" \
      --image-scanning-configuration scanOnPush=true >/dev/null

  log "logging in to ECR"
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

  log "building and pushing ${ECR_URI}:${IMAGE_TAG} (linux/arm64)"
  docker buildx build \
    --platform linux/arm64 \
    -f web/Dockerfile \
    -t "${ECR_URI}:${IMAGE_TAG}" \
    --push \
    .
else
  log "skipping image build/push (OPSCOACH_SKIP_IMAGE_PUSH=1)"
fi

LAB_ECR_PREFIX="${OPSCOACH_LAB_ECR_PREFIX:-${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/your-org/opscoach-lab}"
if [[ "$SKIP_IMAGE" != "1" ]]; then
  log "building and pushing lab images to ${LAB_ECR_PREFIX}"
  for repo in foundations-lab beaconkeeper basic-lab aws-cli-lab; do
    aws ecr describe-repositories --region "$REGION" --repository-names "your-org/opscoach-lab-${repo}" >/dev/null 2>&1 \
      || aws ecr create-repository --region "$REGION" --repository-name "your-org/opscoach-lab-${repo}" \
        --image-scanning-configuration scanOnPush=true >/dev/null
  done
  for entry in foundations-lab:ContentPacks/linux-foundations/runtime/foundations-lab \
    beaconkeeper:ContentPacks/beaconkeeper/runtime \
    basic-lab:ContentPacks/linux-foundations/runtime/basic-lab \
    aws-cli-lab:ContentPacks/aws-foundations/runtime/aws-cli-lab; do
    name="${entry%%:*}"
    context="${entry#*:}"
    image="${LAB_ECR_PREFIX}-${name}:${IMAGE_TAG}"
    log "building and pushing ${image}"
    docker buildx build \
      --platform linux/arm64 \
      -f "${context}/Dockerfile" \
      -t "${image}" \
      --push \
      "${context}"
  done
fi

log "installing infra dependencies"
(cd infra && npm install)

log "synthesizing CDK (sanity check)"
(cd infra && npm run synth:platform >/dev/null)

log "deploying Dev-OpsCoachLabHost and Dev-OpsCoach"
(
  cd infra
  npm run deploy:platform -- \
    --require-approval "$CDK_APPROVAL" \
    --outputs-file "${ROOT}/infra/deploy-outputs.json"
)

if [[ -f "${ROOT}/infra/deploy-outputs.json" ]]; then
  ENDPOINT="$(jq -r '."Dev-OpsCoach".Endpoint // empty' "${ROOT}/infra/deploy-outputs.json")"
  if [[ -n "$ENDPOINT" ]]; then
    log "deploy complete: $ENDPOINT"
    printf '%s\n' "$ENDPOINT"
  fi
fi

if [[ "$SKIP_IMAGE" != "1" ]]; then
  ECS_CLUSTER="${OPSCOACH_ECS_CLUSTER:-your-cluster}"
  ECS_SERVICE="${OPSCOACH_ECS_SERVICE:-Dev-OpsCoach-Service}"
  log "forcing ECS rollout on ${ECS_CLUSTER}/${ECS_SERVICE}"
  aws ecs update-service \
    --region "$REGION" \
    --cluster "$ECS_CLUSTER" \
    --service "$ECS_SERVICE" \
    --force-new-deployment \
    --query 'service.deployments[0].rolloutState' \
    --output text >/dev/null
fi

log "smoke: curl -fsS ${ENDPOINT:-https://opscoach.ops.example.com}/api/labs"
