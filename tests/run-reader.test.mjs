import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { formatRunIndexMarkdown, readRunIndex } from "../dist/reader/index.js";

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(repository, "tests", "fixtures", "run-reader");
const cli = join(repository, "bin", "read-runs.mjs");
const readerUrl = pathToFileURL(join(repository, "dist", "reader", "index.js")).href;
const allRuns = (index) => index.projects.flatMap((project) => project.runs);
const findRun = (index, runId) => allRuns(index).find((run) => run.runId === runId);

async function temporaryFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "synthetic-run-reader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "state");
  await cp(fixture, root, { recursive: true });
  return { directory, root };
}

async function treeHash(root) {
  const hash = createHash("sha256");
  async function visit(path) {
    const information = await lstat(path);
    hash.update(`${relative(root, path).replaceAll("\\", "/")}\0`);
    if (information.isSymbolicLink()) {
      hash.update(`link\0${await readlink(path)}\0`);
    } else if (information.isDirectory()) {
      hash.update("directory\0");
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else {
      hash.update("file\0");
      hash.update(await readFile(path));
      hash.update("\0");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function readWithFileReadAudit(root) {
  const code = `
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { relative, resolve, isAbsolute } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { readRunIndex } from ${JSON.stringify(readerUrl)};
    const root = process.argv[1];
    const outsideReads = [];
    function check(path) {
      if (typeof path !== 'string' && !(path instanceof URL) && !Buffer.isBuffer(path)) return;
      const value = path instanceof URL ? fileURLToPath(path) : String(path);
      const candidates = [resolve(value)];
      try { candidates.push(fs.realpathSync(value)); } catch {}
      for (const candidate of candidates) {
        const rel = relative(root, candidate);
        if (rel === '..' || rel.startsWith('../') || rel.startsWith('..' + String.fromCharCode(92)) || isAbsolute(rel)) {
          outsideReads.push(value);
          throw new Error('Synthetic outside file read denied');
        }
      }
    }
    for (const target of [fs, fsp]) {
      for (const method of target === fs ? ['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream'] : ['readFile', 'open']) {
        const original = target[method];
        target[method] = function(path, ...args) { check(path); return original.call(this, path, ...args); };
      }
    }
    syncBuiltinESMExports();
    const index = await readRunIndex(root);
    console.log(JSON.stringify({ index, outsideReads }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", code, root]);
  return JSON.parse(stdout);
}

async function patchRunStatus(root, project, runId, patch) {
  const path = join(root, "runs", project, runId, "status.json");
  const status = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...status, ...patch }));
}

const recoveryEvent = (recoveryCount) => JSON.stringify({
  schemaVersion: 1,
  detectedAt: "2026-01-01T10:30:00.000Z",
  failureClass: "planner_reconsideration_contract_failure",
  recoveryCount,
  previousAttemptId: `synthetic-attempt-${recoveryCount}`,
  pristineState: { pristine: true },
}) + "\n";

test("run index lists status-bearing runs grouped by project and ordered by recorded time", async () => {
  const index = await readRunIndex(fixture);
  assert.equal(index.schemaVersion, 1);
  assert.deepEqual(index.projects.map(({ project, runs }) => ({
    project,
    runs: runs.map(({ runId }) => runId),
  })), [
    { project: "synthetic-alpha", runs: ["run-go", "run-revise", "run-stop", "run-malformed"] },
    { project: "synthetic-beta", runs: ["run-recovery", "run-review-failure"] },
  ]);
  for (const { project, runs } of index.projects) {
    for (const run of runs) {
      assert.equal(run.project, project);
      assert.equal(run.path, `runs/${project}/${run.runId}`);
      assert.equal(run.createdAt, null);
      assert.equal(run.unavailable.createdAt, run.status === "unreadable" ? "unreadable" : "not_recorded");
    }
  }
});

test("recorded outcomes, decisions, classes and counts remain distinct", async () => {
  const index = await readRunIndex(fixture);
  const go = findRun(index, "run-go");
  const revise = findRun(index, "run-revise");
  const stop = findRun(index, "run-stop");
  const recovery = findRun(index, "run-recovery");
  const review = findRun(index, "run-review-failure");
  assert.deepEqual([go.phase, go.terminal, go.finalDecision, go.implementationAdapter], ["closed", true, "go", "command"]);
  assert.deepEqual([revise.phase, revise.terminal, revise.finalDecision, revise.councilCorrectionRounds], ["closed_partial", true, "revise", 2]);
  assert.deepEqual([stop.phase, stop.terminal, stop.finalDecision, stop.endedAt], ["stopped", true, "stop", "2026-01-03T09:59:00.000Z"]);
  assert.deepEqual([recovery.phase, recovery.terminal, recovery.finalDecision, recovery.failureClass, recovery.automaticRecoveryCount, recovery.automaticRecoveryEvents], ["implementation_failed", true, null, "planner_reconsideration_contract_failure", 1, 1]);
  assert.deepEqual([review.phase, review.terminal, review.finalDecision, review.failureClass, review.automaticRecoveryCount], ["review_infrastructure_failed", true, null, "review_infrastructure_failed", 0]);
  assert.deepEqual([go.deliveryOutcome, go.prUrl], ["success", "https://github.com/example/synthetic-project/pull/1"]);
  assert.equal(revise.deliveryOutcome, "partial");
  for (const run of [go, revise, stop, recovery, review]) {
    assert.equal(run.status, "readable");
    assert.equal(run.interventionCount, null);
    assert.equal(run.unavailable.interventionCount, "not_recorded");
    assert.equal(run.correctionRounds, null);
    assert.equal(run.unavailable.correctionRounds, "not_recorded");
    assert.equal(run.startedAt, null);
    assert.equal(run.durationMs, null);
    assert.equal(run.unavailable.durationMs, "not_recorded");
    assert.equal(run.acceptanceChecks, null);
    assert.equal(run.solutionValue, null);
    assert.equal(run.cost, null);
  }
  assert.equal(go.failureClass, null);
  assert.equal(go.unavailable.failureClass, "not_recorded");
});

test("malformed status is a visible unreadable run and does not hide other runs", async () => {
  const index = await readRunIndex(fixture);
  const malformed = findRun(index, "run-malformed");
  assert.equal(allRuns(index).length, 6);
  assert.equal(malformed.status, "unreadable");
  assert.equal(malformed.phase, null);
  assert.equal(malformed.terminal, null);
  assert.equal(malformed.unavailable.phase, "unreadable");
  assert.equal(findRun(index, "run-go").finalDecision, "go");
});

test("run symlink outside the state root is excluded without reading its target", async (t) => {
  const { directory, root } = await temporaryFixture(t);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "status.json"), JSON.stringify({ phase: "closed", implementationAdapter: "SYNTHETIC_OUTSIDE_SECRET" }));
  await symlink(outside, join(root, "runs", "synthetic-alpha", "outside-link"), process.platform === "win32" ? "junction" : "dir");
  const code = `
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { relative, resolve, isAbsolute } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { readRunIndex } from ${JSON.stringify(readerUrl)};
    const root = process.argv[1];
    const outsideReads = [];
    function check(path) {
      if (typeof path !== 'string' && !(path instanceof URL) && !Buffer.isBuffer(path)) return;
      const value = path instanceof URL ? fileURLToPath(path) : String(path);
      const rel = relative(root, resolve(value));
      if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\\\' : '/')) || isAbsolute(rel)) {
        outsideReads.push(value);
        throw new Error('Synthetic outside file read denied');
      }
    }
    for (const target of [fs, fsp]) {
      for (const method of target === fs ? ['readFile', 'readFileSync', 'open', 'openSync', 'createReadStream'] : ['readFile', 'open']) {
        const original = target[method];
        target[method] = function(path, ...args) { check(path); return original.call(this, path, ...args); };
      }
    }
    syncBuiltinESMExports();
    const index = await readRunIndex(root);
    console.log(JSON.stringify({ index, outsideReads }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", code, root]);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.outsideReads, []);
  assert.equal(allRuns(result.index).length, 6);
  assert.equal(findRun(result.index, "outside-link"), undefined);
  assert.equal(stdout.includes("SYNTHETIC_OUTSIDE_SECRET"), false);
});

test("library and both CLI formats leave state root byte-for-byte unchanged", async (t) => {
  const { root } = await temporaryFixture(t);
  const before = await treeHash(root);
  await readRunIndex(root);
  await execFileAsync(process.execPath, [cli, root]);
  await execFileAsync(process.execPath, [cli, root, "--format", "markdown"]);
  assert.equal(await treeHash(root), before);
});

test("Markdown columns match the reliability baseline per-run table", async () => {
  const baseline = await readFile(join(repository, "docs", "reliability-baseline.md"), "utf8");
  const section = baseline.split("## Per-run record")[1].split("## Proposed criterion")[0];
  const fields = section.split(/\r?\n/).filter((line) => /^\| [a-z]/.test(line)).map((line) => line.split("|")[1].trim());
  assert.equal(fields.length, 9);
  const index = await readRunIndex(fixture);
  const markdown = formatRunIndexMarkdown(index);
  const header = markdown.split(/\r?\n/).find((line) => line.startsWith("|"));
  const columns = header.split("|").slice(1, -1).map((column) => column.trim());
  for (const field of fields) assert.ok(columns.includes(field), `missing baseline column: ${field}`);
  assert.ok(markdown.includes("run-go"));
  assert.ok(markdown.includes("unavailable"));
});

test("CLI defaults to JSON, filters a project and supports Markdown", async () => {
  const { stdout: json } = await execFileAsync(process.execPath, [cli, fixture]);
  assert.deepEqual(JSON.parse(json), await readRunIndex(fixture));
  const { stdout: filtered } = await execFileAsync(process.execPath, [cli, fixture, "--project", "synthetic-beta"]);
  assert.deepEqual(JSON.parse(filtered).projects.map(({ project }) => project), ["synthetic-beta"]);
  assert.deepEqual(await readRunIndex(fixture, { project: "synthetic-beta" }), JSON.parse(filtered));
  const { stdout: markdown } = await execFileAsync(process.execPath, [cli, fixture, "--project", "synthetic-alpha", "--format", "markdown"]);
  assert.ok(markdown.includes("run-go"));
  assert.equal(markdown.includes("run-recovery"), false);
});

test("library loads and reads runs without node_modules or OpenClaw", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synthetic-standalone-reader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(repository, "dist", "reader"), join(directory, "dist", "reader"), { recursive: true });
  await cp(join(repository, "dist", "core"), join(directory, "dist", "core"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  assert.equal(await lstat(join(directory, "node_modules")).catch(() => null), null);
  const standalone = pathToFileURL(join(directory, "dist", "reader", "index.js")).href;
  const code = `import { readRunIndex } from ${JSON.stringify(standalone)}; console.log(JSON.stringify(await readRunIndex(process.argv[1])));`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", code, fixture], { cwd: directory });
  assert.equal(allRuns(JSON.parse(stdout)).length, 6);
});

test("missing decisions are unavailable rather than inferred from terminal phase", async (t) => {
  const { root } = await temporaryFixture(t);
  await rm(join(root, "runs", "synthetic-alpha", "run-go", "final_validation_response.md"));
  const run = findRun(await readRunIndex(root), "run-go");
  assert.equal(run.phase, "closed");
  assert.equal(run.finalDecision, null);
  assert.equal(run.unavailable.finalDecision, "not_recorded");
});

test("malformed optional decision and delivery affect those fields only", async (t) => {
  const { root } = await temporaryFixture(t);
  const runPath = join(root, "runs", "synthetic-alpha", "run-go");
  await writeFile(join(runPath, "final_validation_response.md"), "SYNTHETIC malformed decision with go mentioned later");
  await writeFile(join(runPath, "repository_delivery.json"), "{ bad json");
  const run = findRun(await readRunIndex(root), "run-go");
  assert.equal(run.status, "readable");
  assert.equal(run.phase, "closed");
  assert.equal(run.finalDecision, null);
  assert.equal(run.unavailable.finalDecision, "unreadable");
  assert.equal(run.deliveryOutcome, null);
  assert.equal(run.unavailable.deliveryOutcome, "unreadable");
});

test("durable recovery total survives missing retained event evidence", async (t) => {
  const { root } = await temporaryFixture(t);
  await rm(join(root, "runs", "synthetic-beta", "run-recovery", "automatic_recovery_events.jsonl"));
  const run = findRun(await readRunIndex(root), "run-recovery");
  assert.equal(run.automaticRecoveryCount, 1);
  assert.equal(run.automaticRecoveryEvents, null);
  assert.equal(run.unavailable.automaticRecoveryEvents, "pruned");
});

test("unsafe pointers and private artifact bodies cannot leak into the index", async (t) => {
  const { directory, root } = await temporaryFixture(t);
  const outside = join(directory, "outside-plan.md");
  await writeFile(outside, "SYNTHETIC_OUTSIDE_PLAN_BODY");
  const runPath = join(root, "runs", "synthetic-alpha", "run-go");
  const statusPath = join(runPath, "status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  status.plan = outside;
  status.projectRoot = join(directory, "SYNTHETIC_OUTSIDE_PROJECT");
  status.implementationStdout = outside;
  status.implementationPrompt = "SYNTHETIC_PRIVATE_PROMPT_BODY";
  await writeFile(statusPath, JSON.stringify(status));
  const index = await readRunIndex(root);
  const run = findRun(index, "run-go");
  assert.equal(run.planPath, null);
  assert.equal(run.unavailable.planPath, "unreadable");
  const output = JSON.stringify(index) + formatRunIndexMarkdown(index);
  for (const secret of [outside, "SYNTHETIC_PRIVATE_DECISION_BODY", "SYNTHETIC_PRIVATE_PLAN_BODY", "SYNTHETIC_PRIVATE_INTERVENTION_BODY", "SYNTHETIC_PRIVATE_PROMPT_BODY", "SYNTHETIC_OUTSIDE_PLAN_BODY", "SYNTHETIC_OUTSIDE_PROJECT"]) assert.equal(output.includes(secret), false);
});

test("live, uncompressed and gzip recovery archives count each retained rotation once", async (t) => {
  const { root } = await temporaryFixture(t);
  const runPath = join(root, "runs", "synthetic-beta", "run-recovery");
  const archives = join(runPath, "event-archives", "automatic_recovery_events.jsonl");
  await mkdir(archives, { recursive: true });
  await writeFile(join(archives, "2026-01-01-synthetic-raw.jsonl"), recoveryEvent(2));
  const completedStem = join(archives, "2026-01-01-synthetic-completed.jsonl");
  await writeFile(completedStem, recoveryEvent(3));
  await writeFile(`${completedStem}.gz`, gzipSync(recoveryEvent(3)));
  await writeFile(join(archives, "ignored-compression.gz.tmp"), "Synthetic incomplete compression");
  await patchRunStatus(root, "synthetic-beta", "run-recovery", { automaticPlannerRecoveryCount: 3 });
  const before = await treeHash(root);
  const run = findRun(await readRunIndex(root), "run-recovery");
  assert.equal(run.automaticRecoveryCount, 3);
  assert.equal(run.automaticRecoveryEvents, 3);
  assert.equal(run.unavailable.automaticRecoveryEvents, undefined);
  assert.equal(await treeHash(root), before);
});

test("malformed compressed recovery archive makes event evidence unreadable without losing the total", async (t) => {
  const { root } = await temporaryFixture(t);
  const archives = join(root, "runs", "synthetic-beta", "run-recovery", "event-archives", "automatic_recovery_events.jsonl");
  await mkdir(archives, { recursive: true });
  await writeFile(join(archives, "2026-01-01-synthetic-corrupt.jsonl.gz"), "Synthetic invalid gzip payload");
  const run = findRun(await readRunIndex(root), "run-recovery");
  assert.equal(run.status, "readable");
  assert.equal(run.phase, "implementation_failed");
  assert.equal(run.automaticRecoveryCount, 1);
  assert.equal(run.automaticRecoveryEvents, null);
  assert.equal(run.unavailable.automaticRecoveryEvents, "unreadable");
});

test("recovery archive symlink is rejected without reading its outside target", async (t) => {
  const { directory, root } = await temporaryFixture(t);
  const archives = join(root, "runs", "synthetic-beta", "run-recovery", "event-archives", "automatic_recovery_events.jsonl");
  await mkdir(archives, { recursive: true });
  const outside = join(directory, "outside-recovery.jsonl.gz");
  await writeFile(outside, gzipSync(recoveryEvent(9)));
  await symlink(outside, join(archives, "2026-01-01-synthetic-link.jsonl.gz"), "file");
  const result = await readWithFileReadAudit(root);
  const run = findRun(result.index, "run-recovery");
  assert.deepEqual(result.outsideReads, []);
  assert.equal(run.automaticRecoveryCount, 1);
  assert.equal(run.automaticRecoveryEvents, null);
  assert.equal(run.unavailable.automaticRecoveryEvents, "unreadable");
});

test("retained recovery evidence does not reconstruct a missing durable total", async (t) => {
  const { root } = await temporaryFixture(t);
  const statusPath = join(root, "runs", "synthetic-beta", "run-recovery", "status.json");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  delete status.automaticPlannerRecoveryCount;
  await writeFile(statusPath, JSON.stringify(status));
  const run = findRun(await readRunIndex(root), "run-recovery");
  assert.equal(run.automaticRecoveryEvents, 1);
  assert.equal(run.automaticRecoveryCount, null);
  assert.equal(run.unavailable.automaticRecoveryCount, "not_recorded");
});

test("current attempt dates and duration stay separate from unavailable run lifetime", async (t) => {
  const { root } = await temporaryFixture(t);
  const runPath = join(root, "runs", "synthetic-alpha", "run-go");
  const attemptPath = join(runPath, "implementation_session", "attempts", "synthetic-attempt-1", "status.json");
  await mkdir(dirname(attemptPath), { recursive: true });
  await writeFile(attemptPath, JSON.stringify({
    id: "synthetic-session-1",
    attemptId: "synthetic-attempt-1",
    createdAt: "2026-01-01T08:00:00.000Z",
    exitedAt: "2026-01-01T08:10:00.000Z",
  }));
  await patchRunStatus(root, "synthetic-alpha", "run-go", { directImplementationStatus: attemptPath });
  const run = findRun(await readRunIndex(root), "run-go");
  assert.deepEqual([run.attemptCreatedAt, run.attemptEndedAt, run.attemptDurationMs], ["2026-01-01T08:00:00.000Z", "2026-01-01T08:10:00.000Z", 600000]);
  assert.deepEqual([run.startedAt, run.endedAt, run.durationMs], [null, null, null]);
  assert.equal(run.unavailable.durationMs, "not_recorded");
  await writeFile(attemptPath, JSON.stringify({ createdAt: "2026-01-01T08:00:00.000Z", stoppedAt: "2026-01-01T08:05:00.000Z" }));
  const stoppedAttempt = findRun(await readRunIndex(root), "run-go");
  assert.equal(stoppedAttempt.attemptEndedAt, "2026-01-01T08:05:00.000Z");
  assert.equal(stoppedAttempt.attemptDurationMs, 300000);
});

test("unsafe current attempt pointer is unreadable without reading the target", async (t) => {
  const { directory, root } = await temporaryFixture(t);
  const outside = join(directory, "outside-attempt-status.json");
  await writeFile(outside, JSON.stringify({ createdAt: "2026-01-01T08:00:00.000Z", exitedAt: "2026-01-01T08:10:00.000Z" }));
  await patchRunStatus(root, "synthetic-alpha", "run-go", { directImplementationStatus: outside });
  const result = await readWithFileReadAudit(root);
  const run = findRun(result.index, "run-go");
  assert.deepEqual(result.outsideReads, []);
  for (const field of ["attemptCreatedAt", "attemptEndedAt", "attemptDurationMs"]) {
    assert.equal(run[field], null);
    assert.equal(run.unavailable[field], "unreadable");
  }
  assert.equal(run.finalDecision, "go");
});

test("missing recorded decision, plan and attempt targets are unreadable", async (t) => {
  const { root } = await temporaryFixture(t);
  const runPath = join(root, "runs", "synthetic-alpha", "run-go");
  await rm(join(runPath, "final_validation_response.md"));
  await patchRunStatus(root, "synthetic-alpha", "run-go", {
    finalValidation: join(runPath, "final_validation_response.md"),
    plan: join(runPath, "missing_plan.md"),
    directImplementationStatus: join(runPath, "implementation_session", "missing", "status.json"),
  });
  const run = findRun(await readRunIndex(root), "run-go");
  assert.equal(run.status, "readable");
  for (const field of ["finalDecision", "planPath", "attemptCreatedAt", "attemptEndedAt", "attemptDurationMs"]) {
    assert.equal(run[field], null);
    assert.equal(run.unavailable[field], "unreadable");
  }
});

test("root and ancestor symlinks reject the listing without reading run targets", async (t) => {
  const { directory, root } = await temporaryFixture(t);
  const directLink = join(directory, "root-link");
  await symlink(root, directLink, process.platform === "win32" ? "junction" : "dir");
  const direct = await readWithFileReadAudit(directLink);
  assert.deepEqual(direct.outsideReads, []);
  assert.deepEqual(direct.index.projects, []);
  assert.equal(direct.index.unavailable.projects, "unreadable");
  const actualParent = join(directory, "actual-parent");
  await mkdir(actualParent);
  await cp(root, join(actualParent, "state"), { recursive: true });
  const ancestorLink = join(directory, "ancestor-link");
  await symlink(actualParent, ancestorLink, process.platform === "win32" ? "junction" : "dir");
  const ancestor = await readWithFileReadAudit(join(ancestorLink, "state"));
  assert.deepEqual(ancestor.outsideReads, []);
  assert.deepEqual(ancestor.index.projects, []);
  assert.equal(ancestor.index.unavailable.projects, "unreadable");
});

test("project symlink is excluded without reading its outside run", async (t) => {
  const { directory, root } = await temporaryFixture(t);
  const outside = join(directory, "outside-project");
  await mkdir(join(outside, "outside-run"), { recursive: true });
  await writeFile(join(outside, "outside-run", "status.json"), JSON.stringify({ phase: "closed", implementationAdapter: "SYNTHETIC_OUTSIDE_PROJECT_SECRET" }));
  await symlink(outside, join(root, "runs", "synthetic-linked-project"), process.platform === "win32" ? "junction" : "dir");
  const result = await readWithFileReadAudit(root);
  assert.deepEqual(result.outsideReads, []);
  assert.equal(result.index.projects.some(({ project }) => project === "synthetic-linked-project"), false);
  assert.equal(allRuns(result.index).length, 6);
});

test("status and decision file symlinks never open outside files", async (t) => {
  const { directory, root } = await temporaryFixture(t);
  const outsideStatus = join(directory, "outside-status.json");
  const outsideDecision = join(directory, "outside-decision.md");
  await writeFile(outsideStatus, JSON.stringify({ phase: "closed", implementationAdapter: "SYNTHETIC_OUTSIDE_FILE_SECRET" }));
  await writeFile(outsideDecision, "go SYNTHETIC_OUTSIDE_FILE_SECRET");
  const linkedStatus = join(root, "runs", "synthetic-alpha", "run-go", "status.json");
  const linkedDecision = join(root, "runs", "synthetic-alpha", "run-revise", "final_validation_response.md");
  await rm(linkedStatus);
  await rm(linkedDecision);
  await symlink(outsideStatus, linkedStatus, "file");
  await symlink(outsideDecision, linkedDecision, "file");
  const result = await readWithFileReadAudit(root);
  assert.deepEqual(result.outsideReads, []);
  assert.equal(findRun(result.index, "run-go"), undefined);
  const revise = findRun(result.index, "run-revise");
  assert.equal(revise.status, "readable");
  assert.equal(revise.finalDecision, null);
  assert.equal(revise.unavailable.finalDecision, "unreadable");
  assert.equal(JSON.stringify(result.index).includes("SYNTHETIC_OUTSIDE_FILE_SECRET"), false);
});

test("unknown phase and invalid recorded scalar fields remain unavailable", async (t) => {
  const { root } = await temporaryFixture(t);
  await patchRunStatus(root, "synthetic-alpha", "run-go", {
    phase: "synthetic_future_phase",
    implementationAdapter: { name: "command" },
    failureClass: ["implementation"],
    automaticPlannerRecoveryCount: "0",
    councilCorrectionCount: -1,
    updatedAt: "2026-02-30T10:00:00.000Z",
  });
  const run = findRun(await readRunIndex(root), "run-go");
  assert.equal(run.status, "readable");
  assert.equal(run.phase, "synthetic_future_phase");
  assert.equal(run.finalDecision, "go");
  for (const field of ["terminal", "implementationAdapter", "failureClass", "automaticRecoveryCount", "councilCorrectionRounds", "updatedAt"]) {
    assert.equal(run[field], null);
    assert.equal(run.unavailable[field], "unreadable");
  }
});

test("array delivery classification and credential-bearing PR URL are unreadable", async (t) => {
  const { root } = await temporaryFixture(t);
  const path = join(root, "runs", "synthetic-alpha", "run-go", "repository_delivery.json");
  await writeFile(path, JSON.stringify({ classification: ["success"], pullRequest: { url: "https://synthetic-user:synthetic-pass@example.com/pr/1" } }));
  const run = findRun(await readRunIndex(root), "run-go");
  assert.equal(run.phase, "closed");
  assert.equal(run.deliveryOutcome, null);
  assert.equal(run.unavailable.deliveryOutcome, "unreadable");
  assert.equal(run.prUrl, null);
  assert.equal(run.unavailable.prUrl, "unreadable");
});

test("delivery flags report recorded booleans and do not infer missing values", async (t) => {
  const { root } = await temporaryFixture(t);
  const index = await readRunIndex(root);
  const published = findRun(index, "run-go");
  const local = findRun(index, "run-revise");
  assert.equal(published.deliveryOk, true);
  assert.equal(published.deliveryMerged, true);
  assert.equal(published.deliverySkipped, null);
  assert.equal(published.unavailable.deliverySkipped, "not_recorded");
  assert.equal(local.deliveryLocalOnly, true);
  assert.equal(local.deliverySkipped, true);
  assert.equal(local.deliveryMerged, null);
  assert.equal(local.unavailable.deliveryMerged, "not_recorded");
  const deliveryPath = join(root, "runs", "synthetic-alpha", "run-go", "repository_delivery.json");
  await rm(deliveryPath);
  await patchRunStatus(root, "synthetic-alpha", "run-go", {
    repositoryDelivery: {
      classification: "invalid",
      ok: false,
      skipped: false,
      localOnly: false,
      merged: false,
      pullRequest: { url: "https://github.com/example/synthetic-project/pull/2", state: "OPEN" },
    },
  });
  const mirrored = findRun(await readRunIndex(root), "run-go");
  assert.equal(mirrored.deliveryOutcome, "invalid");
  for (const field of ["deliveryOk", "deliverySkipped", "deliveryLocalOnly", "deliveryMerged"]) {
    assert.equal(mirrored[field], false);
    assert.equal(mirrored.unavailable[field], undefined);
  }
  assert.equal(mirrored.prUrl, "https://github.com/example/synthetic-project/pull/2");
  assert.equal(mirrored.prState, "OPEN");
  await writeFile(deliveryPath, JSON.stringify({ classification: "success", ok: "true", merged: 1 }));
  const invalid = findRun(await readRunIndex(root), "run-go");
  for (const field of ["deliveryOk", "deliveryMerged"]) {
    assert.equal(invalid[field], null);
    assert.equal(invalid.unavailable[field], "unreadable");
  }
});

test("malformed recorded delivery mirror and PR containers are unreadable", async (t) => {
  const { root } = await temporaryFixture(t);
  const deliveryPath = join(root, "runs", "synthetic-alpha", "run-go", "repository_delivery.json");
  await rm(deliveryPath);
  await patchRunStatus(root, "synthetic-alpha", "run-go", { repositoryDelivery: ["synthetic-invalid"] });
  const mirror = findRun(await readRunIndex(root), "run-go");
  assert.equal(mirror.deliveryOutcome, null);
  assert.equal(mirror.unavailable.deliveryOutcome, "unreadable");
  await writeFile(deliveryPath, JSON.stringify({ classification: "success", pullRequest: ["synthetic-invalid"] }));
  const pr = findRun(await readRunIndex(root), "run-go");
  assert.equal(pr.deliveryOutcome, "success");
  for (const field of ["prUrl", "prState"]) {
    assert.equal(pr[field], null);
    assert.equal(pr.unavailable[field], "unreadable");
  }
});
