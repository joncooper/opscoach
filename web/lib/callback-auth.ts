import { timingSafeEqual } from "crypto";
import { getSession } from "./db";
import { verifySessionToken } from "./session-token";

export function readCallbackSecret(request: Request): string | null {
  return (
    request.headers.get("x-internal-secret") ??
    request.headers.get("x-callback-secret")
  );
}

function secretsEqual(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

/** Trusted AWS-side callers (session terminator Lambda). */
export function verifyGlobalCallbackSecret(provided: string | null): boolean {
  const expected = process.env.INTERNAL_CALLBACK_SECRET;
  if (!expected || !provided) {
    return false;
  }
  // Never accept an unconfigured/placeholder secret (e.g. the .env.example value).
  if (expected.length < 16 || expected === "change-me-in-production") {
    return false;
  }
  return secretsEqual(expected, provided);
}

export async function verifySessionCallbackSecret(
  sessionId: string,
  provided: string | null
): Promise<boolean> {
  if (!provided) {
    return false;
  }
  const session = await getSession(sessionId);
  if (!session?.callbackTokenHash) {
    return false;
  }
  return verifySessionToken(provided, session.callbackTokenHash);
}

/**
 * EC2 lab hosts authenticate per-session callbacks with their per-session token.
 * The global secret is a cross-session master key, so it is accepted ONLY where the
 * trusted terminator Lambda legitimately needs it (shutdown) — never for /ready or
 * /progress, which a single compromised holder could otherwise drive on any session.
 */
export async function verifyCallbackAuth(
  sessionId: string,
  request: Request,
  options: { allowGlobalSecret?: boolean } = {}
): Promise<boolean> {
  const provided = readCallbackSecret(request);
  if (!provided) {
    return false;
  }
  if (options.allowGlobalSecret && verifyGlobalCallbackSecret(provided)) {
    return true;
  }
  return verifySessionCallbackSecret(sessionId, provided);
}
