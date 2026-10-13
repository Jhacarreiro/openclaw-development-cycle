import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readTextTail } from "../dist/storage/text.js";

test("tail reads retain the requested unicode suffix of large logs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-tail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "large.log");
  const text = "prefix".repeat(1000000) + "🦀á😀\n".repeat(100);
  await writeFile(path, text);
  assert.equal(await readTextTail(path, 211), text.slice(-211));
  assert.equal(await readTextTail(join(root, "missing.log")), "");
});
