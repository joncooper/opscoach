import * as cdk from "aws-cdk-lib";
import {
  aws_ec2 as ec2,
  aws_events as events,
  aws_events_targets as events_targets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";
import { OpsCoachWebConfig } from "./web-config";

export interface OpsCoachLabHostStackProps extends cdk.StackProps {
  readonly config: OpsCoachWebConfig;
  readonly vpc: ec2.IVpc;
  /** e.g. https://opscoach.ops.example.com — used by terminator Lambda to sync session state. */
  readonly shutdownCallbackBaseUrl?: string;
}

export class OpsCoachLabHostStack extends cdk.Stack {
  public readonly labSecurityGroup: ec2.SecurityGroup;
  public readonly terminatorSecurityGroup: ec2.SecurityGroup;
  public readonly launchTemplate: ec2.LaunchTemplate;
  public readonly instanceProfile: iam.CfnInstanceProfile;
  public readonly terminatorFunction: lambda.Function;
  public readonly schedulerInvokeRole: iam.Role;
  public readonly callbackSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: OpsCoachLabHostStackProps) {
    super(scope, id, props);

    const { config, vpc } = props;
    const shutdownBase = props.shutdownCallbackBaseUrl ?? "";

    cdk.Tags.of(this).add("OpsCoach", "true");
    cdk.Tags.of(this).add("OpsCoachStack", "lab-host");

    this.labSecurityGroup = new ec2.SecurityGroup(this, "LabSecurityGroup", {
      vpc,
      description: "Ops Coach learner lab instances",
      allowAllOutbound: true,
    });
    this.labSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "Learner SSH from the internet",
    );
    // Grader SSH ingress is granted narrowly from the web-task SG in the service stack
    // (no VPC-wide :22 rule, which let any lab host SSH any other — lateral movement).
    // Egress lockdown (NET-03) is deferred to the lab-account move where it can be
    // validated against what bootstrap actually needs.

    this.terminatorSecurityGroup = new ec2.SecurityGroup(this, "TerminatorSecurityGroup", {
      vpc,
      description: "Ops Coach session terminator Lambda",
      allowAllOutbound: true,
    });

    const bootstrapBucket = new s3.Bucket(this, "LabBootstrapBucket", {
      bucketName: `opscoach-lab-bootstrap-${this.account}-${this.region}`.toLowerCase(),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const instanceRole = new iam.Role(this, "LabInstanceRole", {
      roleName: `OpsCoachLabHost-${this.region}`,
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Minimal instance role for Ops Coach lab hosts",
    });
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "LabLogs",
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
        ],
        resources: [
          `arn:${cdk.Aws.PARTITION}:logs:${this.region}:${this.account}:log-group:/opscoach/lab*`,
        ],
      }),
    );
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "LabEcrAuth",
        // GetAuthorizationToken cannot be resource-scoped (API design).
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "LabEcrPull",
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ],
        resources: [
          `arn:${cdk.Aws.PARTITION}:ecr:${this.region}:${this.account}:repository/your-org/opscoach-lab*`,
        ],
      }),
    );

    this.instanceProfile = new iam.CfnInstanceProfile(this, "LabInstanceProfile", {
      instanceProfileName: `OpsCoachLabHost-${this.region}`,
      roles: [instanceRole.roleName],
    });

    const userDataTemplate = fs.readFileSync(path.join(__dirname, "lab-user-data.sh"), "utf8");
    const userData = ec2.UserData.custom(userDataTemplate);

    const ami = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    });

    this.launchTemplate = new ec2.LaunchTemplate(this, "LabLaunchTemplate", {
      launchTemplateName: `opscoach-lab-host-${this.region}`,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      machineImage: ami,
      role: instanceRole,
      securityGroup: this.labSecurityGroup,
      userData,
      requireImdsv2: true,
      // One IMDS hop so a containerized process behind the docker bridge NAT cannot
      // reach instance credentials. (A host-root tenant is still at hop 1 — pair with
      // a host metadata firewall in user-data.)
      httpPutResponseHopLimit: 1,
    });

    this.callbackSecret = new secretsmanager.Secret(this, "CallbackSecret", {
      secretName: "opscoach/web/callback-secret",
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    this.schedulerInvokeRole = new iam.Role(this, "SchedulerInvokeRole", {
      roleName: "OpsCoachSchedulerInvoke",
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description: "Allows EventBridge Scheduler to invoke Ops Coach session terminator",
    });

    const terminatorRole = new iam.Role(this, "SessionTerminatorRole", {
      roleName: "OpsCoachSessionTerminator",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Terminates Ops Coach lab EC2 sessions (scheduled + sweep)",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
      ],
    });
    terminatorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:DescribeInstances",
          "ec2:DescribeTags",
          "ec2:TerminateInstances",
        ],
        resources: ["*"],
      }),
    );
    this.callbackSecret.grantRead(terminatorRole);

    this.terminatorFunction = new lambda.Function(this, "SessionTerminatorFunction", {
      functionName: "OpsCoachSessionTerminator",
      description: "Terminates Ops Coach lab EC2 instances (max TTL schedule + ExpiresAt sweep)",
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "session-terminator")),
      timeout: cdk.Duration.minutes(5),
      role: terminatorRole,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.terminatorSecurityGroup],
      environment: {
        ALLOWED_REGION: config.region,
        DRY_RUN: "false",
        SHUTDOWN_CALLBACK_BASE_URL: shutdownBase,
        // Pass the ARN, not the value — the Lambda fetches it from Secrets Manager at
        // runtime (terminatorRole has grantRead), so no plaintext lands in the template.
        INTERNAL_CALLBACK_SECRET_ARN: this.callbackSecret.secretArn,
      },
    });

    this.schedulerInvokeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [this.terminatorFunction.functionArn],
      }),
    );

    new events.Rule(this, "SessionTerminatorSweep", {
      ruleName: "OpsCoachSessionTerminatorEveryFiveMinutes",
      description: "ExpiresAt backstop sweep for Ops Coach lab EC2 instances",
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new events_targets.LambdaFunction(this.terminatorFunction)],
    });

    new cdk.CfnOutput(this, "LabSecurityGroupId", {
      value: this.labSecurityGroup.securityGroupId,
      description: "Security group for Ops Coach lab EC2 instances",
    });
    new cdk.CfnOutput(this, "LaunchTemplateId", {
      value: this.launchTemplate.launchTemplateId!,
      description: "Launch template for Ops Coach lab EC2 instances",
    });
    new cdk.CfnOutput(this, "LabInstanceProfileArn", {
      value: this.instanceProfile.attrArn,
      description: "Instance profile ARN for Ops Coach lab EC2 instances",
    });
    new cdk.CfnOutput(this, "LabBootstrapBucketName", {
      value: bootstrapBucket.bucketName,
      description: "Optional S3 bucket for lab bootstrap scripts",
    });
    new cdk.CfnOutput(this, "SessionTerminatorFunctionArn", {
      value: this.terminatorFunction.functionArn,
    });
    new cdk.CfnOutput(this, "SchedulerInvokeRoleArn", {
      value: this.schedulerInvokeRole.roleArn,
    });
    new cdk.CfnOutput(this, "CallbackSecretArn", {
      value: this.callbackSecret.secretArn,
    });
  }
}
