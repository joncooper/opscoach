import assert from "node:assert/strict";
import test from "node:test";
import {
  readCallbackSecret,
  verifyGlobalCallbackSecret,
  verifySessionCallbackSecret,
} from "./callback-auth";
import { insertSession } from "./db";
import { hashSessionToken } from "./session-token";
import type { SessionRecord } from "./types";

function minimalSession(id: string, callbackTokenHash: string | null): SessionRecord {
  const now = new Date();
  return {
    id,
    packId: "pack",
    labId: "lab",
    mode: "practice",
    status: "provisioning",
    tokenHash: hashSessionToken("learner-token"),
    callbackTokenHash,
    publicKey: "ssh-ed25519 AAA",
    instanceId: null,
    sshHost: null,
    graderHost: null,
    sshPort: null,
    sshUser: "learner",
    sshHostAlias: "lab",
    contentPackVersion: "1",
    sessionRoot: "/tmp/test",
    seed: "seed",
    graderKeyPath: "/tmp/grader",
    knownHostsPath: "/tmp/known_hosts",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    latestGrader: null,
    errorMessage: null,
    ownerSub: null,
    ownerEmail: null,
  };
}

test("reads callback secret headers", () => {
  const request = new Request("http://localhost", {
    headers: { "x-callback-secret": "abc" },
  });
  assert.equal(readCallbackSecret(request), "abc");
});

test("verifies global secret with timing-safe compare", () => {
  const previous = process.env.INTERNAL_CALLBACK_SECRET;
  const secret = "global-secret-abcdef0123456789";
  process.env.INTERNAL_CALLBACK_SECRET = secret;
  try {
    assert.equal(verifyGlobalCallbackSecret(secret), true);
    assert.equal(verifyGlobalCallbackSecret(secret.slice(0, -1) + "X"), false);
    assert.equal(verifyGlobalCallbackSecret(null), false);
    // Placeholder/short secrets are never accepted (SUPPLY-06).
    process.env.INTERNAL_CALLBACK_SECRET = "change-me-in-production";
    assert.equal(verifyGlobalCallbackSecret("change-me-in-production"), false);
  } finally {
    if (previous === undefined) {
      delete process.env.INTERNAL_CALLBACK_SECRET;
    } else {
      process.env.INTERNAL_CALLBACK_SECRET = previous;
    }
  }
});

test("verifies per-session callback token from memory store", async () => {
  const previousDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  const sessionId = "callback-auth-test-session";
  const token = "per-session-callback-token";
  await insertSession(minimalSession(sessionId, hashSessionToken(token)));

  try {
    assert.equal(await verifySessionCallbackSecret(sessionId, token), true);
    assert.equal(await verifySessionCallbackSecret(sessionId, "wrong"), false);
    assert.equal(await verifySessionCallbackSecret("missing", token), false);
  } finally {
    if (previousDb === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDb;
    }
  }
});
