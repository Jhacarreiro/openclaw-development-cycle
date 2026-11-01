import assert from "node:assert/strict";
import test from "node:test";
import { classifyAutomaticImplementationRecovery } from "../dist/core/automatic-recovery.js";

test("planner reconsideration contract failure is recoverable once when the worktree is pristine", () => {
  const result = classifyAutomaticImplementationRecovery({
    phase: "implementation_failed",
    adapter: "octopus",
    stdout: "ERROR Planner reconsideration did not return both DECISIONS and DECOMPOSITION",
    stderr: "",
    recoveryCount: 0,
    hasIntervention: false,
    pristine: true,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "planner_reconsideration_contract_failure");
});

test("automatic planner recovery refuses side effects, interventions, and a second retry", () => {
  const base = {
    phase: "implementation_failed",
    adapter: "octopus",
    stdout: "Planner reconsideration did not return both DECISIONS and DECOMPOSITION",
    stderr: "",
  };
  assert.equal(classifyAutomaticImplementationRecovery({ ...base, recoveryCount: 0, hasIntervention: false, pristine: false }).eligible, false);
  assert.equal(classifyAutomaticImplementationRecovery({ ...base, recoveryCount: 0, hasIntervention: true, pristine: true }).eligible, false);
  assert.equal(classifyAutomaticImplementationRecovery({ ...base, recoveryCount: 1, hasIntervention: false, pristine: true }).eligible, false);
});

test("unknown implementation failures do not auto-recover", () => {
  const result = classifyAutomaticImplementationRecovery({
    phase: "implementation_failed",
    adapter: "octopus",
    stdout: "tests failed after implementation",
    stderr: "",
    recoveryCount: 0,
    hasIntervention: false,
    pristine: true,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "failure_not_recognized");
});
