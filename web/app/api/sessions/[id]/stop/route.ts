import { NextResponse } from "next/server";
import { stopSession } from "@/lib/sessions";

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
  const session = await stopSession(id, token);
  if (!session) {
    return NextResponse.json({ error: "Invalid session or token" }, { status: 403 });
  }
  return NextResponse.json({ session });
}
