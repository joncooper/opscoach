import { spawn } from "child_process";
import fs from "fs";

export interface SshProbeOptions {
  sshKeyPath: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  knownHostsPath: string;
  command?: string;
  timeoutMs?: number;
}

export interface SshProbeResult {
  ok: boolean;
  detail: string;
}

function runSshProbeOnce(options: SshProbeOptions): Promise<SshProbeResult> {
  const {
    sshKeyPath,
    sshHost,
    sshPort,
    sshUser,
    knownHostsPath,
    command = "true",
    timeoutMs = 10_000,
  } = options;

  if (!fs.existsSync(sshKeyPath)) {
    return Promise.resolve({ ok: false, detail: "Grader SSH key missing on server" });
  }

  return new Promise((resolve) => {
    const args = [
      "-i",
      sshKeyPath,
      "-p",
      String(sshPort),
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${knownHostsPath}`,
      "-o",
      "ConnectTimeout=5",
      `${sshUser}@${sshHost}`,
      command,
    ];
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, detail: "SSH probe timed out" });
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        detail: error instanceof Error ? error.message : "SSH probe failed",
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, detail: "SSH authentication succeeded" });
        return;
      }
      const detail = stderr.trim() || `SSH exited with code ${code ?? 1}`;
      resolve({ ok: false, detail });
    });
  });
}

/** Retry SSH probe until success or attempts exhausted. */
export async function probeSshWithRetry(
  options: SshProbeOptions,
  maxAttempts = 24,
  delayMs = 5000
): Promise<SshProbeResult> {
  let last: SshProbeResult = { ok: false, detail: "SSH probe not attempted" };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    last = await runSshProbeOnce(options);
    if (last.ok) {
      return last;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return last;
}

export async function probeSessionSsh(session: {
  graderKeyPath: string;
  graderHost: string | null;
  sshHost: string | null;
  sshPort: number | null;
  sshUser: string | null;
  knownHostsPath: string;
}): Promise<SshProbeResult> {
  const hosts = [
    session.graderHost,
    session.sshHost,
  ].filter((host): host is string => !!host);
  const uniqueHosts = [...new Set(hosts)];
  if (uniqueHosts.length === 0) {
    return { ok: false, detail: "No SSH host available for probe" };
  }

  let last: SshProbeResult = { ok: false, detail: "SSH probe not attempted" };
  for (const host of uniqueHosts) {
    last = await probeSshWithRetry(
      {
        sshKeyPath: session.graderKeyPath,
        sshHost: host,
        sshPort: session.sshPort ?? 22,
        sshUser: session.sshUser ?? "learner",
        knownHostsPath: session.knownHostsPath,
      },
      12,
      5000
    );
    if (last.ok) {
      return last;
    }
  }
  return last;
}
