#!/usr/bin/env bash
set -euo pipefail

DB_PATH="/var/lib/beacon/beacon.db"
BACKUP_DIR="/var/backups/beacon"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/beacon-${STAMP}.sql.gz"

install -d -o root -g beacon -m 0750 "${BACKUP_DIR}"
tmp="$(mktemp)"
sqlite3 "${DB_PATH}" .dump > "${tmp}"
gzip -c "${tmp}" > "${OUT}"
rm -f "${tmp}"
chown root:beacon "${OUT}"
chmod 0640 "${OUT}"
echo "wrote ${OUT}"
