import { buildLabUserData } from "./lab-user-data";
import { formatEc2Error, validateLabEc2Environment } from "./ec2-errors";
import { isPublicRoutableIp } from "./ip-address";
import { scheduleSessionTermination } from "./session-scheduler";
import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type RunInstancesCommandInput,
} from "@aws-sdk/client-ec2";

export interface ProvisionResult {
  instanceId: string;
  /** Public IP shown to the learner for SSH. */
  sshHost: string | null;
  /** Private IP used by the grader from inside the VPC. */
  graderHost: string | null;
  sshPort: number;
  mock: boolean;
}

function getEc2Client(): EC2Client {
  const region = process.env.AWS_REGION ?? process.env.OPSCOACH_REGION ?? "us-east-1";
  return new EC2Client({ region });
}

export function isMockEc2Mode(): boolean {
  return !process.env.EC2_LAUNCH_TEMPLATE_ID?.trim();
}

function maxLifetimeMinutes(override?: number): number {
  return override ?? Number(process.env.OPSCOACH_MAX_LIFETIME_MINUTES ?? "60");
}

function expiresAtTag(lifetimeMinutes?: number): string {
  const ms = Date.now() + maxLifetimeMinutes(lifetimeMinutes) * 60_000;
  return new Date(ms).toISOString();
}

/** EC2 DescribeInstances can briefly return NotFound right after RunInstances. */
function isEc2DescribeConsistencyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code =
    error.name ||
    ("Code" in error && typeof error.Code === "string" ? error.Code : "");
  if (
    code === "InvalidInstanceID.NotFound" ||
    code === "InvalidInstanceID.Malformed"
  ) {
    return true;
  }
  return /does not exist/i.test(error.message);
}

async function waitForInstanceIps(
  client: EC2Client,
  instanceId: string,
  maxAttempts = 30,
  delayMs = 2000
): Promise<{ publicIp: string | null; privateIp: string | null }> {
  let privateIp: string | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await client.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] })
      );
      const instance = response.Reservations?.[0]?.Instances?.[0];
      privateIp = instance?.PrivateIpAddress ?? privateIp;
      const publicIp = instance?.PublicIpAddress ?? null;
      if (publicIp) {
        return { publicIp, privateIp };
      }
    } catch (error) {
      if (!isEc2DescribeConsistencyError(error)) {
        console.warn(
          `DescribeInstances failed for ${instanceId}; continuing without IP:`,
          error
        );
        break;
      }
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return { publicIp: null, privateIp };
}

export async function describeInstanceIps(
  instanceId: string
): Promise<{ publicIp: string | null; privateIp: string | null }> {
  if (instanceId.startsWith("mock-")) {
    return { publicIp: "127.0.0.1", privateIp: "127.0.0.1" };
  }
  const client = getEc2Client();
  return waitForInstanceIps(client, instanceId, 5, 2000);
}

export async function provisionLabInstance(options: {
  sessionId: string;
  packId: string;
  labId: string;
  seed: string;
  graderPublicKey: string;
  authorizedKeys: string[];
  sshUser: string;
  callbackUrl: string;
  callbackSecret: string;
  labImage?: string;
  maxLifetimeMinutes?: number;
  sshIdleGraceSeconds?: number;
}): Promise<ProvisionResult> {
  if (isMockEc2Mode()) {
    return {
      instanceId: `mock-${options.sessionId}`,
      sshHost: "127.0.0.1",
      graderHost: "127.0.0.1",
      sshPort: 22,
      mock: true,
    };
  }

  validateLabEc2Environment();

  const launchTemplateId = process.env.EC2_LAUNCH_TEMPLATE_ID!.trim();
  const publicSubnetId = process.env.EC2_PUBLIC_SUBNET_ID!.trim();
  const client = getEc2Client();
  const userData = Buffer.from(
    buildLabUserData({
      sessionId: options.sessionId,
      authorizedKeys: options.authorizedKeys,
      callbackUrl: options.callbackUrl,
      callbackSecret: options.callbackSecret,
      shutdownUrl: `${options.callbackUrl.replace(/\/ready$/, "")}/shutdown`,
      labUser: options.sshUser,
      labImage: options.labImage,
      sshIdleGraceSeconds:
        options.sshIdleGraceSeconds ??
        Number(process.env.OPSCOACH_SSH_IDLE_GRACE_SECONDS ?? "120"),
    }),
    "utf8"
  ).toString("base64");

  const input: RunInstancesCommandInput = {
    LaunchTemplate: { LaunchTemplateId: launchTemplateId },
    MinCount: 1,
    MaxCount: 1,
    UserData: userData,
    SubnetId: publicSubnetId,
    TagSpecifications: [
      {
        ResourceType: "instance",
        Tags: [
          { Key: "Name", Value: `opscoach-${options.labId}-${options.sessionId.slice(0, 8)}` },
          { Key: "OpsCoach", Value: "true" },
          { Key: "ExpiresAt", Value: expiresAtTag(options.maxLifetimeMinutes) },
          { Key: "opscoach:session", Value: options.sessionId },
          { Key: "opscoach:pack", Value: options.packId },
          { Key: "opscoach:lab", Value: options.labId },
        ],
      },
    ],
  };

  let response;
  try {
    response = await client.send(new RunInstancesCommand(input));
  } catch (error) {
    throw new Error(`Failed to launch lab EC2 instance: ${formatEc2Error(error)}`);
  }
  const instance = response.Instances?.[0];
  const instanceId = instance?.InstanceId;
  if (!instanceId) {
    throw new Error("EC2 RunInstances did not return an instance id");
  }

  const ips = await waitForInstanceIps(client, instanceId);
  const rawPublicIp = ips.publicIp ?? instance.PublicIpAddress ?? null;
  const publicIp =
    rawPublicIp && isPublicRoutableIp(rawPublicIp) ? rawPublicIp : null;
  const privateIp = ips.privateIp ?? instance.PrivateIpAddress ?? null;

  try {
    await scheduleSessionTermination({
      sessionId: options.sessionId,
      instanceId,
      maxLifetimeMinutes: options.maxLifetimeMinutes,
    });
  } catch (error) {
    console.warn(
      `Failed to schedule termination for session ${options.sessionId}:`,
      error
    );
  }

  return {
    instanceId,
    sshHost: publicIp,
    graderHost: privateIp,
    sshPort: 22,
    mock: false,
  };
}

export async function terminateLabInstance(instanceId: string): Promise<void> {
  if (instanceId.startsWith("mock-")) {
    return;
  }
  const client = getEc2Client();
  await client.send(
    new TerminateInstancesCommand({
      InstanceIds: [instanceId],
    })
  );
}
