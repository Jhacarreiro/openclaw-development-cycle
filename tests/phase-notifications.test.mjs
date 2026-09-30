import assert from "node:assert/strict";
import test from "node:test";
import { phaseNotificationForTransition } from "../dist/core/phase-notifications.js";

test("material phase transitions produce one useful notification payload", () => {
  const notice = phaseNotificationForTransition(
    { phase: "plan_ready_for_implementation", project: "demo", runId: "run-1" },
    { phase: "implementation_launched", project: "demo", runId: "run-1", nextAction: "Watch supervised implementation." },
  );
  assert.equal(notice?.phase, "implementation_launched");
  assert.match(notice?.title || "", /Implementation launched/);
  assert.match(notice?.text || "", /Design Review/);
  assert.match(notice?.text || "", /Run: run-1/);
});

test("same-phase status writes do not produce notification noise", () => {
  assert.equal(
    phaseNotificationForTransition(
      { phase: "implementation_launched", project: "demo", runId: "run-1" },
      { phase: "implementation_launched", project: "demo", runId: "run-1", updatedAt: "later" },
    ),
    null,
  );
});

test("human intervention phases keep their dedicated notification path", () => {
  assert.equal(
    phaseNotificationForTransition(
      { phase: "implementation_launched", project: "demo", runId: "run-1" },
      { phase: "implementation_waiting_human", project: "demo", runId: "run-1" },
    ),
    null,
  );
});

test("terminal outcomes are material notifications", () => {
  const go = phaseNotificationForTransition(
    { phase: "waiting_final_validation", project: "demo", runId: "run-1" },
    { phase: "final_validated", project: "demo", runId: "run-1" },
  );
  const stopped = phaseNotificationForTransition(
    { phase: "implementation_running", project: "demo", runId: "run-1" },
    { phase: "stopped", project: "demo", runId: "run-1", error: "operator stop" },
  );
  assert.match(go?.title || "", /Final decision: go/);
  assert.match(stopped?.title || "", /stopped/);
  assert.match(stopped?.text || "", /operator stop/);
});
