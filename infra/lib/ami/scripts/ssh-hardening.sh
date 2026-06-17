#!/usr/bin/env bash
set -euo pipefail

SSHD_CFG="/etc/ssh/sshd_config"
BACKUP="${SSHD_CFG}.opscoach.bak.$(date +%s)"
cp -a "$SSHD_CFG" "$BACKUP"

apply_kv() {
  local key="$1"
  local value="$2"
  if grep -qiE "^[#[:space:]]*${key}[[:space:]]" "$SSHD_CFG"; then
    sed -i -E "s/^[#[:space:]]*${key}[[:space:]].*/${key} ${value}/I" "$SSHD_CFG"
  else
    printf '\n%s %s\n' "$key" "$value" >>"$SSHD_CFG"
  fi
}

apply_kv "PasswordAuthentication" "no"
apply_kv "PermitRootLogin" "no"
apply_kv "PubkeyAuthentication" "yes"
apply_kv "ChallengeResponseAuthentication" "no"
apply_kv "KbdInteractiveAuthentication" "no"
apply_kv "X11Forwarding" "no"
apply_kv "AllowAgentForwarding" "no"
apply_kv "MaxAuthTries" "3"
apply_kv "ClientAliveInterval" "300"
apply_kv "ClientAliveCountMax" "2"

sshd -t
systemctl restart sshd
