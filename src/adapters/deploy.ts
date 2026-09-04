import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { checkDeployActionTransition } from "../core/deploy-state-machine.js";
import { deployAuthorizationPath, deployRollbackPath, deployStatusPath, loadDeployJson, saveDeployJson, updateDeployStatus } from "../tracks/deploy.js";

const execFileAsync = promisify(execFile);
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

function makeAttemptId(mode: DeployMode): string {
  return `${mode}-${Date.now()}-${randomUUID()}`.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

async function ensureExecutable(path: string): Promise<void> {
  const s = await stat(path).catch(() => null);
  if (!s?.isFile() || (s.mode & 0o111) === 0) throw new Error("deploy_executable_missing_or_not_executable");
}

async function runBoundedAttempt(config: DeployAdapterConfig, input: Omit<DeployLaunchInput, "requestPath">): Promise<any> {
  const attemptId = makeAttemptId(input.mode);
  const attemptDir = join(input.resultsRoot, input.mode, "attempts", attemptId);
  await mkdir(attemptDir, { recursive: true });
  const requestPath = join(attemptDir, "deploy_request.json");
  const verificationEvidencePath = input.mode === "verify" ? join(attemptDir, "verification_evidence.json") : undefined;
  const request = buildDeployRequest({ ...input, verificationEvidencePath });
  await saveDeployJson(requestPath, request);
  const spec = buildDeployLaunchSpec(config, { ...input, requestPath, verificationEvidencePath });
  await ensureExecutable(spec.executable);

  const stdoutPath = join(attemptDir, "stdout.log");
  const stderrPath = join(attemptDir, "stderr.log");
  const statusPath = join(attemptDir, "status.json");
  const startedAt = new Date().toISOString();
  await saveDeployJson(statusPath, { attemptId, mode: input.mode, status: "running", startedAt, requestPath, stdoutPath, stderrPath, timeoutSeconds: input.timeoutSeconds || config.timeoutSeconds });

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let error = "";
  try {
    const result = await execFileAsync(spec.executable, spec.args, {
      cwd: input.projectRoot,
      env: { ...process.env, ...spec.env },
      timeout: Math.max(1, Number(input.timeoutSeconds || config.timeoutSeconds || 1)) * 1000,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = String(result.stdout || "");
    stderr = String(result.stderr || "");
  } catch (e: any) {
    stdout = String(e?.stdout || "");
    stderr = String(e?.stderr || "");
    const timedOut = Boolean(e?.killed || e?.signal === "SIGKILL" || e?.code === "ETIMEDOUT");
    exitCode = timedOut ? 124 : (typeof e?.code === "number" && Number.isFinite(e.code) ? e.code : 1);
    error = timedOut ? `deploy_${input.mode}_timeout` : `deploy_${input.mode}_failed`;
  }
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  const exitedAt = new Date().toISOString();
  await saveDeployJson(statusPath, { attemptId, mode: input.mode, status: exitCode === 0 ? "completed" : "failed", startedAt, exitedAt, requestPath, stdoutPath, stderrPath, exitCode, ...(error ? { error } : {}) });
  return { ok: exitCode === 0, attemptId, attemptDir, requestPath, verificationEvidencePath, stdoutPath, stderrPath, statusPath, exitCode, error };
}

async function readAndValidateManifest(input: { manifestPath: string; sourceCommit: string }): Promise<any> {
  const raw = await loadDeployJson(input.manifestPath);
  return validateDeployManifest(raw, input.sourceCommit);
}

export async function runDeployPrepare(config: DeployAdapterConfig, input: Omit<DeployLaunchInput, "requestPath" | "mode">): Promise<any> {
  if (!config.enabled) return { ok: false, error: "deploy_disabled", attemptId: "" };
  if (!/^[0-9a-f]{40}$/.test(String(input.sourceCommit || ""))) return { ok: false, error: "deploy_sourceCommit_invalid", attemptId: "" };
  const attempt = await runBoundedAttempt(config, { ...input, mode: "prepare" });
  if (!attempt.ok) {
    await updateDeployStatus(input.resultsRoot, { phase: "prepare_failed", sourceCommit: input.sourceCommit, project: input.project, deployId: input.deployId, activeAttempt: attempt });
    return attempt;
  }
  const validated = await readAndValidateManifest(input);
  if (!validated.ok) {
    await updateDeployStatus(input.resultsRoot, { phase: "prepare_failed", sourceCommit: input.sourceCommit, project: input.project, deployId: input.deployId, activeAttempt: attempt, error: validated.error });
    return { ...attempt, ok: false, error: validated.error };
  }
  await saveDeployJson(deployRollbackPath(input.resultsRoot), validated.manifest.rollback);
  await updateDeployStatus(input.resultsRoot, { phase: "prepared", sourceCommit: input.sourceCommit, project: input.project, deployId: input.deployId, manifestPath: input.manifestPath, activeAttempt: attempt });
  return { ...attempt, ok: true, manifest: validated.manifest };
}

export async function runDeployExecute(config: DeployAdapterConfig, input: Omit<DeployLaunchInput, "requestPath" | "mode">): Promise<any> {
  if (!config.enabled) return { ok: false, error: "deploy_disabled", attemptId: "" };
  const validated = await readAndValidateManifest(input);
  if (!validated.ok) return { ok: false, error: validated.error, attemptId: "" };
  const status = await loadDeployJson(deployStatusPath(input.resultsRoot));
  const transition = checkDeployActionTransition("deploy_execute", String(status?.phase || status?.status || ""));
  if (!transition.ok) return { ok: false, error: transition.error, attemptId: "" };

  let authorizationPath = input.authorizationPath || "";
  let authorizationText = String(input.authorizationText || "").trim();
  if (!authorizationText && authorizationPath) authorizationText = String(await readFile(authorizationPath, "utf8").catch(() => "")).trim();
  if (validated.manifest.requiredAuthorizations.length && !authorizationText) return { ok: false, error: "authorization_required", attemptId: "" };
  if (authorizationText) {
    authorizationPath = deployAuthorizationPath(input.resultsRoot);
    await writeFile(authorizationPath, `${authorizationText}\n`, { mode: 0o600 } as any);
  }

  const attempt = await runBoundedAttempt(config, { ...input, authorizationPath, mode: "execute" });
  await updateDeployStatus(input.resultsRoot, { phase: attempt.ok ? "deployed" : "execution_failed", sourceCommit: input.sourceCommit, project: input.project, deployId: input.deployId, authorizationPath, activeAttempt: attempt });
  return attempt;
}

export async function runDeployVerify(config: DeployAdapterConfig, input: Omit<DeployLaunchInput, "requestPath" | "mode">): Promise<any> {
  if (!config.enabled) return { ok: false, error: "deploy_disabled", attemptId: "" };
  const validated = await readAndValidateManifest(input);
  if (!validated.ok) return { ok: false, error: validated.error, attemptId: "" };
  const status = await loadDeployJson(deployStatusPath(input.resultsRoot));
  const transition = checkDeployActionTransition("deploy_verify", String(status?.phase || status?.status || ""));
  if (!transition.ok) return { ok: false, error: transition.error, attemptId: "" };

  const attempt = await runBoundedAttempt(config, { ...input, mode: "verify" });
  let verification: any = null;
  let ok = attempt.ok;
  let error = attempt.error || "";
  if (ok) {
    verification = await loadDeployJson(attempt.verificationEvidencePath);
    const evidence = validateVerificationEvidence(verification, validated.manifest.verificationChecks);
    if (!evidence.ok) { ok = false; error = evidence.error; }
  }
  const result = {
    ok,
    error: ok ? "" : (error || "verification_failed"),
    sourceCommit: input.sourceCommit,
    verificationEvidencePath: attempt.verificationEvidencePath,
    rollback: validated.manifest.rollback,
    nextAction: ok ? "Deployment verified." : "Verification failed; inspect evidence and rollback metadata. There is no automatic rollback.",
  };
  await saveDeployJson(join(attempt.attemptDir, "verify_result.json"), result);
  await updateDeployStatus(input.resultsRoot, { phase: ok ? "verified" : "verification_failed", sourceCommit: input.sourceCommit, project: input.project, deployId: input.deployId, activeAttempt: attempt, verification: result });
  return { ...attempt, ...result, ok };
}
