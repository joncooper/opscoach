import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getLab } from "./content";
import { isAwsLab, prepareAwsSession } from "./aws-lab-manager";
import {
  labImageFor,
  maxLifetimeMinutesFor,
  sshIdleGraceSecondsFor,
} from "./lab-images";
import {
  ensureMigrated,
  getSession,
  insertCheckRun,
  insertSession,
  updateSession,
} from "./db";
import { isMockEc2Mode, provisionLabInstance, terminateLabInstance, describeInstanceIps } from "./ec2-labs";
import { cancelSessionTerminationSchedule } from "./session-scheduler";
import { sessionEvents } from "./events";
import {
  ensureSessionWorkspace,
  runGrader,
  writeKnownHosts,
} from "./grader";
import { generateSessionToken, hashSessionToken, verifySessionToken } from "./session-token";
import { probeSessionSsh } from "./ssh-probe";
import { isPublicRoutableIp, learnerSshHost } from "./ip-address";
import {
  authorizedKeysForLab,
  learnerPublicKeyForSession,
} from "./default-ssh-keys";
import {
  appendBootstrapProgress,
  BOOTSTRAP_STEP_ORDER,
  type BootstrapProgressStep,
} from "./bootstrap-progress";
import type { GraderResult, SessionMode, SessionRecord, SessionState } from "./types";
import { bootstrapReceivedFor, toSessionState, visibleGraderResult as maskGrader } from "./types";

function sessionsRoot(): string {
  return process.env.SESSIONS_ROOT ?? path.join("/tmp", "opscoach-sessions");
}

function callbackBaseUrl(): string {
  return (
    process.env.INTERNAL_CALLBACK_BASE_URL ??
    process.env.APP_BASE_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function readGraderPublicKey(graderKeyPath: string): string {
  const pubPath = `${graderKeyPath}.pub`;
  if (!fs.existsSync(pubPath)) {
    throw new Error(`Missing grader public key at ${pubPath}`);
  }
  return fs.readFileSync(pubPath, "utf8").trim();
}

function publishStep(
  sessionId: string,
  step: string,
  status: "pending" | "active" | "done" | "failed",
  detail?: string
): void {
  sessionEvents.publish(sessionId, { type: "step", step, status, detail });
}

const sshFinalizeInFlight = new Set<string>();

function markBootstrapReceived(sessionRoot: string): void {
  fs.writeFileSync(
    path.join(sessionRoot, "bootstrap.received"),
    new Date().toISOString()
  );
}

export async function reportBootstrapProgress(
  id: string,
  input: { step: BootstrapProgressStep; detail: string }
): Promise<{ accepted: boolean }> {
  await ensureMigrated();
  const existing = await getSession(id);
  if (!existing) {
    return { accepted: false };
  }
  if (existing.status === "stopped" || existing.status === "stopping" || existing.status === "ready") {
    return { accepted: false };
  }

  const entry = appendBootstrapProgress(existing.sessionRoot, input);
  const stepIndex = BOOTSTRAP_STEP_ORDER.indexOf(input.step);
  if (stepIndex >= 0) {
    for (let i = 0; i < stepIndex; i++) {
      publishStep(id, BOOTSTRAP_STEP_ORDER[i], "done");
    }
    publishStep(id, input.step, "active", input.detail);
  }

  sessionEvents.publish(id, {
    type: "bootstrap_progress",
    step: input.step,
    detail: input.detail,
    at: entry.at,
  });

  return { accepted: true };
}

async function finalizeReadyAfterProbe(id: string): Promise<void> {
  if (sshFinalizeInFlight.has(id)) {
    return;
  }
  sshFinalizeInFlight.add(id);
  try {
    const existing = await getSession(id);
    if (!existing || existing.status === "ready" || existing.status === "stopped") {
      return;
    }
    publishStep(id, "verify_ssh", "active");
    const probe = await probeSessionSsh(existing);
    if (!probe.ok) {
      publishStep(id, "verify_ssh", "failed", probe.detail);
      await updateSession(id, {
        errorMessage: `SSH verification failed: ${probe.detail}`,
        lastActivityAt: new Date(),
      });
      sessionEvents.publish(id, {
        type: "error",
        message: `SSH verification failed: ${probe.detail}`,
      });
      return;
    }

    publishStep(id, "verify_ssh", "done", probe.detail);
    const updated = await updateSession(id, {
      status: "ready",
      errorMessage: null,
      lastActivityAt: new Date(),
    });
    if (updated) {
      const sshHost = learnerSshHost(updated.sshHost);
      if (sshHost) {
        sessionEvents.publish(id, {
          type: "ready",
          sshHost,
          sshPort: updated.sshPort ?? 22,
          graderHost: updated.graderHost,
        });
      }
      sessionEvents.publish(id, { type: "status", status: "ready" });
      publishStep(id, "ready", "done");
    }
  } finally {
    sshFinalizeInFlight.delete(id);
  }
}

function ensureEd25519Key(keyPath: string): void {
  if (fs.existsSync(keyPath)) {
    return;
  }
  const configured = process.env.GRADER_SSH_KEY_PATH;
  if (configured && fs.existsSync(configured)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.copyFileSync(configured, keyPath);
    fs.chmodSync(keyPath, 0o600);
    const configuredPub = `${configured}.pub`;
    if (fs.existsSync(configuredPub)) {
      fs.copyFileSync(configuredPub, `${keyPath}.pub`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  execFileSync("ssh-keygen", [
    "-t",
    "ed25519",
    "-f",
    keyPath,
    "-N",
    "",
    "-C",
    "opscoach-grader",
  ]);
  fs.chmodSync(keyPath, 0o600);
}

/**
 * Generate (once) a throwaway ed25519 keypair the platform vends to the learner so they
 * can SSH into this session's lab host from their own terminal — even when they launched
 * the browser terminal and never supplied a key. Returns the OpenSSH public line to add
 * to the host's authorized_keys. The private half stays on the web task and is served,
 * token-gated, by GET /api/sessions/[id]/ssh-key. Uses ssh2's keygen (no ssh-keygen dep).
 */
function ensureVendedKey(keyPath: string): string {
  const pubPath = `${keyPath}.pub`;
  if (fs.existsSync(keyPath) && fs.existsSync(pubPath)) {
    return fs.readFileSync(pubPath, "utf8").trim();
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  // Mirror the grader keygen (ssh-keygen ships in the web image). This yields an
  // OpenSSH-format private key the learner can use directly with `ssh -i`, and a
  // `ssh-ed25519 …` public line for the host's authorized_keys. We deliberately do
  // NOT import ssh2 here — it carries a native .node binary that breaks the Next bundle.
  execFileSync("ssh-keygen", [
    "-t",
    "ed25519",
    "-f",
    keyPath,
    "-N",
    "",
    "-C",
    "opscoach-session",
  ]);
  fs.chmodSync(keyPath, 0o600);
  return fs.readFileSync(pubPath, "utf8").trim();
}

/** Path to a session's vended private key, derived the same way at create + serve time. */
function vendedKeyPathFor(sessionRoot: string): string {
  return path.join(sessionRoot, "ssh", "vended_ed25519");
}

/**
 * Return this session's vended SSH private key, but only to a caller holding the session
 * token. Lets the SSH tab offer a one-click key download without exposing it to anyone else.
 */
export async function getVendedPrivateKey(
  id: string,
  token: string
): Promise<string | null> {
  const existing = await getSession(id);
  if (!existing || !verifySessionToken(token, existing.tokenHash)) {
    return null;
  }
  const keyPath = vendedKeyPathFor(existing.sessionRoot);
  if (!fs.existsSync(keyPath)) {
    return null;
  }
  return fs.readFileSync(keyPath, "utf8");
}

export interface CreateSessionInput {
  packId: string;
  labId: string;
  publicKey: string;
  mode: SessionMode;
  /** Verified ALB OIDC identity of the creating user, when available. */
  owner?: { sub: string; email: string | null } | null;
}

export interface CreateSessionResult {
  session: SessionState;
  token: string;
}

export async function createSession(
  input: CreateSessionInput
): Promise<CreateSessionResult> {
  await ensureMigrated();
  const reference = getLab(input.packId, input.labId);
  const id = uuidv4();
  const token = generateSessionToken();
  const callbackToken = generateSessionToken();
  const now = new Date();
  const learnerPublicKey = learnerPublicKeyForSession(input.publicKey);
  const sessionRootPath = path.join(sessionsRoot(), id);
  ensureSessionWorkspace(sessionRootPath);
  const graderKeyPath = path.join(sessionRootPath, "ssh", "grader_ed25519");
  const knownHostsPath = path.join(sessionRootPath, "ssh", "known_hosts");
  ensureEd25519Key(graderKeyPath);
  const graderPublicKey = readGraderPublicKey(graderKeyPath);
  // Throwaway key handed to the learner so they can SSH in from their own terminal,
  // even on a browser-terminal launch where they supplied no key of their own.
  const vendedPublicKey = ensureVendedKey(vendedKeyPathFor(sessionRootPath));
  const seed =
    reference.lab.runtime.defaultSeed ?? id.replace(/-/g, "").slice(0, 8);

  const record: SessionRecord = {
    id,
    packId: reference.packId,
    labId: reference.lab.id,
    mode: input.mode,
    status: "provisioning",
    tokenHash: hashSessionToken(token),
    callbackTokenHash: hashSessionToken(callbackToken),
    publicKey: learnerPublicKey,
    instanceId: null,
    sshHost: null,
    graderHost: null,
    sshPort: null,
    sshUser: reference.lab.runtime.sshUser,
    sshHostAlias: reference.lab.runtime.sshHostAlias,
    contentPackVersion: reference.packVersion,
    sessionRoot: sessionRootPath,
    seed,
    graderKeyPath,
    knownHostsPath,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    latestGrader: null,
    errorMessage: null,
    ownerSub: input.owner?.sub ?? null,
    ownerEmail: input.owner?.email ?? null,
  };

  await insertSession(record);
  publishStep(id, "create_session", "done");

  if (isAwsLab(reference.lab)) {
    try {
      await prepareAwsSession({
        reference,
        sessionId: id,
        sessionRoot: sessionRootPath,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to prepare AWS lab session";
      const failed = await updateSession(id, {
        status: "failed",
        errorMessage: message,
        updatedAt: new Date(),
      });
      sessionEvents.publish(id, { type: "error", message });
      if (failed) {
        return { session: toSessionState(failed), token };
      }
    }
  }

  const callbackUrl = `${callbackBaseUrl()}/api/sessions/${id}/ready`;
  const lifetimeMinutes = maxLifetimeMinutesFor(reference);
  const idleGraceSeconds = sshIdleGraceSecondsFor(reference);
  try {
    const provisioned = await provisionLabInstance({
      sessionId: id,
      packId: reference.packId,
      labId: reference.lab.id,
      seed,
      graderPublicKey,
      authorizedKeys: authorizedKeysForLab(input.publicKey, graderPublicKey, [
        vendedPublicKey,
      ]),
      sshUser: record.sshUser,
      callbackUrl,
      callbackSecret: callbackToken,
      labImage: labImageFor(reference),
      maxLifetimeMinutes: lifetimeMinutes,
      sshIdleGraceSeconds: idleGraceSeconds,
    });

    publishStep(id, "launch_instance", "done");
    const patched = await updateSession(id, {
      instanceId: provisioned.instanceId,
      sshHost: provisioned.sshHost,
      graderHost: provisioned.graderHost,
      sshPort: provisioned.sshPort,
      status: provisioned.mock ? "ready" : "provisioning",
      lastActivityAt: new Date(),
    });
    const graderTarget = patched?.graderHost ?? patched?.sshHost;
    if (graderTarget && patched?.sshPort) {
      writeKnownHosts(patched.knownHostsPath, graderTarget, patched.sshPort);
    }
    if (provisioned.mock) {
      sessionEvents.publish(id, { type: "status", status: "ready" });
      sessionEvents.publish(id, {
        type: "ready",
        sshHost: provisioned.sshHost ?? "127.0.0.1",
        sshPort: provisioned.sshPort,
        graderHost: provisioned.graderHost,
      });
    } else if (provisioned.sshHost) {
      publishStep(id, "assign_public_ip", "done", provisioned.sshHost);
      publishStep(id, "bootstrap", "active", "Waiting for lab host…");
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to provision lab instance";
    const failed = await updateSession(id, {
      status: "failed",
      errorMessage: message,
      updatedAt: new Date(),
    });
    sessionEvents.publish(id, { type: "error", message });
    if (failed) {
      return { session: toSessionState(failed), token };
    }
  }

  const session = await getSession(id);
  if (!session) {
    throw new Error("Session creation failed");
  }
  return { session: toSessionState(session), token };
}

export async function markReady(
  id: string,
  details: { sshHost: string; graderHost?: string; sshPort: number }
): Promise<SessionState | null> {
  await ensureMigrated();
  if (!isPublicRoutableIp(details.sshHost)) {
    console.warn(
      `Rejected markReady for ${id}: sshHost ${details.sshHost} is not public routable`
    );
    return null;
  }
  const existing = await getSession(id);
  if (!existing) {
    return null;
  }
  // Derive the grader SSH target from EC2 itself, never the callback body. A lab tenant
  // holds the per-session secret and could otherwise point our probe at internal hosts
  // (the supplied details.graderHost is intentionally ignored).
  let graderHost = details.sshHost;
  if (existing.instanceId) {
    try {
      const ips = await describeInstanceIps(existing.instanceId);
      if (ips.privateIp) {
        graderHost = ips.privateIp;
      }
    } catch {
      // Keep the validated public sshHost if the EC2 lookup fails.
    }
  }
  writeKnownHosts(existing.knownHostsPath, graderHost, details.sshPort);
  markBootstrapReceived(existing.sessionRoot);

  publishStep(id, "bootstrap", "done");
  publishStep(id, "start_lab", "done");
  publishStep(id, "install_keys", "done");

  const updated = await updateSession(id, {
    sshHost: details.sshHost,
    graderHost,
    sshPort: details.sshPort,
    lastActivityAt: new Date(),
  });
  void finalizeReadyAfterProbe(id);
  return updated ? toSessionState(updated) : null;
}

export async function touchActivity(id: string): Promise<void> {
  await updateSession(id, { lastActivityAt: new Date() });
}

export async function shutdownSessionInternal(
  id: string,
  reason: "ssh_idle" | "max_ttl" | "expires_at_sweep" | "manual" = "manual"
): Promise<SessionState | null> {
  await ensureMigrated();
  const existing = await getSession(id);
  if (!existing) {
    return null;
  }
  if (existing.status === "stopped" || existing.status === "stopping") {
    return toSessionState(existing);
  }

  await updateSession(id, { status: "stopping", updatedAt: new Date() });

  try {
    await cancelSessionTerminationSchedule(id);
  } catch (error) {
    console.warn(`Failed to cancel scheduler for ${id}:`, error);
  }

  if (existing.instanceId && !existing.instanceId.startsWith("mock-")) {
    try {
      await terminateLabInstance(existing.instanceId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to terminate instance";
      await updateSession(id, { errorMessage: message });
    }
  }

  const updated = await updateSession(id, {
    status: "stopped",
    updatedAt: new Date(),
    lastActivityAt: new Date(),
    errorMessage:
      reason === "ssh_idle"
        ? null
        : existing.errorMessage,
  });
  if (updated) {
    sessionEvents.publish(id, { type: "status", status: "stopped" });
    return toSessionState(updated);
  }
  return null;
}

export async function stopSession(
  id: string,
  token: string
): Promise<SessionState | null> {
  await ensureMigrated();
  const existing = await getSession(id);
  if (!existing || !verifySessionToken(token, existing.tokenHash)) {
    return null;
  }
  return shutdownSessionInternal(id, "manual");
}

export async function runGraderForSession(
  id: string,
  token: string
): Promise<GraderResult | null> {
  await ensureMigrated();
  const existing = await getSession(id);
  if (!existing || !verifySessionToken(token, existing.tokenHash)) {
    return null;
  }
  if (existing.status === "stopped" || existing.status === "failed") {
    throw new Error(`Session is ${existing.status}`);
  }
  if (existing.status === "provisioning") {
    throw new Error("Session is still provisioning; wait until SSH is ready");
  }
  const reference = getLab(existing.packId, existing.labId);
  await updateSession(id, {
    status: "running",
    lastActivityAt: new Date(),
  });
  sessionEvents.publish(id, { type: "status", status: "running" });

  try {
    const result = await runGrader(reference, existing);
    const visible = maskGrader(result, existing.mode);
    await insertCheckRun(id, result);
    await updateSession(id, {
      latestGrader: visible,
      status: "ready",
      lastActivityAt: new Date(),
    });
    sessionEvents.publish(id, { type: "grader", result: visible });
    return visible;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Grader failed";
    await updateSession(id, {
      errorMessage: message,
      lastActivityAt: new Date(),
    });
    sessionEvents.publish(id, { type: "error", message });
    throw error;
  }
}

export async function getSessionState(id: string): Promise<SessionState | null> {
  await ensureMigrated();
  let record = await getSession(id);
  if (!record) {
    return null;
  }
  record = await maybeRefreshSessionIps(record);
  if (
    record.status === "provisioning" &&
    bootstrapReceivedFor(record) &&
    !sshFinalizeInFlight.has(record.id)
  ) {
    void finalizeReadyAfterProbe(record.id);
  }
  return record ? toSessionState(record) : null;
}

async function maybeRefreshSessionIps(
  record: SessionRecord
): Promise<SessionRecord> {
  if (
    record.status === "stopped" ||
    record.status === "failed" ||
    record.status === "stopping" ||
    !record.instanceId ||
    record.instanceId.startsWith("mock-") ||
    isMockEc2Mode()
  ) {
    return record;
  }

  const needsPublicHost =
    !record.sshHost || !isPublicRoutableIp(record.sshHost);
  if (!needsPublicHost) {
    return record;
  }

  try {
    const ips = await describeInstanceIps(record.instanceId);
    const publicIp =
      ips.publicIp && isPublicRoutableIp(ips.publicIp) ? ips.publicIp : null;
    if (!publicIp) {
      return record;
    }

    const graderHost = ips.privateIp ?? record.graderHost ?? publicIp;
    const updated = await updateSession(record.id, {
      sshHost: publicIp,
      graderHost,
      sshPort: record.sshPort ?? 22,
      lastActivityAt: new Date(),
    });
    if (updated) {
      writeKnownHosts(updated.knownHostsPath, graderHost, updated.sshPort ?? 22);
      publishStep(record.id, "assign_public_ip", "done", publicIp);
      return updated;
    }
  } catch (error) {
    console.warn(`Failed to refresh instance IPs for ${record.id}:`, error);
  }

  return record;
}

export function buildSshCommand(
  session: SessionState,
  keyPath = "~/.ssh/id_ed25519"
): string | null {
  const sshHost = learnerSshHost(session.sshHost);
  if (!sshHost) {
    return null;
  }
  const port = session.sshPort ?? 22;
  const user = session.sshUser ?? "learner";
  return `ssh -i ${keyPath} -p ${port} -o StrictHostKeyChecking=accept-new ${user}@${sshHost}`;
}

export function mockModeEnabled(): boolean {
  return isMockEc2Mode();
}
