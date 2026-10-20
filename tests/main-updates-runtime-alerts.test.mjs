import assert from "node:assert/strict";
import test from "node:test";
import { createMainUpdates } from "../dist/cycle/main-updates.js";

const { dcClassify } = createMainUpdates({ runtimeHome: "/nonexistent", loadJson: async () => null, saveJson: async () => {}, cycleStatus: async () => ({}), appendJsonl: async () => {} });
const runtimeWith = (...codes) => ({ richObservation: { alerts: codes.map((code) => ({ code })), latestTimeline: [] } });

test("a delivered run is not blocked by alerts about its exited root process", async () => {
  const ev = await dcClassify("/nonexistent", { phase: "implementation_delivered" }, runtimeWith("wall_clock_timeout_seen", "status_running_but_root_missing"));
  assert.equal(ev.classification, null);
});

test("a provider still running in the attempt outside the observed tree blocks a delivered run", async () => {
  const ev = await dcClassify("/nonexistent", { phase: "implementation_delivered" }, runtimeWith("provider_processes_outside_observed_tree"));
  assert.equal(ev.classification?.failureClass, "runtime_observation_blocker");
});

test("once a provider outside the observed tree is gone, the run gets back the next action the blocker replaced", async () => {
  let status = { phase: "external_validation_passed", nextAction: "Finalize the delivery." };
  const store = { runtimeHome: "/nonexistent", loadJson: async () => null, saveJson: async () => {}, appendJsonl: async () => {}, cycleStatus: async (_dir, patch) => (status = { ...status, ...patch }) };
  const updates = createMainUpdates(store);
  await updates.dcPersistFailure("/nonexistent", status, await updates.dcClassify("/nonexistent", status, runtimeWith("provider_processes_outside_observed_tree")));
  assert.equal(status.failureClass, "runtime_observation_blocker");
  await updates.dcPersistFailure("/nonexistent", status, await updates.dcClassify("/nonexistent", status, runtimeWith()));
  assert.equal(status.failureClass, null);
  assert.equal(status.nextAction, "Finalize the delivery.");
});

test("a blocker that outlives the runner keeps directing the run after the runner's phase change", async () => {
  let status = { phase: "implementation_running", nextAction: "Observe the implementation." };
  const store = { runtimeHome: "/nonexistent", loadJson: async () => null, saveJson: async () => {}, appendJsonl: async () => {}, cycleStatus: async (_dir, patch) => (status = { ...status, ...patch }) };
  const updates = createMainUpdates(store);
  const orphan = runtimeWith("provider_processes_outside_observed_tree");
  await updates.dcPersistFailure("/nonexistent", status, await updates.dcClassify("/nonexistent", status, orphan));
  status = { ...status, phase: "implementation_delivered", nextAction: "Run mechanical final validation, then council code review." };
  await updates.dcPersistFailure("/nonexistent", status, await updates.dcClassify("/nonexistent", status, orphan));
  assert.equal(status.nextAction, status.failureRecommendedAction);
  await updates.dcPersistFailure("/nonexistent", status, await updates.dcClassify("/nonexistent", status, runtimeWith()));
  assert.equal(status.nextAction, "Run mechanical final validation, then council code review.");
});
