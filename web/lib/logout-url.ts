import type { NextRequest } from "next/server";

/** Public origin from ALB / reverse-proxy headers (never localhost fallback). */
export function publicOrigin(request: Pick<NextRequest, "headers" | "nextUrl">): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host =
    forwardedHost?.split(",")[0]?.trim() || request.headers.get("host")?.trim();
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    request.nextUrl.protocol.replace(":", "") ||
    "https";
  if (!host) {
    return request.nextUrl.origin;
  }
  return `${proto}://${host}`;
}

/** ALB session cookies set by the authenticate-cognito action; the app must clear these. */
export const ALB_SESSION_COOKIES = ["AWSELBAuthSessionCookie-0", "AWSELBAuthSessionCookie-1"];

/**
 * Cognito hosted-UI logout URL. The ALB has no /oauth2/logout endpoint, so a real
 * sign-out means (1) clearing the ALB session cookies on this domain (done in the
 * /logout route) and (2) redirecting here so Cognito terminates its own session.
 * `logout_uri` must exactly match a registered LogoutURL on the app client.
 */
export function signOutUrlForRequest(request: NextRequest): string {
  const origin = publicOrigin(request);
  // Land on a public, auth-bypassed page so the ALB does not immediately re-authenticate
  // — with Google SSO still active, redirecting to "/" would silently log the user back in.
  const loggedOut = `${origin}/logged-out`;
  const domain = process.env.COGNITO_DOMAIN?.trim();
  const clientId = process.env.COGNITO_CLIENT_ID?.trim();
  if (!domain || !clientId) {
    // Cognito not configured (local dev / auth disabled): nothing to sign out of.
    return loggedOut;
  }
  const params = new URLSearchParams({ client_id: clientId, logout_uri: loggedOut });
  return `https://${domain}/logout?${params.toString()}`;
}
