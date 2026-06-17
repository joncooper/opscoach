#!/usr/bin/env bash
# End-to-end HTTP smoke for Ops Coach web session APIs (labs → session → grade → stop).
# Prefer a production server (`npm run build && npm start`) — `next dev` hot reload
# clears in-memory sessions and can cause 403 on /grade.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BASE_URL="${OPSCOACH_WEB_BASE_URL:-http://localhost:3000}"
PACK_ID="${OPSCOACH_SMOKE_PACK:-linux-foundations}"
LAB_ID="${OPSCOACH_SMOKE_LAB:-shell-orientation}"
MODE="${OPSCOACH_SMOKE_MODE:-practice}"
SESSIONS_ROOT="${SESSIONS_ROOT:-/tmp/opscoach-sessions}"
COMPOSE_PROJECT="${OPSCOACH_SMOKE_COMPOSE_PROJECT:-opscoach-web-smoke}"
START_COMPOSE="${OPSCOACH_SMOKE_START_COMPOSE:-0}"
POLL_SECONDS="${OPSCOACH_SMOKE_POLL_SECONDS:-120}"

COMPOSE_DIR="${OPSCOACH_SMOKE_COMPOSE_DIR:-$ROOT/ContentPacks/linux-foundations/runtime/foundations-lab}"
COMPOSE_FILE="${COMPOSE_DIR}/docker-compose.yml"
COMPOSE_SERVICE="${OPSCOACH_SMOKE_COMPOSE_SERVICE:-lab}"

TMP_DIR=""
SMOKE_KEY=""
COMPOSE_STARTED=0

log() {
  printf '[smoke-web-session] %s\n' "$*" >&2
}

fail() {
  log "error: $*"
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

cleanup() {
  local status=$?
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
  if [[ "$COMPOSE_STARTED" == "1" ]]; then
    log "tearing down docker compose project $COMPOSE_PROJECT"
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" -f "$TMP_DIR/compose-smoke.override.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  if [[ "$status" -ne 0 ]]; then
    log "session-smoke failed"
  fi
}
trap cleanup EXIT

require_cmd curl
require_cmd jq
require_cmd ssh-keygen

TMP_DIR="$(mktemp -d)"
SMOKE_KEY="$TMP_DIR/smoke_ed25519"
ssh-keygen -t ed25519 -f "$SMOKE_KEY" -N "" -C "opscoach-web-smoke" >/dev/null
PUBLIC_KEY="$(cat "${SMOKE_KEY}.pub")"

start_compose() {
  [[ -f "$COMPOSE_FILE" ]] || fail "compose file not found: $COMPOSE_FILE"
  cat >"$TMP_DIR/compose-smoke.override.yml" <<'YAML'
services:
  lab:
    ports:
      - "127.0.0.1:22:22"
YAML
  log "building and starting $COMPOSE_SERVICE via docker compose on 127.0.0.1:22"
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" -f "$TMP_DIR/compose-smoke.override.yml" build
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" -f "$TMP_DIR/compose-smoke.override.yml" up -d
  COMPOSE_STARTED=1

  local cid=""
  for _ in $(seq 1 60); do
    cid="$(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" -f "$TMP_DIR/compose-smoke.override.yml" ps -q "$COMPOSE_SERVICE" 2>/dev/null || true)"
    if [[ -n "$cid" ]] && docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null | grep -qx true; then
      break
    fi
    sleep 1
  done
  [[ -n "$cid" ]] || fail "compose service $COMPOSE_SERVICE did not start"

  for _ in $(seq 1 60); do
    if docker exec "$cid" pgrep -x sshd >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "lab container sshd did not become ready"
}

inject_container_keys() {
  local session_id="$1"
  local ssh_user="${2:-learner}"
  local learner_pub="$3"
  local grader_pub="${SESSIONS_ROOT}/${session_id}/ssh/grader_ed25519.pub"
  [[ -f "$grader_pub" ]] || {
    log "warning: grader public key not found at $grader_pub (grade may fail without GRADER_SSH_KEY_PATH on the web server)"
    return 0
  }
  local cid
  cid="$(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" -f "$TMP_DIR/compose-smoke.override.yml" ps -q "$COMPOSE_SERVICE")"
  [[ -n "$cid" ]] || return 0
  log "installing learner and grader public keys into running lab container (${ssh_user})"
  docker exec "$cid" bash -c "mkdir -p /home/${ssh_user}/.ssh && chmod 700 /home/${ssh_user}/.ssh"
  printf '%s\n' "$learner_pub" >"$TMP_DIR/learner.pub"
  docker cp "$TMP_DIR/learner.pub" "${cid}:/tmp/opscoach-learner.pub"
  docker cp "$grader_pub" "${cid}:/tmp/opscoach-grader.pub"
  docker exec "$cid" bash -c "printf '%s\n' \"\$(cat /tmp/opscoach-learner.pub)\" \"\$(cat /tmp/opscoach-grader.pub)\" > /home/${ssh_user}/.ssh/authorized_keys && chmod 600 /home/${ssh_user}/.ssh/authorized_keys && chown -R ${ssh_user}:${ssh_user} /home/${ssh_user}/.ssh && rm -f /tmp/opscoach-learner.pub /tmp/opscoach-grader.pub"
}

api_get() {
  local path="$1"
  curl -fsS "${BASE_URL}${path}"
}

api_post_json() {
  local path="$1"
  local body="$2"
  local extra_header="${3:-}"
  if [[ -n "$extra_header" ]]; then
    curl -fsS -X POST -H "Content-Type: application/json" -H "$extra_header" -d "$body" "${BASE_URL}${path}"
  else
    curl -fsS -X POST -H "Content-Type: application/json" -d "$body" "${BASE_URL}${path}"
  fi
}

if [[ "$START_COMPOSE" == "1" ]]; then
  require_cmd docker
  start_compose
fi

log "GET /api/labs"
labs_json="$(api_get "/api/labs")"
echo "$labs_json" | jq -e '.labs | type == "array"' >/dev/null || fail "/api/labs returned unexpected payload"
if ! echo "$labs_json" | jq -e --arg lab "$LAB_ID" '.labs[] | select(.labId == $lab)' >/dev/null; then
  fail "lab $LAB_ID not found in /api/labs catalog"
fi

log "POST /api/sessions pack=$PACK_ID lab=$LAB_ID mode=$MODE"
create_json="$(api_post_json "/api/sessions" "$(jq -nc \
  --arg packId "$PACK_ID" \
  --arg labId "$LAB_ID" \
  --arg publicKey "$PUBLIC_KEY" \
  --arg mode "$MODE" \
  '{packId:$packId, labId:$labId, publicKey:$publicKey, mode:$mode}')")"

SESSION_ID="$(echo "$create_json" | jq -r '.session.id // empty')"
TOKEN="$(echo "$create_json" | jq -r '.token // empty')"
[[ -n "$SESSION_ID" && -n "$TOKEN" ]] || fail "session create did not return session.id and token"

if [[ "$COMPOSE_STARTED" == "1" ]]; then
  SSH_USER="$(echo "$create_json" | jq -r '.session.sshUser // "learner"')"
  inject_container_keys "$SESSION_ID" "$SSH_USER" "$PUBLIC_KEY"
fi

log "polling GET /api/sessions/$SESSION_ID until ready"
deadline=$((SECONDS + POLL_SECONDS))
status="provisioning"
while (( SECONDS < deadline )); do
  session_json="$(api_get "/api/sessions/${SESSION_ID}")"
  status="$(echo "$session_json" | jq -r '.session.status // empty')"
  case "$status" in
    ready|running)
      break
      ;;
    failed|stopped)
      fail "session entered terminal status $status: $(echo "$session_json" | jq -r '.session.errorMessage // .error // "unknown"')"
      ;;
    provisioning|stopping)
      sleep 2
      ;;
    *)
      fail "unexpected session status: $status"
      ;;
  esac
done
[[ "$status" == "ready" || "$status" == "running" ]] || fail "timed out waiting for session to become ready (last status: $status)"

log "POST /api/sessions/$SESSION_ID/grade"
grade_json="$(api_post_json "/api/sessions/${SESSION_ID}/grade" '{}' "X-Session-Token: ${TOKEN}")"
echo "$grade_json" | jq -e '.result.labId' >/dev/null || fail "/grade returned unexpected payload"
grade_lab="$(echo "$grade_json" | jq -r '.result.labId')"
[[ "$grade_lab" == "$LAB_ID" ]] || fail "grader labId mismatch: expected $LAB_ID got $grade_lab"

log "POST /api/sessions/$SESSION_ID/stop"
stop_json="$(api_post_json "/api/sessions/${SESSION_ID}/stop" '{}' "X-Session-Token: ${TOKEN}")"
stop_status="$(echo "$stop_json" | jq -r '.session.status // empty')"
[[ "$stop_status" == "stopped" || "$stop_status" == "stopping" ]] || fail "stop did not return stopped/stopping status"

printf 'session-smoke ok session=%s lab=%s mode=%s\n' "$SESSION_ID" "$LAB_ID" "$MODE"
