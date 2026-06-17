import { NextResponse } from "next/server";
import { getLab } from "@/lib/content";
import { readLearnerSessionToken, requireLearnerSession } from "@/lib/session-access";
import { getSessionState } from "@/lib/sessions";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const token = readLearnerSessionToken(request);
  const authorized = await requireLearnerSession(id, token);
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = await getSessionState(id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  let lab: { prompt?: string; summary?: string } | null = null;
  try {
    const reference = getLab(session.packId, session.labId);
    lab = {
      prompt: reference.lab.prompt,
      summary: reference.lab.summary,
    };
  } catch {
    lab = null;
  }
  return NextResponse.json({ session, lab });
}
