import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunDriver, projectsWithRuns, runToDrive } from "../dist/cycle/run-driver.js";

const hour = 3600 * 1000;

test("the run driver reconciles only each project's latest run while it is open and recently active", async (t) => {
  const runsRoot = join(tmpdir(), `development-cycle-run-driver-${process.pid}-${Date.now()}`);
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const now = Date.parse("2026-10-20T18:00:00Z");
  const runs = {
    // An abandoned launch is superseded by the project's newer delivered run.
    "publisher/publisher-20260918073221590-aaaaaa": { phase: "implementation_launched", updatedAt: "2026-09-18T07:33:00Z" },
    "publisher/publisher-20261020135547455-bbbbbb": { phase: "implementation_delivered", updatedAt: "2026-10-20T17:31:00Z" },
    "stale/stale-20261016120000000-cccccc": { phase: "implementation_launched", updatedAt: "2026-10-16T12:00:00Z" },
    "done/done-20261020100000000-dddddd": { phase: "closed_success", updatedAt: "2026-10-20T17:00:00Z" },
    "human/human-20261020100000000-eeeeee": { phase: "implementation_waiting_human", updatedAt: "2026-10-20T17:00:00Z" },
    "partial/partial-20261020100000000-ffffff": { phase: "closed_partial", failureClass: "review_non_convergence", updatedAt: "2026-10-20T17:00:00Z" },
    "continued/continued-20261020100000000-gggggg": { phase: "closed_partial", failureClass: "review_non_convergence", followUpRunId: "continued-x", updatedAt: "2026-10-20T17:00:00Z" },
    // A follow-up linked just before a restart, not yet launched.
    "linked/linked-20261020100000000-hhhhhh": { phase: "plan_ready_for_implementation", followUp: { sourceRunId: "x" }, updatedAt: "2026-10-20T17:00:00Z" },
    "planned/planned-20261020100000000-iiiiii": { phase: "plan_ready_for_implementation", updatedAt: "2026-10-20T17:00:00Z" },
  };
  for (const [path, status] of Object.entries(runs)) {
    await mkdir(join(runsRoot, path), { recursive: true });
    await writeFile(join(runsRoot, path, "status.json"), JSON.stringify(status));
  }
  const latestRunDir = async (project) => {
    const ids = Object.keys(runs).filter((path) => path.startsWith(`${project}/`)).sort();
    return ids.length ? join(runsRoot, ids.at(-1)) : "";
  };
  const driven = [];
  for (const project of (await projectsWithRuns(runsRoot)).sort()) {
    const run = await runToDrive(project, latestRunDir, 24 * hour, now);
    if (run) driven.push({ project: run.project, runId: run.runId });
  }
  assert.deepEqual(driven, [
    { project: "linked", runId: "linked-20261020100000000-hhhhhh" },
    { project: "partial", runId: "partial-20261020100000000-ffffff" },
    { project: "publisher", runId: "publisher-20261020135547455-bbbbbb" },
  ]);
});

test("stopping the run driver waits for the reconcile in flight and starts no further one", async () => {
  const driven = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const driver = createRunDriver({
    intervalMs: 60_000,
    maxIdleMs: 24 * hour,
    listProjects: async () => ["a", "b"],
    resolveRun: async (project) => ({ project, runId: `${project}-1` }),
    drive: async (run) => { driven.push(run.runId); if (run.runId === "a-1") await blocked; },
  });
  driver.start();
  await new Promise((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = driver.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.deepEqual(driven, ["a-1"]);
});

test("the run driver picks each project's run only when its turn comes", async () => {
  const latest = { a: "a-1", b: "b-1" };
  const driven = [];
  const driver = createRunDriver({
    intervalMs: 60_000,
    maxIdleMs: 24 * hour,
    listProjects: async () => ["a", "b"],
    resolveRun: async (project) => ({ project, runId: latest[project] }),
    // A newer run of b starts while a is still being reconciled.
    drive: async (run) => { driven.push(run.runId); if (run.project === "a") latest.b = "b-2"; },
  });
  await driver.tick();
  assert.deepEqual(driven, ["a-1", "b-2"]);
});

test("the run driver leaves a run its own reconciles have not moved for longer than the idle limit", async () => {
  let clock = 0;
  const driven = [];
  const progress = { a: "delivered" };
  const driver = createRunDriver({
    intervalMs: 60_000,
    maxIdleMs: 10 * hour,
    now: () => clock,
    listProjects: async () => ["a"],
    resolveRun: async (project) => ({ project, runId: "a-1", progress: progress[project] }),
    drive: async () => { driven.push(clock); },
  });
  for (clock = 0; clock <= 12 * hour; clock += 4 * hour) await driver.tick();
  assert.deepEqual(driven, [0, 4 * hour, 8 * hour]);
  progress.a = "validated";
  await driver.tick();
  assert.deepEqual(driven, [0, 4 * hour, 8 * hour, 16 * hour]);
});
