import type { SessionState } from "./types";

export type StepStatus = "pending" | "active" | "done" | "failed";

export interface ProvisioningStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

export const PROVISIONING_STEP_DEFS: Array<{ id: string; label: string }> = [
  { id: "create_session", label: "Creating session" },
  { id: "launch_instance", label: "Launching EC2 instance" },
  { id: "assign_public_ip", label: "Assigning public IP" },
  { id: "bootstrap", label: "Bootstrapping host and pulling lab image" },
  { id: "start_lab", label: "Starting lab environment" },
  { id: "install_keys", label: "Securing host access" },
  { id: "verify_ssh", label: "Verifying host connection" },
  { id: "ready", label: "Ready — your host is live" },
];

export type StepOverrides = Record<
  string,
  { status: StepStatus; detail?: string }
>;

function applyWaterfall(steps: ProvisioningStep[]): ProvisioningStep[] {
  let activeAssigned = false;
  return steps.map((step) => {
    if (step.status === "done" || step.status === "failed") {
      return step;
    }
    if (step.status === "active") {
      if (activeAssigned) {
        return { ...step, status: "pending" };
      }
      activeAssigned = true;
      return step;
    }
    return step;
  });
}

export function deriveProvisioningSteps(
  session: SessionState | null,
  overrides: StepOverrides = {}
): ProvisioningStep[] {
  const status = session?.status ?? "provisioning";
  const hasInstance = !!session?.instanceId;
  const hasPublicIp = !!session?.sshHost;
  const bootstrapReceived = session?.bootstrapReceived ?? false;
  const isReady = status === "ready" || status === "running";
  const isFailed = status === "failed";
  const sshError = session?.errorMessage?.includes("SSH verification");

  function baseStatus(id: string): StepStatus {
    const override = overrides[id];
    if (override) {
      return override.status;
    }
    switch (id) {
      case "create_session":
        return session ? "done" : "active";
      case "launch_instance":
        if (isReady || hasInstance) return "done";
        return session ? "active" : "pending";
      case "assign_public_ip":
        if (isReady || hasPublicIp) return "done";
        if (hasInstance) return "active";
        return "pending";
      case "bootstrap":
        if (isReady || bootstrapReceived) return "done";
        if (hasPublicIp) return "active";
        return "pending";
      case "start_lab":
        if (isReady || bootstrapReceived) return "done";
        if (hasPublicIp) return "pending";
        return "pending";
      case "install_keys":
        if (isReady || bootstrapReceived) return "done";
        return "pending";
      case "verify_ssh":
        if (isReady) return "done";
        if (sshError) return "failed";
        if (bootstrapReceived) return "active";
        return "pending";
      case "ready":
        return isReady ? "done" : "pending";
      default:
        return "pending";
    }
  }

  const raw = PROVISIONING_STEP_DEFS.map(({ id, label }) => ({
    id,
    label,
    status: baseStatus(id),
    detail: overrides[id]?.detail,
  }));

  if (isFailed) {
    const failed = applyWaterfall(raw);
    const firstIncomplete = failed.find(
      (step) => step.status !== "done" && step.id !== "ready"
    );
    if (firstIncomplete && firstIncomplete.status !== "failed") {
      firstIncomplete.status = "failed";
    }
    return failed;
  }

  return applyWaterfall(raw);
}

export function stepEventsForSession(
  session: SessionState,
  overrides: StepOverrides = {}
): Array<{
  type: "step";
  step: string;
  status: StepStatus;
  detail?: string;
}> {
  return deriveProvisioningSteps(session, overrides)
    .filter((step) => step.status !== "pending")
    .map((step) => ({
      type: "step" as const,
      step: step.id,
      status: step.status,
      detail: step.detail,
    }));
}
