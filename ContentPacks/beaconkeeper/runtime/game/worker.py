#!/usr/bin/env python3
"""Background worker for the Beaconkeeper practice game."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path


def parse_env_file(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def log_line(message: str) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    line = f"{stamp} beacon-worker[{os.getpid()}]: {message}\n"
    try:
        with open("/var/log/beacon/worker.log", "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    print(line, end="", flush=True)


try:
    ENV_PATH = os.environ.get("BEACON_ENV", "/etc/beacon/beacon.env")
    CONFIG = parse_env_file(ENV_PATH)
except Exception as exc:
    log_line(f"ConfigError: cannot read {os.environ.get('BEACON_ENV', '/etc/beacon/beacon.env')} as uid {os.geteuid()}: {exc}")
    sys.exit(78)

QUEUE_DIR = Path(CONFIG.get("QUEUE_DIR", "/var/lib/beacon/queue"))
HEARTBEAT = Path(CONFIG.get("WORKER_HEARTBEAT", "/var/lib/beacon/worker/heartbeat"))

if not QUEUE_DIR.exists() or not os.access(QUEUE_DIR, os.W_OK):
    log_line(f"RuntimeError: worker queue directory is not writable: {QUEUE_DIR}")
    sys.exit(73)

try:
    HEARTBEAT.parent.mkdir(parents=True, exist_ok=True)
    HEARTBEAT.write_text(str(time.time()), encoding="utf-8")
except Exception as exc:
    log_line(f"RuntimeError: cannot write heartbeat {HEARTBEAT}: {exc}")
    sys.exit(73)

log_line(f"worker started; queue={QUEUE_DIR}; heartbeat={HEARTBEAT}")
while True:
    HEARTBEAT.write_text(str(time.time()), encoding="utf-8")
    time.sleep(5)
