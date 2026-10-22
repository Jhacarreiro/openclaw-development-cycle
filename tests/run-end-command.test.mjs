import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
