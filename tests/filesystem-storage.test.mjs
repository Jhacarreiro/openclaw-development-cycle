import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFilesystemStore } from "../dist/storage/filesystem.js";

test("filesystem storage uses safe run paths and atomic status updates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixedNow = new Date("2026-07-16T10:00:00.000Z");
  const store = createFilesystemStore(root, () => fixedNow);
  const runDir = store.runDir("Project / One", "Run #1");
  assert.equal(runDir, join(root, "runs", "Project-One", "Run-1"));

  const status = await store.updateStatus(runDir, { phase: "planned" });
  assert.equal(status.updatedAt, fixedNow.toISOString());
  assert.deepEqual(JSON.parse(await readFile(join(runDir, "status.json"), "utf8")), status);
  assert.deepEqual((await readdir(runDir)).filter((name) => name.includes(".tmp-")), []);
});
