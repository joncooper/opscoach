import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
  SchedulerClient,
} from "@aws-sdk/client-scheduler";

function schedulerClient(): SchedulerClient {
  const region = process.env.AWS_REGION ?? process.env.OPSCOACH_REGION ?? "us-east-1";
  return new SchedulerClient({ region });
}

export function scheduleNameForSession(sessionId: string): string {
  return `opscoach-${sessionId}`.slice(0, 64);
}

function maxLifetimeMinutes(): number {
  return Number(process.env.OPSCOACH_MAX_LIFETIME_MINUTES ?? "60");
}

function schedulerEnabled(): boolean {
  return Boolean(
    process.env.SESSION_TERMINATOR_LAMBDA_ARN &&
      process.env.SCHEDULER_INVOKE_ROLE_ARN
  );
}

/** One-time EventBridge Scheduler backstop at T+max lifetime. */
export async function scheduleSessionTermination(options: {
  sessionId: string;
  instanceId: string;
  maxLifetimeMinutes?: number;
}): Promise<string | null> {
  if (!schedulerEnabled()) {
    return null;
  }

  const lifetime = options.maxLifetimeMinutes ?? maxLifetimeMinutes();
  const at = new Date(Date.now() + lifetime * 60_000);
  const expression = `at(${at.toISOString().slice(0, 19)})`;
  const name = scheduleNameForSession(options.sessionId);

  await schedulerClient().send(
    new CreateScheduleCommand({
      Name: name,
      GroupName: process.env.SCHEDULER_GROUP_NAME ?? "default",
      ScheduleExpression: expression,
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
      Target: {
        Arn: process.env.SESSION_TERMINATOR_LAMBDA_ARN!,
        RoleArn: process.env.SCHEDULER_INVOKE_ROLE_ARN!,
        Input: JSON.stringify({
          action: "terminate",
          instanceId: options.instanceId,
          sessionId: options.sessionId,
          reason: "max_ttl",
        }),
      },
      ActionAfterCompletion: "DELETE",
    })
  );

  return name;
}

export async function cancelSessionTerminationSchedule(sessionId: string): Promise<void> {
  if (!schedulerEnabled()) {
    return;
  }

  const name = scheduleNameForSession(sessionId);
  try {
    await schedulerClient().send(
      new DeleteScheduleCommand({
        Name: name,
        GroupName: process.env.SCHEDULER_GROUP_NAME ?? "default",
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ResourceNotFoundException")) {
      return;
    }
    throw error;
  }
}
