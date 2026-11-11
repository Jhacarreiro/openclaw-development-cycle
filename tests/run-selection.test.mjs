import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectPathCandidates } from "../dist/core/ids.js";
import { runToDrive } from "../dist/cycle/run-driver.js";
import { latestRunDir } from "../dist/cycle/run-selection.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-run-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function run(root, project, id, status = {}) {
  const dir = join(root, project, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "status.json"), JSON.stringify(status));
  return dir;
}

test("a registered manual ID supersedes an older timestamped stop despite later reconcile activity", async (t) => {
  const root = await fixture(t);
  const old = await run(root, "demo", "demo-20260101120000000-aaaaaa", {
    phase: "stopped", updatedAt: "2026-01-02T13:00:00Z", failureClass: "rate_limited",
  });
  const current = await run(root, "demo", "demo-preserved-continuation", {
    phase: "implementation_launched", createdAt: "2026-01-02T12:00:00Z", updatedAt: "2026-01-02T12:01:00Z",
  });
  const later = new Date("2026-01-04T00:00:00Z");
  await writeFile(join(old, "runtime_alerts.json"), "{}");
  await utimes(old, later, later);
  await utimes(join(old, "status.json"), later, later);

  assert.equal(await latestRunDir(root, "demo"), current);
  const driven = await runToDrive("demo", (project) => latestRunDir(root, project), 86400_000, Date.parse("2026-01-02T13:00:00Z"));
  assert.equal(driven.runId, "demo-preserved-continuation");
});

test("creation metadata and legacy ID dates share chronological ordering in both directions", async (t) => {
  const root = await fixture(t);
  await run(root, "demo", "demo-manual", { createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-04T00:00:00Z" });
  const newer = await run(root, "demo", "demo-20260103000000000-bbbbbb");
  assert.equal(await latestRunDir(root, "demo"), newer);
  // The caller's ID is an identity, not the authoritative registration date.
  const registered = await run(root, "demo", "demo-20250101000000000-cccccc", { createdAt: "2026-01-04T00:00:00Z" });
  assert.equal(await latestRunDir(root, "demo"), registered);
});

test("legacy second and millisecond IDs remain ordered when metadata is missing or invalid", async (t) => {
  const root = await fixture(t);
  const old = await run(root, "demo", "demo-20260101120000-aaaaaa", { createdAt: "invalid" });
  const newer = await run(root, "demo", "demo-20260101120000001-bbbbbb", { createdAt: null });
  const later = new Date("2026-01-05T00:00:00Z");
  await utimes(old, later, later);
  assert.equal(await latestRunDir(root, "demo"), newer);
});

test("canonical and legacy project directories participate in the same ordering", async (t) => {
  const root = await fixture(t);
  const rawProject = "Example / Project";
  const [canonical, legacy] = projectPathCandidates(rawProject);
  assert.notEqual(canonical, legacy);
  await run(root, canonical, "run-a", { createdAt: "2026-01-01T00:00:00Z" });
  const newer = await run(root, legacy, "run-b", { createdAt: "2026-01-02T00:00:00Z" });
  assert.equal(await latestRunDir(root, rawProject), newer);
});

test("selection keeps root, project, run and status symlinks outside the candidate set", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const current = await run(root, "demo", "current", { createdAt: "2026-01-02T00:00:00Z" });
  const foreign = await run(outside, "demo", "foreign", { createdAt: "2099-01-01T00:00:00Z" });
  await symlink(foreign, join(root, "demo", "linked-run"), "dir");
  const linkedStatus = join(root, "demo", "linked-status");
  await mkdir(linkedStatus);
  await symlink(join(foreign, "status.json"), join(linkedStatus, "status.json"));
  assert.equal(await latestRunDir(root, "demo"), current);
  await symlink(join(outside, "demo"), join(root, "linked-project"), "dir");
  assert.equal(await latestRunDir(root, "linked-project"), "");
  const linkedRoot = join(outside, "linked-root");
  await symlink(root, linkedRoot, "dir");
  assert.equal(await latestRunDir(linkedRoot, "demo"), "");
});

test("unreadable metadata falls back without interpreting updatedAt as run creation", async (t) => {
  const root = await fixture(t);
  const malformed = await run(root, "demo", "demo-20260101000000000-aaaaaa");
  await writeFile(join(malformed, "status.json"), "{invalid");
  const oversized = await run(root, "demo", "demo-20260101120000000-bbbbbb");
  await writeFile(join(oversized, "status.json"), JSON.stringify({ createdAt: "2099-01-01T00:00:00Z", padding: "x".repeat(1024 * 1024) }));
  const current = await run(root, "demo", "demo-20260102000000000-cccccc", { updatedAt: "2026-01-03T00:00:00Z" });
  assert.equal(await latestRunDir(root, "demo"), current);
  assert.equal(await latestRunDir(root, "absent"), "");
});

test("tool status without a runId resolves the latest registered manual continuation", async (t) => {
  const root = await fixture(t);
  const state = join(root, "state");
  await run(join(state, "runs"), "demo", "demo-20260101000000000-aaaaaa", { phase: "stopped" });
  const current = await run(join(state, "runs"), "demo", "manual-continuation", {
    phase: "plan_ready_for_implementation", project: "demo", runId: "manual-continuation", createdAt: "2026-01-02T00:00:00Z",
  });
  Object.assign(process.env, {
    DEVELOPMENT_CYCLE_STATE_ROOT: state,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: join(root, "docs"),
    DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED: "false",
    DEVELOPMENT_CYCLE_OBSERVER_ENABLED: "false",
    DEVELOPMENT_CYCLE_REPOSITORY_DELIVERY_ENABLED: "false",
    DEVELOPMENT_CYCLE_RUN_DRIVER_ENABLED: "false",
  });
  const { default: plugin } = await import(`../dist/index.js?run-selection=${Date.now()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(value) { tool = value; } });
  const response = await tool.execute("status", { action: "status", project: "demo" }, undefined, undefined);
  const result = response.details ?? response;
  assert.equal(result.runId, "manual-continuation");
  assert.equal(result.dir, current);
  assert.equal(result.readOnly, true);
});
