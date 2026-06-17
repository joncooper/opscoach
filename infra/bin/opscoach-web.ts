#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { OpsCoachLabHostStack } from "../lib/lab-host-stack";
import { loadWebConfig } from "../lib/web-config";
import { OpsCoachWebStack } from "../lib/web-stack";

const app = new cdk.App();
const config = loadWebConfig(app);
const env = {
  account: config.labAccountId,
  region: config.region,
};

const webStack = new OpsCoachWebStack(app, "OpsCoachWeb", {
  env,
  config,
});

const labHost = new OpsCoachLabHostStack(app, "OpsCoachLabHost", {
  env,
  config,
  vpc: webStack.vpc,
  shutdownCallbackBaseUrl: config.domain
    ? `https://${config.domain}`
    : `http://${webStack.service.loadBalancer.loadBalancerDnsName}`,
});

webStack.bindLabHost(labHost);
