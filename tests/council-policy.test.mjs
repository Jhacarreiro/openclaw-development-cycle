import assert from "node:assert/strict";
import test from "node:test";
import { councilNeedsCorrectionsText, parseCouncilDecision, resolveAutoCouncilCorrectionsMax } from "../dist/core/council-policy.js";

test("negative and inconclusive council verdicts cannot be promoted by pass language", () => {
  for (const text of ["NO-GO: unresolved security vulnerability", "Decision: FAIL. SQL injection remains", "No blockers in the build. Do not ship: data loss", "STOP: ready to ship only after investigation"]) {
    assert.equal(parseCouncilDecision(text, "go"), "stop", text);
    assert.equal(councilNeedsCorrectionsText(text), true, text);
  }
  assert.equal(parseCouncilDecision("review completed"), "unknown");
  assert.equal(parseCouncilDecision(""), "unknown");
  assert.equal(parseCouncilDecision("Ready to ship", "unexpected"), "unknown");
  assert.equal(parseCouncilDecision("Reviewed the change", "go"), "go");
  assert.equal(parseCouncilDecision("Conditional GO; must fix test coverage"), "revise");
  assert.equal(parseCouncilDecision("No blockers", "stop"), "stop");
  assert.equal(parseCouncilDecision("## Verdict: **GO**\nTests: 194 passed, 0 failed."), "go");
  assert.equal(parseCouncilDecision("Ready to ship.\nTests failed: unresolved regression"), "stop");
});

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
