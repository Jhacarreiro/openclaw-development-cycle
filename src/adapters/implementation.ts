import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
  octopusWriteScopeMode: "strict" | "adaptive";
  octopusReadScopeMode: "strict" | "contextual";
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
  interventionPath?: string;
  writeScopeMode?: "strict" | "adaptive";
  readScopeMode?: "strict" | "contextual";
  projectWikiPath?: string;
  runRoot?: string;
  planPath?: string;
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
    DEVELOPMENT_CYCLE_INTERVENTION_PATH: input.interventionPath || "",
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
 * routes in providers.json. Development Cycle launches are supervised runs, so
 * invalid or incomplete canonical routing is a launch error rather than a
 * reason to fall back silently to upstream defaults.
 *
 * Explicit process-level seat overrides may replace a derived seat identity,
 * but they do not waive validation of the canonical eight routing roles.
 */
function octopusRoutedSeatEnvironment(): Record<string, string> {
  const home = String(process.env.HOME || "").trim();
  if (!home) throw new Error("octopus_routing_home_missing");

  const configPath = join(home, ".claude-octopus", "config", "providers.json");
  let parsed: { routing?: { roles?: Record<string, unknown> } };
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      routing?: { roles?: Record<string, unknown> };
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") throw new Error(`octopus_routing_config_missing:${configPath}`);
    throw new Error(`octopus_routing_config_invalid:${configPath}`);
  }

  const roles = parsed?.routing?.roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    throw new Error("octopus_routing_roles_missing");
  }

  const canonicalRoles = [...new Set(OCTOPUS_ROUTED_SEAT_ROLE_ENV.map(([role]) => role))];
  const validated = new Map<string, string>();
  for (const role of canonicalRoles) {
    const route = roles[role];
    if (!route || typeof route !== "object" || Array.isArray(route)) {
      throw new Error(`octopus_routing_role_invalid:${role}`);
    }
    const target = route as Record<string, unknown>;
    const provider = typeof target.provider === "string" ? target.provider.trim() : "";
    const model = typeof target.model === "string" ? target.model.trim() : "";
    if (!provider || !model) throw new Error(`octopus_routing_role_invalid:${role}`);
    validated.set(role, `${provider}:${model}`);
  }

  const env: Record<string, string> = {};
  for (const [role, envName] of OCTOPUS_ROUTED_SEAT_ROLE_ENV) {
    const explicit = String(process.env[envName] || "").trim();
    env[envName] = explicit || String(validated.get(role));
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
    const readScopeMode = input.readScopeMode || config.octopusReadScopeMode || "contextual";
    if (readScopeMode !== "strict" && readScopeMode !== "contextual") {
      throw new Error("invalid_octopus_read_scope_mode");
    }
    // Parent-owned metadata only. Never derive authority from prompt text or
    // grant the parent directory of an externally attached plan.
    const readEntries = [...new Set([
      input.projectRoot, input.projectWikiPath, input.runRoot, input.planPath,
      input.requestPath, input.promptPath,
    ].filter((value): value is string => Boolean(value)))];
    for (const value of readEntries) {
      if (!isAbsolute(value) || /[\r\n\0]/.test(value)) {
        throw new Error("invalid_octopus_contextual_read_path");
      }
    }
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
        OCTOPUS_TANGLE_WRITE_SCOPE_MODE: input.writeScopeMode || config.octopusWriteScopeMode,
        OCTOPUS_TANGLE_READ_SCOPE_MODE: readScopeMode,
        OCTOPUS_TANGLE_CONTEXTUAL_READ_ROOTS: readScopeMode === "contextual" ? readEntries.join("\n") : "",
        OCTOPUS_HUMAN_INTERVENTION_PATH: input.interventionPath || "",
        ...octopusRoutedSeatEnvironment(),
        OCTOPUS_REQUIRE_EXPLICIT_REVIEW_ROUTING: "true",
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
