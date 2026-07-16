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

test("close only accepts terminal human decisions", () => {
  assert.equal(checkActionTransition("close", "final_validated").ok, true);
  assert.equal(checkActionTransition("close", "stopped").ok, true);
  assert.equal(checkActionTransition("close", "implementation_delivered").ok, false);
});
