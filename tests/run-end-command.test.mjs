import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCycleStore } from "../dist/cycle/cycle-store.js";
import { createNotificationService } from "../dist/runtime/notifications.js";
import { createFilesystemStore } from "../dist/storage/filesystem.js";

// Appends the directory it is given to a calls file in that directory, then prints a summary or fails.
const recorder = (exitCode) => ({
  command: "sh",
  args: ["-c", `printf '%s\\n' "$1" >> "$1/calls"; echo '{"ok":true,"records":3}'; exit ${exitCode}`, "sh"],
  timeoutSeconds: 30,
});

async function fixture(t, runEnd) {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-run-end-"));
  const store = createFilesystemStore(root);
  const dir = store.runDir("demo", "run-1");
  const notifications = createNotificationService(store, root, {
    enabled: false, channel: "", target: "", account: "", deliveryJson: "",
  }, async () => ({ ok: true }));
  t.after(async () => { notifications.dispose(); await rm(root, { recursive: true, force: true }); });
  await store.saveJson(join(dir, "status.json"), { phase: "council_validated", project: "demo", runId: "run-1" });
  const cycle = createCycleStore({ filesystemStore: store, cycleMessageDeliveryQueue: notifications, developmentCycleConfig: { runEnd } });
  return { root, store, dir, cycle };
}

const calls = async (dir) => (await readFile(join(dir, "calls"), "utf8").catch(() => "")).split("\n").filter(Boolean);

test("closing a run runs the run-end command once with the run directory and records its result", async (t) => {
  const { dir, cycle } = await fixture(t, recorder(0));

  await cycle.cycleStatus(dir, { phase: "delivery_published" });
  await cycle.settleRunEndCommands();
  assert.deepEqual(await calls(dir), [], "a run that is not closed yet does not trigger it");

  await cycle.cycleStatus(dir, { phase: "merged" });
  await cycle.settleRunEndCommands();
  await cycle.cycleStatus(dir, { phase: "merged", nextAction: "none" });
  await cycle.settleRunEndCommands();

  assert.deepEqual(await calls(dir), [dir]);
  const result = JSON.parse(await readFile(join(dir, "run_end_command.json"), "utf8"));
  assert.equal(result.ok, true);
  assert.equal(result.state, "finished");
  assert.equal(result.phase, "merged");
  assert.match(result.stdout, /"records":3/);
});

test("a failing run-end command is recorded and leaves the run's state alone", async (t) => {
  const { dir, cycle } = await fixture(t, recorder(3));

  const next = await cycle.cycleStatus(dir, { phase: "closed_partial", nextAction: "none" });
  await cycle.settleRunEndCommands();

  assert.equal(next.phase, "closed_partial");
  const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
  assert.equal(status.phase, "closed_partial");
  assert.equal(status.nextAction, "none");
  const result = JSON.parse(await readFile(join(dir, "run_end_command.json"), "utf8"));
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.deepEqual(await calls(dir), [dir]);
});

test("without a configured command nothing runs and nothing is written", async (t) => {
  const { dir, cycle } = await fixture(t, { command: "", args: [], timeoutSeconds: 30 });

  await cycle.cycleStatus(dir, { phase: "closed_success" });
  await cycle.settleRunEndCommands();

  await assert.rejects(access(join(dir, "run_end_command.json")), { code: "ENOENT" });
});

test("a run-end command left pending by a restart runs again on resume, and a finished one does not", async (t) => {
  const { root, store, dir, cycle } = await fixture(t, recorder(0));
  const finishedDir = store.runDir("demo", "run-0");
  await store.saveJson(join(dir, "status.json"), { phase: "closed_partial", project: "demo", runId: "run-1" });
  await store.saveJson(join(finishedDir, "status.json"), { phase: "merged", project: "demo", runId: "run-0" });
  await store.saveJson(join(dir, "run_end_command.json"), { schemaVersion: 1, state: "pending", phase: "closed_partial", queuedAt: "2026-01-01T00:00:00.000Z" });
  await store.saveJson(join(finishedDir, "run_end_command.json"), { schemaVersion: 1, state: "finished", ok: false, phase: "merged" });

  assert.equal(await cycle.resumeRunEndCommands(join(root, "runs")), 1);
  await cycle.settleRunEndCommands();

  assert.deepEqual(await calls(dir), [dir]);
  assert.deepEqual(await calls(finishedDir), []);
  const result = JSON.parse(await readFile(join(dir, "run_end_command.json"), "utf8"));
  assert.equal(result.state, "finished");
  assert.equal(result.phase, "closed_partial");
  assert.equal(await cycle.resumeRunEndCommands(join(root, "runs")), 0, "a resumed command that finished is not run again");
});

test("closing a run records the command as pending before it finishes", async (t) => {
  const slow = { command: "sh", args: ["-c", "sleep 1", "sh"], timeoutSeconds: 30 };
  const { dir, cycle } = await fixture(t, slow);

  await cycle.cycleStatus(dir, { phase: "closed_success" });
  const queued = JSON.parse(await readFile(join(dir, "run_end_command.json"), "utf8"));
  await cycle.settleRunEndCommands();

  assert.equal(queued.state, "pending");
  assert.equal(JSON.parse(await readFile(join(dir, "run_end_command.json"), "utf8")).state, "finished");
});

test("a run-end request whose run never closed is not run on resume", async (t) => {
  const { root, dir, cycle } = await fixture(t, recorder(0));
  // As left by a gateway that stopped after recording the request and before writing the closing status.
  await cycle.saveJson(join(dir, "run_end_command.json"), { schemaVersion: 1, state: "pending", phase: "closed_success" });

  assert.equal(await cycle.resumeRunEndCommands(join(root, "runs")), 0);
  await cycle.settleRunEndCommands();
  assert.deepEqual(await calls(dir), []);

  await cycle.cycleStatus(dir, { phase: "closed_success" });
  await cycle.settleRunEndCommands();
  assert.deepEqual(await calls(dir), [dir]);
});

test("a pending run-end command still runs on resume after the run was moved on to closed", async (t) => {
  const { root, dir, cycle } = await fixture(t, recorder(0));
  await cycle.saveJson(join(dir, "status.json"), { phase: "closed_partial", project: "demo", runId: "run-1" });
  await cycle.cycleStatus(dir, { phase: "closed" });
  await cycle.settleRunEndCommands();
  assert.deepEqual(await calls(dir), [], "moving from a closed phase to closed does not start it");

  await cycle.saveJson(join(dir, "run_end_command.json"), { schemaVersion: 1, state: "pending", phase: "closed_partial" });
  assert.equal(await cycle.resumeRunEndCommands(join(root, "runs")), 1);
  await cycle.settleRunEndCommands();
  assert.deepEqual(await calls(dir), [dir]);
});

test("two gateways resuming the same state root run a pending command once", async (t) => {
  const { root, store, dir } = await fixture(t, recorder(0));
  const slow = { command: "sh", args: ["-c", `printf '%s\\n' "$1" >> "$1/calls"; sleep 1`, "sh"], timeoutSeconds: 30 };
  await store.saveJson(join(dir, "status.json"), { phase: "closed_success", project: "demo", runId: "run-1" });
  await store.saveJson(join(dir, "run_end_command.json"), { schemaVersion: 1, state: "pending", phase: "closed_success" });
  const gateway = () => createCycleStore({ filesystemStore: createFilesystemStore(root), cycleMessageDeliveryQueue: null, developmentCycleConfig: { runEnd: slow } });
  const [first, second] = [gateway(), gateway()];

  await Promise.all([first.resumeRunEndCommands(join(root, "runs")), second.resumeRunEndCommands(join(root, "runs"))]);
  await Promise.all([first.settleRunEndCommands(), second.settleRunEndCommands()]);

  assert.deepEqual(await calls(dir), [dir]);
  assert.equal(JSON.parse(await readFile(join(dir, "run_end_command.json"), "utf8")).state, "finished");
});

// Writes a claim as another gateway would have left it.
const leaveClaim = (dir, claim) => writeFile(join(dir, "run_end_command.claim"), JSON.stringify({ id: "earlier", ...claim }));
const pendingClosedRun = async (store, dir) => {
  await store.saveJson(join(dir, "status.json"), { phase: "merged", project: "demo", runId: "run-1" });
  await store.saveJson(join(dir, "run_end_command.json"), { schemaVersion: 1, state: "pending", phase: "merged" });
};

test("an expired claim does not block resume", async (t) => {
  const expired = new Date(Date.now() - 600_000);
  const left = {
    "a claim from this host": { host: hostname(), pid: process.pid, claimedAt: expired.toISOString() },
    "a claim from another host": { host: `${hostname()}-other`, pid: 1, claimedAt: expired.toISOString() },
    "an unreadable claim file": null,
  };
  for (const [name, claim] of Object.entries(left)) {
    const { root, store, dir, cycle } = await fixture(t, recorder(0));
    await pendingClosedRun(store, dir);
    if (claim) await leaveClaim(dir, claim);
    else {
      await writeFile(join(dir, "run_end_command.claim"), "{");
      await utimes(join(dir, "run_end_command.claim"), expired, expired);
    }

    await cycle.resumeRunEndCommands(join(root, "runs"));
    await cycle.settleRunEndCommands();

    assert.deepEqual(await calls(dir), [dir], name);
    await assert.rejects(access(join(dir, "run_end_command.claim")), { code: "ENOENT" }, `${name}: the claim is released`);
  }
});

test("a command blocked by a claim runs once the claim expires", async (t) => {
  const quick = { ...recorder(0), timeoutSeconds: 1 };
  const { root, store, dir, cycle } = await fixture(t, quick);
  await pendingClosedRun(store, dir);
  // A one-second time limit gives a claim 61 seconds; this one has about one second left.
  await leaveClaim(dir, { host: hostname(), pid: process.pid, claimedAt: new Date(Date.now() - 60_000).toISOString() });

  await cycle.resumeRunEndCommands(join(root, "runs"));
  await cycle.settleRunEndCommands();
  assert.deepEqual(await calls(dir), [], "not while the claim is live");

  const deadline = Date.now() + 10_000;
  while ((await calls(dir)).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  await cycle.settleRunEndCommands();
  assert.deepEqual(await calls(dir), [dir]);
  assert.equal(JSON.parse(await readFile(join(dir, "run_end_command.json"), "utf8")).state, "finished");
});

test("a claim held by a running command is not taken over by another store in the same process", async (t) => {
  const { root, store, dir } = await fixture(t, recorder(0));
  const slow = { command: "sh", args: ["-c", `printf '%s\\n' "$1" >> "$1/calls"; sleep 1`, "sh"], timeoutSeconds: 30 };
  await store.saveJson(join(dir, "status.json"), { phase: "closed_success", project: "demo", runId: "run-1" });
  await store.saveJson(join(dir, "run_end_command.json"), { schemaVersion: 1, state: "pending", phase: "closed_success" });
  const gateway = () => createCycleStore({ filesystemStore: createFilesystemStore(root), cycleMessageDeliveryQueue: null, developmentCycleConfig: { runEnd: slow } });
  const [first, second] = [gateway(), gateway()];

  await first.resumeRunEndCommands(join(root, "runs"));
  while ((await calls(dir)).length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  await second.resumeRunEndCommands(join(root, "runs"));
  await Promise.all([first.settleRunEndCommands(), second.settleRunEndCommands()]);

  assert.deepEqual(await calls(dir), [dir]);
});

test("a live claim is left alone, even when the gateway that made it is gone", async (t) => {
  const recent = new Date().toISOString();
  const live = {
    "another host with this pid": { host: `${hostname()}-other`, pid: process.pid, claimedAt: recent },
    "a dead gateway on this host, whose command may still run": { host: hostname(), pid: 2 ** 22 + 17, claimedAt: recent },
    "an earlier gateway with this pid": { host: hostname(), pid: process.pid, claimedAt: recent },
  };
  for (const [name, claim] of Object.entries(live)) {
    const { root, store, dir, cycle } = await fixture(t, recorder(0));
    await pendingClosedRun(store, dir);
    await leaveClaim(dir, claim);

    await cycle.resumeRunEndCommands(join(root, "runs"));
    await cycle.settleRunEndCommands();

    assert.deepEqual(await calls(dir), [], name);
    assert.equal(JSON.parse(await readFile(join(dir, "run_end_command.json"), "utf8")).state, "pending", name);
  }
});
