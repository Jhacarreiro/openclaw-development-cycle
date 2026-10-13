import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCycleStore } from "../dist/cycle/cycle-store.js";
import { createNotificationService } from "../dist/runtime/notifications.js";
import { createFilesystemStore } from "../dist/storage/filesystem.js";

const project = "upgrade-demo";
const runId = "run-1";
const signature = (phase) => JSON.stringify({ phase, project, runId });

async function fixture(t, phase) {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-notification-upgrade-"));
  const store = createFilesystemStore(root);
  const dir = store.runDir(project, runId);
  const delivered = [];
  const notifications = createNotificationService(store, root, {
    enabled: true, channel: "slack", target: "fixture", account: "", deliveryJson: "",
  }, async (payload) => { delivered.push(payload); return { ok: true }; });
  notifications.beginExecution();
  t.after(async () => { notifications.dispose(); await rm(root, { recursive: true, force: true }); });
  await store.saveJson(join(dir, "status.json"), { phase, project, runId });
  const cycle = createCycleStore({ filesystemStore: store, cycleMessageDeliveryQueue: notifications });
  return { root, dir, store, cycle, notifications, delivered };
}

test("matching legacy phase dedupe prevents an upgrade-induced repeat and preserves legacy artifacts", async (t) => {
  const { dir, store, cycle, notifications, delivered } = await fixture(t, "plan_ready_for_implementation");
  const legacyPath = join(dir, "telegram_update_state.json");
  const legacyState = { lastSignature: signature("implementation_launched"), updatedAt: "2026-01-01T00:00:00.000Z" };
  await store.saveJson(legacyPath, legacyState);
  const legacyText = await readFile(legacyPath, "utf8");
  const legacyEventsPath = join(dir, "telegram_update_events.jsonl");
  await writeFile(legacyEventsPath, '{"eventType":"legacy"}\n');

  await cycle.cycleStatus(dir, { phase: "implementation_launched" });

  assert.equal(await readFile(legacyPath, "utf8"), legacyText);
  assert.equal(await readFile(legacyEventsPath, "utf8"), '{"eventType":"legacy"}\n');
  assert.equal(notifications.snapshot().pending, 0);
  assert.deepEqual(delivered, []);
  await assert.rejects(access(join(dir, "phase_notification_events.jsonl")), { code: "ENOENT" });

  // Suppression remains effective until a different phase creates canonical state.
  await store.saveJson(join(dir, "status.json"), { phase: "plan_ready_for_implementation", project, runId });
  await cycle.cycleStatus(dir, { phase: "implementation_launched" });
  assert.equal(notifications.snapshot().pending, 0);
});

test("a new phase after upgrade sends once and records canonical notification and delivery events", async (t) => {
  const { root, dir, store, cycle, notifications, delivered } = await fixture(t, "implementation_launched");
  const legacyState = { lastSignature: signature("implementation_launched") };
  const legacyPath = join(dir, "telegram_update_state.json");
  await store.saveJson(legacyPath, legacyState);
  const legacyText = await readFile(legacyPath, "utf8");
  const eventsPath = join(dir, "phase_notification_events.jsonl");

  await cycle.cycleStatus(dir, { phase: "implementation_running" });
  await cycle.cycleStatus(dir, { phase: "implementation_running", nextAction: "Watch the runner." });
  assert.equal(notifications.snapshot().pending, 1);
  const outbox = join(root, "notification-outbox");
  const jobs = await readdir(outbox);
  assert.equal(jobs.length, 1);
  const job = await store.loadJson(join(outbox, jobs[0]));
  assert.equal(job.audit.eventsPath, eventsPath);
  assert.equal(job.audit.event.eventType, "development_cycle.phase_notification_delivery");
  assert.equal((await store.loadJson(join(dir, "phase_notification_state.json"))).lastSignature, signature("implementation_running"));
  assert.equal(await readFile(legacyPath, "utf8"), legacyText);

  notifications.endExecution();
  for (let attempt = 0; attempt < 300 && (await readdir(outbox)).length; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(await readdir(outbox), []);
  assert.equal(delivered.length, 1);
  const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.eventType), ["development_cycle.phase_notification", "development_cycle.phase_notification_delivery"]);
  assert.equal(events.every((event) => event.signature === signature("implementation_running")), true);
  await assert.rejects(access(join(dir, "telegram_update_events.jsonl")), { code: "ENOENT" });
});

test("existing canonical dedupe takes precedence over stale legacy state", async (t) => {
  const { dir, store, cycle, notifications, delivered } = await fixture(t, "implementation_launched");
  const canonicalState = { lastSignature: signature("implementation_running"), updatedAt: "2026-01-02T00:00:00.000Z" };
  const canonicalPath = join(dir, "phase_notification_state.json");
  await store.saveJson(canonicalPath, canonicalState);
  const canonicalText = await readFile(canonicalPath, "utf8");
  const legacyState = { lastSignature: signature("implementation_launched"), updatedAt: "2026-01-01T00:00:00.000Z" };
  const legacyPath = join(dir, "telegram_update_state.json");
  await store.saveJson(legacyPath, legacyState);

  await cycle.cycleStatus(dir, { phase: "implementation_running" });

  assert.equal(await readFile(canonicalPath, "utf8"), canonicalText);
  assert.deepEqual(await store.loadJson(legacyPath), legacyState);
  assert.equal(notifications.snapshot().pending, 0);
  assert.deepEqual(delivered, []);
  await assert.rejects(access(join(dir, "phase_notification_events.jsonl")), { code: "ENOENT" });
});
