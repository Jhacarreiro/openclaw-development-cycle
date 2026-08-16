import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.equal(spec.env.OCTOPUS_DESIGN_REVIEW_CODEX_AGENT, "commandcode");
  assert.equal(spec.env.OCTOPUS_DESIGN_REVIEW_AGY_AGENT, "commandcode-research");
  assert.equal(spec.env.OCTOPUS_DESIGN_REVIEW_GEMINI_AGENT, "commandcode-research");
  assert.equal(spec.env.OCTOPUS_DESIGN_REVIEW_CLAUDE_AGENT, "claude-sonnet");
  assert.equal(spec.env.OCTOPUS_DESIGN_REVIEW_SYNTH_AGENT, "commandcode-research");
  assert.equal(spec.env.OCTOPUS_AGENT_ROOT_SESSION_ID, "session-1");
  assert.equal(spec.env.CRABFLEET_ROOT_SESSION_ID, "session-1");
});

test("Octopus adapter does not persist or reuse Codex auth files", () => {
  const spec = buildImplementationLaunchSpec(
    { adapter: "octopus", command: "", args: [], octopusRoot: "/opt/octopus", octopusSandbox: "workspace-write", loopUntilApproved: true },
    { ...baseInput, adapter: "octopus" },
  );
  assert.equal(Object.hasOwn(spec.env, "CODEX_HOME"), false);
  assert.equal(Object.keys(spec.env).some((key) => /TOKEN|SECRET|PASSWORD/.test(key)), false);
  assert.match(spec.env.PATH, /^\/data\/workspace\/plugins\/development-cycle\/bin:/);
  assert.equal(spec.env.DEVELOPMENT_CYCLE_CODEX_REAL_BIN, "/data/npm-global/bin/codex");
  assert.equal(spec.env.DEVELOPMENT_CYCLE_CODEX_APP_SERVER_SANDBOX, "danger-full-access");
});

test("Codex bridge resolves OpenClaw OAuth by workspace without private auth-store paths", () => {
  const bridge = readFileSync("/data/workspace/plugins/development-cycle/bin/codex-openclaw-bridge.py", "utf8");
  assert.match(bridge, /workspaceDir:process\.env\.DC_WORKSPACE_DIR/);
  assert.match(bridge, /DEVELOPMENT_CYCLE_OPENCLAW_WORKSPACE_DIR/);
  assert.doesNotMatch(bridge, /ensureAuthProfileStore/);
  assert.doesNotMatch(bridge, /auth-profiles\.json/);
  assert.doesNotMatch(bridge, /agents[\"',)]*,[\"']main/);
  assert.match(bridge, /chatgpt_account_id/);
  assert.match(bridge, /chatgpt_plan_type/);
});

test("Codex bridge discovers the real binary when provider isolation removes the explicit env override", () => {
  const root = mkdtempSync(join(tmpdir(), "dc-codex-path-"));
  const fakeBinDir = join(root, "real");
  mkdirSync(fakeBinDir, { recursive: true });
  const fakeCodex = join(fakeBinDir, "codex");
  writeFileSync(fakeCodex, "#!/bin/sh\nprintf '%s\\n' REAL_CODEX_OK\n");
  chmodSync(fakeCodex, 0o755);

  try {
    const stdout = execFileSync(
      "/data/workspace/plugins/development-cycle/bin/codex-openclaw-bridge.py",
      ["--version"],
      {
        encoding: "utf8",
        env: {
          PATH: `/data/workspace/plugins/development-cycle/bin:${fakeBinDir}:/usr/bin:/bin`,
          HOME: "/tmp",
        },
      },
    );
    assert.equal(stdout.trim(), "REAL_CODEX_OK");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
