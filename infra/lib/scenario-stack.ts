import * as cdk from "aws-cdk-lib";
import {
  aws_cloudtrail as cloudtrail,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_s3 as s3,
  aws_sns as sns,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { commonTags, OpsCoachAwsConfig, resourcePrefix } from "./config";

export interface AwsSecurityBasicsScenarioStackProps extends cdk.StackProps {
  readonly config: OpsCoachAwsConfig;
}

export class AwsSecurityBasicsScenarioStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AwsSecurityBasicsScenarioStackProps) {
    super(scope, id, props);

    const { config } = props;
    const prefix = resourcePrefix(config);
    const tags = commonTags(config);

    Object.entries(tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    const dataBucket = new s3.Bucket(this, "ResearchDropBucket", {
      bucketName: `${prefix}-${this.account}-${this.region}`.toLowerCase(),
      versioned: false,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        ignorePublicAcls: false,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const labVpc = new ec2.CfnVPC(this, "LabVpc", {
      cidrBlock: "10.44.0.0/16",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: namedTags(tags, `${prefix}-vpc`),
    });

    const serviceSecurityGroup = new ec2.CfnSecurityGroup(this, "ServiceSecurityGroup", {
      groupDescription: "Ops Coach lab service security group with one intentionally bad ingress rule.",
      groupName: `${prefix}-service-sg`,
      vpcId: labVpc.ref,
      securityGroupIngress: [
        {
          ipProtocol: "tcp",
          fromPort: 22,
          toPort: 22,
          cidrIp: "0.0.0.0/0",
          description: "Intentional lab finding: public SSH ingress.",
        },
        {
          ipProtocol: "tcp",
          fromPort: 443,
          toPort: 443,
          cidrIp: "10.44.0.0/16",
          description: "Expected internal HTTPS ingress.",
        },
      ],
      tags: namedTags(tags, `${prefix}-service-sg`),
    });

    const launchTemplate = new ec2.CfnLaunchTemplate(this, "LaunchTemplate", {
      launchTemplateName: `${prefix}-app-template`,
      tagSpecifications: [
        {
          resourceType: "launch-template",
          tags: namedTags(tags, `${prefix}-app-template`),
        },
      ],
      launchTemplateData: {
        metadataOptions: {
          httpEndpoint: "enabled",
          httpTokens: "optional",
        },
        networkInterfaces: [
          {
            deviceIndex: 0,
            associatePublicIpAddress: true,
            groups: [serviceSecurityGroup.attrGroupId],
          },
        ],
        blockDeviceMappings: [
          {
            deviceName: "/dev/xvda",
            ebs: {
              encrypted: false,
              deleteOnTermination: true,
              volumeSize: 8,
              volumeType: "gp3",
            },
          },
        ],
      },
    });

    const auditRole = new iam.Role(this, "AuditRole", {
      roleName: `${prefix}-app-role`,
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Intentional lab finding: app role with broader S3 access than needed.",
    });
    auditRole.addToPolicy(new iam.PolicyStatement({
      sid: "IntentionalLabFindingBroadS3",
      actions: ["s3:*"],
      resources: [dataBucket.bucketArn, dataBucket.arnForObjects("*")],
    }));

    const trailBucket = new s3.Bucket(this, "TrailBucket", {
      bucketName: `${prefix}-trail-${this.account}-${this.region}`.toLowerCase(),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const trailName = `${prefix}-management-events`;
    new cloudtrail.Trail(this, "ManagementTrail", {
      trailName,
      bucket: trailBucket,
      enableFileValidation: false,
      includeGlobalServiceEvents: false,
      isMultiRegionTrail: false,
      managementEvents: cloudtrail.ReadWriteType.ALL,
      sendToCloudWatchLogs: false,
    });

    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      topicName: `OpsCoach-${config.sessionId}-SecurityAlerts`,
    });

    new cdk.CfnOutput(this, "DataBucketName", { value: dataBucket.bucketName });
    new cdk.CfnOutput(this, "SecurityGroupId", { value: serviceSecurityGroup.attrGroupId });
    new cdk.CfnOutput(this, "LaunchTemplateId", { value: launchTemplate.ref });
    new cdk.CfnOutput(this, "TrailName", { value: trailName });
    new cdk.CfnOutput(this, "AlarmTopicArn", { value: alarmTopic.topicArn });
    new cdk.CfnOutput(this, "AuditRoleName", { value: auditRole.roleName });
    new cdk.CfnOutput(this, "AllowedRegion", { value: config.allowedRegion });
    new cdk.CfnOutput(this, "SessionId", { value: config.sessionId });
    new cdk.CfnOutput(this, "ExpiresAt", { value: config.expiresAt });
  }
}

function namedTags(tags: Record<string, string>, name: string): cdk.CfnTag[] {
  return [
    { key: "Name", value: name },
    ...Object.entries(tags).map(([key, value]) => ({ key, value })),
  ];
}
