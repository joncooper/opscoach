import { NextRequest, NextResponse } from "next/server";
import { GATE_COOKIE, GATE_TOKEN } from "@/lib/gate";

// Gate every app page behind the shared access code (checked after Google auth). API
// routes are exempt — they carry their own per-session token auth, and the lab host's
// callbacks have no browser cookie. The /gate screen and static assets are exempt too.
export function middleware(req: NextRequest) {
  if (req.cookies.get(GATE_COOKIE)?.value === GATE_TOKEN) {
    return NextResponse.next();
  }
  const url = req.nextUrl.clone();
  const next = req.nextUrl.pathname + req.nextUrl.search;
  url.pathname = "/gate";
  url.search = `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next|api|gate|logged-out|favicon).*)"],
};
