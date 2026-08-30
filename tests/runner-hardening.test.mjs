import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const configSource = await readFile(new URL("../src/config.ts", import.meta.url), "utf8");

test("development-cycle uses a persistent subreaper supervisor", () => {
  assert.match(source, /ensureRunnerSupervisor/);
  assert.match(configSource, /runner-supervisor\.py/);
  assert.match(source, /supervised_runner_pid_invalid/);
  assert.match(source, /runnerSupervisorPid/);
});

test("runner finalization reaps heartbeat and cleans live process-group members", () => {
  assert.match(source, /trap - EXIT TERM INT HUP/);
  assert.match(source, /wait \"\$heartbeat_pid\"/);
  assert.match(source, /cleanup_process_group/);
  assert.match(source, /\$1 != self && \$3 !~ \/\^Z\//);
  assert.match(source, /kill -TERM \$cleanup_pids/);
  assert.match(source, /kill -KILL \$cleanup_pids/);
});

test("terminal state is persisted before residual process cleanup", () => {
  const statusWrite = source.indexOf("python3 -c 'import json, os, sys;");
  const cleanupCall = source.indexOf("cleanup_process_group", statusWrite);
  assert.ok(statusWrite >= 0);
  assert.ok(cleanupCall > statusWrite);
});
