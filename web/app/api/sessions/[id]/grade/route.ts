import { NextResponse } from "next/server";
import { runGraderForSession } from "@/lib/sessions";

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
  try {
    const result = await runGraderForSession(id, token);
    if (!result) {
      return NextResponse.json({ error: "Invalid session or token" }, { status: 403 });
    }
    return NextResponse.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Grader failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
