import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import type { GraderResult, LabReference, SessionRecord } from "./types";
import { graderExecutablePath } from "./content";

export class GraderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraderError";
  }
}

// Graders are committed content-pack programs that run as a child of the web task. They
// must NOT inherit the task's secrets or IAM role — only enough to SSH and grade. We pass
// an allowlisted env: region/config-file are safe, but AWS *credential* vars and the ECS
// role-fetch URI are deliberately excluded, so a rogue/buggy grader cannot read the DB or
// callback secrets or assume the task role. AWS-scenario graders authenticate via the
// per-session workspace credentials (--session), not the task role.
const GRADER_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
];

function graderEnvironment(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of GRADER_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env as NodeJS.ProcessEnv;
}

function runCommand(
  executable: string,
  args: string[],
  timeoutMs = 45_000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: graderEnvironment(),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new GraderError(`Grader timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });
}

export async function runGrader(
  reference: LabReference,
  session: SessionRecord
): Promise<GraderResult> {
  const executable = graderExecutablePath(reference);
  if (!fs.existsSync(executable)) {
    throw new GraderError(`Missing grader executable: ${executable}`);
  }
  const sshPort = session.sshPort ?? reference.lab.runtime.sshContainerPort;
  const sshHost = session.graderHost ?? session.sshHost ?? "127.0.0.1";
  const args = [
    "--session",
    session.sessionRoot,
    "--ssh-key",
    session.graderKeyPath,
    "--ssh-port",
    String(sshPort),
    "--ssh-user",
    session.sshUser,
    "--ssh-hostname",
    sshHost,
    "--known-hosts",
    session.knownHostsPath,
    "--mode",
    session.mode,
  ];
  const result = await runCommand(executable, args);
  const output = result.stdout.trim();
  if (!output) {
    throw new GraderError(
      `Grader did not return valid JSON: ${result.stderr || "(empty output)"}`
    );
  }
  try {
    return JSON.parse(output) as GraderResult;
  } catch {
    throw new GraderError(
      `Grader did not return valid JSON: ${output}\n${result.stderr}`
    );
  }
}

export function ensureSessionWorkspace(sessionRoot: string): void {
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.mkdirSync(path.join(sessionRoot, "ssh"), { recursive: true });
}

export function writeKnownHosts(
  knownHostsPath: string,
  host: string,
  port: number
): void {
  fs.mkdirSync(path.dirname(knownHostsPath), { recursive: true });
  if (!fs.existsSync(knownHostsPath)) {
    fs.writeFileSync(knownHostsPath, "", { mode: 0o600 });
  }
  const marker = `[${host}]:${port}`;
  const existing = fs.readFileSync(knownHostsPath, "utf8");
  if (!existing.includes(marker)) {
    fs.appendFileSync(knownHostsPath, `${marker} placeholder\n`);
  }
}
