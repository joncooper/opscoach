import { verify as cryptoVerify } from "crypto";

export interface AlbIdentity {
  sub: string;
  email: string | null;
}

// ALB OIDC public keys are immutable per kid; cache them for the process lifetime.
const keyCache = new Map<string, string>();

function b64urlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function albRegion(): string {
  return process.env.OPSCOACH_REGION || process.env.AWS_REGION || "us-east-1";
}

async function fetchAlbPublicKey(kid: string): Promise<string | null> {
  const cached = keyCache.get(kid);
  if (cached) {
    return cached;
  }
  const url = `https://public-keys.auth.elb.${albRegion()}.amazonaws.com/${encodeURIComponent(kid)}`;
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  const pem = (await response.text()).trim();
  keyCache.set(kid, pem);
  return pem;
}

/**
 * Verify the ALB-injected `x-amzn-oidc-data` JWT (ES256, signed by the load balancer)
 * and return the caller's Cognito identity.
 *
 * Returns null — never throws — when the header is absent (e.g. local dev with no ALB),
 * malformed, expired, or the signature cannot be verified. Callers therefore degrade to
 * the per-session token rather than locking anyone out on a verification hiccup.
 */
export async function readAlbIdentity(
  source: { headers: { get(name: string): string | null } }
): Promise<AlbIdentity | null> {
  try {
    const data = source.headers.get("x-amzn-oidc-data");
    if (!data) {
      return null;
    }
    const [headerB64, payloadB64, signatureB64] = data.split(".");
    if (!headerB64 || !payloadB64 || !signatureB64) {
      return null;
    }
    const header = JSON.parse(b64urlToBuffer(headerB64).toString("utf8")) as {
      alg?: string;
      kid?: string;
    };
    if (header.alg !== "ES256" || !header.kid) {
      return null;
    }
    const pem = await fetchAlbPublicKey(header.kid);
    if (!pem) {
      return null;
    }
    const verified = cryptoVerify(
      "sha256",
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: pem, dsaEncoding: "ieee-p1363" },
      b64urlToBuffer(signatureB64),
    );
    if (!verified) {
      return null;
    }
    const payload = JSON.parse(b64urlToBuffer(payloadB64).toString("utf8")) as {
      sub?: string;
      email?: string;
      exp?: number;
    };
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return null;
    }
    if (!payload.sub) {
      return null;
    }
    return { sub: payload.sub, email: payload.email ?? null };
  } catch {
    return null;
  }
}

/** True when a verified caller identity is the recorded owner of a session. */
export function identityOwnsSession(
  identity: AlbIdentity | null,
  ownerSub: string | null,
): boolean {
  return Boolean(identity && ownerSub && identity.sub === ownerSub);
}
