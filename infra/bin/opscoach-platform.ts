#!/usr/bin/env node
/**
 * Deploy Ops Coach into the shared platform (mono-playground).
 *
 * Prerequisite: Dev-Network, Dev-Cluster, Dev-Edge stacks deployed in account
 * 123456789012 / us-east-1. Pass their resource IDs via CDK context — see
 * infra/PLATFORM_INTEGRATION.md.
 */
import * as cdk from "aws-cdk-lib";
import { aws_ec2 as ec2 } from "aws-cdk-lib";
import {
  importPlatform,
  loadPlatformLookup,
  type PlatformRefs,
} from "../lib/platform";
import { OpsCoachLabHostStack } from "../lib/lab-host-stack";
import { OpsCoachServiceStack } from "../lib/opscoach-service-stack";
import { loadPlatformOpsCoachConfig, internalCallbackBaseUrl } from "../lib/web-config";

const app = new cdk.App();
const lookup = loadPlatformLookup(app);
const envs = app.node.tryGetContext("envs") as { dev: cdk.Environment };

/** VPC.fromLookup must run inside a Stack scope, not on the App. */
class PlatformImportStack extends cdk.Stack {
  public readonly platform: PlatformRefs;

  constructor(scope: cdk.App, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    this.platform = importPlatform(this, lookup);
  }
}

const platformStack = new PlatformImportStack(app, "Dev-OpsCoachPlatform", {
  env: envs.dev,
});
const platform = platformStack.platform;
const config = loadPlatformOpsCoachConfig(app, platform.zoneName);
const internalCallbackUrl = internalCallbackBaseUrl(config);

const labHost = new OpsCoachLabHostStack(app, "Dev-OpsCoachLabHost", {
  env: platform.env,
  config,
  vpc: platform.vpc,
  shutdownCallbackBaseUrl: internalCallbackUrl,
});

const publicSubnet = platform.vpc.selectSubnets({
  subnetType: ec2.SubnetType.PUBLIC,
}).subnets[0];

new OpsCoachServiceStack(app, "Dev-OpsCoach", {
  env: platform.env,
  platform,
  config,
  callbackSecret: labHost.callbackSecret,
  sessionTerminatorLambdaArn: labHost.terminatorFunction.functionArn,
  schedulerInvokeRoleArn: labHost.schedulerInvokeRole.roleArn,
  launchTemplateId: labHost.launchTemplate.launchTemplateId,
  publicSubnetId: publicSubnet.subnetId,
  labSecurityGroup: labHost.labSecurityGroup,
  terminatorSecurityGroup: labHost.terminatorSecurityGroup,
});
