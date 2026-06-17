import test from "node:test";
import assert from "node:assert/strict";
import { probeSshWithRetry } from "./ssh-probe";

test("probeSshWithRetry fails when key file missing", async () => {
  const result = await probeSshWithRetry(
    {
      sshKeyPath: "/tmp/opscoach-nonexistent-grader-key",
      sshHost: "127.0.0.1",
      sshPort: 22,
      sshUser: "learner",
      knownHostsPath: "/tmp/opscoach-known_hosts",
    },
    1,
    0
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /missing/i);
});
