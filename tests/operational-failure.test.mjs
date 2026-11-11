import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyOperationalFailure } from "../dist/cycle/operational-failure.js";
import { createMainUpdates } from "../dist/cycle/main-updates.js";

test("an attributed current-attempt error is classified without scanning model prose", async t => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-operation-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const status = { implementationAttemptId: "attempt-a", directImplementationStatus: join(dir, "status.json") };
  await writeFile(status.directImplementationStatus, JSON.stringify({ attemptId: "attempt-a" }));
  const path = join(dir, "operational-failure.json");
  const evidence = { schemaVersion: 1, source: "provider", provider: "fixture-provider", attemptId: "attempt-a", failureClass: "rate_limited", errorCode: "HTTP_429", occurredAt: "2026-01-01T00:00:00Z" };
  await writeFile(path, JSON.stringify(evidence));
  const result = await classifyOperationalFailure(status);
  assert.equal(result.failureClass, "rate_limited"); assert.equal(result.autoStopRecommended, false); assert.equal(result.matched.evidencePath, path);
  const updates = createMainUpdates({ runtimeHome:dir, loadJson:async()=>null, saveJson:async()=>{}, appendJsonl:async()=>{}, cycleStatus:async()=>status });
  const event = await updates.dcClassify(dir,status,{});
  const notice = await updates.dcNotifyMain(dir,"fixture","run",status,{dryRunMainUpdate:true},event);
  assert.match(notice.text,/fixture-provider/); assert.match(notice.text,/HTTP_429/);
  assert.match(notice.text,/attempt-a/); assert.doesNotMatch(notice.text,/undefined/);
  assert.ok(notice.event.evidencePaths.includes(path));
  for (const change of [{ attemptId: "old-attempt" }, { source: "application" }, { source: "runner" }, { occurredAt: "unknown" }, { schemaVersion: 2 }, { provider: "" }]) {
    await writeFile(path, JSON.stringify({ ...evidence, ...change })); assert.equal(await classifyOperationalFailure(status), null);
  }
  await writeFile(path, "x".repeat(16385)); assert.equal(await classifyOperationalFailure(status), null);
  await rm(path); await writeFile(join(dir, "target"), JSON.stringify(evidence)); await symlink(join(dir, "target"), path);
  assert.equal(await classifyOperationalFailure(status), null);
});

test("corrections attribution remains current after stop and partial finalization", async t => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-correction-operation-")); t.after(() => rm(dir, { recursive:true, force:true }));
  for (const [id, failureClass] of [["implementation", "auth_failed"], ["corrections", "local_runtime_fault"]]) {
    await mkdir(join(dir, id));
    await writeFile(join(dir, id, "status.json"), JSON.stringify({ attemptId:id }));
    await writeFile(join(dir, id, "operational-failure.json"), JSON.stringify({ schemaVersion:1, source:"provider", provider:"fixture", attemptId:id, failureClass, errorCode:"FIXTURE", occurredAt:"2026-01-01T00:00:00Z" }));
  }
  const status = { implementationAttemptId:"implementation", directImplementationStatus:join(dir,"implementation","status.json"), correctionsAttemptId:"corrections", directCorrectionsStatus:join(dir,"corrections","status.json") };
  for (const phase of ["corrections_running", "stopped", "closed_partial"]) {
    const result = await classifyOperationalFailure({ ...status, phase });
    assert.equal(result.failureClass, "local_runtime_fault");
    assert.equal(result.matched.attemptId, "corrections");
  }
});
