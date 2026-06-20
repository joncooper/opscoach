import { NextRequest, NextResponse } from "next/server";
import { GATE_COOKIE, GATE_TOKEN } from "@/lib/gate";

// Decode (not verify) the caller from the ALB OIDC JWT, for access logging only. The ALB
// verifies it upstream and lib/identity.ts re-verifies wherever it gates access; here we
// just want a name on the log line. Edge-safe: atob + JSON, no Node APIs.
function callerFromOidc(token: string | null): string {
  if (!token) return "anon";
  try {
    const payload = token.split(".")[1];
    if (!payload) return "unknown";
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      email?: string;
      sub?: string;
    };
    return claims.email || claims.sub || "unknown";
  } catch {
    return "unknown";
  }
}

// Gate every app page behind the shared access code (checked after Google auth). API
// routes are exempt — they carry their own per-session token auth, and the lab host's
// callbacks have no browser cookie. The /gate screen and static assets are exempt too.
export function middleware(req: NextRequest) {
  // One structured access line per page request (the matcher below excludes assets and
  // API routes). Streams to CloudWatch; query who/when/how-often/from-where with Insights.
  console.log(
    JSON.stringify({
      evt: "access",
      at: new Date().toISOString(),
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      user: callerFromOidc(req.headers.get("x-amzn-oidc-data")),
      method: req.method,
      path: req.nextUrl.pathname,
    }),
  );

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
