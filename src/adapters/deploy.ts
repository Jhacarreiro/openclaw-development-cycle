export type DeployMode = "prepare" | "execute" | "verify";

export interface DeployAdapterConfig {
  enabled?: boolean;
  adapter: "command";
  command: string;
  args: string[];
  timeoutSeconds: number;
  supervisorPath?: string;
  supervisorSocket?: string;
}

export interface DeployLaunchInput {
  project: string;
  deployId: string;
  projectRoot: string;
  sourceRefRequested?: string;
  sourceRunId?: string;
  sourceCommit: string;
  deploymentTarget?: string;
  resultsRoot: string;
  manifestPath: string;
  authorizationPath?: string;
  authorizationText?: string;
  timeoutSeconds?: number;
  mode: DeployMode;
  requestPath: string;
  verificationEvidencePath?: string;
}

export interface DeployLaunchSpec {
  adapter: "command";
  displayName: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
  requestPath: string;
}

export interface DeployManifestV1 {
  schemaVersion?: number;
  sourceCommit: string;
  expectedMutations: string[];
  protectedPaths: string[];
  requiredAuthorizations: string[];
  verificationChecks: string[];
  rollback: { available: boolean; description: string; artifacts: string[] };
  [key: string]: unknown;
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

export function buildDeployLaunchSpec(config: DeployAdapterConfig, input: DeployLaunchInput): DeployLaunchSpec {
  if (config.adapter !== "command") throw new Error(`unsupported_deploy_adapter:${String(config.adapter)}`);
  if (!config.command) throw new Error("deploy_command_not_configured");
  return { adapter: "command", displayName: "deploy-command", executable: config.command, args: [...config.args, input.requestPath], env: deployEnvironment(input), requestPath: input.requestPath };
}

export function shellQuote(value: string): string { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
export function jsonShellQuote(value: string): string { return shellQuote(JSON.stringify(value)); }
export function renderShellCommand(spec: DeployLaunchSpec): string { return [spec.executable, ...spec.args].map(shellQuote).join(" "); }
export function renderShellEnvironment(env: Record<string, string>): string {
  return Object.entries(env).filter(([key]) => /^[A-Z_][A-Z0-9_]*$/.test(key)).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
}

export function buildDeployRequest(input: Omit<DeployLaunchInput, "requestPath">): Record<string, unknown> {
  return {
    schemaVersion: 1,
    track: "deploy",
    mode: input.mode,
    project: input.project,
    deployId: input.deployId,
    projectRoot: input.projectRoot,
    sourceRefRequested: input.sourceRefRequested || "",
    sourceCommit: input.sourceCommit,
    deploymentTarget: input.deploymentTarget || "",
    resultsRoot: input.resultsRoot,
    manifestPath: input.manifestPath,
    authorizationPath: input.authorizationPath || "",
    timeoutSeconds: input.timeoutSeconds,
    ...(input.mode === "verify" && input.verificationEvidencePath ? { verificationEvidencePath: input.verificationEvidencePath } : {}),
  };
}

function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }

export function validateDeployManifest(value: unknown, expectedSourceCommit: string): { ok: true; manifest: DeployManifestV1 } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "deploy_manifest_missing_or_invalid" };
  const manifest = value as any;
  if (manifest.sourceCommit !== expectedSourceCommit) return { ok: false, error: "deploy_manifest_sourceCommit_mismatch" };
  if (!/^[0-9a-f]{40}$/.test(String(manifest.sourceCommit || ""))) return { ok: false, error: "deploy_manifest_sourceCommit_invalid" };
  for (const field of ["expectedMutations", "protectedPaths", "requiredAuthorizations", "verificationChecks"]) {
    if (!stringArray(manifest[field])) return { ok: false, error: `deploy_manifest_${field}_invalid` };
  }
  const rollback = manifest.rollback;
  if (!rollback || typeof rollback !== "object" || typeof rollback.available !== "boolean" || typeof rollback.description !== "string" || !stringArray(rollback.artifacts)) {
    return { ok: false, error: "deploy_manifest_rollback_invalid" };
  }
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) return { ok: false, error: "deploy_manifest_schemaVersion_invalid" };
  return { ok: true, manifest };
}

export function validateVerificationEvidence(value: unknown, requiredChecks: string[]): { ok: true; evidence: any } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "verification_evidence_missing_or_invalid" };
  const evidence = value as any;
  if (evidence.schemaVersion !== 1 || evidence.ok !== true || !Array.isArray(evidence.checks)) return { ok: false, error: "verification_evidence_missing_or_invalid" };
  const passes = new Map<string, boolean>();
  for (const check of evidence.checks) {
    if (!check || typeof check !== "object" || typeof check.name !== "string" || !["pass", "fail"].includes(check.status)) return { ok: false, error: "verification_evidence_check_invalid" };
    passes.set(check.name, check.status === "pass");
  }
  for (const required of requiredChecks) if (passes.get(required) !== true) return { ok: false, error: `verification_check_not_passed:${required}` };
  return { ok: true, evidence };
}
