export interface LabUserDataOptions {
  sessionId: string;
  /** Learner + grader + default keys, deduplicated. */
  authorizedKeys: string[];
  callbackUrl: string;
  callbackSecret: string;
  shutdownUrl: string;
  labImage?: string;
  labUser?: string;
  /** Seconds with no SSH before calling shutdown webhook after a session was seen. */
  sshIdleGraceSeconds?: number;
}

function shellEscape(value: string): string {
  // Values are interpolated inside double-quoted shell strings, where ", \, $ and
  // backtick are all still special (command/parameter substitution). Escape all four.
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

/** Shell user-data passed to RunInstances (overrides launch-template script). */
export function buildLabUserData(options: LabUserDataOptions): string {
  const labImage = options.labImage ?? "ghcr.io/opscoach/foundations-lab:latest";
  const labUser = options.labUser ?? "learner";
  const authorizedKeysB64 = Buffer.from(
    options.authorizedKeys.map((key) => key.trim()).filter(Boolean).join("\n"),
    "utf8"
  ).toString("base64");
  const callbackUrl = shellEscape(options.callbackUrl);
  const callbackSecret = shellEscape(options.callbackSecret);
  const shutdownUrl = shellEscape(options.shutdownUrl);
  const progressUrl = shellEscape(options.callbackUrl.replace(/\/ready$/, "/progress"));
  const idleGrace = options.sshIdleGraceSeconds ?? 120;

  return `#!/bin/bash
set -euo pipefail
SESSION_ID="${shellEscape(options.sessionId)}"
AUTHORIZED_KEYS_B64="${authorizedKeysB64}"
LAB_IMAGE="${shellEscape(labImage)}"
LAB_USER="${shellEscape(labUser)}"
CALLBACK_URL="${callbackUrl}"
CALLBACK_SECRET="${callbackSecret}"
SHUTDOWN_URL="${shutdownUrl}"
PROGRESS_URL="${progressUrl}"
SSH_IDLE_GRACE_SECONDS=${idleGrace}
LAB_DIR="/opt/opscoach/lab"

exec > >(tee /var/log/opscoach-lab-bootstrap.log) 2>&1
echo "Ops Coach lab bootstrap starting for session \${SESSION_ID}"

report_progress() {
  local step="\$1"
  local detail="\$2"
  local esc
  esc=\$(printf '%s' "\${detail}" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
  curl -fsS --max-time 10 -X POST \\
    -H "Content-Type: application/json" \\
    -H "X-Internal-Secret: \${CALLBACK_SECRET}" \\
    -d "{\\"step\\":\\"\${step}\\",\\"detail\\":\\"\${esc}\\"}" \\
    "\${PROGRESS_URL}" 2>/dev/null || true
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    report_progress bootstrap "Docker already available"
    return
  fi
  report_progress bootstrap "Installing Docker (usually about 1 minute)"
  if [ -f /etc/os-release ]; then
    . /etc/os-release
  fi
  case "\${ID:-linux}" in
    amzn)
      dnf install -y docker fail2ban
      systemctl enable --now docker
      systemctl enable --now fail2ban || true
      ;;
    *)
      echo "Unsupported OS for automatic Docker install: \${ID:-unknown}" >&2
      exit 1
      ;;
  esac
}

block_container_imds() {
  # Lab containers must not reach IMDS — neither the instance-role credentials nor the
  # user-data callback secret. The host itself still reaches IMDS (locally-originated
  # traffic does not traverse DOCKER-USER/FORWARD). A host-root escape can undo this;
  # the scoped instance role and lab-account isolation are the backstops.
  iptables -I DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null \\
    || iptables -I FORWARD -d 169.254.169.254 -j DROP 2>/dev/null || true
}

ecr_login_if_needed() {
  case "\${LAB_IMAGE}" in
    *.dkr.ecr.*.amazonaws.com/*)
      report_progress bootstrap "Authenticating with container registry"
      region="\$(echo "\${LAB_IMAGE}" | sed -n 's/.*\\.dkr\\.ecr\\.\\([^.]*\\)\\.amazonaws.com.*/\\1/p')"
      registry="\$(echo "\${LAB_IMAGE}" | cut -d/ -f1)"
      aws ecr get-login-password --region "\${region}" \\
        | docker login --username AWS --password-stdin "\${registry}" || true
      ;;
  esac
}

apply_host_hardening() {
  if command -v fail2ban-client >/dev/null 2>&1; then
    cat > /etc/fail2ban/jail.d/opscoach-sshd.local <<'F2B'
[sshd]
enabled = true
maxretry = 5
findtime = 600
bantime = 3600
F2B
    systemctl restart fail2ban || true
  fi
}

release_host_port22() {
  systemctl stop sshd 2>/dev/null || systemctl stop ssh 2>/dev/null || true
  systemctl disable sshd 2>/dev/null || systemctl disable ssh 2>/dev/null || true
  systemctl mask sshd 2>/dev/null || systemctl mask ssh 2>/dev/null || true
}

start_lab_container() {
  mkdir -p "\${LAB_DIR}"
  cat > "\${LAB_DIR}/docker-compose.yml" <<EOF
services:
  lab:
    image: \${LAB_IMAGE}
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
  cd "\${LAB_DIR}"
  if docker compose version >/dev/null 2>&1; then
    docker compose up -d
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose up -d
  else
    docker run -d --name opscoach-lab --restart unless-stopped \\
      --privileged --cgroupns=host \\
      --security-opt seccomp=unconfined \\
      --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \\
      -v /sys/fs/cgroup:/sys/fs/cgroup:rw \\
      -p 22:22 \\
      \${LAB_IMAGE} /lib/systemd/systemd
  fi
}

lab_container_id() {
  if [ -f "\${LAB_DIR}/docker-compose.yml" ]; then
    cd "\${LAB_DIR}"
    cid=\$(docker compose ps -q lab 2>/dev/null | head -1 || true)
    if [ -n "\${cid}" ]; then
      echo "\${cid}"
      return 0
    fi
  fi
  docker ps -q --filter name=opscoach-lab | head -1
}

wait_for_container_sshd() {
  for _ in \$(seq 1 60); do
    cid=\$(lab_container_id || true)
    if [ -n "\${cid}" ] && docker inspect -f '{{.State.Running}}' "\${cid}" 2>/dev/null | grep -q true; then
      echo "\${cid}"
      return 0
    fi
    sleep 2
  done
  echo "Lab container did not start" >&2
  return 1
}

inject_container_keys() {
  local cid="\$1"
  docker exec "\${cid}" mkdir -p "/home/\${LAB_USER}/.ssh"
  docker exec "\${cid}" chmod 700 "/home/\${LAB_USER}/.ssh"
  echo "\${AUTHORIZED_KEYS_B64}" | base64 -d | docker exec -i "\${cid}" tee "/home/\${LAB_USER}/.ssh/authorized_keys" >/dev/null
  docker exec "\${cid}" chmod 600 "/home/\${LAB_USER}/.ssh/authorized_keys"
  docker exec "\${cid}" chown -R "\${LAB_USER}:\${LAB_USER}" "/home/\${LAB_USER}/.ssh"
}

wait_for_port22() {
  for _ in \$(seq 1 90); do
    if timeout 2 bash -c 'echo > /dev/tcp/127.0.0.1/22' 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "Port 22 not accepting connections on host" >&2
  return 1
}

is_public_routable_ip() {
  case "\$1" in
    10.*|127.*|0.*|169.254.*|192.168.*) return 1 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 1 ;;
    *.*.*.*) return 0 ;;
    *) return 1 ;;
  esac
}

imds_get() {
  local path="\$1"
  local token=""
  token=\$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" \\
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)
  if [ -n "\${token}" ]; then
    curl -fsS -m 2 -H "X-aws-ec2-metadata-token: \${token}" \\
      "http://169.254.169.254/latest/meta-data/\${path}" 2>/dev/null || true
  else
    curl -fsS -m 2 "http://169.254.169.254/latest/meta-data/\${path}" 2>/dev/null || true
  fi
}

notify_ready() {
  public_ip=""
  private_ip=""
  for _ in \$(seq 1 60); do
    public_ip=\$(imds_get "public-ipv4")
    private_ip=\$(imds_get "local-ipv4")
    if [ -n "\${public_ip}" ] && [ -n "\${private_ip}" ]; then
      break
    fi
    sleep 2
  done

  if [ -n "\${public_ip}" ] && is_public_routable_ip "\${public_ip}" && [ -n "\${private_ip}" ]; then
    payload="{\\"sshHost\\":\\"\${public_ip}\\",\\"graderHost\\":\\"\${private_ip}\\",\\"sshPort\\":22}"
    curl -fsS --max-time 30 -X POST \\
      -H "Content-Type: application/json" \\
      -H "X-Internal-Secret: \${CALLBACK_SECRET}" \\
      -d "\${payload}" \\
      "\${CALLBACK_URL}" || echo "Callback failed (non-fatal)"
  else
    echo "No public routable IP available; skipping readiness callback"
  fi
}

start_ssh_idle_watcher() {
  (
    had_session=0
    idle_since=0
    while true; do
      count=\$(ss -tn state established '( sport = :22 )' 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')
      if [ "\${count:-0}" -gt 0 ]; then
        had_session=1
        idle_since=0
      elif [ "\${had_session}" -eq 1 ]; then
        now=\$(date +%s)
        if [ "\${idle_since}" -eq 0 ]; then
          idle_since=\${now}
        elif [ \$((now - idle_since)) -ge "\${SSH_IDLE_GRACE_SECONDS}" ]; then
          payload="{\\"reason\\":\\"ssh_idle\\"}"
          curl -fsS -X POST \\
            -H "Content-Type: application/json" \\
            -H "X-Internal-Secret: \${CALLBACK_SECRET}" \\
            -d "\${payload}" \\
            "\${SHUTDOWN_URL}" || echo "Shutdown callback failed (non-fatal)"
          exit 0
        fi
      fi
      sleep 15
    done
  ) &
}

install_docker
block_container_imds
apply_host_hardening
release_host_port22
report_progress bootstrap "Preparing lab host"
ecr_login_if_needed
report_progress bootstrap "Pulling lab image (\${LAB_IMAGE##*/})"
start_lab_container
report_progress start_lab "Starting lab environment"
CONTAINER_ID=\$(wait_for_container_sshd)
report_progress start_lab "Waiting for SSH service in lab"
wait_for_port22
report_progress install_keys "Installing your SSH keys"
inject_container_keys "\${CONTAINER_ID}"
notify_ready
start_ssh_idle_watcher

echo "Ops Coach lab bootstrap complete"
`;
}
