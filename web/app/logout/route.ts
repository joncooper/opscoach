import { NextRequest, NextResponse } from "next/server";
import { ALB_SESSION_COOKIES, signOutUrlForRequest } from "@/lib/logout-url";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const response = NextResponse.redirect(signOutUrlForRequest(request));
  // The ALB exposes no logout endpoint, so the app expires the ALB session cookies
  // here; the redirect then clears the Cognito session. Both are required to sign out.
  for (const name of ALB_SESSION_COOKIES) {
    response.cookies.set(name, "", {
      path: "/",
      expires: new Date(0),
      maxAge: 0,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
  }
  return response;
}
