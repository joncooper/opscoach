import { z } from "zod";
import { NextResponse } from "next/server";
import { verifyCallbackAuth } from "@/lib/callback-auth";
import { shutdownSessionInternal } from "@/lib/sessions";

const bodySchema = z.object({
  reason: z.enum(["ssh_idle", "max_ttl", "expires_at_sweep", "manual"]).optional(),
});

/** Host/Lambda-initiated teardown when SSH goes idle or max TTL fires. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  // Shutdown is the only callback the trusted terminator Lambda makes, so it is the
  // only one that may present the global secret; /ready and /progress require the
  // per-session token.
  if (!(await verifyCallbackAuth(id, request, { allowGlobalSecret: true }))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let reason: "ssh_idle" | "max_ttl" | "expires_at_sweep" | "manual" = "manual";
  try {
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (parsed.success && parsed.data.reason) {
      reason = parsed.data.reason;
    }
  } catch {
    // empty body is fine
  }

  const session = await shutdownSessionInternal(id, reason);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  return NextResponse.json({ session });
}
