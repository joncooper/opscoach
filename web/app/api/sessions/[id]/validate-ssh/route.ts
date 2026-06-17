import { NextResponse } from "next/server";
import { getSession } from "@/lib/db";
import { probeSessionSsh } from "@/lib/ssh-probe";
import { verifySessionToken } from "@/lib/session-token";

function readToken(request: Request): string | null {
  return request.headers.get("x-session-token");
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const token = readToken(request);
  if (!token) {
    return NextResponse.json({ error: "Missing X-Session-Token header" }, { status: 401 });
  }

  const session = await getSession(id);
  if (!session || !verifySessionToken(token, session.tokenHash)) {
    return NextResponse.json({ error: "Invalid session or token" }, { status: 403 });
  }

  const probe = await probeSessionSsh(session);
  return NextResponse.json({
    ok: probe.ok,
    step: probe.ok ? "verify_ssh" : "verify_ssh",
    detail: probe.detail,
  });
}
