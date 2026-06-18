#!/usr/bin/env python3
"""Build-time setup for the Beaconkeeper Ubuntu container."""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import struct
import os
import py_compile
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path("/opt/beaconkeeper/game")
PRIVATE_DIR = Path("/usr/local/lib/beaconkeeper/private")
INSTANCE_PATH = PRIVATE_DIR / "instance.json"
OPS_PYC_PATH = PRIVATE_DIR / "ops.pyc"
OPS_RUNNER_PATH = Path("/usr/local/sbin/beaconkeeper-ops-runner")
KEEPER_KEY_PATH = PRIVATE_DIR / "keeper_ed25519"


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, text=True, check=check)


def write(path: Path, content: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    path.chmod(mode)


def copy(src: Path, dst: Path, mode: int | None = None) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    if mode is not None:
        dst.chmod(mode)


def chown(path: Path, owner: str, group: str, recursive: bool = False) -> None:
    if recursive:
        run(["chown", "-R", f"{owner}:{group}", str(path)])
    else:
        run(["chown", f"{owner}:{group}", str(path)])


def enable_unit(unit: str) -> None:
    wants = Path("/etc/systemd/system/multi-user.target.wants")
    wants.mkdir(parents=True, exist_ok=True)
    candidates = [
        Path("/etc/systemd/system") / unit,
        Path("/lib/systemd/system") / unit,
        Path("/usr/lib/systemd/system") / unit,
    ]
    src = next((c for c in candidates if c.exists()), None)
    if src is None:
        print(f"warning: cannot enable {unit}; unit file not found")
        return
    link = wants / unit
    if link.exists() or link.is_symlink():
        link.unlink()
    link.symlink_to(src)


def normalize_seed(raw: str) -> tuple[str, str, str]:
    seed = raw.strip() or "demo"
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    tag = digest[:4]
    return seed, tag, digest


def make_instance() -> dict[str, object]:
    seed, tag, digest = normalize_seed(os.environ.get("BEACON_SEED", "demo"))
    port = 41000 + (int(digest[4:8], 16) % 20000)
    wrong_port = port + 17 if port < 60900 else port - 17
    color_num = 10 + (int(digest[8:12], 16) % 89)
    tide_num = 1000 + (int(digest[12:16], 16) % 8000)
    public_path = f"/beacon-{tag}"
    v1_name = f"2026-06-12-{tag}-v1"
    v2_name = f"2026-06-12-{tag}-v2"
    v21_name = f"2026-06-12-{tag}-v2.1"
    shiny_name = f"2026-06-12-{tag}-shiny"
    inst = {
        "seed": seed,
        "tag": tag,
        "internal_port": port,
        "wrong_nginx_port": wrong_port,
        "public_path": public_path,
        "public_health_url": f"http://127.0.0.1{public_path}/healthz",
        "service_name": f"beacon-api-{tag}.service",
        "worker_service": f"beacon-worker-{tag}.service",
        "squatter_service": f"dock-squatter-{tag}.service",
        "backup_service": f"beacon-backup-{tag}.service",
        "backup_timer": f"beacon-backup-{tag}.timer",
        "v1_release": v1_name,
        "v2_release": v2_name,
        "v21_release": v21_name,
        "shiny_release": shiny_name,
        "v1_release_path": f"/srv/beacon/releases/{v1_name}",
        "v2_release_path": f"/srv/beacon/releases/{v2_name}",
        "v21_release_path": f"/srv/beacon/releases/{v21_name}",
        "shiny_release_path": f"/srv/beacon/releases/{shiny_name}",
        "v1_version": f"v1.0-{tag}",
        "v2_version": f"v2.0-{tag}",
        "v21_version": f"v2.1-{tag}",
        "schema_version": f"2.1-{tag}",
        "calibration_color": f"green-{color_num}",
        "tide_marker": f"TIDE-{tag.upper()}-{tide_num}",
        "recent_tide_marker": f"TIDE-{tag.upper()}-RECENT",
        "db_path": "/var/lib/beacon/beacon.db",
        "backup_dir": "/var/backups/beacon",
        "upload_marker": f"/var/lib/beacon/uploads/do-not-delete-upload-{tag}.txt",
        "worker_heartbeat": "/var/lib/beacon/worker/heartbeat",
        "deployer_user": "deployer",
        "deployer_key_name": f"deployer-{tag}.pub",
        "good_tar_name": f"beacon-v2-good-{tag}.tar.gz",
        "good_checksum_name": f"beacon-v2-good-{tag}.sha256",
        "shiny_tar_name": f"beacon-v2-shiny-{tag}.tar.gz",
        "shiny_checksum_name": f"beacon-v2-shiny-{tag}.sha256",
        "fixed_tar_name": f"beacon-v2.1-fixed-{tag}.tar.gz",
        "fixed_checksum_name": f"beacon-v2.1-fixed-{tag}.sha256",
    }
    key_comment = f"beaconkeeper-{tag}"
    key_type = b"ssh-ed25519"
    public_bytes = hashlib.sha256(f"public-key-{seed}".encode("utf-8")).digest()[:32]
    key_blob = struct.pack(">I", len(key_type)) + key_type + struct.pack(">I", len(public_bytes)) + public_bytes
    inst["deployer_public_key"] = f"ssh-ed25519 {base64.b64encode(key_blob).decode('ascii')} {key_comment}"
    return inst


def create_users() -> None:
    run(["useradd", "--system", "--home", "/nonexistent", "--shell", "/usr/sbin/nologin", "beacon"], check=False)
    run(["useradd", "-m", "-s", "/bin/bash", "keeper"], check=False)
    run(["bash", "-lc", "echo 'keeper:keeper' | chpasswd"])
    run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "beaconkeeper-login", "-f", str(KEEPER_KEY_PATH)])
    KEEPER_KEY_PATH.chmod(0o600)
    (KEEPER_KEY_PATH.with_suffix(KEEPER_KEY_PATH.suffix + ".pub")).chmod(0o644)
    ssh_dir = Path("/home/keeper/.ssh")
    ssh_dir.mkdir(parents=True, exist_ok=True)
    ssh_dir.chmod(0o700)
    copy(KEEPER_KEY_PATH.with_suffix(KEEPER_KEY_PATH.suffix + ".pub"), ssh_dir / "authorized_keys", 0o600)
    chown(ssh_dir, "keeper", "keeper", recursive=True)
    write(
        Path("/etc/sudoers.d/keeper"),
        "keeper ALL=(ALL) NOPASSWD: ALL\n",
        0o440,
    )
    write(
        Path("/etc/ssh/sshd_config.d/beaconkeeper.conf"),
        "PubkeyAuthentication yes\n"
        "AuthorizedKeysFile .ssh/authorized_keys\n"
        "PasswordAuthentication yes\n"
        "PermitRootLogin no\n"
        "UsePAM yes\n",
        0o644,
    )
    Path("/run/sshd").mkdir(parents=True, exist_ok=True)


def write_release(path: Path, version: str, buggy_ships: bool, schema_version: str | None = None) -> None:
    path.mkdir(parents=True, exist_ok=True)
    copy(ROOT / "beacon_app.py", path / "app.py", 0o755)
    copy(ROOT / "worker.py", path / "worker.py", 0o755)
    write(path / "VERSION", version + "\n")
    write(path / "BUGGY_SHIPS", "1\n" if buggy_ships else "0\n")
    notes = [f"Release {version}", "", "Deployment layout: unpack into /srv/beacon/releases/<release> and update /srv/beacon/current."]
    if schema_version:
        notes.append(f"Run ./migrate.py after deployment. It sets schema_version={schema_version}.")
        migrate = f'''#!/usr/bin/env python3
import sqlite3
DB = "/var/lib/beacon/beacon.db"
conn = sqlite3.connect(DB)
conn.execute("create table if not exists meta (key text primary key, value text not null)")
conn.execute("insert or replace into meta(key, value) values ('schema_version', '{schema_version}')")
conn.commit()
conn.close()
print("schema_version={schema_version}")
'''
        write(path / "migrate.py", migrate, 0o755)
    write(path / "RELEASE_NOTES.md", "\n".join(notes) + "\n")
    chown(path, "root", "beacon", recursive=True)
    for p in path.rglob("*"):
        if p.is_dir():
            p.chmod(0o755)
        elif p.name.endswith(".py"):
            p.chmod(0o755)
        else:
            p.chmod(0o644)


def tar_release(src: Path, tar_path: Path) -> str:
    tar_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tar_path, "w:gz") as tf:
        tf.add(src, arcname=src.name)
    digest = hashlib.sha256(tar_path.read_bytes()).hexdigest()
    return digest


def create_supply_crates(inst: dict[str, object]) -> None:
    supply = Path("/opt/supply")
    supply.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        v2 = tmp / str(inst["v2_release"])
        write_release(v2, str(inst["v2_version"]), buggy_ships=True)
        good_tar = supply / str(inst["good_tar_name"])
        good_digest = tar_release(v2, good_tar)
        write(supply / str(inst["good_checksum_name"]), f"{good_digest}  {inst['good_tar_name']}\n")

        shiny = tmp / str(inst["shiny_release"])
        write_release(shiny, f"shiny-{inst['tag']}", buggy_ships=False)
        write(shiny / "UNEXPECTED_LAYOUT.txt", "This crate is intentionally suspicious. Reject it.\n")
        shiny_tar = supply / str(inst["shiny_tar_name"])
        _ = tar_release(shiny, shiny_tar)
        bad_digest = "0" * 64
        write(supply / str(inst["shiny_checksum_name"]), f"{bad_digest}  {inst['shiny_tar_name']}\n")

        v21 = tmp / str(inst["v21_release"])
        write_release(v21, str(inst["v21_version"]), buggy_ships=False, schema_version=str(inst["schema_version"]))
        fixed_tar = supply / str(inst["fixed_tar_name"])
        fixed_digest = tar_release(v21, fixed_tar)
        write(supply / str(inst["fixed_checksum_name"]), f"{fixed_digest}  {inst['fixed_tar_name']}\n")

    write(supply / str(inst["deployer_key_name"]), str(inst["deployer_public_key"]) + "\n", 0o644)
    write(supply / "README.txt", f"""
Beaconkeeper supply crates

Good v2 crate:
  {inst['good_tar_name']}
  {inst['good_checksum_name']}

Bad shiny crate:
  {inst['shiny_tar_name']}
  {inst['shiny_checksum_name']}

Fixed v2.1 crate:
  {inst['fixed_tar_name']}
  {inst['fixed_checksum_name']}

New operator onboarding:
  Create a local operator account named "{inst['deployer_user']}" and install the public
  key below in its authorized_keys (standard SSH ownership and modes). Give the account a
  restrictive umask and sudo scoped to the Beacon service only -- not full root.
  Public key file: {inst['deployer_key_name']}
""")


def create_database(inst: dict[str, object]) -> None:
    db = Path(str(inst["db_path"]))
    db.parent.mkdir(parents=True, exist_ok=True)
    if db.exists():
        db.unlink()
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        create table tides (
          marker text primary key,
          height_cm integer not null,
          observed_at text not null
        );
        create table ships (
          id text primary key,
          class text not null,
          status text not null
        );
        create table meta (
          key text primary key,
          value text not null
        );
        """
    )
    conn.execute("insert into tides(marker, height_cm, observed_at) values (?, ?, ?)", (f"TIDE-{inst['tag'].upper()}-OLD", 121, "2026-06-11T08:00:00Z"))
    conn.execute("insert into tides(marker, height_cm, observed_at) values (?, ?, ?)", (inst["recent_tide_marker"], 133, "2026-06-12T08:30:00Z"))
    conn.execute("insert into ships(id, class, status) values ('ship-001', 'lantern', 'waiting')")
    conn.execute("insert into ships(id, class, status) values ('ship-002', 'cargo', 'cleared')")
    conn.commit()
    conn.close()
    chown(db, "beacon", "beacon")
    db.chmod(0o640)

    # Build a compressed backup that includes the missing tide marker. Do not simply restore the whole DB.
    with tempfile.TemporaryDirectory() as td:
        tmp_db = Path(td) / "backup.db"
        shutil.copy2(db, tmp_db)
        conn = sqlite3.connect(tmp_db)
        conn.execute("insert into tides(marker, height_cm, observed_at) values (?, ?, ?)", (inst["tide_marker"], 142, "2026-06-12T07:15:00Z"))
        conn.commit()
        dump = "\n".join(conn.iterdump()) + "\n"
        conn.close()
    backup_dir = Path(str(inst["backup_dir"]))
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / f"beacon-20260612T081500Z-{inst['tag']}.sql.gz"
    with gzip.open(backup, "wt", encoding="utf-8") as f:
        f.write(dump)
    chown(backup_dir, "root", "beacon", recursive=True)
    backup_dir.chmod(0o750)
    backup.chmod(0o640)


def create_runtime_state(inst: dict[str, object]) -> None:
    for p in [Path("/etc/beacon"), Path("/srv/beacon/releases"), Path("/var/lib/beacon"), Path("/var/log/beacon"), Path("/var/backups/beacon"), Path("/var/lib/beacon/cache"), Path("/var/lib/beacon/uploads"), Path("/var/lib/beacon/worker"), Path("/var/lib/beacon/queue"), Path("/var/lib/beacon/calibration")]:
        p.mkdir(parents=True, exist_ok=True)

    # Simulated disk ballast. Small enough for a zip/build, real enough for du/find.
    cache = Path("/var/lib/beacon/cache")
    for i in range(1, 9):
        with open(cache / f"ballast-{i:02d}-{inst['tag']}.tmp", "wb") as f:
            f.write(b"0" * 256 * 1024)

    write(Path(str(inst["upload_marker"])), "This upload marker should survive the cache cleanup challenge.\n")
    write(Path("/var/lib/beacon/calibration/current.json"), json.dumps({"expected_color": inst["calibration_color"]}, indent=2) + "\n")

    env = f"""# Beaconkeeper runtime settings.
INTERNAL_PORT={inst['internal_port']}
DB_PATH={inst['db_path']}
CALIBRATION_FILE=/var/lib/beacon/calibration/current.json
QUEUE_DIR=/var/lib/beacon/queue
WORKER_HEARTBEAT={inst['worker_heartbeat']}
EXPECTED_TIDE_MARKER={inst['tide_marker']}
BEACON_COLOR=red-wrong
BEACON_DEBUG=true
BEACON_BIND=127.0.0.1
"""
    write(Path("/etc/beacon/beacon.env"), env, 0o600)
    chown(Path("/etc/beacon/beacon.env"), "root", "root")

    chown(Path("/var/log/beacon"), "beacon", "beacon", recursive=True)
    Path("/var/log/beacon").chmod(0o750)
    chown(Path("/var/lib/beacon/uploads"), "beacon", "beacon", recursive=True)
    # Intentionally root-owned so the worker initially fails.
    chown(Path("/var/lib/beacon/worker"), "root", "root", recursive=True)
    chown(Path("/var/lib/beacon/queue"), "root", "root", recursive=True)
    Path("/var/lib/beacon/worker").chmod(0o755)
    Path("/var/lib/beacon/queue").chmod(0o755)


def create_app_layout(inst: dict[str, object]) -> None:
    beacon_root = Path("/srv/beacon")
    v1 = Path(str(inst["v1_release_path"]))
    old = Path(f"/srv/beacon/releases/2026-06-08-{inst['tag']}-old")
    write_release(v1, str(inst["v1_version"]), buggy_ships=False)
    write_release(old, f"old-{inst['tag']}", buggy_ships=False)
    current = beacon_root / "current"
    if current.exists() or current.is_symlink():
        current.unlink()
    current.symlink_to(f"/srv/beacon/releases/missing-{inst['tag']}")

    readme = f"""
# Beaconkeeper Local Chart

Instance: `harbor-{inst['tag']}`

The Beacon app is installed under `/srv/beacon`. The active release is selected
with the `/srv/beacon/current` symlink.

## Local manifest

SERVICE_NAME={inst['service_name']}
WORKER_SERVICE={inst['worker_service']}
APP_ROOT=/srv/beacon
INTENDED_CURRENT_RELEASE={inst['v1_release_path']}
INTERNAL_PORT={inst['internal_port']}
PUBLIC_PATH={inst['public_path']}
PUBLIC_HEALTH_URL={inst['public_health_url']}
DB_PATH={inst['db_path']}
BACKUP_DIR={inst['backup_dir']}

## Local conventions

Application releases belong under `/srv/beacon/releases/<release>`.
Runtime state belongs under `/var/lib/beacon`.
Configuration belongs under `/etc/beacon`.
Logs belong under `/var/log/beacon`.
Supply crates and onboarding materials arrive under `/opt/supply`.
Backups belong under `/var/backups/beacon`.

## Operator notes

`/srv/beacon/OPERATOR_FACTS` is available for a concise KEY=value summary of
facts you have verified locally. `/srv/beacon/RUNBOOK.md` is available for the
final handoff. The handoff should cover current services, health checks,
deployment and rollback, logs, backups, and operator access.

"""
    write(beacon_root / "README.md", readme)
    chown(beacon_root, "root", "beacon", recursive=True)
    write(beacon_root / "OPERATOR_FACTS", "# Beaconkeeper operator facts\n", 0o644)
    chown(beacon_root / "OPERATOR_FACTS", "keeper", "keeper")
    write(beacon_root / "RUNBOOK.md", "# Beaconkeeper Runbook\n", 0o644)
    chown(beacon_root / "RUNBOOK.md", "keeper", "keeper")


def create_systemd_units(inst: dict[str, object]) -> None:
    service = f"""[Unit]
Description=Beacon API {inst['tag']}
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=beacon
Group=beacon
WorkingDirectory=/srv/beacon/current
Environment=BEACON_ENV=/etc/beacon/beacon.env
ExecStart=/usr/bin/python3 /srv/beacon/current/app.py
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
"""
    write(Path("/etc/systemd/system") / str(inst["service_name"]), service)

    worker = f"""[Unit]
Description=Beacon worker {inst['tag']}
After=network.target {inst['service_name']}
StartLimitIntervalSec=0

[Service]
Type=simple
User=beacon
Group=beacon
WorkingDirectory=/srv/beacon/current
Environment=BEACON_ENV=/etc/beacon/beacon.env
ExecStart=/usr/bin/python3 /srv/beacon/current/worker.py
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
"""
    write(Path("/etc/systemd/system") / str(inst["worker_service"]), worker)

    squatter = f"""[Unit]
Description=Dock squatter occupying Beacon port {inst['tag']}
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 -m http.server {inst['internal_port']} --bind 127.0.0.1 --directory /var/www/html
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
"""
    write(Path("/etc/systemd/system") / str(inst["squatter_service"]), squatter)

    backup_service = f"""[Unit]
Description=Beacon SQLite backup {inst['tag']}

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/beacon-backup
"""
    write(Path("/etc/systemd/system") / str(inst["backup_service"]), backup_service)

    backup_timer = f"""[Unit]
Description=Run Beacon backup periodically {inst['tag']}

[Timer]
OnCalendar=hourly
Persistent=true
Unit={inst['backup_service']}

[Install]
WantedBy=timers.target
"""
    write(Path("/etc/systemd/system") / str(inst["backup_timer"]), backup_timer)

    copy(ROOT / "beacon-backup.sh", Path("/usr/local/sbin/beacon-backup"), 0o755)

    # Start only the infrastructure and the squatter initially. The user must fix/enable API, worker, backup timer.
    enable_unit("dbus.service")
    enable_unit("ssh.service")
    enable_unit("nginx.service")
    enable_unit(str(inst["squatter_service"]))


_BEACON_OUTAGE_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Beacon - Service Unavailable</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: #c9d4e3;
    background: radial-gradient(130% 115% at 50% 0%, #16243d 0%, #0b1320 52%, #05080f 100%);
  }
  .wrap { text-align: center; padding: 1.5rem; max-width: 560px; }
  .art { width: 300px; max-width: 78vw; height: auto; display: block; margin: 0 auto .25rem;
         -webkit-mask-image: linear-gradient(to bottom, #000 72%, transparent 100%);
         mask-image: linear-gradient(to bottom, #000 72%, transparent 100%); }
  .code { font-size: 4rem; font-weight: 700; letter-spacing: .18em; color: #f0b65a;
          text-shadow: 0 0 30px rgba(240,182,90,.22); line-height: 1; }
  h1 { font-size: 1.45rem; margin: .3rem 0 1rem; color: #eef3fa; font-weight: 600; }
  p { line-height: 1.65; color: #93a6c0; font-size: 1rem; }
  .aside { margin-top: 1rem; font-size: .9rem; color: #6c7f9c; }
  .status { margin-top: 1.7rem; font-size: .8rem; color: #6f86a6;
            border-top: 1px solid #1b2a42; padding-top: 1rem; }
  .status b { color: #e07a5f; font-weight: 600; }
  @media (max-height: 460px) {
    body { align-items: flex-start; }
    .wrap { padding: .6rem 1rem; }
    .art { width: 140px; margin-bottom: .1rem; }
    .code { font-size: 2.4rem; }
    h1 { font-size: 1.05rem; margin: .15rem 0 .5rem; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <img class="art" alt="A lighthouse at night with its lamp dark" src="data:image/jpeg;base64,__IMG__">
    <div class="code">503</div>
    <h1>The beacon is dark</h1>
    <p>Service unavailable. The harbor light went out after a sloppy maintenance shift, and no one has relit the lanterns.</p>
    <p class="aside">Yes, the page loads. The beacon does not. That part is your job tonight, keeper.</p>
    <div class="status">beacon-api &nbsp;&middot;&nbsp; <b>0 of 20 lanterns lit</b> &nbsp;&middot;&nbsp; waiting for the night keeper</div>
  </div>
</body>
</html>
"""


def create_nginx(inst: dict[str, object]) -> None:
    img_b64 = base64.b64encode((ROOT / "beacon-down.jpg").read_bytes()).decode("ascii")
    write(Path("/var/www/html/index.html"), _BEACON_OUTAGE_HTML.replace("__IMG__", img_b64))
    config = f"""server {{
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Root serves a static maintenance page; the real dashboard is the Beacon API.
    location / {{
        root /var/www/html;
        index index.html;
    }}

    # Public health traffic should proxy to the local Beacon API.
    location {inst['public_path']}/ {{
        proxy_pass http://127.0.0.1:{inst['wrong_nginx_port']}/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }}
}}
"""
    write(Path("/etc/nginx/sites-available/default"), config)
    sites_enabled = Path("/etc/nginx/sites-enabled")
    sites_enabled.mkdir(parents=True, exist_ok=True)
    link = sites_enabled / "default"
    if link.exists() or link.is_symlink():
        link.unlink()
    link.symlink_to(Path("/etc/nginx/sites-available/default"))


def create_login_brief(inst: dict[str, object]) -> None:
    brief = f"""Beaconkeeper practical lab
Instance: harbor-{inst['tag']}

You are logged into a Linux host running a small internal service called Beacon.
The service is degraded after routine maintenance, and users report that the
dashboard is wrong or unavailable.

This is a terminal-first operations lab. Assume an interviewer is watching your
screen share and evaluating how you inspect a machine, explain what you find,
and make careful changes from the shell. For a realistic dry run, do not use AI
assistance during the timed session.

Your job is to restore the host to a healthy operational state using normal
Linux tools. Expect practical admin work: host orientation, user and access
setup, services, configuration, networking, storage, logs, and documentation.
Preserve useful data while you work. Leave a concise final handoff in:

  /srv/beacon/RUNBOOK.md

Start by orienting yourself before making changes. Derive facts from the host
rather than guessing. Use sudo when an operator task legitimately requires it.
The starting keeper account has passwordless sudo for this lab.
Your handoff should cover the final state, health checks, deployment/rollback,
logs, backups, and operator access.

Useful commands:
  ops brief
  ops status
  ops verify <n|all>
  ops hint <n>
"""
    issue = f"""Beaconkeeper lab instance harbor-{inst['tag']}
Log in as keeper to begin. The lab brief prints after login.
"""
    write(Path("/etc/beaconkeeper-lab-brief"), brief + "\n", 0o644)
    write(Path("/etc/motd"), issue, 0o644)
    write(Path("/etc/issue"), issue, 0o644)
    write(Path("/etc/issue.net"), issue, 0o644)
    write(
        Path("/etc/profile.d/beaconkeeper-lab.sh"),
        """#!/bin/sh
case "$-" in
  *i*) ;;
  *) return 0 2>/dev/null || exit 0 ;;
esac

[ "$(id -un 2>/dev/null)" = "keeper" ] || return 0 2>/dev/null || exit 0

# Color and the lantern animations need a real terminal type; some SSH clients
# arrive as "dumb" (or empty), which breaks tput/ANSI. Give them a sane default.
case "${TERM:-}" in
  ""|dumb|unknown) TERM=xterm-256color; export TERM ;;
esac

if [ -z "${BEACONKEEPER_BRIEF_SHOWN:-}" ]; then
  export BEACONKEEPER_BRIEF_SHOWN=1
  ops welcome 2>/dev/null || cat /etc/beaconkeeper-lab-brief 2>/dev/null
fi
""",
        0o755,
    )


def install_ops() -> None:
    PRIVATE_DIR.mkdir(parents=True, exist_ok=True)
    PRIVATE_DIR.chmod(0o700)
    py_compile.compile(str(ROOT / "ops.py"), cfile=str(OPS_PYC_PATH), doraise=True, optimize=2)
    OPS_PYC_PATH.chmod(0o600)
    write(
        OPS_RUNNER_PATH,
        "#!/bin/sh\nexec /usr/bin/python3 /usr/local/lib/beaconkeeper/private/ops.pyc \"$@\"\n",
        0o755,
    )
    write(
        Path("/usr/local/bin/ops"),
        "#!/bin/sh\nexec sudo -n /usr/local/sbin/beaconkeeper-ops-runner \"$@\"\n",
        0o755,
    )
    try:
        (ROOT / "ops.py").unlink()
    except FileNotFoundError:
        pass


def main() -> int:
    inst = make_instance()
    PRIVATE_DIR.mkdir(parents=True, exist_ok=True)
    PRIVATE_DIR.chmod(0o700)
    write(INSTANCE_PATH, json.dumps(inst, indent=2, sort_keys=True) + "\n", 0o600)
    install_ops()

    create_users()
    create_runtime_state(inst)
    create_database(inst)
    create_app_layout(inst)
    create_supply_crates(inst)
    create_systemd_units(inst)
    create_nginx(inst)
    create_login_brief(inst)

    progress_dir = Path("/var/lib/beaconkeeper")
    progress_dir.mkdir(parents=True, exist_ok=True)
    write(progress_dir / "progress.json", json.dumps({"completed": [], "hints_used": {}, "hints_remaining": 10}, indent=2) + "\n", 0o600)

    # Keep apt-created machine-id/systemd state from being baked weirdly.
    Path("/etc/machine-id").write_text("", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
