/**
 * Reject cross-site state-changing requests that would ride the ALB session cookie (CSRF).
 * Allows same-origin and direct (no Origin / Sec-Fetch-Site: none) requests; rejects a
 * present Origin whose host differs from the forwarded/Host header.
 */
export function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return false;
  }
  const origin = request.headers.get("origin");
  if (origin) {
    const host =
      request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
      request.headers.get("host");
    try {
      if (host && new URL(origin).host !== host) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}
