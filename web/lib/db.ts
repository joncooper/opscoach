import { readFileSync } from "fs";
import { Pool, type PoolClient } from "pg";
import { v4 as uuidv4 } from "uuid";
import type { GraderResult, SessionMode, SessionRecord, SessionStatus } from "./types";

const memorySessions = new Map<string, SessionRecord>();
const memoryCheckRuns = new Map<string, Array<{ id: string; sessionId: string; createdAt: Date; payload: GraderResult }>>();
const memoryNotes = new Map<string, { body: string; updatedAt: Date }>();
const memoryUserKeys = new Map<string, UserKeyRecord>();

export interface UserKeyRecord {
  ownerSub: string;
  ownerEmail: string | null;
  publicKey: string;
  updatedAt: Date;
}

let pool: Pool | null = null;

function resolveDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  const host = process.env.DATABASE_HOST;
  const user = process.env.DATABASE_USER;
  const password = process.env.DATABASE_PASSWORD;
  const database = process.env.DATABASE_NAME ?? "opscoach";
  const port = process.env.DATABASE_PORT ?? "5432";
  if (host && user && password) {
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
  }
  return undefined;
}

export function usingDatabase(): boolean {
  return Boolean(resolveDatabaseUrl());
}

function poolSslConfig(): { rejectUnauthorized: boolean; ca?: string } | undefined {
  const flag = process.env.DATABASE_SSL?.toLowerCase();
  if (flag === "false" || flag === "0") {
    return undefined;
  }
  const url = resolveDatabaseUrl() ?? "";
  const wantsSsl =
    flag === "true" ||
    flag === "1" ||
    flag === "require" ||
    // RDS rejects non-TLS clients with "no pg_hba.conf entry ... no encryption".
    url.includes(".rds.amazonaws.com");
  if (!wantsSsl) {
    return undefined;
  }
  // Verify the server certificate against the RDS CA bundle when available
  // (inline DATABASE_CA, or DATABASE_CA_PATH pointing at the bundle shipped in the image).
  const inlineCa = process.env.DATABASE_CA?.trim();
  const caPath = process.env.DATABASE_CA_PATH?.trim();
  let ca = inlineCa || undefined;
  if (!ca && caPath) {
    try {
      ca = readFileSync(caPath, "utf8");
    } catch {
      ca = undefined;
    }
  }
  if (ca) {
    return { rejectUnauthorized: true, ca };
  }
  // No CA available: stay encrypted but unverified rather than failing the deploy.
  // Ship DATABASE_CA_PATH (the RDS global bundle) to enable full verification.
  console.warn("[db] TLS enabled without a CA bundle; server certificate not verified.");
  return { rejectUnauthorized: false };
}

function getPool(): Pool {
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (!pool) {
    const ssl = poolSslConfig();
    pool = new Pool({
      connectionString: databaseUrl,
      ...(ssl ? { ssl } : {}),
    });
  }
  return pool;
}

function rowToSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    packId: String(row.pack_id),
    labId: String(row.lab_id),
    mode: String(row.mode) as SessionMode,
    status: String(row.status) as SessionStatus,
    tokenHash: String(row.token_hash),
    callbackTokenHash: row.callback_token_hash
      ? String(row.callback_token_hash)
      : null,
    publicKey: String(row.public_key),
    instanceId: row.instance_id ? String(row.instance_id) : null,
    sshHost: row.ssh_host ? String(row.ssh_host) : null,
    graderHost: row.grader_host ? String(row.grader_host) : null,
    sshPort: row.ssh_port == null ? null : Number(row.ssh_port),
    sshUser: String(row.ssh_user),
    sshHostAlias: String(row.ssh_host_alias),
    contentPackVersion: String(row.content_pack_version),
    sessionRoot: String(row.session_root),
    seed: String(row.seed),
    graderKeyPath: String(row.grader_key_path),
    knownHostsPath: String(row.known_hosts_path),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    lastActivityAt: new Date(String(row.last_activity_at)),
    latestGrader: row.latest_grader
      ? (row.latest_grader as GraderResult)
      : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    ownerSub: row.owner_sub ? String(row.owner_sub) : null,
    ownerEmail: row.owner_email ? String(row.owner_email) : null,
  };
}

export async function migrate(): Promise<void> {
  if (!usingDatabase()) {
    return;
  }
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        lab_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        public_key TEXT NOT NULL,
        instance_id TEXT,
        ssh_host TEXT,
        grader_host TEXT,
        ssh_port INTEGER,
        ssh_user TEXT NOT NULL,
        ssh_host_alias TEXT NOT NULL,
        content_pack_version TEXT NOT NULL,
        session_root TEXT NOT NULL,
        seed TEXT NOT NULL,
        grader_key_path TEXT NOT NULL,
        known_hosts_path TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_activity_at TIMESTAMPTZ NOT NULL,
        latest_grader JSONB,
        error_message TEXT
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS check_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS check_runs_session_id_idx ON check_runs(session_id)
    `);
    await client.query(`
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS grader_host TEXT
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS session_notes (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        body TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
    await client.query(`
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS callback_token_hash TEXT
    `);
    await client.query(`
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_sub TEXT
    `);
    await client.query(`
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_email TEXT
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_keys (
        owner_sub TEXT PRIMARY KEY,
        owner_email TEXT,
        public_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS sessions_owner_sub_idx ON sessions(owner_sub)
    `);
  } finally {
    client.release();
  }
}

export async function insertSession(record: SessionRecord): Promise<void> {
  if (!usingDatabase()) {
    memorySessions.set(record.id, { ...record });
    return;
  }
  await getPool().query(
    `INSERT INTO sessions (
      id, pack_id, lab_id, mode, status, token_hash, callback_token_hash, public_key,
      instance_id, ssh_host, grader_host, ssh_port, ssh_user, ssh_host_alias,
      content_pack_version, session_root, seed, grader_key_path,
      known_hosts_path, created_at, updated_at, last_activity_at,
      latest_grader, error_message, owner_sub, owner_email
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9,$10,$11,$12,$13,$14,
      $15,$16,$17,$18,
      $19,$20,$21,$22,
      $23,$24,$25,$26
    )`,
    [
      record.id,
      record.packId,
      record.labId,
      record.mode,
      record.status,
      record.tokenHash,
      record.callbackTokenHash,
      record.publicKey,
      record.instanceId,
      record.sshHost,
      record.graderHost,
      record.sshPort,
      record.sshUser,
      record.sshHostAlias,
      record.contentPackVersion,
      record.sessionRoot,
      record.seed,
      record.graderKeyPath,
      record.knownHostsPath,
      record.createdAt.toISOString(),
      record.updatedAt.toISOString(),
      record.lastActivityAt.toISOString(),
      record.latestGrader,
      record.errorMessage,
      record.ownerSub,
      record.ownerEmail,
    ]
  );
}

export async function updateSession(
  id: string,
  patch: Partial<SessionRecord>
): Promise<SessionRecord | null> {
  const existing = await getSession(id);
  if (!existing) {
    return null;
  }
  const updated: SessionRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    updatedAt: patch.updatedAt ?? new Date(),
  };

  if (!usingDatabase()) {
    memorySessions.set(id, updated);
    return updated;
  }

  await getPool().query(
    `UPDATE sessions SET
      pack_id = $2,
      lab_id = $3,
      mode = $4,
      status = $5,
      token_hash = $6,
      callback_token_hash = $7,
      public_key = $8,
      instance_id = $9,
      ssh_host = $10,
      grader_host = $11,
      ssh_port = $12,
      ssh_user = $13,
      ssh_host_alias = $14,
      content_pack_version = $15,
      session_root = $16,
      seed = $17,
      grader_key_path = $18,
      known_hosts_path = $19,
      created_at = $20,
      updated_at = $21,
      last_activity_at = $22,
      latest_grader = $23,
      error_message = $24,
      owner_sub = $25,
      owner_email = $26
    WHERE id = $1`,
    [
      updated.id,
      updated.packId,
      updated.labId,
      updated.mode,
      updated.status,
      updated.tokenHash,
      updated.callbackTokenHash,
      updated.publicKey,
      updated.instanceId,
      updated.sshHost,
      updated.graderHost,
      updated.sshPort,
      updated.sshUser,
      updated.sshHostAlias,
      updated.contentPackVersion,
      updated.sessionRoot,
      updated.seed,
      updated.graderKeyPath,
      updated.knownHostsPath,
      updated.createdAt.toISOString(),
      updated.updatedAt.toISOString(),
      updated.lastActivityAt.toISOString(),
      updated.latestGrader,
      updated.errorMessage,
      updated.ownerSub,
      updated.ownerEmail,
    ]
  );
  return updated;
}

export async function getSession(id: string): Promise<SessionRecord | null> {
  if (!usingDatabase()) {
    const record = memorySessions.get(id);
    return record ? { ...record } : null;
  }
  const result = await getPool().query(`SELECT * FROM sessions WHERE id = $1`, [id]);
  if (result.rowCount === 0) {
    return null;
  }
  return rowToSession(result.rows[0]);
}

/** Active (non-terminal) sessions owned by a user — used to cap concurrent labs. */
export async function countActiveSessionsForOwner(ownerSub: string): Promise<number> {
  if (!usingDatabase()) {
    let count = 0;
    for (const session of memorySessions.values()) {
      if (
        session.ownerSub === ownerSub &&
        session.status !== "stopped" &&
        session.status !== "failed"
      ) {
        count += 1;
      }
    }
    return count;
  }
  const result = await getPool().query(
    `SELECT COUNT(*)::int AS count FROM sessions
     WHERE owner_sub = $1 AND status NOT IN ('stopped', 'failed')`,
    [ownerSub]
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function insertCheckRun(
  sessionId: string,
  payload: GraderResult
): Promise<string> {
  const id = uuidv4();
  const createdAt = new Date();
  if (!usingDatabase()) {
    const runs = memoryCheckRuns.get(sessionId) ?? [];
    runs.push({ id, sessionId, createdAt, payload });
    memoryCheckRuns.set(sessionId, runs);
    return id;
  }
  await getPool().query(
    `INSERT INTO check_runs (id, session_id, created_at, payload)
     VALUES ($1, $2, $3, $4)`,
    [id, sessionId, createdAt.toISOString(), payload]
  );
  return id;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (!usingDatabase()) {
    return fn(null as unknown as PoolClient);
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let migrated = false;
export async function ensureMigrated(): Promise<void> {
  if (!usingDatabase() || migrated) {
    return;
  }
  await migrate();
  migrated = true;
}

export async function getSessionNote(sessionId: string): Promise<string> {
  if (!usingDatabase()) {
    return memoryNotes.get(sessionId)?.body ?? "";
  }
  const result = await getPool().query(
    `SELECT body FROM session_notes WHERE session_id = $1`,
    [sessionId]
  );
  if (result.rowCount === 0) {
    return "";
  }
  return String(result.rows[0].body);
}

export async function setSessionNote(sessionId: string, body: string): Promise<void> {
  const updatedAt = new Date();
  if (!usingDatabase()) {
    memoryNotes.set(sessionId, { body, updatedAt });
    return;
  }
  await getPool().query(
    `INSERT INTO session_notes (session_id, body, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO UPDATE SET body = EXCLUDED.body, updated_at = EXCLUDED.updated_at`,
    [sessionId, body, updatedAt.toISOString()]
  );
}

/** The saved default SSH public key for an authenticated user, if any. */
export async function getUserKey(ownerSub: string): Promise<UserKeyRecord | null> {
  if (!usingDatabase()) {
    const record = memoryUserKeys.get(ownerSub);
    return record ? { ...record } : null;
  }
  const result = await getPool().query(
    `SELECT owner_sub, owner_email, public_key, updated_at FROM user_keys WHERE owner_sub = $1`,
    [ownerSub]
  );
  if (result.rowCount === 0) {
    return null;
  }
  const row = result.rows[0];
  return {
    ownerSub: String(row.owner_sub),
    ownerEmail: row.owner_email ? String(row.owner_email) : null,
    publicKey: String(row.public_key),
    updatedAt: new Date(String(row.updated_at)),
  };
}

export async function setUserKey(
  ownerSub: string,
  ownerEmail: string | null,
  publicKey: string
): Promise<void> {
  const now = new Date();
  if (!usingDatabase()) {
    memoryUserKeys.set(ownerSub, { ownerSub, ownerEmail, publicKey, updatedAt: now });
    return;
  }
  await getPool().query(
    `INSERT INTO user_keys (owner_sub, owner_email, public_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (owner_sub) DO UPDATE SET
       owner_email = EXCLUDED.owner_email,
       public_key = EXCLUDED.public_key,
       updated_at = EXCLUDED.updated_at`,
    [ownerSub, ownerEmail, publicKey, now.toISOString()]
  );
}

/** Recent sessions owned by a user, newest first — backs the "My labs" page. */
export async function listSessionsForOwner(
  ownerSub: string,
  limit = 25
): Promise<SessionRecord[]> {
  if (!usingDatabase()) {
    return [...memorySessions.values()]
      .filter((session) => session.ownerSub === ownerSub)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((session) => ({ ...session }));
  }
  const result = await getPool().query(
    `SELECT * FROM sessions WHERE owner_sub = $1 ORDER BY created_at DESC LIMIT $2`,
    [ownerSub, limit]
  );
  return result.rows.map(rowToSession);
}
