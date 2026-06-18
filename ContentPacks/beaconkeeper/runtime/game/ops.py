#!/usr/bin/env python3
"""Beaconkeeper verifier and helper CLI.

This is intentionally a local-practice verifier. For high-stakes screening, put the
canonical verifier outside the container and keep the expected state hidden from the
candidate.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import pwd
import grp
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

INSTANCE_PATH = Path("/usr/local/lib/beaconkeeper/private/instance.json")
PROGRESS_PATH = Path("/var/lib/beaconkeeper/progress.json")
DEFAULT_HINTS_REMAINING = 10

STEPS = {
    1: "The Chart Room",
    2: "The Captain's Note",
    3: "The Flooded Hold",
    4: "The Locked Lens",
    5: "The Stowaway Process",
    6: "The Dead Lantern",
    7: "The Whispering Logbook",
    8: "The Sleeping Deckhand",
    9: "The Broken Signal Tower",
    10: "The False Beacon",
    11: "The Supply Crate",
    12: "The Bad Crate",
    13: "The Rollback Drill",
    14: "The Clean Redeploy",
    15: "The Tide Ledger",
    16: "The Clockwork Keeper",
    17: "The Overstuffed Logbook",
    18: "The New Operator",
    19: "The Barnacle Scrape",
    20: "The Dawn Handoff",
}

OBJECTIVES = {
    1: "Current release matches the local chart",
    2: "OPERATOR_FACTS lists each chart key name with verified values",
    3: "Disposable cache data is removed without data loss",
    4: "Service configuration has appropriate ownership and mode",
    5: "Unexpected port listener is removed cleanly",
    6: "API service is enabled and managed by systemd",
    7: "Internal health reports the calibrated state",
    8: "Worker service is enabled and heartbeating",
    9: "Public health traffic reaches the API through nginx",
    10: "Root page serves the real dashboard",
    11: "Trusted release is deployed with rollback preserved",
    12: "Untrusted release artifact is rejected",
    13: "Bad deployment is rolled back cleanly",
    14: "Fixed release is deployed and migrated",
    15: "Missing ledger row is restored without clobbering newer data",
    16: "Backups are scheduled and can run on demand",
    17: "Beacon logrotate policy targets the log dir and passes dry-run",
    18: "New operator has SSH, restrictive umask (0027 or 0077), and narrow sudo",
    19: "Production debug exposure is removed",
    20: "Runbook matches the final machine state",
}

HINTS: dict[int, list[str]] = {
    1: [
        "Start by mapping the application root and release layout.",
        "Compare the active release selector with the local chart.",
        "Repair the release selector; do not edit release contents to make this check pass.",
    ],
    2: [
        "The fact sheet should contain only values you can justify from local evidence.",
        "The local chart names the service, app root, ports, health URL, database, and backup location.",
        "Use plain KEY=value lines so another operator can source or grep the file.",
    ],
    3: [
        "Disk pressure is simulated; use size-oriented inspection before deleting anything.",
        "Runtime cache is a better cleanup target than uploads, logs, or database files.",
        "Remove only the disposable cache objects with the consistent generated naming pattern.",
    ],
    4: [
        "Identify the service account before changing configuration permissions.",
        "Inspect the config file's owner, group, and mode from an administrator shell.",
        "The service account needs read access without making the config world-readable or group-writable.",
    ],
    5: [
        "Use the internal port from your fact sheet to look for a competing listener.",
        "Prefer process and unit evidence over guessing from filenames.",
        "Remove the competing listener through normal service management rather than changing the app contract.",
    ],
    6: [
        "Use the API unit named in the local chart as the source of truth.",
        "The service should run as the service account and use the active release path.",
        "Enable and start the API only after the release selector, config access, and port conflict are addressed.",
    ],
    7: [
        "A running process is not the same thing as a healthy service.",
        "Check the internal health endpoint and the API journal for the reported degradation reason.",
        "Align runtime configuration with the local calibration source, then restart the API.",
    ],
    8: [
        "The dashboard depends on both the API and a worker.",
        "Check the worker unit, its journal, and the runtime directories it writes to.",
        "Fix the runtime directory ownership needed for the worker to create its heartbeat.",
    ],
    9: [
        "Separate internal application health from public routing health.",
        "Inspect nginx's active configuration and test the public health URL from the local chart.",
        "Make the generated public path proxy to the actual internal API port, then reload nginx.",
    ],
    10: [
        "A 200 response can still be stale content.",
        "Compare the root page with the dashboard served by the internal app.",
        "Route the root page to the application rather than the old static test page.",
    ],
    11: [
        "Supply artifacts live outside the application root; inspect them before deploying.",
        "Verify the checksum and archive layout before extracting a release.",
        "Deploy through the release directory and active-release selector, preserving the previous release for rollback.",
    ],
    12: [
        "Not every artifact in the supply area should be trusted.",
        "Treat checksum evidence and archive layout as deployment gates.",
        "Your job is to decide which artifact should be trusted and deployed.",
    ],
    13: [
        "Validate more than the generic health endpoint after a deployment.",
        "Rollback should use the release layout rather than rewriting release contents.",
        "Return the active-release selector to the prior known-good release and restart the API.",
    ],
    14: [
        "A fixed release artifact is available after the rollback drill.",
        "Inspect its notes before deploying; release-specific operational steps matter.",
        "Deploy the fixed release and apply its database migration.",
    ],
    15: [
        "Compare current ledger data with the compressed SQL backups.",
        "Repair only the missing record; avoid full-database restore that would lose newer rows.",
        "A targeted SQL insert from backup evidence is sufficient.",
    ],
    16: [
        "Backups should be both scheduled and testable on demand.",
        "Inspect the installed backup service and timer units before enabling them.",
        "Enable the timer and run the one-shot backup service once to prove the path works.",
    ],
    17: [
        "Log growth should be handled by policy, not one-time deletion.",
        "Create a logrotate policy that targets Beacon's log directory.",
        "Validate the rotation policy with a dry run.",
    ],
    18: [
        "Onboarding material for the new operator is in the supply area.",
        "The account needs SSH key access with standard SSH ownership and mode hygiene.",
        "Think beyond login: default file modes and sudo scope are both part of machine setup.",
    ],
    19: [
        "Look for development-only configuration that should not survive production handoff.",
        "The debug endpoint should not expose runtime details.",
        "Disable the debug setting, restart the API, and confirm endpoint behavior changed.",
    ],
    20: [
        "The final handoff is both machine state and documentation.",
        "Document actual generated names and paths, not generic placeholders.",
        "Before final verification, re-run the full checklist and make the runbook match what is currently true.",
    ],
}


def load_instance() -> dict[str, object]:
    return json.loads(INSTANCE_PATH.read_text(encoding="utf-8"))


def load_progress() -> dict[str, object]:
    if not PROGRESS_PATH.exists():
        return {"completed": [], "hints_used": {}, "hints_remaining": DEFAULT_HINTS_REMAINING}
    try:
        return json.loads(PROGRESS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"completed": [], "hints_used": {}, "hints_remaining": DEFAULT_HINTS_REMAINING}


def hints_remaining(progress: dict[str, object]) -> int:
    value = progress.get("hints_remaining", progress.get("oil", DEFAULT_HINTS_REMAINING))
    try:
        return int(value)
    except Exception:
        return DEFAULT_HINTS_REMAINING


def save_progress(progress: dict[str, object]) -> None:
    PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PROGRESS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(progress, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(PROGRESS_PATH)


def mark_complete(n: int) -> None:
    progress = load_progress()
    completed = set(int(x) for x in progress.get("completed", []))
    completed.add(n)
    progress["completed"] = sorted(completed)
    save_progress(progress)


def is_complete(n: int) -> bool:
    return n in {int(x) for x in load_progress().get("completed", [])}


def completed_count() -> int:
    return len({int(x) for x in load_progress().get("completed", [])})


# ----------------------------------------------------------------------------
# Atmosphere. Color and small animations for interactive keepers — a harbor that
# darkens at dusk and brightens toward dawn as lanterns are lit. EVERYTHING here
# is gated on an interactive TTY (and honors NO_COLOR / BEACON_NO_ANIM), so the
# grader — which runs `ops verify all --force; ops status` over a non-TTY SSH and
# parses the plain "[✓]/[ ] NN Name" lines — sees exactly the same text as before.
# ----------------------------------------------------------------------------

# sky stage by lanterns lit -> (256-color, phrase)
_SKY = [
    (17, "midnight"),       # 0-3
    (61, "the small hours"),# 4-7
    (97, "false dawn"),     # 8-11
    (174, "first light"),   # 12-15
    (215, "daybreak"),      # 16-19
    (220, "DAWN"),          # 20
]


def _color_enabled() -> bool:
    return sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def _anim_enabled() -> bool:
    return _color_enabled() and os.environ.get("BEACON_NO_ANIM") is None


def _fg(code: int, s: str) -> str:
    return f"\x1b[38;5;{code}m{s}\x1b[0m" if _color_enabled() else s


def _bold(s: str) -> str:
    return f"\x1b[1m{s}\x1b[0m" if _color_enabled() else s


def _dim(s: str) -> str:
    return f"\x1b[2m{s}\x1b[0m" if _color_enabled() else s


def _sky_for(count: int) -> tuple[int, str]:
    return _SKY[min(count // 4, 5)] if count < 20 else _SKY[5]


def _lantern_row(count: int, flicker: int | None = None) -> str:
    cells = []
    for i in range(1, 21):
        if flicker is not None and i == flicker:
            cells.append(_fg(229, "✦"))
        elif i <= count:
            cells.append(_fg(220, "●"))
        else:
            cells.append(_dim("·"))
    color, phrase = _sky_for(count)
    bar = "".join(cells)
    tail = _fg(color, f"{count} of 20 alight  ·  {phrase}")
    return f"  {_dim('⟨')} {bar} {_dim('⟩')}   {tail}"


def _write(s: str) -> None:
    sys.stdout.write(s)
    sys.stdout.flush()


def celebrate_lantern(n: int, count: int) -> None:
    """A brief flicker as one lantern catches, then the harbor row."""
    if not _anim_enabled():
        return
    name = STEPS.get(n, "")
    _write("\x1b[?25l")  # hide cursor
    try:
        for glyph, col in ((".", 240), ("✶", 215), ("✦", 229), ("✦", 220)):
            _write("\r   " + _fg(col, glyph) + "  lighting the lantern…   ")
            time.sleep(0.12)
        _write("\r\x1b[2K")  # clear the line
        print(f"   {_fg(220, '✦')}  {_bold('Lantern ' + f'{n:02d}')} lit — {name}")
        print(_lantern_row(count, flicker=n))
        print()
        # settle the flicker into a steady glow
        time.sleep(0.18)
        _write("\x1b[2A\r")
        print(_lantern_row(count))
        _write("\x1b[1B\r")
    finally:
        _write("\x1b[?25h")  # show cursor


# Spoken once when a freshly lit lantern tips the sky into a new phase (4/8/12/16).
_MILESTONES = {
    4: "The small hours. The worst of the dark is behind you.",
    8: "False dawn glimmers on the water.",
    12: "First light. The harbor takes shape.",
    16: "Daybreak. Four more before the sun.",
}


def milestone_beat(count: int) -> None:
    """A short phase line at the sky crossings — makes progress feel earned. TTY-only."""
    if not _anim_enabled() or count not in _MILESTONES:
        return
    col = _SKY[min(count // 4, 5)][0]
    print()
    print("   " + _bold(_fg(col, "▸ " + _MILESTONES[count])))
    print()
    time.sleep(0.4)


def dawn_break() -> None:
    """The payoff: lighting all twenty brings the sun up over the harbor."""
    if not _anim_enabled():
        return
    sea = _fg(24, "≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈")
    # sky brightens through the night colors as the sun clears the horizon
    stages = [17, 18, 60, 97, 132, 174, 209, 215, 220]
    suns = ["·", "▁▁▁", "▂▂▂▂▂", "(  )", "( ☼ )", "( ☼ )"]
    _write("\x1b[?25l\x1b[2J\x1b[H")
    try:
        for i, col in enumerate(stages):
            sun = suns[min(i, len(suns) - 1)]
            sky = _fg(col, "—" * 30)
            _write("\x1b[H")
            print("\n\n")
            print("        " + sky)
            print("        " + _fg(228, sun).center(30 + len("\x1b[38;5;228m\x1b[0m")))
            print("        " + sea)
            time.sleep(0.22)
        # the whole harbor, alight
        print()
        print(_lantern_row(20))
        print()
        print("   " + _bold(_fg(220, "☀  Dawn breaks over the harbor.")))
        print("   " + _fg(215, "All twenty lanterns burned till first light. The beacon held."))
        print("   " + _dim("Well kept, Keeper.  Leave your handoff in /srv/beacon/RUNBOOK.md."))
        print()
    finally:
        _write("\x1b[?25h")


def beacon_sweep() -> None:
    """Easter egg: the lighthouse sweeps its beam. `ops beacon`."""
    spokes = ["—", "\\", "|", "/"]
    tower = [
        "        ( )        ",
        "       =[_]=       ",
        "        |#|        ",
        "        |#|        ",
        "       /###\\       ",
    ]
    if not _anim_enabled():
        for row in tower:
            print(row)
        return
    _write("\x1b[?25l")
    try:
        for k in range(12):
            beam = spokes[k % 4]
            _write("\x1b[2J\x1b[H\n")
            print("   " + _fg(24, "the keeper trims the great lamp…\n"))
            for j, row in enumerate(tower):
                if j == 1:
                    print("   " + _fg(220, beam) + " " + _fg(228, row) + " " + _fg(220, beam))
                else:
                    print("   " + _fg(250, row))
            print("\n   " + _fg(24, "≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈"))
            time.sleep(0.12)
    finally:
        _write("\x1b[?25h")


def ignite_welcome() -> None:
    """Cold open: the dark lamp sputters, catches, and flares to life — the keeper's
    watch beginning. TTY-only and time-boxed; the grader (non-TTY) never runs this."""
    if not _anim_enabled():
        return
    _write("\x1b[?25l")  # hide cursor
    try:
        for glyph, col, label in (
            ("·", 238, "a dark coast"),
            ("·", 240, "the lamp is cold"),
            ("✦", 215, "a spark catches"),
            ("✶", 220, "the wick takes"),
            ("☀", 228, "the beacon flares"),
        ):
            _write("\r\x1b[2K   " + _fg(col, glyph) + "  " + _dim(label) + " …   ")
            time.sleep(0.22)
        _write("\r\x1b[2K")
        print(
            "   "
            + _bold(_fg(228, "☀"))
            + "  "
            + _bold(_fg(220, "The beacon catches."))
            + _fg(215, "  Your watch begins.")
        )
        time.sleep(0.45)
        print()
    finally:
        _write("\x1b[?25h")  # show cursor


def sail_across() -> None:
    """Easter egg: a little sloop runs across the dark harbor. `ops sail`.
    TTY-only; prints a static boat when there's no terminal."""
    boat = [
        r"      |\    ",
        r"      | \   ",
        r"      |  \  ",
        r"  ____|___\ ",
        r"  \________/",
    ]
    if not _anim_enabled():
        for row in boat:
            print(row)
        return
    span = 46
    _write("\x1b[?25l")
    try:
        for pos in range(0, span, 2):
            _write("\x1b[2J\x1b[H\n")
            print("   " + _fg(24, "a sloop runs the harbor mouth …") + "\n")
            pad = " " * pos
            for row in boat:
                print(pad + _fg(228, row))
            print("   " + _fg(24, "≈" * span))
            time.sleep(0.09)
        print("   " + _dim("gone into the dark. keep the lamp lit."))
    finally:
        _write("\x1b[?25h")


def run(cmd: list[str], timeout: int = 8) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, timeout=timeout)


def sudo(cmd: list[str], timeout: int = 8) -> subprocess.CompletedProcess[str]:
    return run(["sudo", "-n", *cmd], timeout=timeout)


def http_get(url: str, timeout: int = 4) -> tuple[int, str]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # nosec - local exercise URL
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except Exception as exc:
        return 0, str(exc)


def http_get_eventually(
    url: str,
    accept: Callable[[int, str], bool],
    attempts: int = 6,
    delay: float = 0.5,
) -> tuple[int, str]:
    last = (0, "")
    for attempt in range(attempts):
        last = http_get(url)
        if accept(*last):
            return last
        if attempt + 1 < attempts:
            time.sleep(delay)
    return last


def body_reports_ok(status: int, body: str) -> bool:
    return status == 200 and ('"status": "ok"' in body or '"status":"ok"' in body)


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def path_owner_group(path: Path) -> tuple[str, str, int]:
    st = path.stat()
    return pwd.getpwuid(st.st_uid).pw_name, grp.getgrgid(st.st_gid).gr_name, stat.S_IMODE(st.st_mode)


def check_symlink(inst: dict[str, object]) -> tuple[bool, str]:
    target = Path(str(inst["v1_release_path"]))
    current = Path("/srv/beacon/current")
    if not current.is_symlink():
        return False, "/srv/beacon/current is not a symlink."
    actual = current.resolve(strict=False)
    if actual != target:
        return False, "current does not point at the intended release from the local manifest."
    if not (target / "app.py").exists():
        return False, "The target release does not contain app.py."
    return True, "current points at the intended v1 release."


def check_facts(inst: dict[str, object]) -> tuple[bool, str]:
    path = Path("/srv/beacon/OPERATOR_FACTS")
    if not path.exists():
        return False, "Missing /srv/beacon/OPERATOR_FACTS."
    values = parse_env(path)
    expected = {
        "SERVICE_NAME": str(inst["service_name"]),
        "APP_ROOT": "/srv/beacon",
        "INTERNAL_PORT": str(inst["internal_port"]),
        "PUBLIC_HEALTH_URL": str(inst["public_health_url"]),
        "DB_PATH": str(inst["db_path"]),
        "BACKUP_DIR": str(inst["backup_dir"]),
    }
    missing = [k for k in expected if values.get(k) != expected[k]]
    if missing:
        return False, "Incorrect or missing facts: " + ", ".join(missing)
    return True, "Operator facts match this instance."


def check_cache_cleanup(inst: dict[str, object]) -> tuple[bool, str]:
    cache = Path("/var/lib/beacon/cache")
    upload_marker = Path(str(inst["upload_marker"]))
    if not cache.is_dir():
        return False, "Cache directory itself is missing."
    ballast = list(cache.glob("ballast-*"))
    if ballast:
        return False, f"Found {len(ballast)} ballast cache files still present."
    if not upload_marker.exists():
        return False, "Upload marker was deleted; cleanup was too broad."
    if not Path("/var/log/beacon").is_dir():
        return False, "Log directory is missing."
    return True, "Ballast cache removed without deleting protected data."


def check_env_permissions(inst: dict[str, object]) -> tuple[bool, str]:
    path = Path("/etc/beacon/beacon.env")
    if not path.exists():
        return False, "Missing /etc/beacon/beacon.env."
    owner, group, mode = path_owner_group(path)
    if group != "beacon":
        return False, "The env file is not readable through the expected service group."
    if mode & 0o007:
        return False, f"File is accessible by others: mode {mode:04o}."
    if mode & 0o020:
        return False, f"File is group-writable: mode {mode:04o}."
    if not (mode & 0o040):
        return False, f"Group beacon cannot read the file: mode {mode:04o}."
    cp = sudo(["-u", "beacon", "test", "-r", str(path)])
    if cp.returncode != 0:
        return False, "The beacon service user still cannot read the env file."
    return True, f"Env file permissions are acceptable: {owner}:{group} {mode:04o}."


def check_squatter(inst: dict[str, object]) -> tuple[bool, str]:
    service = str(inst["squatter_service"])
    active = run(["systemctl", "is-active", service])
    enabled = run(["systemctl", "is-enabled", service])
    if active.returncode == 0:
        return False, f"{service} is still active."
    if enabled.returncode == 0:
        return False, f"{service} is still enabled."
    return True, "The port squatter service is stopped and disabled."


def service_main_user(service: str) -> str | None:
    cp = run(["systemctl", "show", service, "-p", "MainPID", "--value"])
    if cp.returncode != 0:
        return None
    pid = cp.stdout.strip()
    if not pid or pid == "0":
        return None
    ps = run(["ps", "-o", "user=", "-p", pid])
    if ps.returncode != 0:
        return None
    return ps.stdout.strip()


def check_api_service(inst: dict[str, object]) -> tuple[bool, str]:
    service = str(inst["service_name"])
    if run(["systemctl", "is-enabled", service]).returncode != 0:
        return False, f"{service} is not enabled."
    if run(["systemctl", "is-active", service]).returncode != 0:
        return False, f"{service} is not active. Check journalctl -u {service}."
    user = service_main_user(service)
    if user != "beacon":
        return False, f"{service} should run as beacon, not {user}."
    unit = run(["systemctl", "cat", service]).stdout
    if "/srv/beacon/current" not in unit:
        return False, "Service should run via /srv/beacon/current, not a hardcoded release path."
    return True, "API service is active, enabled, and running as beacon."


def check_internal_health(inst: dict[str, object]) -> tuple[bool, str]:
    url = f"http://127.0.0.1:{inst['internal_port']}/healthz"
    status, body = http_get_eventually(url, lambda s, _b: s == 200)
    if status != 200:
        return False, f"Internal health is not OK: HTTP {status}: {body[:160]}"
    try:
        payload = json.loads(body)
    except Exception:
        return False, "Internal health did not return JSON."
    if payload.get("status") != "ok":
        return False, f"Internal health status is {payload.get('status')}."
    env = parse_env(Path("/etc/beacon/beacon.env"))
    if env.get("BEACON_COLOR") != inst["calibration_color"]:
        return False, "BEACON_COLOR does not match calibration."
    return True, "Internal /healthz is green."


def check_worker(inst: dict[str, object]) -> tuple[bool, str]:
    service = str(inst["worker_service"])
    if run(["systemctl", "is-enabled", service]).returncode != 0:
        return False, f"{service} is not enabled."
    if run(["systemctl", "is-active", service]).returncode != 0:
        return False, f"{service} is not active. Check journalctl -u {service}."
    user = service_main_user(service)
    if user != "beacon":
        return False, f"{service} should run as beacon, not {user}."
    heartbeat = Path(str(inst["worker_heartbeat"]))
    if not heartbeat.exists():
        return False, "Worker heartbeat file is missing."
    age = time.time() - heartbeat.stat().st_mtime
    if age > 30:
        return False, f"Worker heartbeat is stale: {age:.1f}s old."
    return True, "Worker is active and heartbeating."


def check_nginx_public_health(inst: dict[str, object]) -> tuple[bool, str]:
    if run(["systemctl", "is-active", "nginx"]).returncode != 0:
        return False, "nginx is not active."
    test = sudo(["nginx", "-t"])
    if test.returncode != 0:
        return False, "nginx -t failed: " + (test.stderr or test.stdout)[-300:]
    status, body = http_get_eventually(str(inst["public_health_url"]), body_reports_ok)
    if status != 200:
        return False, f"Public health URL failed: HTTP {status}: {body[:160]}"
    if '"status": "ok"' not in body and '"status":"ok"' not in body:
        return False, "Public health URL did not report status ok."
    ss = run(["ss", "-ltnp"]).stdout
    if f"0.0.0.0:{inst['internal_port']}" in ss or f"*:{inst['internal_port']}" in ss:
        return False, "The app appears to be exposed directly instead of bound to localhost."
    return True, "nginx proxies the public health endpoint correctly."


def check_false_beacon_removed(inst: dict[str, object]) -> tuple[bool, str]:
    status, body = http_get_eventually(
        "http://127.0.0.1/",
        lambda s, b: s == 200 and "False Beacon" not in b and "Beacon Dashboard" in b,
    )
    if status != 200:
        return False, f"Root page failed: HTTP {status}."
    if "beacon is dark" in body.lower() or "False Beacon" in body or "Beacon OK" in body:
        return False, "Root page still serves the maintenance placeholder, not the dashboard."
    if "Beacon Dashboard" not in body:
        return False, "Root page is not the real Beacon dashboard."
    return True, "Root route serves the real dashboard."


def current_release() -> Path | None:
    current = Path("/srv/beacon/current")
    if not current.is_symlink():
        return None
    return current.resolve(strict=False)


def check_v2_deployed(inst: dict[str, object]) -> tuple[bool, str]:
    expected = Path(str(inst["v2_release_path"]))
    cur = current_release()
    if cur != expected:
        return False, "current does not point at the trusted v2 release."
    if not (expected / "VERSION").exists():
        return False, "v2 release directory is missing VERSION."
    if (Path(str(inst["v1_release_path"])) / "VERSION").exists() is False:
        return False, "Old v1 release disappeared; rollback would not be possible."
    status, body = http_get_eventually(
        f"http://127.0.0.1:{inst['internal_port']}/version",
        lambda s, b: s == 200 and str(inst["v2_version"]) in b,
    )
    if status != 200 or str(inst["v2_version"]) not in body:
        return False, f"/version does not report {inst['v2_version']}."
    h_status, _ = http_get_eventually(
        f"http://127.0.0.1:{inst['internal_port']}/healthz",
        lambda s, _b: s == 200,
    )
    if h_status != 200:
        return False, "v2 is deployed but health is not green."
    return True, "v2 supply crate deployed with rollback still available."


def check_bad_crate_rejected(inst: dict[str, object]) -> tuple[bool, str]:
    shiny_path = Path(str(inst["shiny_release_path"]))
    if shiny_path.exists():
        return False, f"The bad shiny crate appears to have been unpacked into {shiny_path}."
    cur = current_release()
    if cur and "shiny" in str(cur):
        return False, "current points at the bad shiny release."
    # Checksum should still fail; if the user edited it to pass, call that out.
    cp = run(["bash", "-lc", f"cd /opt/supply && sha256sum -c {inst['shiny_checksum_name']}"], timeout=8)
    if cp.returncode == 0:
        return False, "The bad crate trust evidence has been altered."
    return True, "Bad shiny crate was rejected."


def check_rollback(inst: dict[str, object]) -> tuple[bool, str]:
    expected = Path(str(inst["v1_release_path"]))
    cur = current_release()
    if cur != expected:
        return False, "current does not point back to the prior known-good release."
    status, body = http_get_eventually(
        f"http://127.0.0.1:{inst['internal_port']}/api/ships?class=lantern",
        lambda s, _b: s == 200,
    )
    if status != 200:
        return False, f"Rollback did not clear the synthetic ships regression: HTTP {status}: {body[:160]}"
    if not Path(str(inst["v2_release_path"])).exists():
        if not is_complete(11):
            return False, "Rollback evidence is not available yet."
        return False, "v2 release was deleted instead of preserved for inspection."
    return True, "Rollback to v1 succeeded and v2 remains available for inspection."


def check_v21_deployed(inst: dict[str, object]) -> tuple[bool, str]:
    expected = Path(str(inst["v21_release_path"]))
    cur = current_release()
    if cur != expected:
        return False, "current does not point at the fixed v2.1 release."
    status, body = http_get_eventually(
        f"http://127.0.0.1:{inst['internal_port']}/version",
        lambda s, b: s == 200 and str(inst["v21_version"]) in b,
    )
    if status != 200 or str(inst["v21_version"]) not in body:
        return False, f"/version does not report {inst['v21_version']}."
    with sqlite3.connect(str(inst["db_path"])) as conn:
        row = conn.execute("select value from meta where key = 'schema_version'").fetchone()
    if not row or row[0] != inst["schema_version"]:
        return False, "Migration marker is missing or incorrect."
    status, body = http_get_eventually(
        f"http://127.0.0.1:{inst['internal_port']}/api/ships?class=lantern",
        lambda s, _b: s == 200,
    )
    if status != 200:
        return False, f"Fixed v2.1 should clear ships regression: HTTP {status}: {body[:160]}"
    return True, "Fixed v2.1 deployed and migrated."


def check_tide_row(inst: dict[str, object]) -> tuple[bool, str]:
    marker = str(inst["tide_marker"])
    with sqlite3.connect(str(inst["db_path"])) as conn:
        row = conn.execute("select height_cm, observed_at from tides where marker = ?", (marker,)).fetchone()
        recent = conn.execute("select 1 from tides where marker = ?", (inst["recent_tide_marker"],)).fetchone()
    if not row:
        return False, "The required missing tide record has not been restored."
    if not recent:
        return False, "A newer tide row disappeared during the repair."
    owner, group, mode = path_owner_group(Path(str(inst["db_path"])))
    if mode & 0o002:
        return False, f"DB is world-writable: mode {mode:04o}."
    return True, f"Tide marker {marker} restored without losing newer data."


def check_backup_timer(inst: dict[str, object]) -> tuple[bool, str]:
    timer = str(inst["backup_timer"])
    service = str(inst["backup_service"])
    if run(["systemctl", "is-enabled", timer]).returncode != 0:
        return False, f"{timer} is not enabled."
    if run(["systemctl", "is-active", timer]).returncode != 0:
        return False, f"{timer} is not active."
    cp = sudo(["systemctl", "start", service], timeout=12)
    if cp.returncode != 0:
        return False, f"{service} could not run: {(cp.stderr or cp.stdout)[-300:]}"
    backups = sorted(Path(str(inst["backup_dir"])).glob("beacon-*.sql.gz"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not backups:
        return False, "No backup files found."
    newest = backups[0]
    if time.time() - newest.stat().st_mtime > 180:
        return False, f"Newest backup is stale: {newest}. Run the backup service once."
    try:
        with gzip.open(newest, "rt", encoding="utf-8") as f:
            content = f.read(512)
    except Exception as exc:
        return False, f"Newest backup is not readable gzip SQL: {exc}"
    if "CREATE TABLE" not in content and "BEGIN TRANSACTION" not in content:
        return False, "Newest backup does not look like a SQLite dump."
    return True, "Backup timer enabled and a fresh backup is restorable-looking."


def check_logrotate(inst: dict[str, object]) -> tuple[bool, str]:
    cfg = Path("/etc/logrotate.d/beacon")
    if not cfg.exists():
        return False, "Missing /etc/logrotate.d/beacon."
    text = cfg.read_text(encoding="utf-8", errors="replace")
    if "/var/log/beacon" not in text:
        return False, "Logrotate config does not target /var/log/beacon."
    cp = sudo(["logrotate", "-d", str(cfg)], timeout=10)
    if cp.returncode != 0:
        return False, "logrotate dry run failed: " + (cp.stderr or cp.stdout)[-300:]
    return True, "Beacon logrotate config exists and validates."


def check_deployer(inst: dict[str, object]) -> tuple[bool, str]:
    user = str(inst["deployer_user"])
    try:
        pw = pwd.getpwnam(user)
    except KeyError:
        return False, f"User {user} does not exist."
    home = Path(pw.pw_dir)
    ak = home / ".ssh" / "authorized_keys"
    if not ak.exists():
        return False, f"Missing {ak}."
    if str(inst["deployer_public_key"]).strip() not in ak.read_text(encoding="utf-8", errors="replace"):
        return False, "authorized_keys does not contain the supplied new operator public key."
    ssh_dir_mode = stat.S_IMODE((home / ".ssh").stat().st_mode)
    ak_mode = stat.S_IMODE(ak.stat().st_mode)
    if ssh_dir_mode & 0o077:
        return False, f".ssh permissions too broad: {ssh_dir_mode:04o}."
    if ak_mode & 0o177:
        return False, f"authorized_keys permissions too broad: {ak_mode:04o}."
    listing = sudo(["-l", "-U", user], timeout=8)
    if listing.returncode != 0:
        return False, f"Cannot list sudo privileges for {user}: {(listing.stderr or listing.stdout)[-240:]}"
    out = listing.stdout + listing.stderr
    if "NOPASSWD: ALL" in out or re.search(r"\(ALL(?::ALL)?\)\s+NOPASSWD:\s+ALL", out):
        return False, "Sudoers grants passwordless full root; scope it to the Beacon service only."
    sysctl_path = shutil.which("systemctl") or "/usr/bin/systemctl"
    ok = sudo(["-u", user, "sudo", "-n", sysctl_path, "status", str(inst["service_name"])], timeout=8)
    if ok.returncode not in (0, 3):  # status returns 3 for inactive; active should be 0
        return False, f"{user} cannot run limited systemctl status for the API service."
    bad = sudo(["-u", user, "sudo", "-n", "/usr/bin/id"], timeout=8)
    if bad.returncode == 0:
        return False, f"{user} can run arbitrary sudo commands."
    umask_cp = sudo(["-u", user, "bash", "-lc", "umask"], timeout=8)
    if umask_cp.returncode != 0:
        return False, f"Cannot inspect default file mode for {user}."
    umask_value = umask_cp.stdout.strip()
    if umask_value not in {"0027", "0077"}:
        return False, f"{user} default file creation is too permissive: umask {umask_value}."
    return True, "New operator access is least-privilege enough for this exercise."


def check_debug_disabled(inst: dict[str, object]) -> tuple[bool, str]:
    env = parse_env(Path("/etc/beacon/beacon.env"))
    if env.get("BEACON_DEBUG", "false").lower() in {"1", "true", "yes", "on"}:
        return False, "BEACON_DEBUG is still enabled in /etc/beacon/beacon.env."
    for url in [f"http://127.0.0.1:{inst['internal_port']}/debug", "http://127.0.0.1/debug"]:
        status, body = http_get_eventually(url, lambda s, b: not (s == 200 and "debug" in b.lower()))
        if status == 200 and "debug" in body.lower():
            return False, f"Debug endpoint is still exposed at {url}. Restart the API after changing config."
    return True, "Debug barnacle removed."


def check_runbook(inst: dict[str, object]) -> tuple[bool, str]:
    missing_progress = [str(n) for n in range(1, 20) if not is_complete(n)]
    if missing_progress:
        return False, "Complete and verify earlier lanterns first: " + ", ".join(missing_progress)
    rb = Path("/srv/beacon/RUNBOOK.md")
    if not rb.exists():
        return False, "Missing /srv/beacon/RUNBOOK.md."
    text = rb.read_text(encoding="utf-8", errors="replace")
    required_literals = [
        str(inst["service_name"]),
        str(inst["worker_service"]),
        "/srv/beacon/current",
        str(inst["public_health_url"]),
        str(inst["db_path"]),
        str(inst["backup_dir"]),
    ]
    missing = [x for x in required_literals if x not in text]
    required_words = ["deploy", "rollback", "journalctl", "health", "backup", "nginx"]
    missing += [w for w in required_words if w.lower() not in text.lower()]
    if missing:
        return False, "Runbook is missing: " + ", ".join(missing)
    # Recheck final operational state.
    for fn in [check_api_service, check_internal_health, check_worker, check_nginx_public_health, check_false_beacon_removed, check_v21_deployed, check_tide_row, check_backup_timer, check_logrotate, check_deployer, check_debug_disabled]:
        ok, msg = fn(inst)
        if not ok:
            return False, f"Final inspection failed: {msg}"
    return True, "Runbook and final production-readiness inspection passed."


CHECKS: dict[int, Callable[[dict[str, object]], tuple[bool, str]]] = {
    1: check_symlink,
    2: check_facts,
    3: check_cache_cleanup,
    4: check_env_permissions,
    5: check_squatter,
    6: check_api_service,
    7: check_internal_health,
    8: check_worker,
    9: check_nginx_public_health,
    10: check_false_beacon_removed,
    11: check_v2_deployed,
    12: check_bad_crate_rejected,
    13: check_rollback,
    14: check_v21_deployed,
    15: check_tide_row,
    16: check_backup_timer,
    17: check_logrotate,
    18: check_deployer,
    19: check_debug_disabled,
    20: check_runbook,
}


def cmd_status(args: argparse.Namespace) -> int:
    progress = load_progress()
    completed = {int(x) for x in progress.get("completed", [])}
    count = len(completed)
    remaining_hints = hints_remaining(progress)
    title = "Beaconkeeper Readiness Checklist"
    print("\n" + (_bold(_fg(220, title)) if _color_enabled() else title) + "\n")
    for n, name in STEPS.items():
        done = n in completed
        objective = OBJECTIVES.get(n)
        suffix = f" - {objective}" if objective else ""
        # NOTE: the plain branch must stay byte-identical — the grader parses these
        # "[✓]/[ ] NN Name" lines over a non-TTY (no-color) SSH.
        if _color_enabled():
            if done:
                print(_fg(220, "[✓]") + f" {n:02d} " + name + _dim(suffix))
            else:
                print(_dim(f"[ ] {n:02d} {name}{suffix}"))
        else:
            mark = "✓" if done else " "
            print(f"[{mark}] {n:02d} {name}{suffix}")
    print()
    print(_lantern_row(count))
    print(f"\nChecks complete: {count}/20")
    print(f"Hints remaining: {remaining_hints}/{DEFAULT_HINTS_REMAINING}")
    print("\nCommands: ops brief | ops verify <n|all> | ops hint <n> | ops debrief")
    return 0


def cmd_brief(args: argparse.Namespace) -> int:
    print("""
Beaconkeeper operator brief

You are on a Linux host running a small internal service called Beacon. The
service is degraded after maintenance, and users report that the dashboard is
wrong or unavailable.

Restore the host to a healthy, supportable state using normal shell and Linux
administration tools. Work from local evidence, preserve useful data, and leave
the machine ready for another operator.

Start with ops status for the readiness checklist. Use ops verify <n> when you
have evidence that one item is repaired. Use ops hint <n> only when you need a
progressive nudge.

Commands:
  ops status
  ops verify <n|all>
  ops hint <n>
  ops debrief
""")
    return 0


def cmd_hint(args: argparse.Namespace) -> int:
    n = int(args.step)
    if n not in HINTS:
        print(f"No such step: {n}", file=sys.stderr)
        return 2
    progress = load_progress()
    hints_used = {str(k): int(v) for k, v in dict(progress.get("hints_used", {})).items()}
    used = hints_used.get(str(n), 0)
    idx = min(used, len(HINTS[n]) - 1)
    print(f"\nHint {idx + 1} for {n:02d} {STEPS[n]}:\n")
    print(HINTS[n][idx])
    if used < len(HINTS[n]):
        hints_used[str(n)] = used + 1
        progress["hints_used"] = hints_used
        remaining_hints = hints_remaining(progress)
        progress.pop("oil", None)
        progress["hints_remaining"] = max(0, remaining_hints - 1)
        save_progress(progress)
    return 0


# After the API service comes back (the relay the browser web shell rides), nudge the
# keeper — once, interactively — to prove they can operate the host both ways.
CHANNEL_STEP = 6


def channel_interlude() -> None:
    if not sys.stdout.isatty():
        return
    print()
    print("   " + _bold(_fg(220, "⚓ Keeper's log — the relay holds two lines")))
    print("   You can work this host two ways, and a good keeper keeps both open:")
    print("     " + _fg(215, "• web shell") + "  — the console in your browser tab")
    print("     " + _fg(215, "• ssh") + "        — your own terminal (the Console's SSH tab has the command)")
    print("   Switch now as a drill: if you're in the browser, reconnect over SSH; if you")
    print("   SSH'd in, hop to the browser shell. You land right back here — your progress")
    print("   lives on the host, not the connection.")
    print()


def verify_one(
    n: int, inst: dict[str, object], force: bool = False, flicker: bool = False
) -> bool:
    if n not in CHECKS:
        print(f"No such step: {n}", file=sys.stderr)
        return False
    if is_complete(n) and not force:
        objective = OBJECTIVES.get(n, "already complete")
        print(f"[✓] {n:02d} {STEPS[n]}: already complete - {objective}.")
        return True
    newly = not is_complete(n)
    ok, msg = CHECKS[n](inst)
    if ok:
        mark_complete(n)
        print(f"[✓] {n:02d} {STEPS[n]}: {msg}")
        if newly:
            count = completed_count()
            if flicker:
                celebrate_lantern(n, count)
                milestone_beat(count)
            if n == CHANNEL_STEP:
                channel_interlude()
            if count >= 20:
                dawn_break()
        return True
    print(f"[ ] {n:02d} {STEPS[n]}: {msg}")
    return False


def cmd_verify(args: argparse.Namespace) -> int:
    inst = load_instance()
    if args.step == "all":
        all_ok = True
        for n in range(1, 21):
            # Preserve transient lanterns that were already honestly verified.
            # (force stays off here so the grader's machine read is stable; the
            # dawn finale still fires from verify_one when the 20th lantern lights.)
            ok = verify_one(n, inst, force=False, flicker=False)
            all_ok = all_ok and ok
            if not ok:
                print("\nStopped at the first incomplete lantern. Verify later items individually when you have evidence for them.")
                return 1
        return 0 if all_ok else 1
    n = int(args.step)
    return 0 if verify_one(n, inst, force=args.force, flicker=True) else 1


def cmd_debrief(args: argparse.Namespace) -> int:
    inst = load_instance()
    completed = {int(x) for x in load_progress().get("completed", [])}
    print("\nBeaconkeeper Debrief\n")
    print(f"Checks complete: {len(completed)}/20")
    print(f"API service:  {inst['service_name']}")
    print(f"Worker:       {inst['worker_service']}")
    print(f"Public URL:   {inst['public_health_url']}")
    print("\nExplain these before claiming victory:")
    questions = [
        "What was the first reason the API could not start?",
        "What owned the internal port before the Beacon service could bind it?",
        "Why was the shiny crate rejected?",
        "How did rollback work, and why did it preserve evidence?",
        "What can the new operator do with sudo, and what can they not do?",
        "Where would you look first if the public endpoint returned HTTP 200 but the system was still unhealthy?",
    ]
    for i, q in enumerate(questions, 1):
        print(f"  {i}. {q}")
    print("")
    return 0


def cmd_welcome(args: argparse.Namespace) -> int:
    ignite_welcome()
    try:
        tag = str(load_instance().get("tag", ""))
    except Exception:
        tag = ""
    count = completed_count()
    print()
    print("   " + _fg(220, "\\") + _fg(250, "  ( )  ") + _fg(220, "/"))
    print("   " + _fg(250, " =[_]= ") + "     " + _bold(_fg(220, "BEACONKEEPER")))
    print("   " + _fg(250, "  |#|  ") + "     " + _fg(215, "Twenty Lanterns to Dawn"))
    print("   " + _fg(250, "  |#|  "))
    print("   " + _fg(250, " /###\\ "))
    print("   " + _fg(24, "≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈"))
    print()
    print("   " + _lantern_row(count).lstrip())
    if tag:
        print("   " + _dim(f"harbor {tag}"))
    print()
    print("   The Beacon dashboard went dark after routine maintenance.")
    print("   " + _fg(215, "Light all twenty lanterns and keep the beacon burning until dawn."))
    print()
    print("   → orient with " + _bold("ops status") + _dim("   (ops brief = full brief · ops hint <n> = a nudge)"))
    print()
    return 0


def cmd_beacon(args: argparse.Namespace) -> int:
    beacon_sweep()
    return 0


def cmd_sail(args: argparse.Namespace) -> int:
    sail_across()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ops", description="Beaconkeeper operations lab CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("brief").set_defaults(func=cmd_brief)
    sub.add_parser("welcome").set_defaults(func=cmd_welcome)
    sub.add_parser("beacon").set_defaults(func=cmd_beacon)
    sub.add_parser("sail").set_defaults(func=cmd_sail)
    hint = sub.add_parser("hint")
    hint.add_argument("step")
    hint.set_defaults(func=cmd_hint)
    verify = sub.add_parser("verify")
    verify.add_argument("step", help="step number or 'all'")
    verify.add_argument("--force", action="store_true", help="re-run even if already completed")
    verify.set_defaults(func=cmd_verify)
    sub.add_parser("debrief").set_defaults(func=cmd_debrief)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
