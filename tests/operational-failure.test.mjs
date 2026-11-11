import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyOperationalFailure } from "../dist/cycle/operational-failure.js";

test("an attributed current-attempt error is classified without scanning model prose", async t => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-operation-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const status = { implementationAttemptId: "attempt-a", directImplementationStatus: join(dir, "status.json") };
  await writeFile(status.directImplementationStatus, JSON.stringify({ attemptId: "attempt-a" }));
  const path = join(dir, "operational-failure.json");
  const evidence = { schemaVersion: 1, source: "provider", provider: "fixture-provider", attemptId: "attempt-a", failureClass: "rate_limited", errorCode: "HTTP_429", occurredAt: "2026-01-01T00:00:00Z" };
  await writeFile(path, JSON.stringify(evidence));
  const result = await classifyOperationalFailure(status);
  assert.equal(result.failureClass, "rate_limited"); assert.equal(result.autoStopRecommended, false); assert.equal(result.matched.evidencePath, path);
  for (const change of [{ attemptId: "old-attempt" }, { source: "application" }, { source: "runner" }, { occurredAt: "unknown" }, { schemaVersion: 2 }, { provider: "" }]) {
    await writeFile(path, JSON.stringify({ ...evidence, ...change })); assert.equal(await classifyOperationalFailure(status), null);
  }
  await writeFile(path, "x".repeat(16385)); assert.equal(await classifyOperationalFailure(status), null);
  await rm(path); await writeFile(join(dir, "target"), JSON.stringify(evidence)); await symlink(join(dir, "target"), path);
  assert.equal(await classifyOperationalFailure(status), null);
});
