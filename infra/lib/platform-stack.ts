import * as cdk from "aws-cdk-lib";
import { aws_iam as iam, aws_lambda as lambda, aws_scheduler as scheduler } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import { OpsCoachAwsConfig } from "./config";

export interface OpsCoachPlatformStackProps extends cdk.StackProps {
  readonly config: OpsCoachAwsConfig;
}

export class OpsCoachPlatformStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OpsCoachPlatformStackProps) {
    super(scope, id, props);

    const { config } = props;
    const trustedAdmin = new iam.ArnPrincipal(config.adminPrincipalArn);
    const opsCoachBucketArn = "arn:aws:s3:::opscoach-*";
    const opsCoachBucketObjectsArn = "arn:aws:s3:::opscoach-*/*";
    const opsCoachAlarmArn = `arn:${cdk.Aws.PARTITION}:cloudwatch:${this.region}:${this.account}:alarm:OpsCoach-*`;
    const opsCoachTrailArn = `arn:${cdk.Aws.PARTITION}:cloudtrail:${this.region}:${this.account}:trail/opscoach-*`;
    const opsCoachTopicArn = `arn:${cdk.Aws.PARTITION}:sns:${this.region}:${this.account}:OpsCoach-*`;
    const opsCoachRoleArn = `arn:${cdk.Aws.PARTITION}:iam::${this.account}:role/opscoach-*`;

    const candidatePolicy = new iam.ManagedPolicy(this, "CandidateAllowlistPolicy", {
      managedPolicyName: "OpsCoachCandidateAllowlist",
      description: "Maximum allowed AWS CLI actions for an Ops Coach candidate session.",
      document: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: "IdentityAndDiscovery",
            actions: [
              "sts:GetCallerIdentity",
              "tag:GetResources",
              "ec2:DescribeLaunchTemplates",
              "ec2:DescribeLaunchTemplateVersions",
              "ec2:DescribeSecurityGroups",
              "ec2:DescribeTags",
              "s3:ListAllMyBuckets",
              "cloudtrail:DescribeTrails",
              "cloudtrail:GetTrailStatus",
              "cloudwatch:DescribeAlarms",
              "iam:GetRole",
              "iam:GetRolePolicy",
              "iam:ListRolePolicies",
              "sns:GetTopicAttributes",
              "sns:ListTopics",
            ],
            resources: ["*"],
          }),
          new iam.PolicyStatement({
            sid: "S3LabBucketRead",
            actions: [
              "s3:GetAccelerateConfiguration",
              "s3:GetBucketAcl",
              "s3:GetBucketCORS",
              "s3:GetBucketLocation",
              "s3:GetBucketLogging",
              "s3:GetBucketNotification",
              "s3:GetBucketPolicy",
              "s3:GetBucketPolicyStatus",
              "s3:GetBucketPublicAccessBlock",
              "s3:GetBucketTagging",
              "s3:GetBucketVersioning",
              "s3:GetBucketWebsite",
              "s3:GetEncryptionConfiguration",
              "s3:GetLifecycleConfiguration",
              "s3:ListBucket",
            ],
            resources: [opsCoachBucketArn],
          }),
          new iam.PolicyStatement({
            sid: "S3LabBucketRemediation",
            actions: ["s3:PutBucketPublicAccessBlock", "s3:PutBucketVersioning"],
            resources: [opsCoachBucketArn],
          }),
          new iam.PolicyStatement({
            sid: "S3LabObjectRead",
            actions: ["s3:GetObject"],
            resources: [opsCoachBucketObjectsArn],
          }),
          new iam.PolicyStatement({
            sid: "Ec2TaggedRemediation",
            actions: [
              "ec2:CreateLaunchTemplateVersion",
              "ec2:ModifyLaunchTemplate",
              "ec2:RevokeSecurityGroupIngress",
            ],
            resources: ["*"],
            conditions: {
              StringEquals: {
                "aws:ResourceTag/OpsCoach": "true",
              },
            },
          }),
          new iam.PolicyStatement({
            sid: "CloudTrailLabRemediation",
            actions: ["cloudtrail:UpdateTrail"],
            resources: [opsCoachTrailArn],
          }),
          new iam.PolicyStatement({
            sid: "CloudWatchLabAlarmRemediation",
            actions: ["cloudwatch:PutMetricAlarm"],
            resources: [opsCoachAlarmArn],
          }),
          new iam.PolicyStatement({
            sid: "SnsLabTopicRead",
            actions: ["sns:GetTopicAttributes"],
            resources: [opsCoachTopicArn],
          }),
          new iam.PolicyStatement({
            sid: "IamLabRoleReadOnly",
            actions: ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies"],
            resources: [opsCoachRoleArn],
          }),
        ],
      }),
    });

    const candidateRole = new iam.Role(this, "CandidateRole", {
      roleName: "OpsCoachCandidateRole",
      description: "Short-lived role assumed by Ops Coach candidates for the AWS security basics lab.",
      assumedBy: trustedAdmin,
      maxSessionDuration: cdk.Duration.hours(config.maxSessionHours),
      permissionsBoundary: candidatePolicy,
    });
    candidateRole.addManagedPolicy(candidatePolicy);

    const graderRole = new iam.Role(this, "GraderRole", {
      roleName: "OpsCoachGraderRole",
      description: "Read-only role used by Ops Coach to grade AWS lab state.",
      assumedBy: trustedAdmin,
      maxSessionDuration: cdk.Duration.hours(1),
    });
    graderRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "sts:GetCallerIdentity",
        "tag:GetResources",
        "ec2:DescribeLaunchTemplates",
        "ec2:DescribeLaunchTemplateVersions",
        "ec2:DescribeSecurityGroups",
        "s3:GetAccelerateConfiguration",
        "s3:GetBucketAcl",
        "s3:GetBucketCORS",
        "s3:GetBucketLocation",
        "s3:GetBucketLogging",
        "s3:GetBucketNotification",
        "s3:GetBucketPolicy",
        "s3:GetBucketPolicyStatus",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketTagging",
        "s3:GetBucketVersioning",
        "s3:GetBucketWebsite",
        "s3:GetEncryptionConfiguration",
        "s3:GetLifecycleConfiguration",
        "cloudtrail:DescribeTrails",
        "cloudtrail:GetTrailStatus",
        "cloudwatch:DescribeAlarms",
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "sns:GetTopicAttributes",
        "sns:ListTopics",
      ],
      resources: ["*"],
    }));

    const provisionerRole = new iam.Role(this, "ProvisionerRole", {
      roleName: "OpsCoachProvisionerRole",
      description: "Privileged role used by Ops Coach automation to deploy and reset lab scenarios.",
      assumedBy: trustedAdmin,
      maxSessionDuration: cdk.Duration.hours(2),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess")],
    });

    const janitorRole = new iam.Role(this, "JanitorRole", {
      roleName: "OpsCoachJanitorRole",
      description: "Role used by the Ops Coach janitor Lambda to report and clean expired lab resources.",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      maxSessionDuration: cdk.Duration.hours(1),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")],
    });
    janitorRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "tag:GetResources",
        "ec2:DeleteLaunchTemplate",
        "ec2:DeleteSecurityGroup",
        "ec2:DescribeLaunchTemplates",
        "ec2:DescribeSecurityGroups",
        "s3:DeleteBucket",
        "s3:DeleteBucketPolicy",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:GetBucketTagging",
        "s3:ListAllMyBuckets",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "cloudtrail:DeleteTrail",
        "cloudtrail:DescribeTrails",
        "cloudtrail:ListTags",
        "cloudwatch:DeleteAlarms",
        "cloudwatch:DescribeAlarms",
        "iam:DeleteRole",
        "iam:DeleteRolePolicy",
        "iam:GetRole",
        "iam:ListRoles",
        "iam:ListRolePolicies",
        "iam:ListRoleTags",
        "logs:DeleteLogGroup",
        "logs:DescribeLogGroups",
        "sns:DeleteTopic",
        "sns:ListTagsForResource",
        "sns:ListTopics",
      ],
      resources: ["*"],
    }));

    const janitorFn = new lambda.Function(this, "JanitorFunction", {
      functionName: "OpsCoachJanitor",
      description: "Reports and deletes expired Ops Coach AWS lab resources.",
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "janitor")),
      timeout: cdk.Duration.minutes(5),
      role: janitorRole,
      environment: {
        ALLOWED_REGION: config.allowedRegion,
        DRY_RUN: "false",
      },
    });

    const scheduleRole = new iam.Role(this, "JanitorScheduleRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    janitorFn.grantInvoke(scheduleRole);

    new scheduler.CfnSchedule(this, "NightlyJanitorSchedule", {
      name: "OpsCoachNightlyJanitor",
      description: "Nightly cleanup/reporting pass for expired Ops Coach lab resources.",
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "cron(0 7 * * ? *)",
      target: {
        arn: janitorFn.functionArn,
        roleArn: scheduleRole.roleArn,
        input: JSON.stringify({ reason: "nightly-schedule" }),
      },
    });

    new cdk.CfnOutput(this, "CandidateRoleArn", { value: candidateRole.roleArn });
    new cdk.CfnOutput(this, "GraderRoleArn", { value: graderRole.roleArn });
    new cdk.CfnOutput(this, "ProvisionerRoleArn", { value: provisionerRole.roleArn });
    new cdk.CfnOutput(this, "JanitorFunctionName", { value: janitorFn.functionName });
  }
}
