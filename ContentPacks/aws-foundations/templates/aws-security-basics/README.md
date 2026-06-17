# AWS Security Basics Starter Templates

These files are starter request bodies for AWS CLI operations that need dense JSON.

| File | Purpose |
|------|---------|
| `public-access-block.json` | Enable all four bucket-level public access block controls. |
| `revoke-public-ssh-rule.json` | **Revoke** the bad public SSH ingress rule (`0.0.0.0/0` on port 22). Use with `aws ec2 revoke-security-group-ingress` — do **not** authorize this rule. |
| `launch-template-data.json` | Corrected default launch template data (private IP, IMDSv2, encrypted root volume). |
| `root-account-alarm.json` | CloudWatch alarm for root account usage; session and SNS topic placeholders are filled at hydration. |
