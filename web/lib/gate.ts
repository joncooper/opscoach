// A minimal post-auth access gate: even once a visitor is authenticated through the
// upstream identity provider, they must enter a shared passphrase before reaching any
// app page. This is intentionally simple (a shared code, not per-user auth) — it just
// keeps random authenticated accounts out of the demo. The prompt, accepted answers, and
// cookie token are all supplied via environment variables so nothing secret lives in the
// source. Edge-safe: pure strings + process.env, no Node APIs (middleware imports it).

export const GATE_COOKIE = "ops_gate";

// Opaque token written to the (httpOnly) cookie once the code is accepted. A visitor must
// know the code to get this set; it is never otherwise exposed to the client. Provide a
// strong random value in production via the GATE_TOKEN env var.
export const GATE_TOKEN = process.env.GATE_TOKEN ?? "dev-change-me";

// Accepted answers come from the GATE_ANSWERS env var (comma-separated) and are normalized
// the same way submitted codes are, so matching is punctuation- and case-insensitive.
const ACCEPTED = (process.env.GATE_ANSWERS ?? "change me")
  .split(",")
  .map((answer) => normalizeGateCode(answer))
  .filter((answer) => answer.length > 0);

export function normalizeGateCode(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "") // ignore punctuation
    .replace(/\s+/g, " ")
    .trim();
}

export function checkGateCode(input: string): boolean {
  return ACCEPTED.includes(normalizeGateCode(input));
}
