import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRunIndex } from "../dist/reader/index.js";

function detailsOf(result) { return result?.details ?? result; }

async function loadTool(root) {
  Object.assign(process.env, {
    DEVELOPMENT_CYCLE_STATE_ROOT: join(root, "state"),
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED: "false",
    DEVELOPMENT_CYCLE_OBSERVER_ENABLED: "false",
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED: "false",
  });
  delete process.env.DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_COMMAND;
  const { default: plugin } = await import(`../dist/index.js?run-tracking=${Date.now()}-${Math.random()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });
  return tool;
}

async function closeRun(tool, project, runId, checkout, statusPath, patch = {}) {
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  await writeFile(statusPath, JSON.stringify({ ...status, ...patch, phase: "council_validated", projectRoot: checkout }));
  assert.equal(detailsOf(await tool.execute("finalize", { action: "finalize_delivery", project, runId, projectRoot: checkout }, undefined, undefined)).ok, true);
  assert.equal(detailsOf(await tool.execute("close", { action: "close", project, runId }, undefined, undefined)).phase, "closed");
}

test("a new run records its lifetime and zero counts, and the reader reports them", async (t) => {
  const root = join(tmpdir(), `development-cycle-run-tracking-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, ".git"), { recursive: true });
  const tool = await loadTool(root);
  const project = "run-tracking";
  const runId = "run-tracking-new";
  const requested = detailsOf(await tool.execute("request", { action: "request_plan", project, runId, projectRoot: checkout }, undefined, undefined));
  const statusPath = join(requested.dir, "status.json");
  const created = JSON.parse(await readFile(statusPath, "utf8"));
  assert.ok(Number.isFinite(Date.parse(created.createdAt)));
  assert.deepEqual([created.interventionAnswerCount, created.correctionRoundCount], [0, 0]);

  // Launches are simulated by the status patch; the first one would record startedAt.
  await closeRun(tool, project, runId, checkout, statusPath, { startedAt: created.createdAt });
  const closed = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(closed.createdAt, created.createdAt);

  const run = (await readRunIndex(join(root, "state"))).projects[0].runs[0];
  assert.deepEqual([run.lifecycle, run.interventionCount, run.correctionRounds, run.endedAt], ["closed", 0, 0, closed.closedAt]);
  assert.equal(run.durationMs, Date.parse(closed.closedAt) - Date.parse(created.createdAt));
});

test("a run created before tracking keeps counts and start time unavailable", async (t) => {
  const root = join(tmpdir(), `development-cycle-run-tracking-legacy-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, ".git"), { recursive: true });
  const tool = await loadTool(root);
  const project = "run-tracking";
  const runId = "run-tracking-legacy";
  const requested = detailsOf(await tool.execute("request", { action: "request_plan", project, runId, projectRoot: checkout }, undefined, undefined));
  const statusPath = join(requested.dir, "status.json");
  const { createdAt, interventionAnswerCount, correctionRoundCount, ...legacy } = JSON.parse(await readFile(statusPath, "utf8"));
  await writeFile(statusPath, JSON.stringify(legacy));

  await closeRun(tool, project, runId, checkout, statusPath);
  const closed = JSON.parse(await readFile(statusPath, "utf8"));
  for (const field of ["createdAt", "startedAt", "interventionAnswerCount", "correctionRoundCount"]) assert.equal(closed[field], undefined, field);

  const run = (await readRunIndex(join(root, "state"))).projects[0].runs[0];
  assert.equal(run.endedAt, closed.closedAt);
  assert.deepEqual([run.interventionCount, run.correctionRounds, run.durationMs], [null, null, null]);
  assert.deepEqual([run.unavailable.interventionCount, run.unavailable.correctionRounds, run.unavailable.durationMs], ["not_recorded", "not_recorded", "not_recorded"]);
});
