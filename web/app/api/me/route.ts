import { NextResponse } from "next/server";
import { readAlbIdentity } from "@/lib/identity";

// The signed-in caller, derived from the verified ALB OIDC header. Returns nulls
// (never 401) when there is no ALB identity — e.g. local dev — so the client UI can
// degrade gracefully rather than error.
export async function GET(request: Request) {
  const identity = await readAlbIdentity(request);
  return NextResponse.json({
    email: identity?.email ?? null,
    sub: identity?.sub ?? null,
  });
}
