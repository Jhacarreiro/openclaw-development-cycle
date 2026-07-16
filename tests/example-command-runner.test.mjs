import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("example command adapter consumes request v1 without changing the source checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source");
  const resultsRoot = join(root, "results");
  const promptPath = join(root, "prompt.txt");
  const requestPath = join(root, "request.json");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceRoot, { recursive: true }));
  await writeFile(promptPath, "Implement nothing; this is a fixture.\n");
  await writeFile(requestPath, JSON.stringify({
    schemaVersion: 1,
    project: "fixture",
    runId: "fixture-run",
    mode: "delivery",
    projectRoot: sourceRoot,
    promptPath,
    planPath: "",
    validationPath: "",
    resultsRoot,
    timeoutSeconds: 60,
    command: "implement"
  }, null, 2));

  const runner = new URL("../examples/command-runner.sh", import.meta.url);
  const result = await execFileAsync(runner.pathname, [requestPath], { cwd: sourceRoot });
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.ok, true);
  const delivery = await readFile(parsed.artifact, "utf8");
  assert.match(delivery, /Example command adapter delivery/);
  assert.match(delivery, /Implement nothing/);
  assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(sourceRoot)), []);
});
