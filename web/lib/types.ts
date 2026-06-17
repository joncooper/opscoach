export type SessionMode = "practice" | "assessment";

export type SessionStatus =
  | "provisioning"
  | "ready"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type CheckStatus = "pass" | "fail" | "pending" | "warning";

export interface Score {
  passed: number;
  total: number;
}

export interface CheckResult {
  id: string;
  status: CheckStatus;
  label: string;
  detail?: string | null;
}

export interface GraderResult {
  labId: string;
  checks: CheckResult[];
  score: Score;
}

export interface SessionState {
  id: string;
  packId: string;
  labId: string;
  mode: SessionMode;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  sshHost: string | null;
  sshPort: number | null;
  sshUser: string | null;
  sshHostAlias: string | null;
  instanceId: string | null;
  contentPackVersion: string | null;
  latestGrader: GraderResult | null;
  errorMessage: string | null;
  bootstrapReceived?: boolean;
  bootstrapProgress?: Array<{ step: string; detail: string; at: string }>;
}

export interface LabCatalogEntry {
  packId: string;
  packTitle: string;
  moduleId: string;
  moduleTitle: string;
  labId: string;
  labTitle: string;
  kind: string;
  summary: string;
  estimatedMinutes: number;
  prompt: string;
  hints: string[];
  isAwsLab: boolean;
}

export interface ContentPackManifest {
  id: string;
  title: string;
  version: string;
  modules: ModuleManifest[];
}

export interface ModuleManifest {
  id: string;
  title: string;
  summary: string;
  labs: LabManifest[];
}

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

export interface LabManifest {
  id: string;
  title: string;
  kind: string;
  surface?: string;
  summary: string;
  estimatedMinutes: number;
  prompt: string;
  hints: string[];
  aws?: AWSLabManifest;
  runtime: RuntimeManifest;
  grader: GraderManifest;
}

export interface RuntimeManifest {
  directory: string;
  composeFile: string;
  serviceName: string;
  sshUser: string;
  sshHostAlias: string;
  sshContainerPort: number;
  privateKeyContainerPath: string;
  defaultSeed?: string;
}

export interface GraderManifest {
  executable: string;
}

export interface LabReference {
  packId: string;
  packRoot: string;
  packTitle: string;
  packVersion: string;
  moduleId: string;
  moduleTitle: string;
  lab: LabManifest;
}

export interface SessionRecord {
  id: string;
  packId: string;
  labId: string;
  mode: SessionMode;
  status: SessionStatus;
  tokenHash: string;
  /** SHA-256 hash of the EC2/Lambda callback secret for this session. */
  callbackTokenHash: string | null;
  publicKey: string;
  instanceId: string | null;
  sshHost: string | null;
  graderHost: string | null;
  sshPort: number | null;
  sshUser: string;
  sshHostAlias: string;
  contentPackVersion: string;
  sessionRoot: string;
  seed: string;
  graderKeyPath: string;
  knownHostsPath: string;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
  latestGrader: GraderResult | null;
  errorMessage: string | null;
  /** Cognito subject + email of the user who created the session (ALB OIDC identity). */
  ownerSub: string | null;
  ownerEmail: string | null;
}

import { learnerSshHost } from "./ip-address";
import { readBootstrapProgress } from "./bootstrap-progress";
import fs from "fs";
import path from "path";

export function bootstrapReceivedFor(record: SessionRecord): boolean {
  try {
    return fs.existsSync(path.join(record.sessionRoot, "bootstrap.received"));
  } catch {
    return false;
  }
}

export function toSessionState(record: SessionRecord): SessionState {
  const visibleSshHost = learnerSshHost(record.sshHost);
  return {
    id: record.id,
    packId: record.packId,
    labId: record.labId,
    mode: record.mode,
    status:
      record.status === "ready" && !visibleSshHost && record.sshHost
        ? "provisioning"
        : record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    lastActivityAt: record.lastActivityAt.toISOString(),
    sshHost: visibleSshHost,
    sshPort: record.sshPort,
    sshUser: record.sshUser,
    sshHostAlias: record.sshHostAlias,
    instanceId: record.instanceId,
    contentPackVersion: record.contentPackVersion,
    latestGrader: record.latestGrader,
    errorMessage: record.errorMessage,
    bootstrapReceived: bootstrapReceivedFor(record),
    bootstrapProgress: readBootstrapProgress(record.sessionRoot),
  };
}

export function visibleGraderResult(
  result: GraderResult,
  mode: SessionMode
): GraderResult {
  if (mode !== "assessment") {
    return result;
  }
  return {
    ...result,
    checks: result.checks.map((check) => ({
      ...check,
      detail: null,
    })),
  };
}
