#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { loadConfig } from "../lib/config";
import { OpsCoachOrgGuardrailsStack } from "../lib/org-guardrails-stack";
import { OpsCoachPlatformStack } from "../lib/platform-stack";
import { AwsSecurityBasicsScenarioStack } from "../lib/scenario-stack";

const app = new cdk.App();
const config = loadConfig(app);
const env = {
  account: config.labAccountId,
  region: config.allowedRegion,
};

new OpsCoachOrgGuardrailsStack(app, "OpsCoachOrgGuardrails", {
  env: {
    account: config.managementAccountId,
    region: config.managementRegion,
  },
  config,
});

new OpsCoachPlatformStack(app, "OpsCoachAwsPlatform", {
  env,
  config,
});

new AwsSecurityBasicsScenarioStack(app, "OpsCoachAwsSecurityBasicsScenario", {
  env,
  config,
});
