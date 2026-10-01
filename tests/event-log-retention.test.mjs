import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { createFilesystemStore } from "../dist/storage/filesystem.js";
import { loadDevelopmentCycleConfig } from "../dist/config.js";

async function fixture(t, policy) {
  const root = await mkdtemp(join(tmpdir(), "dc-event-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "events.jsonl");
  return { root, path, archives: join(root, "event-archives", "events.jsonl"), store: createFilesystemStore(root, undefined, policy) };
}

async function archivedEvents(directory) {
  const names = (await readdir(directory)).sort();
  const entries = [];
  for (const name of names) {
    assert.match(name, /\.jsonl\.gz$/);
    const text = gunzipSync(await readFile(join(directory, name))).toString();
    entries.push(...text.trim().split("\n").map(line => JSON.parse(line)));
  }
  return entries;
}

test("concurrent writers preserve every event across compressed rotations", async t => {
  const { root, path, archives, store } = await fixture(t, { maxBytes: 45, archivesToKeep: 0 });
  const second = createFilesystemStore(root, undefined, { maxBytes: 45, archivesToKeep: 0 });
  await Promise.all(Array.from({ length: 20 }, (_, id) => (id % 2 ? store : second).appendJsonl(path, { id, message: "event" })));
  const current = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const all = [...await archivedEvents(archives), ...current];
  assert.deepEqual(all.map(event => event.id).sort((a, b) => a - b), Array.from({ length: 20 }, (_, id) => id));
  assert.ok(Buffer.byteLength(await readFile(path)) <= 45);
});

test("explicit retention prunes completed archives while preserving interrupted ones and run state", async t => {
  const { root, path, archives, store } = await fixture(t, { maxBytes: 10, archivesToKeep: 2 });
  const statusPath = join(root, "status.json");
  await writeFile(statusPath, '{"phase":"implementation_running"}');
  await store.appendJsonl(path, { id: 0 });
  await store.appendJsonl(path, { id: 1 });
  await store.appendJsonl(path, { id: 2 });
  await writeFile(join(archives, "interrupted.jsonl"), '{"id":"preserved"}\n');
  for (let id = 3; id < 7; id++) await store.appendJsonl(path, { id });
  const completed = (await readdir(archives)).filter(name => name.endsWith(".gz"));
  assert.equal(completed.length, 2);
  assert.equal(await readFile(join(archives, "interrupted.jsonl"), "utf8"), '{"id":"preserved"}\n');
  assert.equal(await readFile(statusPath, "utf8"), '{"phase":"implementation_running"}');
  const current = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual([...await Promise.all(completed.map(async name => JSON.parse(gunzipSync(await readFile(join(archives, name))).toString().trim()))), ...current].map(event => event.id).sort((a, b) => a - b), [4, 5, 6]);
});

test("an oversized event remains one intact JSON line", async t => {
  const { path, archives, store } = await fixture(t, { maxBytes: 20, archivesToKeep: 0 });
  const large = { text: "x".repeat(100) };
  await store.appendJsonl(path, large);
  assert.deepEqual(JSON.parse((await readFile(path, "utf8")).trim()), large);
  await store.appendJsonl(path, { id: 1 });
  assert.deepEqual(await archivedEvents(archives), [large]);
});

test("rotation refuses symlinked archive roots before moving the live log", { skip: process.platform === "win32" }, async t => {
  const { root, path, store } = await fixture(t, { maxBytes: 10, archivesToKeep: 1 });
  const outside = await mkdtemp(join(tmpdir(), "dc-event-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "event-archives"), "dir");
  await store.appendJsonl(path, { id: 1 });
  await assert.rejects(store.appendJsonl(path, { id: 2 }), /event_log_archive_directory_unsafe/);
  assert.deepEqual(JSON.parse((await readFile(path, "utf8")).trim()), { id: 1 });
  assert.deepEqual(await readdir(outside), []);
});

test("retention defaults to preserving all archives and rejects ambiguous deletion settings", () => {
  assert.deepEqual(loadDevelopmentCycleConfig({}).eventLogs, { maxBytes: 8 * 1024 * 1024, archivesToKeep: 0 });
  assert.deepEqual(loadDevelopmentCycleConfig({ DEVELOPMENT_CYCLE_EVENT_LOG_MAX_BYTES: "1024", DEVELOPMENT_CYCLE_EVENT_LOG_ARCHIVES_TO_KEEP: "3" }).eventLogs, { maxBytes: 1024, archivesToKeep: 3 });
  for (const value of ["-1", "NaN", "1.5"]) assert.throws(() => loadDevelopmentCycleConfig({ DEVELOPMENT_CYCLE_EVENT_LOG_ARCHIVES_TO_KEEP: value }), /invalid_configuration/);
});
