import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateRoot = mkdtempSync(join(tmpdir(), "hermes-retention-"));
process.env.DEVELOPMENT_CYCLE_STATE_ROOT = stateRoot;
process.env.DEVELOPMENT_CYCLE_RETENTION_DAYS = "1";

const { pruneExpiredRuns } = await import("../dist/index.js");

test("pruneExpiredRuns removes stale run dirs and keeps fresh ones", async () => {
  const oldRun = join(stateRoot, "runs", "proj", "proj-20200101");
  const freshRun = join(stateRoot, "runs", "proj", "proj-20260806");
  mkdirSync(oldRun, { recursive: true });
  mkdirSync(freshRun, { recursive: true });
  writeFileSync(join(oldRun, "status.json"), "{}");
  writeFileSync(join(freshRun, "status.json"), "{}");

  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(oldRun, twoDaysAgo, twoDaysAgo);
  utimesSync(join(oldRun, "status.json"), twoDaysAgo, twoDaysAgo);

  await pruneExpiredRuns();

  assert.equal(existsSync(oldRun), false, "stale run should be pruned");
  assert.equal(existsSync(freshRun), true, "fresh run should be kept");
});

test("pruneExpiredRuns never follows a symlinked project directory", async () => {
  const outside = mkdtempSync(join(tmpdir(), "hermes-retention-outside-project-"));
  const evilProject = join(stateRoot, "runs", "evil-project");
  symlinkSync(outside, evilProject);
  // A real run directory inside the symlink target, old enough to prune.
  const victim = join(outside, "victim-run");
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, "status.json"), "{}");
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(victim, twoDaysAgo, twoDaysAgo);
  utimesSync(join(victim, "status.json"), twoDaysAgo, twoDaysAgo);

  await pruneExpiredRuns();

  assert.equal(
    existsSync(victim),
    true,
    "runs inside a symlinked project dir must never be pruned (outside the runs root)",
  );
  rmSync(outside, { recursive: true, force: true });
});

test("pruneExpiredRuns never follows a symlinked run directory", async () => {
  const outside = mkdtempSync(join(tmpdir(), "hermes-retention-outside-run-"));
  const projectDir = join(stateRoot, "runs", "symlink-run-project");
  mkdirSync(projectDir, { recursive: true });
  const victim = join(outside, "victim-run");
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, "status.json"), "{}");
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(victim, twoDaysAgo, twoDaysAgo);
  utimesSync(join(victim, "status.json"), twoDaysAgo, twoDaysAgo);
  symlinkSync(victim, join(projectDir, "link-run"));

  await pruneExpiredRuns();

  assert.equal(
    existsSync(victim),
    true,
    "a symlinked run entry must not be followed or deleted",
  );
  assert.equal(existsSync(join(projectDir, "link-run")), true, "the symlink itself stays");
  rmSync(outside, { recursive: true, force: true });
});

test.after(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});
