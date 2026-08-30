import assert from "node:assert/strict";
import test from "node:test";
import { transientRuntimeObservationRecoveryPatch } from "../dist/core/runtime-failure.js";

test("clears a stale runtime observation blocker once the current observation is clean", () => {
  const patch = transientRuntimeObservationRecoveryPatch({
    phase: "implementation_launched",
    failureClass: "runtime_observation_blocker",
  }, null);
  assert.equal(patch.failureClass, null);
  assert.match(patch.nextAction, /Continue observing the supervised implementation/);
  assert.ok(patch.failureClearedAt);
});

test("does not clear substantive failures", () => {
  assert.equal(transientRuntimeObservationRecoveryPatch({
    phase: "implementation_launched",
    failureClass: "auth_failed",
  }, null), null);
});

test("does not clear the blocker while a current classification still exists", () => {
  assert.equal(transientRuntimeObservationRecoveryPatch({
    phase: "implementation_launched",
    failureClass: "runtime_observation_blocker",
  }, { failureClass: "runtime_observation_blocker" }), null);
});
