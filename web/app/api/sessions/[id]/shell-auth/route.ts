import { NextResponse } from "next/server";
import { requireLearnerSession } from "@/lib/session-access";
import { verifyGlobalCallbackSecret } from "@/lib/callback-auth";

// Internal-only: the custom WebSocket server (server.js) calls this during a /shell
// upgrade to authenticate the learner's per-session token and learn where to SSH. It is
// double-gated — the internal secret proves the caller is server.js, and the session
// token proves the browser owns this session — and it returns only a server-local key
// path (never key material), so a path leak grants nothing.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!verifyGlobalCallbackSecret(request.headers.get("x-shell-internal"))) {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const token =
    typeof (body as { token?: unknown })?.token === "string"
      ? (body as { token: string }).token
      : null;
  const session = await requireLearnerSession(id, token);
  if (!session) {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  const host = session.graderHost ?? session.sshHost;
  if (!host) {
    return NextResponse.json({ ok: false, error: "not_ready" });
  }
  return NextResponse.json({
    ok: true,
    host,
    port: session.sshPort ?? 22,
    user: session.sshUser,
    keyPath: session.graderKeyPath,
  });
}
