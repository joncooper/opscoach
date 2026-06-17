import type { LabReference } from "./types";

const DEFAULT_REGISTRY =
  process.env.OPSCOACH_LAB_IMAGE_REGISTRY ?? "ghcr.io/opscoach";

function imageName(reference: LabReference): string {
  if (reference.packId === "beaconkeeper") {
    return "beaconkeeper";
  }
  const directory = reference.lab.runtime.directory;
  if (directory.includes("aws-cli-lab") || reference.packId === "aws-foundations") {
    return "aws-cli-lab";
  }
  if (directory.includes("basic-lab")) {
    return "basic-lab";
  }
  if (directory.includes("foundations-lab") || reference.packId === "linux-foundations") {
    return "foundations-lab";
  }
  return "foundations-lab";
}

export function labImageFor(reference: LabReference): string {
  const override = process.env[`OPSCOACH_LAB_IMAGE_${reference.packId.toUpperCase().replace(/-/g, "_")}`];
  if (override) {
    return override;
  }
  const tag = process.env.OPSCOACH_LAB_IMAGE_TAG ?? "latest";
  const ecrRepo = process.env.OPSCOACH_LAB_ECR_PREFIX;
  if (ecrRepo) {
    return `${ecrRepo}-${imageName(reference)}:${tag}`;
  }
  return `${DEFAULT_REGISTRY}/${imageName(reference)}:${tag}`;
}

/** Longer capstone labs need more wall-clock time. */
export function maxLifetimeMinutesFor(reference: LabReference): number {
  const configured = Number(process.env.OPSCOACH_MAX_LIFETIME_MINUTES ?? "60");
  if (reference.packId === "beaconkeeper" || reference.lab.estimatedMinutes >= 60) {
    return Math.max(configured, 120);
  }
  return configured;
}

export function sshIdleGraceSecondsFor(reference: LabReference): number {
  const configured = Number(process.env.OPSCOACH_SSH_IDLE_GRACE_SECONDS ?? "120");
  if (reference.packId === "beaconkeeper") {
    return Math.max(configured, 300);
  }
  return configured;
}
