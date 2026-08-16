import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DevelopmentCycleConfig {
  stateRoot: string;
  projectDocsRoot: string;
  projectDocsGitRoot: string;
  implementation: {
    adapter: "command" | "octopus";
    command: string;
    args: string[];
    octopusRoot: string;
    octopusSandbox: string;
    loopUntilApproved: boolean;
  };
  retentionDays: number;
  notifications: {
    enabled: boolean;
    channel: string;
    target: string;
    account: string;
    deliveryJson: string;
  };
  openclawBin: string;
  externalGate: {
    secretPath: string;
    url: string;
  };
  runner: {
    supervisorPath: string;
    supervisorSocket: string;
    heartbeatIntervalSeconds: number;
    defaultTimeoutSeconds: number;
  };
  observer: {
    enabled: boolean;
    observeHelperPath: string;
    agentHookPath: string;
    hookLogPath: string;
    sessionsRoot: string;
    baseUrl: string;
    repository: string;
    branch: string;
    runtime: string;
    owner: string;
  };
}

function text(env: NodeJS.ProcessEnv, name: string, fallback = ""): string {
  const value = String(env[name] ?? "").trim();
  return value || fallback;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArray(env: NodeJS.ProcessEnv, name: string): string[] {
  const value = String(env[name] ?? "").trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = String(env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

export function loadDevelopmentCycleConfig(env: NodeJS.ProcessEnv = process.env): DevelopmentCycleConfig {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const home = text(env, "HOME", homedir());
  const stateRoot = text(
    env,
    "DEVELOPMENT_CYCLE_STATE_ROOT",
    "/data/workspace/project-cycle-handoff",
  );
  const observerRoot = text(
    env,
    "DEVELOPMENT_CYCLE_OBSERVER_ADAPTER_ROOT",
    "/data/workspace/openai-compatible-tool-adapter/gallivanter-runtime-adapter",
  );

  return {
    stateRoot,
    projectDocsRoot: text(
      env,
      "DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT",
      "/data/workspace/openclaw-wiki/Projects",
    ),
    projectDocsGitRoot: text(
      env,
      "DEVELOPMENT_CYCLE_PROJECT_DOCS_GIT_ROOT",
      "/data/workspace/openclaw-wiki",
    ),
    implementation: {
      adapter: text(env, "DEVELOPMENT_CYCLE_IMPLEMENTATION_ADAPTER", "octopus") === "octopus" ? "octopus" : "command",
      command: text(env, "DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND"),
      args: stringArray(env, "DEVELOPMENT_CYCLE_IMPLEMENTATION_ARGS_JSON"),
      octopusRoot: text(
        env,
        "DEVELOPMENT_CYCLE_OCTOPUS_ROOT",
        text(env, "OCTOPUS_ROOT", "/data/workspace/contrib/claude-octopus"),
      ),
      octopusSandbox: text(env, "DEVELOPMENT_CYCLE_OCTOPUS_SANDBOX", "danger-full-access"),
      loopUntilApproved: boolean(env, "DEVELOPMENT_CYCLE_LOOP_UNTIL_APPROVED", true),
    },
    retentionDays: positiveInteger(env, "DEVELOPMENT_CYCLE_RETENTION_DAYS", 30),
    notifications: {
      enabled: boolean(env, "DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED", false),
      channel: text(env, "DEVELOPMENT_CYCLE_NOTIFICATION_CHANNEL"),
      target: text(env, "DEVELOPMENT_CYCLE_NOTIFICATION_TARGET"),
      account: text(env, "DEVELOPMENT_CYCLE_NOTIFICATION_ACCOUNT"),
      deliveryJson: text(env, "DEVELOPMENT_CYCLE_NOTIFICATION_DELIVERY_JSON"),
    },
    openclawBin: text(env, "DEVELOPMENT_CYCLE_OPENCLAW_BIN", "openclaw"),
    externalGate: {
      secretPath: text(
        env,
        "DEVELOPMENT_CYCLE_EXTERNAL_GATE_SECRET_PATH",
        "/data/.openclaw/secrets/ai-server-commander.env",
      ),
      url: text(
        env,
        "DEVELOPMENT_CYCLE_EXTERNAL_GATE_URL",
        "http://192.168.1.220:33001",
      ).replace(/\/$/, ""),
    },
    runner: {
      supervisorPath: text(
        env,
        "DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_PATH",
        join(packageRoot, "runner-supervisor.py"),
      ),
      supervisorSocket: text(
        env,
        "DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET",
        join(tmpdir(), "development-cycle-runner-supervisor.sock"),
      ),
      heartbeatIntervalSeconds: positiveInteger(
        env,
        "DEVELOPMENT_CYCLE_HEARTBEAT_INTERVAL_SECONDS",
        30,
      ),
      defaultTimeoutSeconds: positiveInteger(
        env,
        "DEVELOPMENT_CYCLE_DEFAULT_TIMEOUT_SECONDS",
        0,
      ),
    },
    observer: {
      enabled: boolean(env, "DEVELOPMENT_CYCLE_OBSERVER_ENABLED", true),
      observeHelperPath: text(
        env,
        "DEVELOPMENT_CYCLE_OBSERVER_HELPER_PATH",
        observerRoot ? join(observerRoot, "bin", "observe-process.mjs") : "",
      ),
      agentHookPath: text(
        env,
        "DEVELOPMENT_CYCLE_OBSERVER_AGENT_HOOK_PATH",
        observerRoot ? join(observerRoot, "bin", "octopus-agent-lifecycle-crabfleet.mjs") : "",
      ),
      hookLogPath: text(
        env,
        "DEVELOPMENT_CYCLE_OBSERVER_HOOK_LOG_PATH",
        observerRoot ? join(observerRoot, "octopus-hook-state", "development-cycle-octopus-hook.log") : "",
      ),
      sessionsRoot: text(
        env,
        "DEVELOPMENT_CYCLE_OBSERVER_SESSIONS_ROOT",
        observerRoot ? join(observerRoot, "sessions") : "",
      ),
      baseUrl: text(
        env,
        "DEVELOPMENT_CYCLE_OBSERVER_BASE_URL",
        "http://127.0.0.1:8791",
      ).replace(/\/$/, ""),
      repository: text(env, "DEVELOPMENT_CYCLE_OBSERVER_REPOSITORY", "Jhacarreiro/claude-octopus"),
      branch: text(env, "DEVELOPMENT_CYCLE_OBSERVER_BRANCH", "main"),
      runtime: text(env, "DEVELOPMENT_CYCLE_OBSERVER_RUNTIME", "crabbox"),
      owner: text(env, "DEVELOPMENT_CYCLE_OBSERVER_OWNER", "bootstrap"),
    },
  };
}
