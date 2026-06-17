#!/usr/bin/env bash
set -euo pipefail

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi

case "${ID:-}" in
  amzn)
    dnf install -y fail2ban
    ;;
  *)
    echo "Unsupported OS for fail2ban install: ${ID:-unknown}" >&2
    exit 1
    ;;
esac

install -d -m 0755 /etc/fail2ban/jail.d
cat >/etc/fail2ban/jail.d/opscoach-sshd.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF

systemctl enable --now fail2ban
fail2ban-client status sshd >/dev/null
