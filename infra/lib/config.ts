import * as cdk from "aws-cdk-lib";

export interface OpsCoachAwsConfig {
  readonly labAccountId: string;
  readonly managementAccountId: string;
  readonly managementRegion: string;
  readonly adminPrincipalArn: string;
  readonly allowedRegion: string;
  readonly labName: string;
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly maxSessionHours: number;
  readonly budgetLimitUsd: number;
  readonly notificationEmail?: string;
}

function requiredContext(scope: cdk.App, key: string): string {
  const value = scope.node.tryGetContext(key);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required CDK context value: ${key}`);
  }
  return value.trim();
}

function optionalContext(scope: cdk.App, key: string, fallback: string): string {
  const value = scope.node.tryGetContext(key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
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

function defaultExpiry(): string {
  const expires = new Date(Date.now() + 6 * 60 * 60 * 1000);
  return expires.toISOString();
}

function accountIdFromArn(arn: string): string {
  const match = arn.match(/^arn:[^:]+:iam::([0-9]{12}):/);
  if (!match) {
    throw new Error(`Could not parse management account ID from adminPrincipalArn: ${arn}`);
  }
  return match[1];
}

function validateAccountId(key: string, value: string): void {
  if (!/^[0-9]{12}$/.test(value)) {
    throw new Error(`${key} must be a 12-digit AWS account ID`);
  }
}

export function loadConfig(app: cdk.App): OpsCoachAwsConfig {
  const sessionId = optionalContext(app, "sessionId", "dev");
  if (!/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(sessionId)) {
    throw new Error("sessionId must be 2-32 lowercase letters, numbers, or hyphens, and must start/end with a letter or number");
  }
  const labAccountId = requiredContext(app, "labAccountId");
  validateAccountId("labAccountId", labAccountId);
  const adminPrincipalArn = requiredContext(app, "adminPrincipalArn");
  const managementAccountId = optionalContext(app, "managementAccountId", accountIdFromArn(adminPrincipalArn));
  validateAccountId("managementAccountId", managementAccountId);

  return {
    labAccountId,
    managementAccountId,
    managementRegion: optionalContext(app, "managementRegion", "us-east-1"),
    adminPrincipalArn,
    allowedRegion: optionalContext(app, "allowedRegion", "us-east-1"),
    labName: optionalContext(app, "labName", "aws-security-basics"),
    sessionId,
    expiresAt: optionalContext(app, "expiresAt", defaultExpiry()),
    maxSessionHours: optionalNumberContext(app, "maxSessionHours", 3),
    budgetLimitUsd: optionalNumberContext(app, "budgetLimitUsd", 25),
    notificationEmail: app.node.tryGetContext("notificationEmail"),
  };
}

export function resourcePrefix(config: OpsCoachAwsConfig): string {
  return `opscoach-${config.sessionId}`;
}

export function commonTags(config: OpsCoachAwsConfig): Record<string, string> {
  return {
    OpsCoach: "true",
    LabId: config.labName,
    SessionId: config.sessionId,
    ExpiresAt: config.expiresAt,
  };
}
