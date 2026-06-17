import * as cdk from "aws-cdk-lib";

export interface OpsCoachWebConfig {
  readonly region: string;
  readonly idleTimeoutMinutes: number;
  /** Hard backstop — EventBridge one-time schedule + ExpiresAt tag. */
  readonly maxLifetimeMinutes: number;
  /** Host-side debounce after last SSH disconnect before shutdown webhook. */
  readonly sshIdleGraceSeconds: number;
  /** Standalone stack only */
  readonly domain?: string;
  readonly labAccountId?: string;
  /** platform deploy */
  readonly hostName?: string;
  readonly ecrRepositoryName?: string;
  readonly listenerRulePriority?: number;
  /** ALB rule priority for unauthenticated lab callback paths (must be < listenerRulePriority). */
  readonly listenerBypassRulePriority?: number;
  readonly launchTemplateId?: string;
  readonly publicSubnetId?: string;
  /** Shared Platform Cognito user pool (Dev-WorkspaceAuth / Dev-Auth). */
  readonly cognitoUserPoolId?: string;
  /** Full hosted UI domain, e.g. your-pool.auth.us-east-1.amazoncognito.com */
  readonly cognitoDomainName?: string;
  /** When false, ALB forwards without authenticate-cognito (local / rollback). */
  readonly cognitoAuthEnabled?: boolean;
  /** Cloud Map service name for in-VPC callbacks, e.g. opscoach-web.ops.internal */
  readonly cloudMapServiceName?: string;
  readonly cloudMapNamespaceName?: string;
}

function requiredContext(scope: cdk.App, key: string): string {
  const value = scope.node.tryGetContext(key);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required CDK context value: ${key}`);
  }
  return value.trim();
}

function optionalContext(scope: cdk.App, key: string, fallback?: string): string | undefined {
  const value = scope.node.tryGetContext(key);
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return fallback;
}

function optionalNumberContext(scope: cdk.App, key: string, fallback: number): number {
  const value = scope.node.tryGetContext(key);
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`CDK context value ${key} must be a positive number`);
  }
  return parsed;
}

/** Standalone VPC + ALB deploy (local dev account or greenfield). */
export function loadWebConfig(app: cdk.App): OpsCoachWebConfig {
  return {
    region: optionalContext(app, "region", "us-east-1")!,
    idleTimeoutMinutes: optionalNumberContext(app, "idleTimeoutMinutes", 10),
    maxLifetimeMinutes: optionalNumberContext(app, "maxLifetimeMinutes", 60),
    sshIdleGraceSeconds: optionalNumberContext(app, "sshIdleGraceSeconds", 120),
    domain: optionalContext(app, "domain"),
    labAccountId: requiredContext(app, "labAccountId"),
  };
}

/** shared platform (mono-playground) deploy. */
export function loadPlatformOpsCoachConfig(app: cdk.App, zoneName: string): OpsCoachWebConfig {
  const hostLabel = optionalContext(app, "opscoachHostLabel", "opscoach")!;

  return {
    region: optionalContext(app, "region", "us-east-1")!,
    idleTimeoutMinutes: optionalNumberContext(app, "idleTimeoutMinutes", 10),
    maxLifetimeMinutes: optionalNumberContext(app, "maxLifetimeMinutes", 60),
    sshIdleGraceSeconds: optionalNumberContext(app, "sshIdleGraceSeconds", 120),
    hostName: `${hostLabel}.${zoneName}`,
    ecrRepositoryName: optionalContext(app, "opscoachEcrRepository", "your-org/opscoach-web"),
    listenerRulePriority: optionalNumberContext(app, "opscoachListenerPriority", 40),
    listenerBypassRulePriority: optionalNumberContext(
      app,
      "opscoachListenerBypassPriority",
      39,
    ),
    launchTemplateId: app.node.tryGetContext("launchTemplateId"),
    publicSubnetId: app.node.tryGetContext("publicSubnetId"),
    cognitoUserPoolId: optionalContext(app, "platformCognitoUserPoolId"),
    cognitoDomainName: optionalContext(app, "platformCognitoDomainName"),
    cognitoAuthEnabled: app.node.tryGetContext("opscoachCognitoAuth") !== false,
    cloudMapServiceName: optionalContext(app, "opscoachCloudMapServiceName", "opscoach-web"),
    cloudMapNamespaceName: optionalContext(app, "platformCloudMapNamespaceName", "ops.internal"),
  };
}

export function internalCallbackBaseUrl(config: OpsCoachWebConfig, port = 3000): string {
  const service = config.cloudMapServiceName ?? "opscoach-web";
  const namespace = config.cloudMapNamespaceName ?? "ops.internal";
  return `http://${service}.${namespace}:${port}`;
}
