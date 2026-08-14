import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFilesystemStore } from "../dist/storage/filesystem.js";
import { cleanId } from "../dist/core/ids.js";

test("filesystem storage uses safe run paths and atomic status updates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixedNow = new Date("2026-07-16T10:00:00.000Z");
  const store = createFilesystemStore(root, () => fixedNow);
  const runDir = store.runDir("Project / One", "Run #1");
  assert.equal(runDir, join(root, "runs", cleanId("Project / One"), cleanId("Run #1")));
  assert.notEqual(cleanId("Project / One"), "Project-One");
  assert.notEqual(cleanId("Run #1"), "Run-1");

  const status = await store.updateStatus(runDir, { phase: "planned" });
  assert.equal(status.updatedAt, fixedNow.toISOString());
  assert.deepEqual(JSON.parse(await readFile(join(runDir, "status.json"), "utf8")), status);
  assert.deepEqual((await readdir(runDir)).filter((name) => name.includes(".tmp-")), []);
});

test("fresh install writes the canonical sanitized run path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFilesystemStore(root, () => new Date("2026-07-16T10:00:00.000Z"));
  const runDir = store.runDir("Project / One", "Run #1");
  await store.updateStatus(runDir, { phase: "planned" });
  const names = await readdir(join(root, "runs"));
  assert.deepEqual(names, [cleanId("Project / One")]);
  assert.equal(store.runDir("Project / One", "Run #1"), runDir);
});

test("upgrade resolves legacy sanitized run paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFilesystemStore(root, () => new Date("2026-07-16T10:00:00.000Z"));
  const legacy = join(root, "runs", "Project-One", "Run-1");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "status.json"), `${JSON.stringify({ phase: "planned", runId: "Run-1" }, null, 2)}\n`);
  assert.equal(store.runDir("Project / One", "Run #1"), legacy);
  const status = await store.loadJson(join(store.runDir("Project / One", "Run #1"), "status.json"));
  assert.equal(status.phase, "planned");
});
