#!/usr/bin/env python3
"""Tiny Beacon app used by the Beaconkeeper Linux/DevOps practice game."""

from __future__ import annotations

import html
import json
import os
import socketserver
import sqlite3
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
VERSION = (BASE_DIR / "VERSION").read_text(encoding="utf-8").strip() if (BASE_DIR / "VERSION").exists() else "unknown"
BUGGY_SHIPS = (BASE_DIR / "BUGGY_SHIPS").read_text(encoding="utf-8").strip() == "1" if (BASE_DIR / "BUGGY_SHIPS").exists() else False


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
    line = f"{stamp} beacon-api[{os.getpid()}]: {message}\n"
    try:
        with open("/var/log/beacon/beacon.log", "a", encoding="utf-8") as f:
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

PORT = int(CONFIG.get("INTERNAL_PORT", "8000"))
DB_PATH = CONFIG.get("DB_PATH", "/var/lib/beacon/beacon.db")
DEBUG = CONFIG.get("BEACON_DEBUG", "false").lower() in {"1", "true", "yes", "on"}
BIND = CONFIG.get("BEACON_BIND", "127.0.0.1")
CALIBRATION_FILE = Path(CONFIG.get("CALIBRATION_FILE", "/var/lib/beacon/calibration/current.json"))
WORKER_HEARTBEAT = Path(CONFIG.get("WORKER_HEARTBEAT", "/var/lib/beacon/worker/heartbeat"))
EXPECTED_TIDE_MARKER = CONFIG.get("EXPECTED_TIDE_MARKER", "")


def load_calibration() -> dict[str, str]:
    try:
        return json.loads(CALIBRATION_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"error": str(exc)}


def current_health() -> dict[str, object]:
    calibration = load_calibration()
    expected_color = calibration.get("expected_color")
    actual_color = CONFIG.get("BEACON_COLOR")
    checks: dict[str, object] = {
        "version": VERSION,
        "color": actual_color,
        "expected_color": expected_color,
        "debug_enabled": DEBUG,
    }
    if actual_color != expected_color:
        return {"status": "degraded", "reason": "wrong BEACON_COLOR", "checks": checks}
    return {"status": "ok", "checks": checks}


def db_rows(query: str, args: tuple[object, ...] = ()) -> list[tuple]:
    with sqlite3.connect(DB_PATH) as conn:
        return list(conn.execute(query, args))


def worker_age() -> float | None:
    try:
        return time.time() - WORKER_HEARTBEAT.stat().st_mtime
    except FileNotFoundError:
        return None


class Handler(BaseHTTPRequestHandler):
    server_version = "BeaconHTTP/0.1"

    def _send_json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload, indent=2, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, status: int, body: str) -> None:
        raw = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _send_text(self, status: int, body: str) -> None:
        raw = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt: str, *args: object) -> None:
        log_line(f"{self.address_string()} {self.command} {self.path} - {fmt % args}")

    def do_GET(self) -> None:  # noqa: N802 - http.server naming convention
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/healthz":
            health = current_health()
            self._send_json(200 if health["status"] == "ok" else 503, health)
            return

        if path == "/readyz":
            health = current_health()
            age = worker_age()
            ready = health["status"] == "ok" and age is not None and age < 30
            self._send_json(200 if ready else 503, {"status": "ok" if ready else "degraded", "health": health, "worker_heartbeat_age_seconds": age})
            return

        if path == "/version":
            self._send_json(200, {"version": VERSION, "buggy_ships": BUGGY_SHIPS})
            return

        if path == "/api/ships":
            if BUGGY_SHIPS and query.get("class") == ["lantern"]:
                self._send_json(500, {"status": "error", "reason": "v2 regression: lantern-class ship lookup failed"})
                return
            rows = db_rows("select id, class, status from ships order by id")
            self._send_json(200, {"ships": [{"id": r[0], "class": r[1], "status": r[2]} for r in rows]})
            return

        if path == "/api/tides":
            rows = db_rows("select marker, height_cm, observed_at from tides order by observed_at")
            self._send_json(200, {"tides": [{"marker": r[0], "height_cm": r[1], "observed_at": r[2]} for r in rows]})
            return

        if path == "/debug":
            if not DEBUG:
                self._send_json(404, {"status": "not_found"})
                return
            self._send_json(200, {"debug": True, "env_path": ENV_PATH, "config_keys": sorted(CONFIG.keys()), "uid": os.geteuid()})
            return

        if path in {"/", "/dashboard"}:
            health = current_health()
            age = worker_age()
            tide_present = False
            migration = "missing"
            try:
                tide_present = bool(db_rows("select 1 from tides where marker = ?", (EXPECTED_TIDE_MARKER,)))
                rows = db_rows("select value from meta where key = 'schema_version'")
                migration = rows[0][0] if rows else "missing"
            except Exception as exc:
                migration = f"db-error: {exc}"
            body = f"""
            <!doctype html>
            <html><head><title>Beacon Dashboard</title></head>
            <body>
              <h1>Beacon Dashboard</h1>
              <p><strong>Version:</strong> {html.escape(VERSION)}</p>
              <p><strong>Health:</strong> {html.escape(str(health.get('status')))}</p>
              <p><strong>Worker heartbeat age:</strong> {html.escape(str(age))}</p>
              <p><strong>Expected tide restored:</strong> {html.escape(str(tide_present))}</p>
              <p><strong>Schema version:</strong> {html.escape(str(migration))}</p>
              <p><strong>Debug enabled:</strong> {html.escape(str(DEBUG))}</p>
            </body></html>
            """
            self._send_html(200, body)
            return

        self._send_json(404, {"status": "not_found", "path": self.path})


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    health = current_health()
    log_line(f"starting Beacon API version={VERSION} bind={BIND}:{PORT} health={health['status']} debug={DEBUG}")
    try:
        with ReusableTCPServer((BIND, PORT), Handler) as httpd:
            httpd.serve_forever()
    except OSError as exc:
        log_line(f"SocketError: cannot bind {BIND}:{PORT}: {exc}")
        raise
