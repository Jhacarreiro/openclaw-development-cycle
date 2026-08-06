import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

test.after(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});
