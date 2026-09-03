import { join } from "node:path";

export type DeployMode = "prepare" | "execute" | "verify";

export interface DeployAdapterConfig {
  adapter: "command";
  command: string;
  args: string[];
  timeoutSeconds: number;
}

export interface DeployLaunchInput {
  project: string;
  deployId: string;
  projectRoot: string;
  sourceRefRequested: string;
  sourceCommit: string;
  deploymentTarget: string;
  resultsRoot: string;
  manifestPath: string;
  authorizationPath: string;
  timeoutSeconds?: number;
  mode: DeployMode;
  requestPath: string;
}

export interface DeployLaunchSpec {
  adapter: "command";
  displayName: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
  requestPath: string;
}

function deployEnvironment(input: DeployLaunchInput): Record<string, string> {
  return {
    DEVELOPMENT_CYCLE_DEPLOY_PROJECT: input.project,
    DEVELOPMENT_CYCLE_DEPLOY_ID: input.deployId,
    DEVELOPMENT_CYCLE_DEPLOY_MODE: input.mode,
    DEVELOPMENT_CYCLE_DEPLOY_PROJECT_ROOT: input.projectRoot,
    DEVELOPMENT_CYCLE_DEPLOY_REQUEST_PATH: input.requestPath,
  };
}

export function buildDeployLaunchSpec(
  config: DeployAdapterConfig,
  input: DeployLaunchInput,
): DeployLaunchSpec {
  if (config.adapter !== "command") {
    throw new Error(`unsupported_deploy_adapter:${String(config.adapter)}`);
  }
  if (!config.command) {
    throw new Error("deploy_command_not_configured");
  }
  return {
    adapter: "command",
    displayName: "deploy-command",
    executable: config.command,
    args: [...config.args, input.requestPath],
    env: deployEnvironment(input),
    requestPath: input.requestPath,
  };
}

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function jsonShellQuote(value: string): string {
  return shellQuote(JSON.stringify(value));
}

export function renderShellCommand(spec: DeployLaunchSpec): string {
  return [spec.executable, ...spec.args].map(shellQuote).join(" ");
}

export function renderShellEnvironment(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([key]) => /^[A-Z_][A-Z0-9_]*$/.test(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
}

export function buildDeployRequest(input: Omit<DeployLaunchInput, "requestPath" | "manifestPath" | "authorizationPath" | "resultsRoot"> & { resultsRoot: string; manifestPath: string; authorizationPath: string; requestPath: string }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    track: "deploy",
    mode: input.mode,
    project: input.project,
    deployId: input.deployId,
    projectRoot: input.projectRoot,
    sourceRefRequested: input.sourceRefRequested,
    sourceCommit: input.sourceCommit,
    deploymentTarget: input.deploymentTarget,
    resultsRoot: input.resultsRoot,
    manifestPath: input.manifestPath,
    authorizationPath: input.authorizationPath,
    timeoutSeconds: input.timeoutSeconds,
  };
}
