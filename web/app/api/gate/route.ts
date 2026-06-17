import { NextResponse } from "next/server";
import { checkGateCode, GATE_COOKIE, GATE_TOKEN } from "@/lib/gate";

// Accepts the shared access code and, if correct, sets the gate cookie that the
// middleware checks on every page. Exempt from the gate itself (it lives under /api).
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const code = typeof (body as { code?: unknown })?.code === "string"
    ? (body as { code: string }).code
    : "";
  if (!checkGateCode(code)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(GATE_COOKIE, GATE_TOKEN, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
}
