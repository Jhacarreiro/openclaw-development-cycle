import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsPromises, { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { shellQuote } from "../dist/adapters/implementation.js";
import { createRunnerSession } from "../dist/cycle/runner-session.js";

const execFileAsync = promisify(execFile);

test("extracted runner factory resolves the packaged bounded-log helper", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "development-cycle-runner assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Windows does not expose POSIX executable bits. Let the portable asset check
  // reach script generation with the same executable mode used in production.
  if (process.platform === "win32") {
    const originalStat = fsPromises.stat;
    t.mock.method(fsPromises, "stat", async (path, ...args) => {
      const info = await originalStat(path, ...args);
      if (path === process.execPath) info.mode |= 0o111;
      return info;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
  }

  const { createImplementationRunnerSession } = createRunnerSession({
    developmentCycleConfig: { observer: { enabled: false } },
    implementationConfig: {
      adapter: "command",
      command: process.execPath,
      args: ["-e", "process.stdout.write('adapter stdout\\n'); process.stderr.write('adapter stderr\\n')"],
    },
    runtimeHome: root,
    observerAgentHook: "",
    observerHookLog: "",
    observerRepository: "",
    observerBranch: "",
    observerOwner: "test",
    runnerSupervisorPath: "",
    runnerSupervisorSocket: "",
    runnerHeartbeatIntervalSeconds: 1,
    runnerDefaultTimeoutSeconds: 5,
    ensureRunnerSupervisor: async () => { throw new Error("test_supervisor_disabled"); },
    saveJson: async (path, value) => writeFile(path, JSON.stringify(value)),
    pinTrustedProjectRoot: async () => ({
      realPath: root,
      handle: { stat: () => stat(root), close: async () => {} },
    }),
  });
  const launch = await createImplementationRunnerSession(root, {
    project: "asset-check",
    runId: "asset-check-run",
    projectRoot: root,
    prompt: "Exercise the generated adapter command.",
  });
  assert.equal(launch.error, "test_supervisor_disabled");

  const script = await readFile(launch.runnerPath, "utf8");
  const command = script.split("\n").find((line) => line.startsWith("python3 "));
  const helper = fileURLToPath(new URL("../bin/bounded-log.py", import.meta.url));
  await access(helper);
  assert.ok(command?.startsWith(`python3 ${shellQuote(helper)} --stdout `), command);

  await t.test("generated bounded-log command reaches the adapter and captures both logs", {
    skip: process.platform === "win32" ? "Generated runner commands require a POSIX shell." : false,
  }, async () => {
    await execFileAsync("/bin/sh", ["-c", command], { cwd: root, timeout: 10000 });
    assert.equal(await readFile(launch.stdoutPath, "utf8"), "adapter stdout\n");
    assert.equal(await readFile(launch.stderrPath, "utf8"), "adapter stderr\n");
  });
});
