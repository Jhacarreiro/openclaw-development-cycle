import assert from "node:assert/strict";
import test from "node:test";
import { parseFinalDecision } from "../dist/decisions.js";

test("accepts the three contractual decisions", () => {
  assert.deepEqual(parseFinalDecision("go\nAll checks passed."), { ok: true, decision: "go" });
  assert.deepEqual(parseFinalDecision("REVISE: fix tests"), { ok: true, decision: "revise" });
  assert.deepEqual(parseFinalDecision("stop. blocker"), { ok: true, decision: "stop" });
});

test("rejects ambiguous or accidental first tokens", () => {
  for (const text of ["approved", "pass", "error", "needs revision", ""]) {
    const result = parseFinalDecision(text);
    assert.equal(result.ok, false, text);
    assert.equal(result.error, "invalid_final_decision");
  }
});
