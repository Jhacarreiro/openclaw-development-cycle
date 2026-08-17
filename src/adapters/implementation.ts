import { join } from "node:path";

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
    DEVELOPMENT_CYCLE_MODE: input.mode,
    DEVELOPMENT_CYCLE_PROJECT_ROOT: input.projectRoot,
    DEVELOPMENT_CYCLE_REQUEST_PATH: input.requestPath,
    DEVELOPMENT_CYCLE_PROMPT_PATH: input.promptPath,
    DEVELOPMENT_CYCLE_OBSERVER_SESSION_ID: input.observer?.sessionId || "",
  };
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
        OCTOPUS_CODEX_SANDBOX: config.octopusSandbox,
        LOOP_UNTIL_APPROVED: config.loopUntilApproved ? "true" : "false",
        // Gallivanter routing policy: the design-review ceremony must use the
        // same persistent role routing as the rest of Octopus instead of the
        // upstream hardcoded agy/claude/codex-mini defaults.
        OCTOPUS_DESIGN_REVIEW_CODEX_AGENT: "commandcode",
        OCTOPUS_DESIGN_REVIEW_AGY_AGENT: "commandcode-research",
        OCTOPUS_DESIGN_REVIEW_GEMINI_AGENT: "commandcode-research",
        OCTOPUS_DESIGN_REVIEW_CLAUDE_AGENT: "claude-sonnet",
        OCTOPUS_DESIGN_REVIEW_SYNTH_AGENT: "commandcode-research",
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

export function renderShellCommand(spec: ImplementationLaunchSpec): string {
  return [spec.executable, ...spec.args].map(shellQuote).join(" ");
}

export function renderShellEnvironment(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([key]) => /^[A-Z_][A-Z0-9_]*$/.test(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
}
