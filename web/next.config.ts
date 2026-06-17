import type { NextConfig } from "next";

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  // SAMEORIGIN (not DENY) so the session page can embed the live lab dashboard, which is
  // proxied through this same origin; cross-origin framing is still blocked.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

const nextConfig: NextConfig = {
  // Served by a custom Node server (server.js) that also hosts the WebSocket terminal,
  // so we use a normal build (not standalone).
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
