#!/bin/bash
set -euo pipefail

SESSION_ID="{{SESSION_ID}}"
LEARNER_PUBKEY="{{LEARNER_PUBKEY}}"
GRADER_PUBKEY="{{GRADER_PUBKEY}}"
LAB_IMAGE="{{LAB_IMAGE}}"
LAB_USER="${LAB_USER:-learner}"
CALLBACK_URL="{{CALLBACK_URL}}"
CALLBACK_SECRET="{{CALLBACK_SECRET}}"
LAB_DIR="/opt/opscoach/lab"

exec > >(tee /var/log/opscoach-lab-bootstrap.log) 2>&1
echo "Ops Coach lab bootstrap starting for session ${SESSION_ID}"

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    return
  fi
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
  fi
  case "${ID:-linux}" in
    amzn)
      dnf install -y docker fail2ban
      systemctl enable --now docker
      ;;
    ubuntu|debian)
      apt-get update -y
      apt-get install -y ca-certificates curl gnupg
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
      echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} \
        ${VERSION_CODENAME:-stable} stable" > /etc/apt/sources.list.d/docker.list
      apt-get update -y
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      systemctl enable --now docker
      ;;
    *)
      echo "Unsupported OS for automatic Docker install: ${ID:-unknown}" >&2
      exit 1
      ;;
  esac
}

ecr_login_if_needed() {
  case "${LAB_IMAGE}" in
    *.dkr.ecr.*.amazonaws.com/*)
      region="$(echo "${LAB_IMAGE}" | sed -n 's/.*\.dkr\.ecr\.\([^.]*\)\.amazonaws.com.*/\1/p')"
      registry="$(echo "${LAB_IMAGE}" | cut -d/ -f1)"
      aws ecr get-login-password --region "${region}" \
        | docker login --username AWS --password-stdin "${registry}" || true
      ;;
  esac
}

release_host_port22() {
  systemctl stop sshd 2>/dev/null || systemctl stop ssh 2>/dev/null || true
  systemctl disable sshd 2>/dev/null || systemctl disable ssh 2>/dev/null || true
  systemctl mask sshd 2>/dev/null || systemctl mask ssh 2>/dev/null || true
}

start_lab_container() {
  mkdir -p "${LAB_DIR}"
  cat > "${LAB_DIR}/docker-compose.yml" <<EOF
services:
  lab:
    image: ${LAB_IMAGE}
    restart: unless-stopped
    privileged: true
    cgroup: host
    security_opt:
      - seccomp:unconfined
    tmpfs:
      - /run
      - /run/lock
      - /tmp
    volumes:
      - /sys/fs/cgroup:/sys/fs/cgroup:rw
    ports:
      - "22:22"
    command: ["/lib/systemd/systemd"]
    stop_signal: SIGRTMIN+3
EOF
  cd "${LAB_DIR}"
  if docker compose version >/dev/null 2>&1; then
    docker compose up -d
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose up -d
  else
    docker run -d --name opscoach-lab --restart unless-stopped \
      --privileged --cgroupns=host \
      --security-opt seccomp=unconfined \
      --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
      -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
      -p 22:22 \
      "${LAB_IMAGE}" /lib/systemd/systemd
  fi
}

lab_container_id() {
  if [ -f "${LAB_DIR}/docker-compose.yml" ]; then
    cd "${LAB_DIR}"
    cid=$(docker compose ps -q lab 2>/dev/null | head -1 || true)
    if [ -n "${cid}" ]; then
      echo "${cid}"
      return 0
    fi
  fi
  docker ps -q --filter name=opscoach-lab | head -1
}

wait_for_container_sshd() {
  for _ in $(seq 1 60); do
    cid=$(lab_container_id || true)
    if [ -n "${cid}" ] && docker inspect -f '{{.State.Running}}' "${cid}" 2>/dev/null | grep -q true; then
      echo "${cid}"
      return 0
    fi
    sleep 2
  done
  echo "Lab container did not start" >&2
  return 1
}

inject_container_keys() {
  local cid="$1"
  docker exec "${cid}" mkdir -p "/home/${LAB_USER}/.ssh"
  docker exec "${cid}" chmod 700 "/home/${LAB_USER}/.ssh"
  echo "${AUTHORIZED_KEYS_B64}" | base64 -d | docker exec -i "${cid}" tee "/home/${LAB_USER}/.ssh/authorized_keys" >/dev/null
  docker exec "${cid}" chmod 600 "/home/${LAB_USER}/.ssh/authorized_keys"
  docker exec "${cid}" chown -R "${LAB_USER}:${LAB_USER}" "/home/${LAB_USER}/.ssh"
}

wait_for_port22() {
  for _ in $(seq 1 90); do
    if timeout 2 bash -c 'echo > /dev/tcp/127.0.0.1/22' 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "Port 22 not accepting connections on host" >&2
  return 1
}

is_public_routable_ip() {
  case "$1" in
    10.*|127.*|0.*|169.254.*|192.168.*) return 1 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 1 ;;
    *.*.*.*) return 0 ;;
    *) return 1 ;;
  esac
}

imds_get() {
  local path="$1"
  local token=""
  token=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)
  if [ -n "${token}" ]; then
    curl -fsS -m 2 -H "X-aws-ec2-metadata-token: ${token}" \
      "http://169.254.169.254/latest/meta-data/${path}" 2>/dev/null || true
  else
    curl -fsS -m 2 "http://169.254.169.254/latest/meta-data/${path}" 2>/dev/null || true
  fi
}

notify_ready() {
  if [ -z "${CALLBACK_URL}" ] || [ "${CALLBACK_URL}" = "{{CALLBACK_URL}}" ]; then
    echo "No callback URL configured; skipping readiness notification"
    return
  fi

  public_ip=""
  private_ip=""
  for _ in $(seq 1 60); do
    public_ip=$(imds_get "public-ipv4")
    private_ip=$(imds_get "local-ipv4")
    if [ -n "${public_ip}" ] && [ -n "${private_ip}" ]; then
      break
    fi
    sleep 2
  done

  if [ -z "${public_ip}" ] || ! is_public_routable_ip "${public_ip}" || [ -z "${private_ip}" ]; then
    echo "No public routable IP available; skipping readiness callback"
    return
  fi

  payload=$(cat <<JSON
{"sshHost":"${public_ip}","graderHost":"${private_ip}","sshPort":22}
JSON
)
  secret_header=()
  if [ -n "${CALLBACK_SECRET:-}" ] && [ "${CALLBACK_SECRET}" != "{{CALLBACK_SECRET}}" ]; then
    secret_header=(-H "X-Internal-Secret: ${CALLBACK_SECRET}")
  fi

  curl -fsS --max-time 30 -X POST \
    -H "Content-Type: application/json" \
    "${secret_header[@]}" \
    -d "${payload}" \
    "${CALLBACK_URL}" || echo "Callback notification failed (non-fatal)"
}

install_docker
release_host_port22
ecr_login_if_needed
start_lab_container
CONTAINER_ID=$(wait_for_container_sshd)
wait_for_port22
inject_container_keys "${CONTAINER_ID}"
notify_ready
echo "Ops Coach lab bootstrap complete for session ${SESSION_ID}"
