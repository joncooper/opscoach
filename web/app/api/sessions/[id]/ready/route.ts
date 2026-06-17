import { z } from "zod";
import { NextResponse } from "next/server";
import { verifyCallbackAuth } from "@/lib/callback-auth";
import { getSession } from "@/lib/db";
import { isPublicRoutableIp } from "@/lib/ip-address";
import { markReady } from "@/lib/sessions";
import { toSessionState } from "@/lib/types";

const bodySchema = z.object({
  sshHost: z.string().min(1),
  graderHost: z.string().min(1).optional(),
  sshPort: z.number().int().positive(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  if (!(await verifyCallbackAuth(id, request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const existing = await getSession(id);
  if (!existing) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (existing.status !== "provisioning") {
    return NextResponse.json(
      { error: `Session is ${existing.status}; readiness not accepted` },
      { status: 409 }
    );
  }

  const json = await request.json();
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  if (!isPublicRoutableIp(parsed.data.sshHost)) {
    return NextResponse.json(
      { error: "sshHost must be a public routable IPv4 address" },
      { status: 422 }
    );
  }
  const session = await markReady(id, parsed.data);
  if (!session) {
    const current = await getSession(id);
    if (!current) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (current.errorMessage?.includes("SSH verification")) {
      return NextResponse.json(
        { error: current.errorMessage, session: toSessionState(current) },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "Could not accept readiness callback" },
      { status: 422 }
    );
  }
  return NextResponse.json({ session, accepted: true }, { status: 202 });
}
