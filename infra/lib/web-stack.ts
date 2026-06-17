import * as cdk from "aws-cdk-lib";
import {
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_ecs_patterns as ecs_patterns,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_rds as rds,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import type { OpsCoachLabHostStack } from "./lab-host-stack";
import { OpsCoachWebConfig } from "./web-config";

export interface OpsCoachWebStackProps extends cdk.StackProps {
  readonly config: OpsCoachWebConfig;
}

export class OpsCoachWebStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs_patterns.ApplicationLoadBalancedFargateService;
  public readonly database: rds.DatabaseInstance;
  public readonly repository: ecr.Repository;
  private readonly webTaskRole: iam.Role;

  constructor(scope: Construct, id: string, props: OpsCoachWebStackProps) {
    super(scope, id, props);

    const { config } = props;

    cdk.Tags.of(this).add("OpsCoach", "true");
    cdk.Tags.of(this).add("OpsCoachStack", "web");

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    const fargateSecurityGroup = new ec2.SecurityGroup(this, "FargateSecurityGroup", {
      vpc: this.vpc,
      description: "Ops Coach web Fargate tasks",
      allowAllOutbound: true,
    });

    const databaseSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc: this.vpc,
      description: "Ops Coach web Postgres database",
      allowAllOutbound: false,
    });
    databaseSecurityGroup.addIngressRule(
      fargateSecurityGroup,
      ec2.Port.tcp(5432),
      "Postgres from Fargate tasks",
    );

    const databaseCredentials = new secretsmanager.Secret(this, "DatabaseCredentials", {
      secretName: "opscoach/web/database",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "opscoach" }),
        generateStringKey: "password",
        excludePunctuation: true,
      },
    });

    this.database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      credentials: rds.Credentials.fromSecret(databaseCredentials),
      databaseName: "opscoach",
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      publiclyAccessible: false,
    });

    this.repository = new ecr.Repository(this, "WebRepository", {
      repositoryName: "opscoach-web",
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.cluster = new ecs.Cluster(this, "Cluster", {
      vpc: this.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const taskRole = new iam.Role(this, "WebTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Task role for Ops Coach web app lab provisioning",
    });
    this.webTaskRole = taskRole;
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "LabEc2Discovery",
        actions: [
          "ec2:DescribeInstances",
          "ec2:DescribeImages",
          "ec2:DescribeSubnets",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeLaunchTemplates",
          "ec2:DescribeLaunchTemplateVersions",
          "ec2:DescribeTags",
        ],
        resources: ["*"],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "LabEc2Lifecycle",
        actions: [
          "ec2:RunInstances",
          "ec2:TerminateInstances",
          "ec2:CreateTags",
        ],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "aws:RequestTag/OpsCoach": "true",
          },
        },
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "LabEc2TerminateTagged",
        actions: ["ec2:TerminateInstances"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "aws:ResourceTag/OpsCoach": "true",
          },
        },
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "LabPassRole",
        actions: ["iam:PassRole"],
        resources: [`arn:${cdk.Aws.PARTITION}:iam::${this.account}:role/OpsCoachLabHost-*`],
        conditions: {
          StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" },
        },
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AwsLabCloudFormationRead",
        actions: ["cloudformation:DescribeStacks"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:cloudformation:${this.region}:${this.account}:stack/OpsCoach*/*`,
          `arn:${cdk.Aws.PARTITION}:cloudformation:${this.region}:${this.account}:stack/opscoach-*/*`,
        ],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AwsLabStsAssumeRole",
        actions: ["sts:AssumeRole"],
        resources: [`arn:${cdk.Aws.PARTITION}:iam::*:role/OpsCoach*`],
      }),
    );

    const logGroup = new logs.LogGroup(this, "WebLogGroup", {
      logGroupName: "/opscoach/web",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.service = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "WebService", {
      cluster: this.cluster,
      cpu: 256,
      memoryLimitMiB: 512,
      desiredCount: 1,
      publicLoadBalancer: true,
      listenerPort: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [fargateSecurityGroup],
      assignPublicIp: false,
      openListener: true,
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(this.repository, "latest"),
        containerPort: 8080,
        taskRole,
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: "web",
          logGroup,
        }),
        environment: {
          OPSCOACH_DOMAIN: config.domain ?? "",
          OPSCOACH_REGION: config.region,
          OPSCOACH_IDLE_TIMEOUT_MINUTES: String(config.idleTimeoutMinutes),
          OPSCOACH_MAX_LIFETIME_MINUTES: String(config.maxLifetimeMinutes),
          OPSCOACH_SSH_IDLE_GRACE_SECONDS: String(config.sshIdleGraceSeconds),
          DATABASE_HOST: this.database.dbInstanceEndpointAddress,
          DATABASE_PORT: this.database.dbInstanceEndpointPort,
          DATABASE_NAME: "opscoach",
        },
        secrets: {
          DATABASE_USER: ecs.Secret.fromSecretsManager(databaseCredentials, "username"),
          DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(databaseCredentials, "password"),
        },
      },
    });

    this.service.listener.connections.allowDefaultPortFromAnyIpv4("HTTP from the internet");
    fargateSecurityGroup.connections.allowFrom(
      this.service.loadBalancer,
      ec2.Port.tcp(8080),
      "Traffic from ALB to web container",
    );

    if (config.domain) {
      cdk.Annotations.of(this.service).addInfo(
        `Domain ${config.domain} is configured; attach an ACM certificate and HTTPS listener when ready.`,
      );
    }

    new cdk.CfnOutput(this, "LoadBalancerDNS", {
      value: this.service.loadBalancer.loadBalancerDnsName,
      description: "Public DNS name for the Ops Coach web ALB",
    });
    new cdk.CfnOutput(this, "EcrRepositoryUri", {
      value: this.repository.repositoryUri,
      description: "ECR repository URI for opscoach-web container images",
    });
    new cdk.CfnOutput(this, "DatabaseEndpoint", {
      value: this.database.dbInstanceEndpointAddress,
      description: "RDS Postgres endpoint hostname",
    });
    new cdk.CfnOutput(this, "VpcId", {
      value: this.vpc.vpcId,
      description: "Shared VPC ID for lab host resources",
    });
  }

  /** Wire lab-host Lambda/Scheduler + callback secret after sibling stack is created. */
  public bindLabHost(labHost: OpsCoachLabHostStack): void {
    const container = this.service.taskDefinition.defaultContainer;
    if (!container) {
      throw new Error("OpsCoach web task has no default container");
    }

    labHost.callbackSecret.grantRead(this.webTaskRole);
    this.webTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "SessionScheduler",
        actions: ["scheduler:CreateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:scheduler:${this.region}:${this.account}:schedule/default/opscoach-*`,
        ],
      }),
    );
    this.webTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassSchedulerInvokeRole",
        actions: ["iam:PassRole"],
        resources: [labHost.schedulerInvokeRole.roleArn],
        conditions: {
          StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" },
        },
      }),
    );

    container.addEnvironment(
      "SESSION_TERMINATOR_LAMBDA_ARN",
      labHost.terminatorFunction.functionArn,
    );
    container.addEnvironment(
      "SCHEDULER_INVOKE_ROLE_ARN",
      labHost.schedulerInvokeRole.roleArn,
    );
    container.addSecret(
      "INTERNAL_CALLBACK_SECRET",
      ecs.Secret.fromSecretsManager(labHost.callbackSecret),
    );
  }
}
