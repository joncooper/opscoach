#!/usr/bin/env bash
# Build all ContentPack lab runtime Docker images with local tags.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PUSH="${OPSCOACH_LAB_IMAGE_PUSH:-0}"
REGISTRY="${OPSCOACH_LAB_IMAGE_REGISTRY:-ghcr.io/opscoach}"
TAG="${OPSCOACH_LAB_IMAGE_TAG:-latest}"
PLATFORM="${OPSCOACH_LAB_IMAGE_PLATFORM:-}"

log() {
  printf '[build-lab-images] %s\n' "$*" >&2
}

fail() {
  log "error: $*"
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker is required"

declare -a IMAGES=(
  "foundations-lab:ContentPacks/linux-foundations/runtime/foundations-lab"
  "basic-lab:ContentPacks/linux-foundations/runtime/basic-lab"
  "aws-cli-lab:ContentPacks/aws-foundations/runtime/aws-cli-lab"
  "beaconkeeper:ContentPacks/beaconkeeper/runtime"
)

platform_args=()
if [[ -n "$PLATFORM" ]]; then
  platform_args=(--platform "$PLATFORM")
fi

for entry in "${IMAGES[@]}"; do
  name="${entry%%:*}"
  context="${entry#*:}"
  image="${REGISTRY}/${name}:${TAG}"
  [[ -f "${context}/Dockerfile" ]] || fail "missing Dockerfile in ${context}"
  log "building ${image} (context=${context})"
  if [[ "$PUSH" == "1" ]]; then
    docker buildx build "${platform_args[@]}" -f "${context}/Dockerfile" -t "${image}" --push "${context}"
  else
    docker build "${platform_args[@]}" -f "${context}/Dockerfile" -t "${image}" "${context}"
  fi
  log "built ${image}"
done

log "all lab images built under ${REGISTRY}/*:${TAG}"
