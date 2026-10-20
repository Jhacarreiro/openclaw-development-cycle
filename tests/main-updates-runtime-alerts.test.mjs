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
