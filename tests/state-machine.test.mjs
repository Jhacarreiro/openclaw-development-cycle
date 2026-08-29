import assert from "node:assert/strict";
import test from "node:test";
import { checkActionTransition } from "../dist/state-machine.js";

test("status and reconcile are always allowed", () => {
  assert.equal(checkActionTransition("status", "implementation_launched").ok, true);
  assert.equal(checkActionTransition("reconcile", "final_validated").ok, true);
});

test("handoff requires an approved plan", () => {
  assert.equal(checkActionTransition("start_implementation", "plan_ready_for_implementation").ok, true);
  const denied = checkActionTransition("start_implementation", "waiting_external_plan");
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "invalid_phase_transition");
});

test("final validation response requires the human gate phase", () => {
  assert.equal(checkActionTransition("record_final_validation", "waiting_final_validation").ok, true);
  assert.equal(checkActionTransition("record_final_validation", "external_validation_passed").ok, false);
});


test("finalize_delivery accepts terminal delivery outcomes", () => {
  for (const phase of [
    "final_validated",
    "needs_corrections",
    "implementation_failed",
    "corrections_failed",
    "council_review_needs_corrections",
    "council_review_failed",
    "council_validated",
    "council_review_waiting_human",
    "external_validation_failed",
    "stopped",
    "repository_delivery_failed",
  ]) {
    assert.equal(checkActionTransition("finalize_delivery", phase).ok, true, phase);
  }
  assert.equal(checkActionTransition("finalize_delivery", "implementation_running").ok, false);
});


test("close cannot bypass repository delivery", () => {
  assert.equal(checkActionTransition("close", "final_validated").ok, false);
  assert.equal(checkActionTransition("close", "stopped").ok, false);
  assert.equal(checkActionTransition("close", "merged").ok, true);
  assert.equal(checkActionTransition("close", "closed_partial").ok, true);
  assert.equal(checkActionTransition("close", "closed_invalid").ok, true);
});

test("council corrections can be launched from council_review_needs_corrections", () => {
  assert.equal(checkActionTransition("start_corrections", "council_review_needs_corrections").ok, true);
});

test("failed implementation can be retried only through explicit start_implementation", () => {
  assert.equal(checkActionTransition("start_implementation", "implementation_failed").ok, true);
});
