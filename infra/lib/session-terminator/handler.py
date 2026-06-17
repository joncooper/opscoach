import datetime
import json
import os
import urllib.error
import urllib.request

import boto3
from botocore.exceptions import ClientError


def handler(event, _context):
    region = os.environ.get("AWS_REGION", os.environ.get("ALLOWED_REGION", "us-east-1"))
    dry_run = str(event.get("dryRun", os.environ.get("DRY_RUN", "false"))).lower() == "true"
    now = datetime.datetime.now(datetime.timezone.utc)
    report = {
        "dryRun": dry_run,
        "region": region,
        "action": event.get("action", "sweep"),
        "terminated": [],
        "notified": [],
        "errors": [],
    }

    action = event.get("action")
    if action == "terminate":
        terminate_one(
            region=region,
            instance_id=event.get("instanceId"),
            session_id=event.get("sessionId"),
            reason=event.get("reason", "max_ttl"),
            dry_run=dry_run,
            report=report,
        )
    else:
        terminate_expired_instances(region, now, dry_run, report)

    print(json.dumps(report, sort_keys=True))
    return report


def tag_map(tags):
    if isinstance(tags, dict):
        return tags
    return {tag.get("Key") or tag.get("key"): tag.get("Value") or tag.get("value") for tag in tags or []}


def is_expired(tags, now):
    values = tag_map(tags)
    if values.get("OpsCoach") != "true":
        return False
    expires_at = values.get("ExpiresAt")
    if not expires_at:
        return False
    try:
        parsed = datetime.datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed <= now


_SECRET_CACHE = {}


def get_callback_secret(region):
    # Fetch the callback secret from Secrets Manager at runtime so it is never stored in
    # plaintext in the Lambda environment / CloudFormation template.
    arn = os.environ.get("INTERNAL_CALLBACK_SECRET_ARN", "")
    if not arn:
        return os.environ.get("INTERNAL_CALLBACK_SECRET", "")
    if arn not in _SECRET_CACHE:
        client = boto3.client("secretsmanager", region_name=region)
        _SECRET_CACHE[arn] = client.get_secret_value(SecretId=arn).get("SecretString", "")
    return _SECRET_CACHE[arn]


def notify_shutdown(session_id, reason, region):
    base_url = os.environ.get("SHUTDOWN_CALLBACK_BASE_URL", "").rstrip("/")
    secret = get_callback_secret(region)
    if not base_url or not session_id:
        return False

    payload = json.dumps({"reason": reason}).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/api/sessions/{session_id}/shutdown",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Internal-Secret": secret,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return 200 <= response.status < 300
    except urllib.error.HTTPError as exc:
        if exc.code in (404, 409):
            return True
        raise


def terminate_one(region, instance_id, session_id, reason, dry_run, report):
    if not instance_id:
        report["errors"].append({"error": "missing instanceId"})
        return

    item = {"kind": "ec2-instance", "instanceId": instance_id, "sessionId": session_id, "reason": reason}
    if dry_run:
        report["terminated"].append(item)
        return

    ec2 = boto3.client("ec2", region_name=region)
    try:
        ec2.terminate_instances(InstanceIds=[instance_id])
        report["terminated"].append(item)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code not in ("InvalidInstanceID.NotFound", "IncorrectInstanceState"):
            report["errors"].append({**item, "error": str(exc)})
            return

    if session_id:
        try:
            if notify_shutdown(session_id, reason, region):
                report["notified"].append({"sessionId": session_id, "reason": reason})
        except Exception as exc:  # noqa: BLE001 — keep termination success visible
            report["errors"].append({"sessionId": session_id, "error": f"shutdown callback failed: {exc}"})


def terminate_expired_instances(region, now, dry_run, report):
    ec2 = boto3.client("ec2", region_name=region)
    paginator = ec2.get_paginator("describe_instances")
    for page in paginator.paginate(
        Filters=[
            {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]},
            {"Name": "tag:OpsCoach", "Values": ["true"]},
        ]
    ):
        for reservation in page.get("Reservations", []):
            for instance in reservation.get("Instances", []):
                instance_id = instance["InstanceId"]
                tags = instance.get("Tags", [])
                if not is_expired(tags, now):
                    continue

                session_id = tag_map(tags).get("opscoach:session")
                terminate_one(
                    region=region,
                    instance_id=instance_id,
                    session_id=session_id,
                    reason="expires_at_sweep",
                    dry_run=dry_run,
                    report=report,
                )
