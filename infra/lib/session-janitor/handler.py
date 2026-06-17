import datetime
import json
import os

import boto3
from botocore.exceptions import ClientError


def handler(event, _context):
    region = os.environ.get("AWS_REGION", os.environ.get("ALLOWED_REGION", "us-east-1"))
    dry_run = str(event.get("dryRun", os.environ.get("DRY_RUN", "false"))).lower() == "true"
    now = datetime.datetime.now(datetime.timezone.utc)
    report = {
        "dryRun": dry_run,
        "region": region,
        "expired": [],
        "terminated": [],
        "errors": [],
    }

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

                item = {"kind": "ec2-instance", "instanceId": instance_id}
                report["expired"].append(item)
                if dry_run:
                    continue
                try:
                    ec2.terminate_instances(InstanceIds=[instance_id])
                    report["terminated"].append(item)
                except ClientError as exc:
                    report["errors"].append({**item, "error": str(exc)})
