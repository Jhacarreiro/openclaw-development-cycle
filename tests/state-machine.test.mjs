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

test("mechanical revision outcome routes into the corrections path", () => {
  assert.equal(checkActionTransition("start_corrections", "external_validation_needs_revision").ok, true);
  assert.equal(checkActionTransition("start_corrections", "external_validation_needs_revision").error, undefined);
});

test("mechanical revisions allow rerunning final validation and closing the stopped gate", () => {
  assert.equal(checkActionTransition("run_final_validation", "external_validation_needs_revision").ok, true);
  assert.equal(checkActionTransition("run_final_validation", "external_validation_stopped").ok, true);
  assert.equal(checkActionTransition("close", "external_validation_stopped").ok, true);
});

test("state machine tests cover every new phase entry", () => {
  // Exhaustively assert the new phase entries added by the fix
  const cases = [
    ["run_final_validation", "external_validation_needs_revision", true],
    ["run_final_validation", "external_validation_stopped", true],
    ["start_corrections", "external_validation_needs_revision", true],
    ["start_corrections", "needs_corrections", true],
    ["close", "external_validation_stopped", true],
    ["close", "final_validated", true],
    ["close", "stopped", true],
    // Negatives: should stay blocked
    ["start_corrections", "external_validation_passed", false],
    ["close", "external_validation_passed", false],
  ];
  for (const [action, phase, shouldPass] of cases) {
    const res = checkActionTransition(action, phase);
    assert.equal(res.ok, shouldPass, `${action} from ${phase} expected ok=${shouldPass} but got ${res.ok}`);
  }
});
