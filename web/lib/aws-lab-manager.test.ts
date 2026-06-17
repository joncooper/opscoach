import assert from "node:assert/strict";
import test from "node:test";
import { hydrateTemplateText, type AwsSessionMetadata } from "./aws-lab-manager";

const sampleMetadata: AwsSessionMetadata = {
  accountId: "123456789012",
  region: "us-east-1",
  sourceProfile: "platform",
  labAdminProfile: "opscoach-lab-admin",
  scenarioStackName: "OpsCoachAwsSecurityBasicsScenario",
  platformStackName: "OpsCoachAwsPlatform",
  candidateRoleArn: "arn:aws:iam::123456789012:role/OpsCoachCandidate",
  graderRoleArn: "arn:aws:iam::123456789012:role/OpsCoachGrader",
  outputs: {
    DataBucketName: "opscoach-research-bucket",
    LaunchTemplateId: "lt-0abc123",
    TrailName: "opscoach-trail",
    SecurityGroupId: "sg-0def456",
    SessionId: "sess-789",
    AlarmTopicArn: "arn:aws:sns:us-east-1:123456789012:opscoach-alerts",
  },
};

test("hydrateTemplateText replaces REPLACE_WITH_* placeholders", () => {
  const raw = [
    "account=REPLACE_WITH_ACCOUNT_ID",
    "region=REPLACE_WITH_REGION",
    "bucket=REPLACE_WITH_RESEARCH_BUCKET_NAME",
    "lt=REPLACE_WITH_LAUNCH_TEMPLATE_ID",
    "trail=REPLACE_WITH_TRAIL_NAME",
    "sg=REPLACE_WITH_SECURITY_GROUP_ID",
    "session=REPLACE_SESSION_ID",
    "topic=REPLACE_WITH_ALARM_TOPIC_ARN",
  ].join("\n");

  const hydrated = hydrateTemplateText(raw, sampleMetadata);

  assert.equal(hydrated, [
    "account=123456789012",
    "region=us-east-1",
    "bucket=opscoach-research-bucket",
    "lt=lt-0abc123",
    "trail=opscoach-trail",
    "sg=sg-0def456",
    "session=sess-789",
    "topic=arn:aws:sns:us-east-1:123456789012:opscoach-alerts",
  ].join("\n"));
});
