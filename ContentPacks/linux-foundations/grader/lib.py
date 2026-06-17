import json
import subprocess
from types import SimpleNamespace

def add_ssh_args(parser):
    parser.add_argument("--ssh-key", required=True)
    parser.add_argument("--ssh-port", required=True)
    parser.add_argument("--ssh-user", required=True)
    parser.add_argument("--ssh-hostname", required=True)
    parser.add_argument("--known-hosts", required=True)

def ssh(args, command, timeout=12):
    ssh_args = [
        "ssh",
        "-i", args.ssh_key,
        "-p", str(args.ssh_port),
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", f"UserKnownHostsFile={args.known_hosts}",
        "-o", "ConnectTimeout=5",
        f"{args.ssh_user}@{args.ssh_hostname}",
        command,
    ]
    try:
        return subprocess.run(ssh_args, text=True, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        return SimpleNamespace(returncode=124, stdout=exc.stdout or "", stderr=exc.stderr or "ssh timed out")

def check(args, check_id, label, command, detail, timeout=12):
    cp = ssh(args, command, timeout=timeout)
    ok = cp.returncode == 0
    return {"id": check_id, "status": "pass" if ok else "fail", "label": label, "detail": "ok" if ok else detail}

def emit(lab_id, checks):
    passed = sum(1 for c in checks if c["status"] == "pass")
    print(json.dumps({"labId": lab_id, "checks": checks, "score": {"passed": passed, "total": len(checks)}}))
