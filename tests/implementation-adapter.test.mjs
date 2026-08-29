import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildImplementationLaunchSpec,
  renderShellCommand,
  renderShellEnvironment,
  jsonShellQuote,
  shellQuote,
} from "../dist/adapters/implementation.js";

const baseInput = {
  project: "example",
  runId: "run-1",
  attemptId: "delivery-attempt-1",
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
  assert.equal(spec.env.DEVELOPMENT_CYCLE_ATTEMPT_ID, "delivery-attempt-1");
  assert.equal(spec.env.OCTOPUS_TANGLE_RUN_ID, "delivery-attempt-1");
  assert.equal(spec.env.OCTOPUS_PRESERVE_CALLER_PROCESS_GROUP, "true");
  assert.equal(spec.env.LOOP_UNTIL_APPROVED, "true");
  assert.equal(spec.env.OCTOPUS_AGENT_ROOT_SESSION_ID, "session-1");
  assert.equal(spec.env.CRABFLEET_ROOT_SESSION_ID, "session-1");
});

test("Octopus adapter maps canonical role routes into Octopus review seat identities", () => {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "development-cycle-octopus-"));
  const configDir = join(home, ".claude-octopus", "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "providers.json"),
    JSON.stringify({
      routing: {
        roles: {
          architect: { provider: "claude", model: "claude-opus-5" },
          strategist: { provider: "commandcode", model: "qwen/qwen3.8-27b" },
          "security-reviewer": { provider: "claude", model: "claude-opus-5" },
          "code-reviewer": { provider: "codex", model: "gpt-5.6-luna" },
          implementer: { provider: "commandcode", model: "meta/muse-spark-1.2-contributor" },
          "implementer-heavy": { provider: "codex", model: "gpt-5.6-sol" },
          synthesizer: { provider: "commandcode", model: "thinkingmachines/inkling-small" },
          researcher: { provider: "commandcode", model: "tencent/hy3-paid" },
        },
      },
    }),
  );

  try {
    process.env.HOME = home;
    const spec = buildImplementationLaunchSpec(
      {
        adapter: "octopus",
        command: "",
        args: [],
        octopusRoot: "/opt/octopus",
        octopusSandbox: "workspace-write",
        loopUntilApproved: true,
      },
      { ...baseInput, adapter: "octopus", command: "tangle" },
    );

    assert.equal(
      spec.env.OCTOPUS_DESIGN_REVIEW_IMPLEMENTER_AGENT,
      "commandcode:meta/muse-spark-1.2-contributor",
    );
    assert.equal(
      spec.env.OCTOPUS_DESIGN_REVIEW_RESEARCHER_AGENT,
      "commandcode:tencent/hy3-paid",
    );
    assert.equal(spec.env.OCTOPUS_DESIGN_REVIEW_CODE_REVIEWER_AGENT, "codex:gpt-5.6-luna");
    assert.equal(
      spec.env.OCTOPUS_DESIGN_REVIEW_SYNTHESIZER_AGENT,
      "commandcode:thinkingmachines/inkling-small",
    );
    assert.equal(spec.env.OCTOPUS_REVIEW_LOGIC_AGENT, "codex:gpt-5.6-luna");
    assert.equal(spec.env.OCTOPUS_REVIEW_SECURITY_AGENT, "claude:claude-opus-5");
    assert.equal(spec.env.OCTOPUS_REVIEW_ARCHITECTURE_AGENT, "claude:claude-opus-5");
    assert.equal(spec.env.OCTOPUS_REVIEW_CVE_AGENT, "commandcode:tencent/hy3-paid");
    assert.equal(spec.env.OCTOPUS_REVIEW_DIVERSITY_AGENT, "commandcode:qwen/qwen3.8-27b");
    assert.equal(spec.env.OCTOPUS_REVIEW_VERIFIER_AGENT, "codex:gpt-5.6-luna");
    assert.equal(spec.env.OCTOPUS_REVIEW_DEBATER_AGENT, "commandcode:qwen/qwen3.8-27b");
    assert.equal(
      spec.env.OCTOPUS_REVIEW_SYNTHESIZER_AGENT,
      "commandcode:thinkingmachines/inkling-small",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("Octopus adapter does not invent routed review seats for non-exact role routes", () => {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "development-cycle-octopus-"));
  const configDir = join(home, ".claude-octopus", "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "providers.json"),
    JSON.stringify({
      routing: {
        roles: {
          implementer: "commandcode",
          researcher: { provider: "commandcode" },
        },
      },
    }),
  );

  try {
    process.env.HOME = home;
    const spec = buildImplementationLaunchSpec(
      {
        adapter: "octopus",
        command: "",
        args: [],
        octopusRoot: "/opt/octopus",
        octopusSandbox: "workspace-write",
        loopUntilApproved: true,
      },
      { ...baseInput, adapter: "octopus", command: "tangle" },
    );

    assert.equal(spec.env.OCTOPUS_DESIGN_REVIEW_IMPLEMENTER_AGENT, undefined);
    assert.equal(spec.env.OCTOPUS_DESIGN_REVIEW_RESEARCHER_AGENT, undefined);
    assert.equal(spec.env.OCTOPUS_REVIEW_CVE_AGENT, undefined);
    assert.equal(spec.env.OCTOPUS_REVIEW_DEBATER_AGENT, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
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

test("jsonShellQuote encodes JSON then shell-quotes the result", () => {
  assert.equal(jsonShellQuote(`foo"bar`), `'"foo\\"bar"'`);
  assert.equal(jsonShellQuote("foo\\bar"), `'"foo\\\\bar"'`);
  assert.equal(jsonShellQuote("foo\nbar"), `'"foo\\nbar"'`);
  assert.equal(jsonShellQuote("a'b"), `'"a'"'"'b"'`);
});


test("Octopus adapter requires an attempt id for deterministic Tangle handoff", () => {
  assert.throws(() => buildImplementationLaunchSpec(
    { adapter: "octopus", command: "", args: [], octopusRoot: "/opt/octopus", octopusSandbox: "workspace-write", loopUntilApproved: true },
    { ...baseInput, attemptId: "", adapter: "octopus", command: "tangle" },
  ), /octopus_attempt_id_required/);
});
