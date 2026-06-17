import fs from "fs/promises";
import path from "path";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { LabManifest, LabReference } from "./types";

export interface AWSLabManifest {
  scenarioStackName: string;
  platformStackName: string;
  region: string;
  sourceProfile: string;
  labAdminProfile: string;
  candidateRoleOutput: string;
  graderRoleOutput: string;
  starterFilesDirectory: string;
}

export type LabWithAws = LabManifest & { aws?: AWSLabManifest };

export interface AwsSessionMetadata {
  accountId: string;
  region: string;
  sourceProfile: string;
  labAdminProfile: string;
  scenarioStackName: string;
  platformStackName: string;
  candidateRoleArn: string;
  graderRoleArn: string;
  outputs: Record<string, string>;
}

export interface PrepareAwsSessionInput {
  reference: LabReference;
  sessionId: string;
  sessionRoot: string;
}

export class AwsLabManagerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "missingAWSManifest"
      | "missingStarterFiles"
      | "missingCloudFormationStack"
      | "missingCloudFormationOutput"
      | "invalidAWSResponse"
      | "awsCommandFailed" = "awsCommandFailed"
  ) {
    super(message);
    this.name = "AwsLabManagerError";
  }
}

interface AwsLabRuntimeConfig {
  scenarioStackName: string;
  platformStackName: string;
  region: string;
  sourceProfile: string;
  labAdminProfile: string;
  candidateRoleOutput: string;
  graderRoleOutput: string;
  candidateRoleArn?: string;
  graderRoleArn?: string;
  candidateDurationSeconds: number;
}

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export function isAwsLab(lab: LabWithAws): boolean {
  return lab.aws != null;
}

export async function prepareAwsSession(
  input: PrepareAwsSessionInput
): Promise<void> {
  const { reference, sessionId, sessionRoot } = input;
  const manifest = (reference.lab as LabWithAws).aws;
  if (!manifest) {
    return;
  }

  const config = buildRuntimeConfig(manifest, process.env);
  const platformOutputs = await stackOutputs(
    config.platformStackName,
    config.region
  );
  const scenarioOutputs = await stackOutputs(
    config.scenarioStackName,
    config.region
  );

  const candidateRoleArn =
    config.candidateRoleArn ??
    requiredOutput(
      config.candidateRoleOutput,
      platformOutputs,
      config.platformStackName
    );
  const graderRoleArn =
    config.graderRoleArn ??
    requiredOutput(
      config.graderRoleOutput,
      platformOutputs,
      config.platformStackName
    );

  const credentials = await assumeRole({
    roleArn: candidateRoleArn,
    region: config.region,
    sessionName: `opscoach-${sessionId.slice(0, 12).toLowerCase()}`,
    durationSeconds: config.candidateDurationSeconds,
  });

  const starterSource = path.join(
    reference.packRoot,
    manifest.starterFilesDirectory
  );
  try {
    await fs.access(starterSource);
  } catch {
    throw new AwsLabManagerError(
      `AWS starter files are missing: ${starterSource}`,
      "missingStarterFiles"
    );
  }

  const awsSessionRoot = path.join(sessionRoot, "aws-session");
  const graderRoot = path.join(sessionRoot, "aws-grader");
  const workspaceRoot = path.join(sessionRoot, "aws-workspace");

  await recreateDirectory(awsSessionRoot);
  await recreateDirectory(graderRoot);
  await recreateDirectory(workspaceRoot);
  await fs.chmod(awsSessionRoot, 0o755);
  await fs.chmod(graderRoot, 0o755);
  await fs.chmod(workspaceRoot, 0o777);

  const metadata: AwsSessionMetadata = {
    accountId: accountIdFromRoleArn(candidateRoleArn),
    region: config.region,
    sourceProfile: config.sourceProfile,
    labAdminProfile: config.labAdminProfile,
    scenarioStackName: config.scenarioStackName,
    platformStackName: config.platformStackName,
    candidateRoleArn,
    graderRoleArn,
    outputs: scenarioOutputs,
  };

  await writeCredentialFiles(credentials, config.region, awsSessionRoot);
  await hydrateWorkspace(starterSource, workspaceRoot, metadata);

  await writeJson(
    metadata,
    path.join(graderRoot, "metadata.json")
  );
  await writeResourceMap(
    metadata,
    path.join(workspaceRoot, "resource-map.env")
  );
}

function buildRuntimeConfig(
  manifest: AWSLabManifest,
  environment: NodeJS.ProcessEnv
): AwsLabRuntimeConfig {
  return {
    scenarioStackName:
      environment.OPSCOACH_AWS_SCENARIO_STACK ?? manifest.scenarioStackName,
    platformStackName:
      environment.OPSCOACH_AWS_PLATFORM_STACK ?? manifest.platformStackName,
    region: environment.OPSCOACH_AWS_REGION ?? manifest.region,
    sourceProfile: manifest.sourceProfile,
    labAdminProfile: manifest.labAdminProfile,
    candidateRoleOutput: manifest.candidateRoleOutput,
    graderRoleOutput: manifest.graderRoleOutput,
    candidateRoleArn: environment.OPSCOACH_AWS_CANDIDATE_ROLE_ARN,
    graderRoleArn: environment.OPSCOACH_AWS_GRADER_ROLE_ARN,
    candidateDurationSeconds:
      Number(environment.OPSCOACH_AWS_CANDIDATE_DURATION_SECONDS) || 3600,
  };
}

async function stackOutputs(
  stackName: string,
  region: string
): Promise<Record<string, string>> {
  const client = new CloudFormationClient({ region });
  try {
    const response = await client.send(
      new DescribeStacksCommand({ StackName: stackName })
    );
    const stack = response.Stacks?.[0];
    if (!stack) {
      throw new AwsLabManagerError(
        `AWS stack was not found or returned no outputs: ${stackName}`,
        "missingCloudFormationStack"
      );
    }
    const outputs: Record<string, string> = {};
    for (const output of stack.Outputs ?? []) {
      if (output.OutputKey && output.OutputValue) {
        outputs[output.OutputKey] = output.OutputValue;
      }
    }
    return outputs;
  } catch (error) {
    if (error instanceof AwsLabManagerError) {
      throw error;
    }
    const detail =
      error instanceof Error ? error.message : String(error);
    throw new AwsLabManagerError(
      `AWS command failed: ${detail}`,
      "awsCommandFailed"
    );
  }
}

function requiredOutput(
  name: string,
  outputs: Record<string, string>,
  stackName: string
): string {
  const value = outputs[name];
  if (!value) {
    throw new AwsLabManagerError(
      `AWS stack ${stackName} is missing output ${name}.`,
      "missingCloudFormationOutput"
    );
  }
  return value;
}

async function assumeRole(options: {
  roleArn: string;
  region: string;
  sessionName: string;
  durationSeconds: number;
}): Promise<AwsCredentials> {
  const client = new STSClient({ region: options.region });
  try {
    const response = await client.send(
      new AssumeRoleCommand({
        RoleArn: options.roleArn,
        RoleSessionName: options.sessionName,
        DurationSeconds: options.durationSeconds,
      })
    );
    const credentials = response.Credentials;
    if (
      !credentials?.AccessKeyId ||
      !credentials.SecretAccessKey ||
      !credentials.SessionToken
    ) {
      throw new AwsLabManagerError(
        "AWS STS assume-role returned incomplete credentials",
        "invalidAWSResponse"
      );
    }
    return {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    };
  } catch (error) {
    if (error instanceof AwsLabManagerError) {
      throw error;
    }
    const detail =
      error instanceof Error ? error.message : String(error);
    throw new AwsLabManagerError(
      `AWS command failed: ${detail}`,
      "awsCommandFailed"
    );
  }
}

async function recreateDirectory(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true });
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeCredentialFiles(
  credentials: AwsCredentials,
  region: string,
  root: string
): Promise<void> {
  const credentialsText = `[default]
aws_access_key_id=${credentials.accessKeyId}
aws_secret_access_key=${credentials.secretAccessKey}
aws_session_token=${credentials.sessionToken}

[opscoach]
aws_access_key_id=${credentials.accessKeyId}
aws_secret_access_key=${credentials.secretAccessKey}
aws_session_token=${credentials.sessionToken}

`;
  const configText = `[default]
region=${region}
output=json

[profile opscoach]
region=${region}
output=json

`;
  const credentialsPath = path.join(root, "credentials");
  const configPath = path.join(root, "config");
  const regionPath = path.join(root, "region");

  await fs.writeFile(credentialsPath, credentialsText, "utf8");
  await fs.writeFile(configPath, configText, "utf8");
  await fs.writeFile(regionPath, `${region}\n`, "utf8");
  await fs.chmod(credentialsPath, 0o644);
  await fs.chmod(configPath, 0o644);
  await fs.chmod(regionPath, 0o644);
}

async function hydrateWorkspace(
  source: string,
  workspaceRoot: string,
  metadata: AwsSessionMetadata
): Promise<void> {
  const templatesRoot = path.join(workspaceRoot, "templates");
  await fs.mkdir(templatesRoot, { recursive: true });

  const children = await fs.readdir(source, { withFileTypes: true });
  for (const child of children) {
    if (child.name.startsWith(".")) {
      continue;
    }

    const sourcePath = path.join(source, child.name);
    const rootLevelFiles = ["findings.md", "AWS_CLI_QUICK_REFERENCE.md"];
    let target = rootLevelFiles.includes(child.name)
      ? path.join(workspaceRoot, child.name)
      : path.join(templatesRoot, child.name);

    if (child.isDirectory()) {
      target = path.join(templatesRoot, child.name);
      await fs.cp(sourcePath, target, { recursive: true });
      continue;
    }

    const raw = await fs.readFile(sourcePath, "utf8");
    const hydrated = hydrateTemplateText(raw, metadata);
    await fs.writeFile(target, hydrated, "utf8");
  }

  const findingsPath = path.join(workspaceRoot, "findings.md");
  try {
    await fs.access(findingsPath);
    await fs.chmod(findingsPath, 0o666);
  } catch {
    // findings.md may be absent in some packs
  }

  await writeWorkspaceReadme(workspaceRoot);
}

export function hydrateTemplateText(
  raw: string,
  metadata: AwsSessionMetadata
): string {
  const outputs = metadata.outputs;
  return raw
    .replaceAll("REPLACE_WITH_ACCOUNT_ID", metadata.accountId)
    .replaceAll("REPLACE_WITH_REGION", metadata.region)
    .replaceAll(
      "REPLACE_WITH_RESEARCH_BUCKET_NAME",
      outputs.DataBucketName ?? ""
    )
    .replaceAll(
      "REPLACE_WITH_LAUNCH_TEMPLATE_ID",
      outputs.LaunchTemplateId ?? ""
    )
    .replaceAll("REPLACE_WITH_TRAIL_NAME", outputs.TrailName ?? "")
    .replaceAll(
      "REPLACE_WITH_SECURITY_GROUP_ID",
      outputs.SecurityGroupId ?? ""
    )
    .replaceAll("REPLACE_SESSION_ID", outputs.SessionId ?? "")
    .replaceAll(
      "REPLACE_WITH_ALARM_TOPIC_ARN",
      outputs.AlarmTopicArn ?? ""
    );
}

export async function writeWorkspaceReadme(
  workspaceRoot: string
): Promise<void> {
  const text = `# AWS Security Basics

You are in a dedicated AWS lab account with short-lived credentials. Work from this directory.

## Start Here

1. Confirm the assigned resource names are loaded:

   echo "$RESEARCH_BUCKET_NAME"

2. Confirm your AWS identity:

   aws sts get-caller-identity

3. Inspect the resource map:

   cat resource-map.env

The research bucket is the bucket named by \`RESEARCH_BUCKET_NAME\`. The other variables name the security group, launch template, CloudTrail trail, alert topic, and audit role assigned to this lab.

New shells source \`resource-map.env\` automatically. If you open a shell before the file exists or want to refresh values, run \`source ./resource-map.env\`.

If you need AWS CLI syntax help, read \`AWS_CLI_QUICK_REFERENCE.md\`. It explains command shape, completion, \`file://\`, \`--query\`, and common error meanings without listing a solve path.

## Target State

Bring only the assigned resources to this final state:

- \`RESEARCH_BUCKET_NAME\`: versioning is enabled.
- \`RESEARCH_BUCKET_NAME\`: all four S3 public-access-block settings are enabled.
- \`SECURITY_GROUP_ID\`: public SSH ingress from \`0.0.0.0/0\` is removed.
- \`SECURITY_GROUP_ID\`: internal HTTPS ingress from \`10.44.0.0/16\` remains.
- \`LAUNCH_TEMPLATE_ID\`: the default launch template version does not assign a public IP.
- \`LAUNCH_TEMPLATE_ID\`: the default launch template version requires IMDSv2 tokens.
- \`LAUNCH_TEMPLATE_ID\`: the default launch template version uses encrypted root storage.
- \`TRAIL_NAME\`: CloudTrail log file validation is enabled.
- CloudWatch: a root-account-use alarm named \`OpsCoach-$OPSCOACH_SESSION_ID-RootAccountUsage\` sends to \`ALARM_TOPIC_ARN\`.
- \`findings.md\`: records the resources you changed and the final state.

Do not create EC2 instances. Do not change unrelated account resources.

## Starter Files

The \`templates/\` directory contains starter request bodies for AWS CLI operations that would otherwise require dense JSON. Edit them as needed before using them.

`;
  await fs.writeFile(path.join(workspaceRoot, "README.md"), text, "utf8");
}

export async function writeResourceMap(
  metadata: AwsSessionMetadata,
  filePath: string
): Promise<void> {
  const outputs = metadata.outputs;
  const lines = [
    "# Assigned AWS resources for this lab.",
    "# Source this file before running CLI examples: source ./resource-map.env",
    `export AWS_ACCOUNT_ID=${shellSingleQuote(metadata.accountId)}`,
    `export AWS_REGION=${shellSingleQuote(metadata.region)}`,
    `export OPSCOACH_SESSION_ID=${shellSingleQuote(outputs.SessionId ?? "")}`,
    `export RESEARCH_BUCKET_NAME=${shellSingleQuote(outputs.DataBucketName ?? "")}`,
    'export DATA_BUCKET_NAME="$RESEARCH_BUCKET_NAME"',
    `export SECURITY_GROUP_ID=${shellSingleQuote(outputs.SecurityGroupId ?? "")}`,
    `export LAUNCH_TEMPLATE_ID=${shellSingleQuote(outputs.LaunchTemplateId ?? "")}`,
    `export TRAIL_NAME=${shellSingleQuote(outputs.TrailName ?? "")}`,
    `export ALARM_TOPIC_ARN=${shellSingleQuote(outputs.AlarmTopicArn ?? "")}`,
    `export AUDIT_ROLE_NAME=${shellSingleQuote(outputs.AuditRoleName ?? "")}`,
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function accountIdFromRoleArn(roleArn: string): string {
  const parts = roleArn.split(":");
  if (parts.length <= 4 || !parts[4]) {
    throw new AwsLabManagerError(
      `Could not parse account ID from ${roleArn}`,
      "invalidAWSResponse"
    );
  }
  return parts[4];
}

async function writeJson(value: unknown, filePath: string): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
