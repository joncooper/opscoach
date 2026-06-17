import * as cdk from "aws-cdk-lib";
import {
  aws_cognito as cognito,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_elasticloadbalancingv2_actions as elbv2Actions,
  aws_iam as iam,
  aws_logs as logs,
  aws_rds as rds,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import type { PlatformRefs } from "./platform";
import { internalCallbackBaseUrl, OpsCoachWebConfig } from "./web-config";

export interface OpsCoachServiceStackProps extends cdk.StackProps {
  readonly platform: PlatformRefs;
  readonly config: OpsCoachWebConfig;
  readonly callbackSecret: secretsmanager.ISecret;
  readonly sessionTerminatorLambdaArn: string;
  readonly schedulerInvokeRoleArn: string;
  /** Resolved at synth when lab-host stack is in the same app. */
  readonly launchTemplateId?: string;
  readonly publicSubnetId?: string;
  readonly labSecurityGroup: ec2.ISecurityGroup;
  readonly terminatorSecurityGroup: ec2.ISecurityGroup;
}

/**
 * Ops Coach web + API on the shared Platform Fargate cluster and ALB.
 * Mirrors mono-playground LlmProxyStack wiring; does not create VPC/ALB/cluster.
 */
export class OpsCoachServiceStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly database: rds.DatabaseInstance;
  public readonly taskRole: iam.Role;
  public readonly callbackSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: OpsCoachServiceStackProps) {
    super(scope, id, props);

    const { platform, config } = props;
    const hostName = config.hostName ?? "opscoach.local";
    const containerPort = 3000;
    const launchTemplateId = props.launchTemplateId ?? config.launchTemplateId ?? "";
    const publicSubnetId = props.publicSubnetId ?? config.publicSubnetId ?? "";
    const internalCallbackUrl = internalCallbackBaseUrl(config, containerPort);
    this.callbackSecret = props.callbackSecret;

    cdk.Tags.of(this).add("OpsCoach", "true");
    cdk.Tags.of(this).add("OpsCoachStack", "service");

    const serviceSecurityGroup = new ec2.SecurityGroup(this, "ServiceSecurityGroup", {
      vpc: platform.vpc,
      description: "Ops Coach Fargate tasks",
      allowAllOutbound: true,
    });

    const databaseSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc: platform.vpc,
      description: "Ops Coach Postgres",
      allowAllOutbound: false,
    });
    databaseSecurityGroup.addIngressRule(
      serviceSecurityGroup,
      ec2.Port.tcp(5432),
      "Postgres from Ops Coach tasks",
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
      vpc: platform.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [databaseSecurityGroup],
      credentials: rds.Credentials.fromSecret(databaseCredentials),
      databaseName: "opscoach",
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      publiclyAccessible: false,
    });

    this.taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Ops Coach web task - lab EC2 lifecycle and grader SSH",
    });
    this.taskRole.addToPolicy(
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
    const ec2Arn = (resource: string) =>
      `arn:${cdk.Aws.PARTITION}:ec2:${this.region}:${this.account}:${resource}`;

    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "LabEc2RunInstancesDependencies",
        actions: ["ec2:RunInstances"],
        resources: [
          ec2Arn("launch-template/*"),
          ec2Arn("subnet/*"),
          ec2Arn("security-group/*"),
          ec2Arn("image/*"),
          // Amazon-owned AMIs (AL2023) use an empty account segment in the ARN.
          `arn:${cdk.Aws.PARTITION}:ec2:${this.region}::image/*`,
          ec2Arn("volume/*"),
          ec2Arn("network-interface/*"),
        ],
      }),
    );
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "LabEc2RunInstances",
        actions: ["ec2:RunInstances"],
        resources: [ec2Arn("instance/*")],
        conditions: {
          StringEquals: {
            "aws:RequestTag/OpsCoach": "true",
          },
        },
      }),
    );
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "LabEc2CreateTags",
        actions: ["ec2:CreateTags"],
        resources: [
          ec2Arn("instance/*"),
          ec2Arn("volume/*"),
          ec2Arn("network-interface/*"),
        ],
        conditions: {
          StringEquals: {
            "aws:RequestTag/OpsCoach": "true",
          },
        },
      }),
    );
    this.taskRole.addToPolicy(
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
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "LabPassRole",
        actions: ["iam:PassRole"],
        resources: [`arn:${cdk.Aws.PARTITION}:iam::${this.account}:role/OpsCoachLabHost-*`],
        conditions: {
          StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" },
        },
      }),
    );
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "SessionScheduler",
        actions: [
          "scheduler:CreateSchedule",
          "scheduler:DeleteSchedule",
          "scheduler:GetSchedule",
        ],
        resources: [
          `arn:${cdk.Aws.PARTITION}:scheduler:${this.region}:${this.account}:schedule/default/opscoach-*`,
        ],
      }),
    );
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassSchedulerInvokeRole",
        actions: ["iam:PassRole"],
        resources: [props.schedulerInvokeRoleArn],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "scheduler.amazonaws.com",
          },
        },
      }),
    );
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AwsLabCloudFormationRead",
        actions: ["cloudformation:DescribeStacks"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:cloudformation:${this.region}:${this.account}:stack/OpsCoach*/*`,
          `arn:${cdk.Aws.PARTITION}:cloudformation:${this.region}:${this.account}:stack/Dev-OpsCoach*/*`,
          `arn:${cdk.Aws.PARTITION}:cloudformation:${this.region}:${this.account}:stack/opscoach-*/*`,
        ],
      }),
    );
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AwsLabStsAssumeRole",
        // Only OpsCoach-named lab roles; tightened to the specific lab account
        // in the cross-account provisioning work.
        actions: ["sts:AssumeRole"],
        resources: [`arn:${cdk.Aws.PARTITION}:iam::*:role/OpsCoach*`],
      }),
    );
    databaseCredentials.grantRead(this.taskRole);
    this.callbackSecret.grantRead(this.taskRole);

    const repo = ecr.Repository.fromRepositoryName(
      this,
      "Repo",
      config.ecrRepositoryName ?? "your-org/opscoach-web",
    );

    const taskDef = new ecs.FargateTaskDefinition(this, "Task", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
      taskRole: this.taskRole,
    });

    const webContainer = taskDef.addContainer("opscoach-web", {
      image: ecs.ContainerImage.fromEcrRepository(repo, "latest"),
      environment: {
        PORT: String(containerPort),
        // Override ECS-injected HOSTNAME so Next.js binds 0.0.0.0 for ALB health checks.
        HOSTNAME: "0.0.0.0",
        CONTENT_ROOT: "/app/ContentPacks",
        OPSCOACH_REGION: this.region,
        OPSCOACH_IDLE_TIMEOUT_MINUTES: String(config.idleTimeoutMinutes),
        OPSCOACH_MAX_LIFETIME_MINUTES: String(config.maxLifetimeMinutes),
        OPSCOACH_SSH_IDLE_GRACE_SECONDS: String(config.sshIdleGraceSeconds),
        APP_BASE_URL: `https://${hostName}`,
        INTERNAL_CALLBACK_BASE_URL: internalCallbackUrl,
        DATABASE_HOST: this.database.dbInstanceEndpointAddress,
        DATABASE_PORT: this.database.dbInstanceEndpointPort,
        DATABASE_NAME: "opscoach",
        DATABASE_SSL: "require",
        EC2_LAUNCH_TEMPLATE_ID: launchTemplateId,
        EC2_PUBLIC_SUBNET_ID: publicSubnetId,
        SESSION_TERMINATOR_LAMBDA_ARN: props.sessionTerminatorLambdaArn,
        SCHEDULER_INVOKE_ROLE_ARN: props.schedulerInvokeRoleArn,
        AWS_REGION: this.region,
        OPSCOACH_LAB_ECR_PREFIX: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/your-org/opscoach-lab`,
      },
      secrets: {
        DATABASE_USER: ecs.Secret.fromSecretsManager(databaseCredentials, "username"),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(databaseCredentials, "password"),
        INTERNAL_CALLBACK_SECRET: ecs.Secret.fromSecretsManager(this.callbackSecret),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "opscoach-web",
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      portMappings: [{ name: "http", containerPort }],
    });

    this.service = new ecs.FargateService(this, "Service", {
      cluster: platform.cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      capacityProviderStrategies: [{ capacityProvider: "FARGATE", weight: 1 }],
      circuitBreaker: { rollback: true },
      cloudMapOptions: {
        name: config.cloudMapServiceName ?? "opscoach-web",
        cloudMapNamespace: platform.cloudMapNamespace,
      },
      // ALB registers task IP:3000 directly; Service Connect on the same port
      // intercepts health checks in Envoy and caused Target.Timeout (see playground HOSTNAME=::).
    });

    this.service.connections.allowFrom(platform.alb, ec2.Port.tcp(containerPort), "ALB to Ops Coach");
    // Imported ALB SG uses explicit egress allowlists; allowFrom alone only opens task ingress.
    platform.alb.connections.allowTo(
      serviceSecurityGroup,
      ec2.Port.tcp(containerPort),
      "ALB egress to Ops Coach",
    );
    this.service.connections.allowFrom(
      props.labSecurityGroup,
      ec2.Port.tcp(containerPort),
      "Lab EC2 session callbacks",
    );
    this.service.connections.allowFrom(
      props.terminatorSecurityGroup,
      ec2.Port.tcp(containerPort),
      "Session terminator Lambda callbacks",
    );
    // Grader SSH reaches lab hosts only from the web task (the lab SG dropped its
    // VPC-wide :22 rule). Created as an explicit Cfn rule in this stack — which already
    // depends on the lab-host stack — to avoid a cross-stack dependency cycle that
    // connections.allowFrom on the imported lab SG would introduce.
    new ec2.CfnSecurityGroupIngress(this, "LabGraderSshFromTask", {
      groupId: props.labSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 22,
      toPort: 22,
      sourceSecurityGroupId: serviceSecurityGroup.securityGroupId,
      description: "Grader SSH from web task",
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc: platform.vpc,
      port: containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { path: "/api/health", healthyHttpCodes: "200" },
      targets: [
        this.service.loadBalancerTarget({
          containerName: "opscoach-web",
          containerPort,
        }),
      ],
    });

    const listenerPriority = config.listenerRulePriority ?? 40;
    const bypassPriority = config.listenerBypassRulePriority ?? listenerPriority - 1;
    const cognitoReady =
      config.cognitoAuthEnabled !== false &&
      Boolean(config.cognitoUserPoolId?.trim()) &&
      Boolean(config.cognitoDomainName?.trim());

    if (cognitoReady) {
      const userPool = cognito.UserPool.fromUserPoolId(
        this,
        "ImportedUserPool",
        config.cognitoUserPoolId!.trim(),
      );
      const userPoolDomain = cognito.UserPoolDomain.fromDomainName(
        this,
        "ImportedUserPoolDomain",
        config.cognitoDomainName!.trim(),
      );
      const homeUrl = `https://${hostName}/`;
      const albClient = new cognito.UserPoolClient(this, "AlbClient", {
        userPool,
        userPoolClientName: "alb-opscoach-web",
        generateSecret: true,
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [
            cognito.OAuthScope.OPENID,
            cognito.OAuthScope.EMAIL,
            cognito.OAuthScope.PROFILE,
          ],
          callbackUrls: [`https://${hostName}/oauth2/idpresponse`],
          logoutUrls: [homeUrl, `https://${hostName}/logged-out`],
        },
        supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
        preventUserExistenceErrors: true,
      });

      // Give the running app what it needs for a correct hosted-UI logout:
      // /logout clears the ALB cookies, then redirects to https://<domain>/logout?client_id=...
      webContainer.addEnvironment("COGNITO_DOMAIN", config.cognitoDomainName!.trim());
      webContainer.addEnvironment("COGNITO_CLIENT_ID", albClient.userPoolClientId);

      // Bypass Cognito auth for ALB health checks and for /logout, so sign-out is not
      // itself gated by a valid session (mirrors the play service's /logout rule).
      // Lab callbacks use Cloud Map inside the VPC, not this public listener.
      new elbv2.ApplicationListenerRule(this, "HttpsCallbackBypassRule", {
        listener: platform.httpsListener,
        priority: bypassPriority,
        conditions: [
          elbv2.ListenerCondition.hostHeaders([hostName]),
          elbv2.ListenerCondition.pathPatterns(["/api/health", "/logout", "/logged-out"]),
        ],
        action: elbv2.ListenerAction.forward([targetGroup]),
      });

      new elbv2.ApplicationListenerRule(this, "HttpsRule", {
        listener: platform.httpsListener,
        priority: listenerPriority,
        conditions: [elbv2.ListenerCondition.hostHeaders([hostName])],
        action: new elbv2Actions.AuthenticateCognitoAction({
          userPool,
          userPoolClient: albClient,
          userPoolDomain,
          scope: "openid email profile",
          sessionTimeout: cdk.Duration.hours(12),
          onUnauthenticatedRequest: elbv2.UnauthenticatedAction.AUTHENTICATE,
          next: elbv2.ListenerAction.forward([targetGroup]),
        }),
      });

      new cdk.CfnOutput(this, "CognitoAlbClientId", {
        value: albClient.userPoolClientId,
        description: "Ops Coach ALB OAuth client (Dev-OpsCoach stack)",
      });
    } else {
      new elbv2.ApplicationListenerRule(this, "HttpsRule", {
        listener: platform.httpsListener,
        priority: listenerPriority,
        conditions: [elbv2.ListenerCondition.hostHeaders([hostName])],
        action: elbv2.ListenerAction.forward([targetGroup]),
      });
    }

    new cdk.CfnOutput(this, "Endpoint", {
      value: `https://${hostName}`,
      description: "Ops Coach public URL",
    });
    new cdk.CfnOutput(this, "DatabaseEndpoint", {
      value: this.database.dbInstanceEndpointAddress,
    });
    new cdk.CfnOutput(this, "EcrRepository", {
      value: config.ecrRepositoryName ?? "your-org/opscoach-web",
    });
    new cdk.CfnOutput(this, "CallbackSecretArn", {
      value: this.callbackSecret.secretArn,
    });
    new cdk.CfnOutput(this, "InternalCallbackBaseUrl", {
      value: internalCallbackUrl,
      description: "In-VPC base URL for EC2/Lambda session webhooks (Cloud Map)",
    });
  }
}
