import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { withCanonicalRoutingHome } from "./helpers/octopus-routing.mjs";
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
      octopusWriteScopeMode: "strict",
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

test("Octopus adapter translates the generic request into orchestrate.sh", () => withCanonicalRoutingHome(() => {
  const spec = buildImplementationLaunchSpec(
    {
      adapter: "command",
      command: "/opt/runner/bin/implement",
      args: [],
      octopusRoot: "/opt/octopus",
      octopusSandbox: "read-only",
      octopusWriteScopeMode: "adaptive",
      loopUntilApproved: true,
    },
    {
      ...baseInput,
      adapter: "octopus",
      command: "tangle",
      interventionPath: "/tmp/run/intervention.json",
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
  assert.equal(spec.env.OCTOPUS_CONTEXT_BUDGET, "64000");
  assert.equal(spec.env.OCTOPUS_TANGLE_CORRECTION_HARD_CAP, "3");
  assert.equal(spec.env.DEVELOPMENT_CYCLE_ATTEMPT_ID, "delivery-attempt-1");
  assert.equal(spec.env.OCTOPUS_TANGLE_RUN_ID, "delivery-attempt-1");
  assert.equal(spec.env.OCTOPUS_TANGLE_WRITE_SCOPE_MODE, "adaptive");
  assert.equal(spec.env.OCTOPUS_HUMAN_INTERVENTION_PATH, "/tmp/run/intervention.json");
  assert.equal(spec.env.DEVELOPMENT_CYCLE_INTERVENTION_PATH, "/tmp/run/intervention.json");
  assert.equal(spec.env.OCTOPUS_PRESERVE_CALLER_PROCESS_GROUP, "true");
  assert.match(spec.env.PATH, /development-cycle\/bin:/);
  assert.equal(Object.hasOwn(spec.env, "CODEX_HOME"), false);
  assert.equal(Object.keys(spec.env).some((key) => /TOKEN|SECRET|PASSWORD/.test(key)), false);
  assert.equal(spec.env.LOOP_UNTIL_APPROVED, "true");
  assert.equal(spec.env.OCTOPUS_AGENT_ROOT_SESSION_ID, "session-1");
  assert.equal(spec.env.CRABFLEET_ROOT_SESSION_ID, "session-1");
  assert.equal(spec.env.OCTOPUS_REQUIRE_EXPLICIT_REVIEW_ROUTING, "true");
}));

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
        octopusWriteScopeMode: "strict",
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

test("Codex bridge reads OpenClaw's auth store without credential files or local paths", () => {
  const bridgePath = fileURLToPath(new URL("../bin/codex-openclaw-bridge.py", import.meta.url));
  const bridge = readFileSync(bridgePath, "utf8");
  assert.doesNotMatch(bridge, /resolveApiKeyForProvider/);
  assert.doesNotMatch(bridge, /auth\.json/);
  assert.doesNotMatch(bridge, /auth-profiles\.json/);
  assert.doesNotMatch(bridge, /\/data\//);
});

// A fake OpenClaw package serving the given auth store and config, and a fake
// Codex app-server that answers with the account id the bridge logged in with.
function runCodexBridge(store, config = {}, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "development-cycle-codex-bridge-oauth-"));
  const pkg = join(root, "openclaw");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "openclaw",
    type: "module",
    exports: { "./plugin-sdk/agent-runtime": "./agent-runtime.js", "./plugin-sdk/runtime-config-snapshot": "./runtime-config-snapshot.js" },
  }));
  // Like OpenClaw's resolver: the store's order wins over the configured one, and
  // expired OAuth profiles are dropped before the caller sees the order.
  writeFileSync(join(pkg, "agent-runtime.js"), [
    "export function ensureAuthProfileStore() { return JSON.parse(process.env.FAKE_OPENCLAW_STORE); }",
    "export function resolveAuthProfileOrder({ cfg, store, provider }) {",
    "  const order = store.order?.[provider] || cfg?.auth?.order?.[provider] || Object.keys(store.profiles);",
    "  return order.filter((id) => Number(store.profiles[id]?.expires) > Date.now());",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(pkg, "runtime-config-snapshot.js"), [
    "export function getRuntimeConfig() { console.log('Config warnings: fake'); return JSON.parse(process.env.FAKE_OPENCLAW_CONFIG); }",
    "",
  ].join("\n"));
  writeFileSync(join(pkg, "openclaw"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(pkg, "openclaw"), 0o755);
  const fakeCodex = join(root, "codex-real");
  writeFileSync(fakeCodex, [
    "#!/usr/bin/env python3",
    "import json,sys",
    "acc=''",
    "def out(o): print(json.dumps(o),flush=True)",
    "for line in sys.stdin:",
    " z=json.loads(line); m=z.get('method'); q=z.get('params') or {}",
    " if 'id' not in z: continue",
    " if m=='account/login/start': acc=q.get('chatgptAccountId','')",
    " r={'thread':{'id':'t1'}} if m=='thread/start' else {'turn':{'id':'u1'}} if m=='turn/start' else {}",
    " out({'id':z['id'],'result':r})",
    " if m=='turn/start':",
    "  out({'method':'item/completed','params':{'item':{'type':'agentMessage','text':acc}}})",
    "  out({'method':'turn/completed','params':{}})",
    "",
  ].join("\n"));
  chmodSync(fakeCodex, 0o755);
  try {
    const bridgePath = fileURLToPath(new URL("../bin/codex-openclaw-bridge.py", import.meta.url));
    const result = spawnSync("python3", [bridgePath, "exec", "--model", "gpt-test", "-"], {
      encoding: "utf8",
      input: "say hi",
      env: {
        PATH: `${pkg}:/usr/local/bin:/usr/bin:/bin`,
        HOME: root,
        DEVELOPMENT_CYCLE_CODEX_REAL_BIN: fakeCodex,
        FAKE_OPENCLAW_STORE: JSON.stringify(store),
        FAKE_OPENCLAW_CONFIG: JSON.stringify(config),
        ...extraEnv,
      },
    });
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const liveOpenAiProfile = (accountId) => ({ type: "oauth", provider: "openai", access: "access-token", accountId, expires: Date.now() + 3_600_000 });

test("Codex bridge logs in with the live OpenAI profile when openai:default is stale", () => {
  const result = runCodexBridge({
    profiles: {
      "openai:default": { ...liveOpenAiProfile("stale-account"), expires: 0 },
      "openai:account": liveOpenAiProfile("live-account"),
    },
    order: { openai: ["openai:default", "openai:account"] },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "live-account");
});

test("Codex bridge stays within the configured profile order and says why no profile in it is usable", () => {
  const result = runCodexBridge({
    profiles: {
      "openai:default": { ...liveOpenAiProfile("stale-account"), expires: 0 },
      "openai:excluded": liveOpenAiProfile("excluded-account"),
    },
  }, { auth: { order: { openai: ["openai:default"] } } });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /OpenClaw OAuth profile read failed: openai oauth profile expired or near expiry/);
});

// Gone, or a zombie waiting for whoever adopted it to reap it.
function stoppedWithin(pid, ms) {
  for (const end = Date.now() + ms; Date.now() < end; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)) {
    try {
      process.kill(pid, 0);
      if (readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z")) return true;
    } catch {
      return true;
    }
  }
  return false;
}

test("Codex bridge starts the app-server behind a configured prefix, after reading auth outside it", () => {
  const store = { profiles: { "openai:account": liveOpenAiProfile("live-account") } };
  const dir = mkdtempSync(join(tmpdir(), "development-cycle-codex-prefix-"));
  try {
    const log = join(dir, "prefix.log");
    const prefix = join(dir, "prefix.sh");
    const leftover = join(dir, "leftover.pid");
    const ids = join(dir, "ids");
    // A wrapper that leaves a process of its own behind, as a sandbox's init could, and records its
    // own pid, process group and session.
    writeFileSync(prefix, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\necho $$ $(cut -d')' -f2 /proc/$$/stat | cut -d' ' -f4,5) > ${JSON.stringify(ids)}\nsleep 60 &\necho $! > ${JSON.stringify(leftover)}\nshift\nexec "$@"\n`);
    chmodSync(prefix, 0o755);
    const result = runCodexBridge(store, {}, { DEVELOPMENT_CYCLE_CODEX_APP_SERVER_PREFIX: JSON.stringify([prefix, "--marker"]) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "live-account");
    const args = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(args[0], "--marker");
    assert.deepEqual(args.slice(-2), ["app-server", "--stdio"]);
    const pid = Number(readFileSync(leftover, "utf8"));
    assert.ok(stoppedWithin(pid, 3000), "the wrapper's leftover process outlived the bridge");
    // A group of its own, in the session the runner and its supervisor stop the run by.
    const [wrapper, group, session] = readFileSync(ids, "utf8").trim().split(" ").map(Number);
    assert.equal(group, wrapper);
    assert.equal(session, Number(readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[3]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const bad = runCodexBridge(store, {}, { DEVELOPMENT_CYCLE_CODEX_APP_SERVER_PREFIX: "{\"not\": \"a list\"}" });
  assert.equal(bad.status, 64);
  assert.match(bad.stderr, /must be a JSON array of strings/);
});

const bwrap = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).stdout.trim();
const hasBwrap = Boolean(bwrap) && spawnSync(bwrap, ["--ro-bind", "/", "/", "--unshare-pid", "true"]).status === 0;
test("Codex bridge behind a real bwrap prefix with its own PID namespace leaves nothing running", { skip: !hasBwrap && "bwrap is not available here" }, () => {
  const store = { profiles: { "openai:account": liveOpenAiProfile("live-account") } };
  const marker = `development-cycle-bwrap-${process.pid}-${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), "development-cycle-codex-bwrap-"));
  try {
    // The sandboxed side starts a long-lived process of its own before the app-server.
    const inner = join(dir, "inner.sh");
    writeFileSync(inner, `#!/bin/sh\nsh -c 'sleep 60; : ${marker}' &\nexec "$@"\n`);
    chmodSync(inner, 0o755);
    // By absolute path: the bridge runs with a minimal PATH.
    const prefix = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", tmpdir(), tmpdir(), "--unshare-pid", "--die-with-parent", "--", inner];
    const result = runCodexBridge(store, {}, { DEVELOPMENT_CYCLE_CODEX_APP_SERVER_PREFIX: JSON.stringify(prefix) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "live-account");
    const left = () => spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout.trim();
    for (const end = Date.now() + 3000; left() && Date.now() < end;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    assert.equal(left(), "", "a process from inside the sandbox outlived the bridge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex bridge discovers and forwards to the real CLI for non-exec commands", () => {
  const root = mkdtempSync(join(tmpdir(), "development-cycle-codex-bridge-"));
  const fakeBinDir = join(root, "real");
  mkdirSync(fakeBinDir, { recursive: true });
  const fakeCodex = join(fakeBinDir, "codex");
  writeFileSync(fakeCodex, "#!/bin/sh\nprintf '%s\\n' REAL_CODEX_OK\n");
  chmodSync(fakeCodex, 0o755);

  try {
    const shimPath = fileURLToPath(new URL("../bin/codex", import.meta.url));
    const bridgeBin = fileURLToPath(new URL("../bin/", import.meta.url));
    const stdout = execFileSync(shimPath, ["--version"], {
      encoding: "utf8",
      env: {
        PATH: `${bridgeBin}:${fakeBinDir}:/usr/bin:/bin`,
        HOME: root,
      },
    });
    assert.equal(stdout.trim(), "REAL_CODEX_OK");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Octopus adapter fails closed for non-exact canonical role routes", () => {
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
    assert.throws(() => buildImplementationLaunchSpec(
      {
        adapter: "octopus",
        command: "",
        args: [],
        octopusRoot: "/opt/octopus",
        octopusSandbox: "workspace-write",
        octopusWriteScopeMode: "strict",
        loopUntilApproved: true,
      },
      { ...baseInput, adapter: "octopus", command: "tangle" },
    ), /octopus_routing_role_invalid:implementer/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("Octopus adapter omits timeout when the control plane delegates timeout policy", () => withCanonicalRoutingHome(() => {
  const spec = buildImplementationLaunchSpec(
    {
      adapter: "octopus",
      command: "",
      args: [],
      octopusRoot: "/opt/octopus",
      octopusSandbox: "workspace-write",
      octopusWriteScopeMode: "strict",
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
}));

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
    { adapter: "octopus", command: "", args: [], octopusRoot: "/opt/octopus", octopusSandbox: "workspace-write", octopusWriteScopeMode: "strict", loopUntilApproved: true },
    { ...baseInput, attemptId: "", adapter: "octopus", command: "tangle" },
  ), /octopus_attempt_id_required/);
});
