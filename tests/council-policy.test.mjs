import assert from "node:assert/strict";
import test from "node:test";
import { councilNeedsCorrectionsText, resolveAutoCouncilCorrectionsMax } from "../dist/core/council-policy.js";

test("council pass language does not trigger corrections", () => {
  for (const text of ["no blockers found", "No blocking issues; ready to ship", "ready to ship", "GO"]) {
    assert.equal(councilNeedsCorrectionsText(text), false, text);
  }
  assert.equal(councilNeedsCorrectionsText("must fix blocker before ship"), true);
  assert.equal(councilNeedsCorrectionsText("corrections required"), true);
});

test("auto council correction limit preserves explicit zero", () => {
  assert.equal(resolveAutoCouncilCorrectionsMax(undefined), 2);
  assert.equal(resolveAutoCouncilCorrectionsMax(null), 2);
  assert.equal(resolveAutoCouncilCorrectionsMax(""), 2);
  assert.equal(resolveAutoCouncilCorrectionsMax(0), 0);
  assert.equal(resolveAutoCouncilCorrectionsMax(1), 1);
  assert.equal(resolveAutoCouncilCorrectionsMax("bad"), 2);
});
