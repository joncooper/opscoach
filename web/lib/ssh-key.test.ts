import assert from "node:assert/strict";
import test from "node:test";
import { validatePublicKey } from "./ssh-key";

const ED25519 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICzMiBPOhQSLlWzCH7VdTnY5cHpOVc1nVWsnyT0TUS00 me@host";

test("accepts a valid ed25519 key and trims it", () => {
  const result = validatePublicKey(`  ${ED25519}\n`);
  assert.equal(result.ok, true);
  assert.equal(result.key, ED25519);
});

test("accepts a key with no comment", () => {
  const [type, blob] = ED25519.split(" ");
  const result = validatePublicKey(`${type} ${blob}`);
  assert.equal(result.ok, true);
});

test("rejects empty input", () => {
  assert.equal(validatePublicKey("   ").ok, false);
});

test("rejects multi-line input (prevents injecting extra keys)", () => {
  assert.equal(validatePublicKey(`${ED25519}\nssh-rsa AAAAB3Nz...`).ok, false);
});

test("rejects unknown key types", () => {
  assert.equal(validatePublicKey("ssh-magic AAAAB3NzaC1abc123def456").ok, false);
});

test("rejects a non-base64 key body", () => {
  assert.equal(validatePublicKey("ssh-ed25519 not*valid*base64!!").ok, false);
});

test("rejects a key with only a type and no body", () => {
  assert.equal(validatePublicKey("ssh-ed25519").ok, false);
});
