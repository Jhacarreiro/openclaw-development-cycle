import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImplementationLaunchSpec,
  renderShellCommand,
  renderShellEnvironment,
  shellQuote,
} from "../dist/adapters/implementation.js";

const baseInput = {
  project: "example",
  runId: "run-1",
  mode: "delivery",
  projectRoot: "/tmp/project",
  requestPath: "/tmp/run/request.json",
  promptPath: "/tmp/run/prompt.txt",
  prompt: "Implement the approved plan.",
  timeoutSeconds: 900,
  command: "implement",
};

test("command adapter receives the stable request JSON path", () => {
  const spec = buildImplementationLaunchSpec(
    {
      adapter: "command",
      command: "/opt/runner/bin/implement",
      args: ["--format", "json"],
      octopusRoot: "",
      octopusSandbox: "workspace-write",
      loopUntilApproved: true,
    },
    baseInput,
  );
  assert.equal(spec.adapter, "command");
  assert.equal(spec.executable, "/opt/runner/bin/implement");
  assert.deepEqual(spec.args, ["--format", "json", "/tmp/run/request.json"]);
  assert.equal(spec.env.DEVELOPMENT_CYCLE_MODE, "delivery");
  assert.equal(spec.env.DEVELOPMENT_CYCLE_REQUEST_PATH, "/tmp/run/request.json");
});

test("Octopus adapter translates the generic request into orchestrate.sh", () => {
  const spec = buildImplementationLaunchSpec(
    {
      adapter: "command",
      command: "/opt/runner/bin/implement",
      args: [],
      octopusRoot: "/opt/octopus",
      octopusSandbox: "read-only",
      loopUntilApproved: true,
    },
    {
      ...baseInput,
      adapter: "octopus",
      command: "tangle",
      observer: {
        sessionId: "session-1",
        agentHookPath: "/opt/observer/hook.mjs",
        hookLogPath: "/tmp/observer.log",
        repository: "owner/repo",
        branch: "main",
        owner: "team",
      },
    },
  );
  assert.equal(spec.adapter, "octopus");
  assert.equal(spec.executable, "/opt/octopus/scripts/orchestrate.sh");
  assert.deepEqual(spec.args.slice(0, 5), ["--dir", "/tmp/project", "--timeout", "900", "tangle"]);
  assert.equal(spec.args.at(-1), "Implement the approved plan.");
  assert.equal(spec.env.OCTOPUS_CODEX_SANDBOX, "read-only");
  assert.equal(spec.env.LOOP_UNTIL_APPROVED, "true");
  assert.equal(spec.env.OCTOPUS_AGENT_ROOT_SESSION_ID, "session-1");
  assert.equal(spec.env.CRABFLEET_ROOT_SESSION_ID, "session-1");
});

test("Octopus adapter omits timeout when the control plane delegates timeout policy", () => {
  const spec = buildImplementationLaunchSpec(
    {
      adapter: "octopus",
      command: "",
      args: [],
      octopusRoot: "/opt/octopus",
      octopusSandbox: "workspace-write",
      loopUntilApproved: false,
    },
    {
      ...baseInput,
      adapter: "octopus",
      timeoutSeconds: undefined,
      command: "tangle",
    },
  );
  assert.deepEqual(spec.args.slice(0, 3), ["--dir", "/tmp/project", "tangle"]);
  assert.equal(spec.env.LOOP_UNTIL_APPROVED, "false");
});

test("shell rendering quotes executable, arguments and environment values", () => {
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
  const command = renderShellCommand({
    adapter: "command",
    displayName: "command",
    executable: "/tmp/my runner",
    args: ["a'b", "$(touch /tmp/nope)"],
    env: {},
    requestPath: "/tmp/request.json",
  });
  assert.equal(command, `'/tmp/my runner' 'a'"'"'b' '$(touch /tmp/nope)'`);
  assert.equal(renderShellEnvironment({ SAFE_NAME: "a'b", "bad-name": "ignored" }), `export SAFE_NAME='a'"'"'b'`);
});
