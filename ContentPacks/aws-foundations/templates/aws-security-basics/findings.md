# AWS Security Basics Findings

## Identity

- Account: REPLACE_WITH_ACCOUNT_ID
- Region: REPLACE_WITH_REGION
- Role:

## Assigned Resources

Record the IDs/names from `resource-map.env` (or README.md):

- Research bucket (`RESEARCH_BUCKET_NAME`): REPLACE_WITH_RESEARCH_BUCKET_NAME
- Security group (`SECURITY_GROUP_ID`): REPLACE_WITH_SECURITY_GROUP_ID
- Launch template (`LAUNCH_TEMPLATE_ID`): REPLACE_WITH_LAUNCH_TEMPLATE_ID
- CloudTrail trail (`TRAIL_NAME`): REPLACE_WITH_TRAIL_NAME
- Alarm topic (`ALARM_TOPIC_ARN`): REPLACE_WITH_ALARM_TOPIC_ARN
- Root-account alarm (`OpsCoach-<session>-RootAccountUsage`): OpsCoach-REPLACE_SESSION_ID-RootAccountUsage

## Target State Checklist

After remediation, fill each row with the **observed final state** using one of: enabled, disabled, removed, true, false, or required. Do not copy placeholder text. Record what you verified with describe/get calls.

Format examples (replace with your verified values):

- Research bucket versioning: enabled
- Research bucket public access block: enabled
- Security group public SSH: removed
- Security group internal HTTPS: enabled
- Launch template public IP: disabled
- Launch template IMDS tokens: required
- Launch template root volume encryption: true
- CloudTrail log file validation: enabled
- Root account usage alarm: enabled

## Handoff

Summarize what you changed and the final state for each assigned resource above.

-
