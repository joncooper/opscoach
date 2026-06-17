import fs from "fs";
import path from "path";

export interface BootstrapProgressEntry {
  step: string;
  detail: string;
  at: string;
}

export const BOOTSTRAP_STEP_ORDER = [
  "bootstrap",
  "start_lab",
  "install_keys",
] as const;

export type BootstrapProgressStep = (typeof BOOTSTRAP_STEP_ORDER)[number];

const MAX_LINES = 40;

export function bootstrapProgressPath(sessionRoot: string): string {
  return path.join(sessionRoot, "bootstrap.progress.jsonl");
}

export function appendBootstrapProgress(
  sessionRoot: string,
  entry: { step: string; detail: string; at?: string }
): BootstrapProgressEntry {
  const line: BootstrapProgressEntry = {
    step: entry.step,
    detail: entry.detail,
    at: entry.at ?? new Date().toISOString(),
  };
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.appendFileSync(
    bootstrapProgressPath(sessionRoot),
    `${JSON.stringify(line)}\n`
  );
  return line;
}

export function readBootstrapProgress(
  sessionRoot: string
): BootstrapProgressEntry[] {
  try {
    const raw = fs.readFileSync(bootstrapProgressPath(sessionRoot), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines
      .slice(-MAX_LINES)
      .map((line) => JSON.parse(line) as BootstrapProgressEntry);
  } catch {
    return [];
  }
}

export function isBootstrapProgressStep(
  step: string
): step is BootstrapProgressStep {
  return (BOOTSTRAP_STEP_ORDER as readonly string[]).includes(step);
}
