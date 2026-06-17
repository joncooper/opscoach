import test from "node:test";
import assert from "node:assert/strict";
import { parseLabBrief } from "./lab-brief";

test("parseLabBrief extracts objective and paths", () => {
  const brief = parseLabBrief(
    "Orient yourself on this host. Create ~/work/orientation/summary.txt with facts. Copy /etc/hosts if needed."
  );
  assert.match(brief.objective, /Orient yourself/);
  assert.ok(brief.deliverables.includes("~/work/orientation/summary.txt"));
});

test("parseLabBrief handles empty input", () => {
  assert.deepEqual(parseLabBrief(""), {
    objective: "",
    body: "",
    steps: [],
    deliverables: [],
  });
});
