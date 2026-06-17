import datetime
import json
import os

import boto3
from botocore.exceptions import ClientError


def handler(event, _context):
    region = os.environ.get("ALLOWED_REGION", "us-east-1")
    dry_run = str(event.get("dryRun", os.environ.get("DRY_RUN", "true"))).lower() == "true"
    now = datetime.datetime.now(datetime.timezone.utc)
    report = {
        "dryRun": dry_run,
        "region": region,
        "expired": [],
        "deleted": [],
        "errors": [],
    }

    delete_expired_s3_buckets(region, now, dry_run, report)
    delete_expired_security_groups(region, now, dry_run, report)
    delete_expired_launch_templates(region, now, dry_run, report)
    delete_expired_cloudtrails(region, now, dry_run, report)
    delete_expired_cloudwatch_alarms(region, now, dry_run, report)
    delete_expired_sns_topics(region, now, dry_run, report)
    delete_expired_iam_roles(now, dry_run, report)

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


def record(report, kind, name, dry_run, delete_fn):
    item = {"kind": kind, "name": name}
    report["expired"].append(item)
    if dry_run:
        return
    try:
        delete_fn()
        report["deleted"].append(item)
    except ClientError as exc:
        report["errors"].append({**item, "error": str(exc)})


def delete_expired_s3_buckets(region, now, dry_run, report):
    s3 = boto3.client("s3", region_name=region)
    for bucket in s3.list_buckets().get("Buckets", []):
        name = bucket["Name"]
        if not name.startswith("opscoach-"):
            continue
        try:
            tags = s3.get_bucket_tagging(Bucket=name).get("TagSet", [])
        except ClientError:
            continue
        if not is_expired(tags, now):
            continue

        def delete_bucket():
            paginator = s3.get_paginator("list_object_versions")
            for page in paginator.paginate(Bucket=name):
                objects = []
                for version in page.get("Versions", []):
                    objects.append({"Key": version["Key"], "VersionId": version["VersionId"]})
                for marker in page.get("DeleteMarkers", []):
                    objects.append({"Key": marker["Key"], "VersionId": marker["VersionId"]})
                if objects:
                    s3.delete_objects(Bucket=name, Delete={"Objects": objects})
            try:
                s3.delete_bucket_policy(Bucket=name)
            except ClientError:
                pass
            s3.delete_bucket(Bucket=name)

        record(report, "s3-bucket", name, dry_run, delete_bucket)


def delete_expired_security_groups(region, now, dry_run, report):
    ec2 = boto3.client("ec2", region_name=region)
    groups = ec2.describe_security_groups(
        Filters=[{"Name": "tag:OpsCoach", "Values": ["true"]}]
    ).get("SecurityGroups", [])
    for group in groups:
        if is_expired(group.get("Tags", []), now):
            record(
                report,
                "security-group",
                group["GroupId"],
                dry_run,
                lambda group_id=group["GroupId"]: ec2.delete_security_group(GroupId=group_id),
            )


def delete_expired_launch_templates(region, now, dry_run, report):
    ec2 = boto3.client("ec2", region_name=region)
    templates = ec2.describe_launch_templates(
        Filters=[{"Name": "tag:OpsCoach", "Values": ["true"]}]
    ).get("LaunchTemplates", [])
    for template in templates:
        if is_expired(template.get("Tags", []), now):
            record(
                report,
                "launch-template",
                template["LaunchTemplateId"],
                dry_run,
                lambda template_id=template["LaunchTemplateId"]: ec2.delete_launch_template(
                    LaunchTemplateId=template_id
                ),
            )


def delete_expired_cloudtrails(region, now, dry_run, report):
    cloudtrail = boto3.client("cloudtrail", region_name=region)
    for trail in cloudtrail.describe_trails(includeShadowTrails=False).get("trailList", []):
        name = trail["Name"]
        if not name.startswith("opscoach-"):
            continue
        tags = cloudtrail.list_tags(ResourceIdList=[trail["TrailARN"]]).get("ResourceTagList", [])
        trail_tags = tags[0].get("TagsList", []) if tags else []
        if is_expired(trail_tags, now):
            record(report, "cloudtrail", name, dry_run, lambda trail_name=name: cloudtrail.delete_trail(Name=trail_name))


def delete_expired_cloudwatch_alarms(region, now, dry_run, report):
    cloudwatch = boto3.client("cloudwatch", region_name=region)
    for page in cloudwatch.get_paginator("describe_alarms").paginate(AlarmNamePrefix="OpsCoach-"):
        for alarm in page.get("MetricAlarms", []):
            name = alarm["AlarmName"]
            arn = alarm["AlarmArn"]
            tags = cloudwatch.list_tags_for_resource(ResourceARN=arn).get("Tags", [])
            if is_expired(tags, now):
                record(
                    report,
                    "cloudwatch-alarm",
                    name,
                    dry_run,
                    lambda alarm_name=name: cloudwatch.delete_alarms(AlarmNames=[alarm_name]),
                )


def delete_expired_sns_topics(region, now, dry_run, report):
    sns = boto3.client("sns", region_name=region)
    for page in sns.get_paginator("list_topics").paginate():
        for topic in page.get("Topics", []):
            arn = topic["TopicArn"]
            name = arn.rsplit(":", 1)[-1]
            if not name.startswith("OpsCoach-"):
                continue
            tags = sns.list_tags_for_resource(ResourceArn=arn).get("Tags", [])
            if is_expired(tags, now):
                record(report, "sns-topic", arn, dry_run, lambda topic_arn=arn: sns.delete_topic(TopicArn=topic_arn))


def delete_expired_iam_roles(now, dry_run, report):
    iam = boto3.client("iam")
    paginator = iam.get_paginator("list_roles")
    for page in paginator.paginate():
        for role in page.get("Roles", []):
            name = role["RoleName"]
            if not name.startswith("opscoach-"):
                continue
            tags = iam.list_role_tags(RoleName=name).get("Tags", [])
            if not is_expired(tags, now):
                continue

            def delete_role(role_name=name):
                for policy_name in iam.list_role_policies(RoleName=role_name).get("PolicyNames", []):
                    iam.delete_role_policy(RoleName=role_name, PolicyName=policy_name)
                iam.delete_role(RoleName=role_name)

            record(report, "iam-role", name, dry_run, delete_role)
