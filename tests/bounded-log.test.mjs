import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../bin/bounded-log.py", import.meta.url));
test("runner logging bounds both streams, preserves final output and propagates failure", { skip: process.platform !== "linux" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-bounded-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stdout = join(root, "stdout.log");
  const stderr = join(root, "stderr.log");
  await assert.rejects(exec("python3", [script, "--stdout", stdout, "--stderr", stderr, "--max-bytes", "4096", "--", "python3", "-c", "import sys; sys.stdout.write('x'*50000+'STDOUT END'); sys.stderr.write('y'*50000+'STDERR END'); sys.exit(7)"], { timeout: 10000 }), error => error.code === 7);
  assert.match(await readFile(stdout, "utf8"), /STDOUT END$/);
  assert.match(await readFile(stderr, "utf8"), /STDERR END$/);
  assert.equal((await readdir(root)).length, 4);
  for (const name of await readdir(root)) assert.ok((await stat(join(root, name))).size <= 4096, name);
});
