import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendBootstrapProgress,
  readBootstrapProgress,
} from "./bootstrap-progress";

test("appendBootstrapProgress persists readable lines", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opscoach-progress-"));
  appendBootstrapProgress(root, {
    step: "bootstrap",
    detail: "Installing Docker",
  });
  appendBootstrapProgress(root, {
    step: "start_lab",
    detail: "Starting lab container",
  });

  const entries = readBootstrapProgress(root);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.detail, "Installing Docker");
  assert.equal(entries[1]?.step, "start_lab");
});
