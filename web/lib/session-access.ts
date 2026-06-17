import { getSession } from "./db";
import type { SessionRecord } from "./types";
import { verifySessionToken } from "./session-token";

/** Learner token from header or query (SSE cannot set headers). */
export function readLearnerSessionToken(request: Request): string | null {
  const header = request.headers.get("x-session-token");
  if (header) {
    return header;
  }
  return new URL(request.url).searchParams.get("token");
}

/** Learner session tokens are bounded in time; labs are ephemeral (well under a day). */
const SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export async function requireLearnerSession(
  sessionId: string,
  token: string | null
): Promise<SessionRecord | null> {
  if (!token) {
    return null;
  }
  const session = await getSession(sessionId);
  if (!session || !verifySessionToken(token, session.tokenHash)) {
    return null;
  }
  if (Date.now() - session.createdAt.getTime() > SESSION_TOKEN_TTL_MS) {
    return null;
  }
  return session;
}
