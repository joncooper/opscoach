import { NextRequest, NextResponse } from "next/server";
import { ensureMigrated, getSession, getSessionNote, setSessionNote } from "@/lib/db";
import { verifySessionToken } from "@/lib/session-token";
import { identityOwnsSession, readAlbIdentity } from "@/lib/identity";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  await ensureMigrated();
  const session = await getSession(id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  // Reading notes requires being the owner (verified ALB identity) or holding the
  // session token. Previously this route had no check at all (cross-user IDOR).
  const identity = await readAlbIdentity(request);
  const token = request.headers.get("X-Session-Token");
  const authorized =
    identityOwnsSession(identity, session.ownerSub) ||
    (token != null && verifySessionToken(token, session.tokenHash));
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await getSessionNote(id);
  return NextResponse.json({ note: body });
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const token = request.headers.get("X-Session-Token");
  if (!token) {
    return NextResponse.json({ error: "Missing session token" }, { status: 401 });
  }
  await ensureMigrated();
  const session = await getSession(id);
  if (!session || !verifySessionToken(token, session.tokenHash)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const payload = (await request.json()) as { body?: string };
  const body = typeof payload.body === "string" ? payload.body : "";
  if (body.length > 100_000) {
    return NextResponse.json({ error: "Note too large" }, { status: 413 });
  }
  await setSessionNote(id, body);
  return NextResponse.json({ note: body });
}
