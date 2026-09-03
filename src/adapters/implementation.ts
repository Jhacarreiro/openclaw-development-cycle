import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEVELOPMENT_CYCLE_BIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin");

export type ImplementationAdapterKind = "command" | "octopus";
export type ImplementationMode = "delivery" | "corrections";

export interface ImplementationAdapterConfig {
  adapter: ImplementationAdapterKind;
  command: string;
  args: string[];
  octopusRoot: string;
  octopusSandbox: string;
  loopUntilApproved: boolean;
}

export interface ImplementationLaunchInput {
  adapter?: ImplementationAdapterKind;
  project: string;
  runId: string;
  attemptId?: string;
  mode: ImplementationMode;
  projectRoot: string;
  requestPath: string;
  promptPath: string;
  prompt: string;
  timeoutSeconds?: number;
  command?: string;
  observer?: {
    sessionId?: string;
    agentHookPath?: string;
    hookLogPath?: string;
    repository?: string;
    branch?: string;
    owner?: string;
  };
}

export interface ImplementationLaunchSpec {
  adapter: ImplementationAdapterKind;
  displayName: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
  requestPath: string;
}

function genericEnvironment(input: ImplementationLaunchInput): Record<string, string> {
  return {
    DEVELOPMENT_CYCLE_PROJECT: input.project,
    DEVELOPMENT_CYCLE_RUN_ID: input.runId,
    DEVELOPMENT_CYCLE_ATTEMPT_ID: input.attemptId || "",
    DEVELOPMENT_CYCLE_MODE: input.mode,
    DEVELOPMENT_CYCLE_PROJECT_ROOT: input.projectRoot,
    DEVELOPMENT_CYCLE_REQUEST_PATH: input.requestPath,
    DEVELOPMENT_CYCLE_PROMPT_PATH: input.promptPath,
    DEVELOPMENT_CYCLE_OBSERVER_SESSION_ID: input.observer?.sessionId || "",
  };
}

const OCTOPUS_ROUTED_SEAT_ROLE_ENV: ReadonlyArray<readonly [string, string]> = [
  // Design Review ceremony.
  ["implementer", "OCTOPUS_DESIGN_REVIEW_IMPLEMENTER_AGENT"],
  ["researcher", "OCTOPUS_DESIGN_REVIEW_RESEARCHER_AGENT"],
  ["code-reviewer", "OCTOPUS_DESIGN_REVIEW_CODE_REVIEWER_AGENT"],
  ["synthesizer", "OCTOPUS_DESIGN_REVIEW_SYNTHESIZER_AGENT"],

  // Contextual code review. These map semantic seats back to the canonical
  // eight routing roles rather than maintaining a second model table.
  ["code-reviewer", "OCTOPUS_REVIEW_LOGIC_AGENT"],
  ["security-reviewer", "OCTOPUS_REVIEW_SECURITY_AGENT"],
  ["architect", "OCTOPUS_REVIEW_ARCHITECTURE_AGENT"],
  ["researcher", "OCTOPUS_REVIEW_CVE_AGENT"],
  ["strategist", "OCTOPUS_REVIEW_DIVERSITY_AGENT"],
  ["code-reviewer", "OCTOPUS_REVIEW_VERIFIER_AGENT"],
  ["strategist", "OCTOPUS_REVIEW_DEBATER_AGENT"],
  ["synthesizer", "OCTOPUS_REVIEW_SYNTHESIZER_AGENT"],
];

/**
 * Keep Octopus ceremony/review seats aligned with the exact canonical role
 * routes in providers.json. Seat-specific upstream environment variables are
 * launch-time transport only; providers.json remains the single model source
 * of truth.
 *
 * Explicit process-level seat overrides win. If the Octopus config is missing,
 * malformed, or a role route is not an exact {provider, model} object, no value
 * is invented and upstream behavior remains unchanged for that seat.
 */
function octopusRoutedSeatEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  const pending: Array<readonly [string, string]> = [];

  for (const [role, envName] of OCTOPUS_ROUTED_SEAT_ROLE_ENV) {
    const explicit = String(process.env[envName] || "").trim();
    if (explicit) {
      env[envName] = explicit;
    } else {
      pending.push([role, envName]);
    }
  }

  if (pending.length === 0) return env;

  const home = String(process.env.HOME || "").trim();
  if (!home) return env;

  try {
    const configPath = join(home, ".claude-octopus", "config", "providers.json");
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      routing?: { roles?: Record<string, unknown> };
    };
    const roles = parsed?.routing?.roles;
    if (!roles || typeof roles !== "object") return env;

    for (const [role, envName] of pending) {
      const route = roles[role];
      if (!route || typeof route !== "object" || Array.isArray(route)) continue;
      const target = route as Record<string, unknown>;
      const provider = typeof target.provider === "string" ? target.provider.trim() : "";
      const model = typeof target.model === "string" ? target.model.trim() : "";
      if (provider && model) env[envName] = `${provider}:${model}`;
    }
  } catch {
    // Missing or malformed Octopus config: preserve upstream behavior.
  }

  return env;
}

export function buildImplementationLaunchSpec(
  config: ImplementationAdapterConfig,
  input: ImplementationLaunchInput,
): ImplementationLaunchSpec {
  const adapter = input.adapter || config.adapter;
  const genericEnv = genericEnvironment(input);

  if (adapter === "command") {
    if (!config.command) {
      throw new Error("implementation_command_not_configured");
    }
    return {
      adapter,
      displayName: "command",
      executable: config.command,
      args: [...config.args, input.requestPath],
      env: genericEnv,
      requestPath: input.requestPath,
    };
  }

  if (adapter === "octopus") {
    if (!config.octopusRoot) {
      throw new Error("octopus_root_not_configured");
    }
    if (!String(input.attemptId || "").trim()) {
      throw new Error("octopus_attempt_id_required");
    }
    const sessionId = input.observer?.sessionId || "";
    return {
      adapter,
      displayName: "Octopus",
      executable: join(config.octopusRoot, "scripts", "orchestrate.sh"),
      args: [
        "--dir",
        input.projectRoot,
        ...(Number(input.timeoutSeconds || 0) > 0 ? ["--timeout", String(input.timeoutSeconds)] : []),
        input.command || "tangle",
        input.prompt,
      ],
      env: {
        ...genericEnv,
        PATH: `${DEVELOPMENT_CYCLE_BIN_DIR}:${process.env.PATH || ""}`,
        OCTOPUS_CODEX_SANDBOX: config.octopusSandbox,
        OCTOPUS_TANGLE_RUN_ID: String(input.attemptId),
        ...octopusRoutedSeatEnvironment(),
        OCTOPUS_PRESERVE_CALLER_PROCESS_GROUP: "true",
        LOOP_UNTIL_APPROVED: config.loopUntilApproved ? "true" : "false",
        OCTOPUS_AGENT_LIFECYCLE_HOOK: input.observer?.agentHookPath || "",
        OCTOPUS_AGENT_LIFECYCLE_HOOK_LOG: input.observer?.hookLogPath || "",
        OCTOPUS_AGENT_ROOT_SESSION_ID: sessionId,
        OCTOPUS_AGENT_PARENT_SESSION_ID: sessionId,
        CRABFLEET_ROOT_SESSION_ID: sessionId,
        CRABFLEET_PARENT_SESSION_ID: sessionId,
        CRABFLEET_REPO: input.observer?.repository || "",
        CRABFLEET_BRANCH: input.observer?.branch || "",
        CRABFLEET_OWNER: input.observer?.owner || "",
        CRABFLEET_PROJECT: input.project,
      },
      requestPath: input.requestPath,
    };
  }

  throw new Error(`unsupported_implementation_adapter:${String(adapter)}`);
}

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/** JSON-encode a value, then single-quote it for a generated /bin/sh script. */
export function jsonShellQuote(value: string): string {
  return shellQuote(JSON.stringify(value));
}

export function renderShellCommand(spec: ImplementationLaunchSpec): string {
  return [spec.executable, ...spec.args].map(shellQuote).join(" ");
}

export function renderShellEnvironment(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([key]) => /^[A-Z_][A-Z0-9_]*$/.test(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
}
