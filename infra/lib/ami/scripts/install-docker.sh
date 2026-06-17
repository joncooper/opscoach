#!/usr/bin/env bash
set -euo pipefail

if command -v docker >/dev/null 2>&1; then
  echo "Docker already installed: $(docker --version)"
  exit 0
fi

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi

case "${ID:-}" in
  amzn)
    dnf install -y docker
    systemctl enable --now docker
    usermod -aG docker ec2-user || true
    ;;
  *)
    echo "Unsupported OS for Docker install: ${ID:-unknown}" >&2
    exit 1
    ;;
esac

docker --version
