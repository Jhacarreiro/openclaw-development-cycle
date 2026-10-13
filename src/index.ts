import { Type, type Static } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { join, relative, sep, basename, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ACTIONS, checkActionTransition } from "./core/state-machine.js";
import { parseFinalDecision } from "./core/decisions.js";
import { cleanId, newRunId as createRunId, projectPathCandidates } from "./core/ids.js";
import { classifyAutomaticImplementationRecovery } from "./core/automatic-recovery.js";
import { createNotificationService } from "./runtime/notifications.js";
import { loadDevelopmentCycleConfig } from "./config.js";
import { acquireLock, createFilesystemStore } from "./storage/filesystem.js";
import { createExternalGate } from "./cycle/external-gate.js";
import { createCycleStore } from "./cycle/cycle-store.js";
import { readTextIfExists, excerpt, readJsonIfExists, textTail } from "./cycle/files.js";
import { createMainUpdates } from "./cycle/main-updates.js";
import { createRunnerSupervisor } from "./cycle/runner-supervisor.js";
import { createPinnedFs } from "./cycle/pinned-fs.js";
import { createRunnerSession } from "./cycle/runner-session.js";
import { createObserver } from "./cycle/observer.js";
import { looksLikePlanRequest, analyzeImplementationPlan, normalizeImplementationPlan } from "./cycle/plan.js";
import { createPlanningPack } from "./cycle/planning-pack.js";
import { createOctopusOutput } from "./cycle/octopus-output.js";
import { createRepositoryDelivery } from "./cycle/repository-delivery.js";
import { createImplementationStatus } from "./cycle/implementation-status.js";
import { createRuntimeObservation } from "./cycle/runtime-observation.js";
import { createFinalValidation } from "./cycle/final-validation.js";
import { createCouncil } from "./cycle/council.js";
import { createStop } from "./cycle/stop.js";

const lifecycleLockHeld = Symbol("developmentCycleLifecycleLockHeld");
const resolvedCycleDir = Symbol("developmentCycleResolvedCycleDir");
const interventionResume = Symbol("developmentCycleInterventionResume");
const lifecycleLockTimeoutMs = 30000;

type CycleParameters = Partial<Static<typeof cycleParameters>> & {
  [lifecycleLockHeld]?: boolean;
  [resolvedCycleDir]?: string;
  [interventionResume]?: { id: string; response: string; responsePath: string; answeredAt: string; sourceAttemptId: string | null };
  automaticRecovery?: boolean;
};

interface CycleResult {
  ok: boolean;
  [detail: string]: unknown;
}

const developmentCycleConfig = loadDevelopmentCycleConfig();
const secretPath = developmentCycleConfig.externalGate.secretPath;
const defaultUrl = developmentCycleConfig.externalGate.url;
const lit = <const T extends string[]>(...xs: T) => Type.Enum<T>(xs);

const cycleRoot = developmentCycleConfig.stateRoot;
const wikiRoot = developmentCycleConfig.projectDocsGitRoot;
const projectsWikiRoot = developmentCycleConfig.projectDocsRoot;
const implementationConfig = developmentCycleConfig.implementation;
const repositoryDeliveryConfig = developmentCycleConfig.repositoryDelivery;
const observerObserveHelper = developmentCycleConfig.observer.observeHelperPath;
const observerAgentHook = developmentCycleConfig.observer.agentHookPath;
const observerHookLog = developmentCycleConfig.observer.hookLogPath;
const adapterSessionsRoot = developmentCycleConfig.observer.sessionsRoot;
const observerLocalBaseUrl = developmentCycleConfig.observer.baseUrl;
const defaultCodexSandbox = implementationConfig.octopusSandbox;
const runtimeHome = process.env.HOME || process.cwd();
const observerRepository = developmentCycleConfig.observer.repository;
const observerBranch = developmentCycleConfig.observer.branch;
const observerRuntime = developmentCycleConfig.observer.runtime;
const observerOwner = developmentCycleConfig.observer.owner || "operator";
const runnerSupervisorPath = developmentCycleConfig.runner.supervisorPath;
const runnerSupervisorSocket = developmentCycleConfig.runner.supervisorSocket;
const runnerHeartbeatIntervalSeconds = developmentCycleConfig.runner.heartbeatIntervalSeconds;
const runnerDefaultTimeoutSeconds = developmentCycleConfig.runner.defaultTimeoutSeconds;
const filesystemStore = createFilesystemStore(cycleRoot, undefined, developmentCycleConfig.eventLogs);

const cycleMessageDeliveryQueue = createNotificationService(filesystemStore, cycleRoot, developmentCycleConfig.notifications);

// Each coordinator module receives the configuration and the functions of the modules before it.
const cycleContext0 = {
  developmentCycleConfig, secretPath, defaultUrl, cycleRoot, wikiRoot, projectsWikiRoot,
  implementationConfig, repositoryDeliveryConfig, observerObserveHelper, observerAgentHook, observerHookLog,
  adapterSessionsRoot, observerLocalBaseUrl, defaultCodexSandbox, runtimeHome, observerRepository,
  observerBranch, observerRuntime, observerOwner, runnerSupervisorPath, runnerSupervisorSocket,
  runnerHeartbeatIntervalSeconds, runnerDefaultTimeoutSeconds, filesystemStore, cycleMessageDeliveryQueue,
};
const cycleContext1 = { ...cycleContext0, ...createExternalGate(cycleContext0) };
const cycleContext2 = { ...cycleContext1, ...createCycleStore(cycleContext1) };
const cycleContext3 = { ...cycleContext2, ...createMainUpdates(cycleContext2) };
const cycleContext4 = { ...cycleContext3, ...createRunnerSupervisor(cycleContext3) };
const cycleContext5 = { ...cycleContext4, ...createPinnedFs(cycleContext4) };
const cycleContext6 = { ...cycleContext5, ...createRunnerSession(cycleContext5) };
const cycleContext7 = { ...cycleContext6, ...createObserver(cycleContext6) };
const cycleContext8 = { ...cycleContext7, ...createPlanningPack(cycleContext7) };
const cycleContext9 = { ...cycleContext8, ...createOctopusOutput(cycleContext8) };
const cycleContext10 = { ...cycleContext9, ...createRepositoryDelivery(cycleContext9) };
const cycleContext11 = { ...cycleContext10, ...createImplementationStatus(cycleContext10) };
const cycleContext12 = { ...cycleContext11, ...createRuntimeObservation(cycleContext11) };
const cycleContext13 = { ...cycleContext12, ...createFinalValidation(cycleContext12) };
const cycleContext14 = { ...cycleContext13, ...createCouncil(cycleContext13) };
const cycleContext15 = { ...cycleContext14, ...createStop(cycleContext14) };
const {
  sendCycleNotice, cycleDir, loadJson, saveJson, cycleStatus, sendCycleMessage,
  clearActiveImplementationAttempt, clearActiveCorrectionsAttempt, dcClassify, dcPersistFailure,
  dcNotifyMain, resolveTrustedProjectWikiPath, pinTrustedProjectRoot, readAllowedTextFile,
  pinContainedWikiDir, persistApprovedPlan, createImplementationRunnerSession,
  createImplementationObserverSession, updateImplementationObserverSession, finalizeObserverSessions,
  writePlanningPack, repositoryDeliveryMissingRequiredOutput, octopusAttemptPristine,
  resumeReviewInfrastructureFinalization, requiredValidationError, finalizeRepositoryDeliveryState,
  reconcileRepositoryDeliveryState, autoCommitCanonicalPlan, refreshLaunchedImplementationStatus,
  cycleRuntimeSummary, writeFinalValidationPack, runExternalFinalValidation, maybeRunCouncilEndgate,
  stopLaunchedImplementation, maybeHandleStalledRun, isExactBroadProjectRoot,
} = cycleContext15;
export { isExactBroadProjectRoot };

function newRunId(project: string) { return createRunId(project); }
async function maybeAutoRecoverImplementationFailure(dir: string, status: any, params: any) {
  if (String(status?.phase || "") !== "implementation_failed") return { attempted: false, status };
  const stdoutPath = String(status?.implementationStdout || status?.directImplementationStdout || "");
  const stderrPath = String(status?.implementationStderr || status?.directImplementationStderr || "");
  const [stdout, stderr, pristineState] = await Promise.all([
    textTail(stdoutPath, 60000),
    textTail(stderrPath, 30000),
    octopusAttemptPristine(status),
  ]);
  const classification = classifyAutomaticImplementationRecovery({
    phase: status?.phase,
    adapter: status?.implementationAdapter,
    stdout,
    stderr,
    recoveryCount: Number(status?.automaticPlannerRecoveryCount || 0),
    hasIntervention: Boolean(status?.implementationIntervention || status?.implementationInterventionPath),
    pristine: pristineState.pristine,
  });
  if (!classification.eligible) return { attempted: false, classification, pristineState, status };

  const recoveryCount = Number(status?.automaticPlannerRecoveryCount || 0) + 1;
  const recoveryEvent = {
    schemaVersion: 1,
    detectedAt: new Date().toISOString(),
    failureClass: classification.reason,
    recoveryCount,
    previousAttemptId: status?.implementationAttemptId || null,
    pristineState,
  };
  await filesystemStore.appendJsonl(join(dir, "automatic_recovery_events.jsonl"), recoveryEvent);
  const marked = await cycleStatus(dir, {
    automaticPlannerRecoveryCount: recoveryCount,
    automaticRecoveryLast: recoveryEvent,
    nextAction: "Automatically relaunching the same approved implementation after a recoverable planner-contract failure with a pristine worktree.",
  });
  await sendCycleMessage({}, `♻️ Development Cycle auto-recovery — ${status?.project || "project"}`, `Run: ${status?.runId || ""}\nReason: ${classification.reason}\nAttempt: ${recoveryCount}/1\nWorktree: pristine\nAction: relaunching the same approved plan.`).catch(() => null);
  const relaunch = await projectCycle({
    action: "start_implementation",
    project: status?.project || params?.project,
    runId: status?.runId || params?.runId,
    projectRoot: status?.projectRoot,
    projectWikiPath: status?.projectWikiPath,
    planPath: status?.plan,
    implementationAdapter: status?.implementationAdapter || "octopus",
    [resolvedCycleDir]: dir,
    [lifecycleLockHeld]: true,
    automaticRecovery: true,
  });
  const nextStatus = await loadJson(join(dir, "status.json"));
  return { attempted: true, classification, pristineState, recoveryEvent, relaunch, status: nextStatus || marked };
}

// Run tracking fields exist only on runs created with them, so older runs never get partial counts.
function countedOnce(status: any, field: "interventionAnswerCount" | "correctionRoundCount") {
  return Number.isSafeInteger(status?.[field]) ? { [field]: status[field] + 1 } : {};
}
function firstLaunch(status: any) {
  return status?.createdAt && !status?.startedAt ? { startedAt: new Date().toISOString() } : {};
}

async function latestRunDir(project: string) {
  const runsRoot = join(cycleRoot, "runs");
  const runsRootInfo = await lstat(runsRoot).catch(() => null);
  if (!runsRootInfo?.isDirectory() || runsRootInfo.isSymbolicLink()) return "";
  const realRunsRoot = await realpath(runsRoot).catch(() => "");
  if (!realRunsRoot) return "";

  const containedDir = async (path: string) => {
    const info = await lstat(path).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    const realPath = await realpath(path).catch(() => "");
    if (!realPath) return null;
    const rel = relative(realRunsRoot, realPath);
    if (!rel || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith(sep)) return null;
    return info;
  };

  const entries: Array<{ dir: string; name: string; mtime: number; ts: string }> = [];
  for (const dirName of projectPathCandidates(project)) {
    const base = join(runsRoot, dirName);
    if (!(await containedDir(base))) continue;

    let ents: Array<{ name: string; isDirectory: () => boolean }> = [];
    try { ents = await readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      if (!ent.isDirectory() || !ent.name || ent.name === "." || ent.name === ".." || ent.name === ".git") continue;
      const full = join(base, ent.name);
      const fullInfo = await containedDir(full);
      if (!fullInfo) continue;

      const statusPath = join(full, "status.json");
      const statusInfo = await lstat(statusPath).catch(() => null);
      if (!statusInfo?.isFile() || statusInfo.isSymbolicLink()) continue;

      const tsMatch = ent.name.match(/-(\d{14,17})(?:-[a-z0-9]+)?$/i);
      entries.push({
        dir: full,
        name: ent.name,
        mtime: fullInfo.mtimeMs,
        ts: tsMatch ? tsMatch[1].padEnd(17, "0") : "",
      });
    }
  }

  entries.sort((a, b) => {
    if (a.ts && b.ts && a.ts !== b.ts) return a.ts.localeCompare(b.ts);
    if (a.ts && !b.ts) return 1;
    if (!a.ts && b.ts) return -1;
    if (a.mtime !== b.mtime) return a.mtime - b.mtime;
    return a.name.localeCompare(b.name);
  });
  return entries.at(-1)?.dir || "";
}

const LIVE_RUN_PHASES = ["implementation_launched", "implementation_running", "corrections_launched", "corrections_running"];

// Returns the current live phase when the run has an active runner, else "".
function liveRunPhase(phase: any): string {
  const p = String(phase || "");
  return LIVE_RUN_PHASES.includes(p) ? p : "";
}

async function projectCycle(params: CycleParameters | null | undefined): Promise<CycleResult> {
  // Defense-in-depth: host SDKs validate arguments before execute, but direct
  // or future invocations with null/undefined must behave like {} (the plugin
  // already defaults every field at runtime), not throw an unhandled trace.
  params ??= {};
  const supported = [...ACTIONS];
  const action = params.action || "status";
  if (!(supported as readonly string[]).includes(action)) return { ok: false, error: "unknown_action", action, supported };

  const rawProject = params.project || "default";
  let project = cleanId(rawProject);
  const createRun = action === "request_plan" || action === "record_plan";

  let dir = params[resolvedCycleDir] ? String(params[resolvedCycleDir]) : "";
  if (!dir) {
    if (params.runId) dir = cycleDir(rawProject, params.runId);
    else if (createRun) dir = cycleDir(rawProject, newRunId(rawProject));
    else dir = await latestRunDir(rawProject);
  }
  if (!dir) return { ok: true, project, runId: null, dir: null, status: null, files: [], nextAction: "request_plan or record_plan" };
  project = basename(dirname(dir));
  const runId = basename(dir);
  if (action !== "status" && params[lifecycleLockHeld] !== true) {
    await mkdir(dir, { recursive: true });
    let lifecycleLock: Awaited<ReturnType<typeof acquireLock>>;
    try {
      lifecycleLock = await acquireLock(join(dir, ".lifecycle-action.lock"), lifecycleLockTimeoutMs);
    } catch (err: any) {
      return { ok: false, error: "lifecycle_action_busy", project, runId, dir, action, detail: String(err?.message || err) };
    }
    try {
      if (!(await lifecycleLock.isHeld())) {
        return { ok: false, error: "lifecycle_action_lock_lost", project, runId, dir, action };
      }
      return await projectCycle({ ...params, project: rawProject, [resolvedCycleDir]: dir, [lifecycleLockHeld]: true });
    } finally {
      await lifecycleLock.release();
    }
  }
  const status = await loadJson(join(dir, "status.json"));

  if (action === "status") {
    const files = (await readdir(dir).catch(() => [])).sort();
    const runtimeObservation = await loadJson(join(dir, "runtime_observation.json"));
    const runtimeAlerts = await loadJson(join(dir, "runtime_alerts.json"));
    return {
      ok: true,
      readOnly: true,
      project,
      runId,
      dir,
      status,
      files,
      runtime: { observation: runtimeObservation, alerts: runtimeAlerts },
      nextAction: status?.nextAction || null,
    };
  }

  if (action === "reconcile") {
    const refreshedStatus = await refreshLaunchedImplementationStatus(dir, status);
    let effectiveStatus = refreshedStatus;
    const automaticRecovery = await maybeAutoRecoverImplementationFailure(dir, { ...effectiveStatus, project, runId }, params);
    effectiveStatus = automaticRecovery.status || effectiveStatus;
    if (automaticRecovery.attempted && automaticRecovery.relaunch?.ok) {
      const files = (await readdir(dir).catch(() => [])).sort();
      const runtime = await cycleRuntimeSummary(dir, effectiveStatus);
      return { ok: true, project, runId, dir, phase: effectiveStatus?.phase, status: effectiveStatus, files, runtime, automaticRecovery };
    }
    const repositoryDeliveryReconcile = await reconcileRepositoryDeliveryState(dir, { ...effectiveStatus, project, runId }, params);
    effectiveStatus = repositoryDeliveryReconcile?.status || effectiveStatus;
    let automaticValidation: any = null;
    if (params.autoRunFinalValidation === true && ["implementation_delivered", "corrections_completed"].includes(String(effectiveStatus?.phase || "")) && !effectiveStatus?.externalValidation) {
      automaticValidation = await runExternalFinalValidation(dir, { ...effectiveStatus, project, runId }, params, "implementation_delivered");
      effectiveStatus = automaticValidation.status || effectiveStatus;
    }
    let councilEndgate: any = null;
    if (params.autoRunCouncilReview === true) {
      councilEndgate = await maybeRunCouncilEndgate(dir, { ...effectiveStatus, project, runId }, params);
      effectiveStatus = councilEndgate?.status || effectiveStatus;
    }
    const stall = await maybeHandleStalledRun(dir, effectiveStatus, params);
    effectiveStatus = stall?.status || effectiveStatus;
    const files = (await readdir(dir).catch(() => [])).sort();
    const runtime = await cycleRuntimeSummary(dir, effectiveStatus);
    const runtimeEvent = await dcClassify(dir, { ...effectiveStatus, project, runId }, runtime);
    const failurePolicy = await dcPersistFailure(dir, effectiveStatus, runtimeEvent);
    effectiveStatus = failurePolicy.status || effectiveStatus;
    let automaticRepositoryDelivery: any = null;
    const failureDeliveryPhase = ["implementation_failed", "corrections_failed", "stopped"].includes(String(effectiveStatus?.phase || ""));
    if (repositoryDeliveryConfig.enabled && failureDeliveryPhase && repositoryDeliveryMissingRequiredOutput(effectiveStatus)) {
      effectiveStatus = await cycleStatus(dir, {
        repositoryDeliverySuppressed: {
          reason: "octopus_output_path_missing",
          phase: String(effectiveStatus?.phase || ""),
          suppressedAt: new Date().toISOString(),
        },
        nextAction: "No deliverable Octopus output exists for this attempt. Start a new clean plan/implementation handoff after fixing the blocker.",
      });
    } else if (repositoryDeliveryConfig.enabled && failureDeliveryPhase) {
      automaticRepositoryDelivery = await finalizeRepositoryDeliveryState(dir, { ...effectiveStatus, project, runId }, params);
      effectiveStatus = automaticRepositoryDelivery.status || effectiveStatus;
    }
    const mainUpdate = await dcNotifyMain(dir, project, runId, effectiveStatus, params, runtimeEvent);
    return { ok: true, readOnly: false, project, runId, dir, status: effectiveStatus, files, runtime, stall, automaticValidation, councilEndgate, repositoryDeliveryReconcile, automaticRepositoryDelivery, failurePolicy: runtimeEvent, mainUpdate };
  }

  const transition = checkActionTransition(action, status?.phase);
  if (!transition.ok) {
    return { project, runId, dir, ...transition, nextAction: "Inspect status and invoke only the action allowed for the current phase." };
  }

  if (action === "resume_finalization") {
    const resumed = await resumeReviewInfrastructureFinalization(dir, { ...status, project, runId });
    const files = (await readdir(dir).catch(() => [])).sort();
    return { ...resumed, project, runId, dir, files };
  }

  if (action === "stop_implementation") {
    const reason = String(params.stopReason || params.reason || "Stopped by development_cycle stop_implementation.");
    const stopped = await stopLaunchedImplementation(dir, status, reason);
    const files = (await readdir(dir).catch(() => [])).sort();
    const runtime = await cycleRuntimeSummary(dir, stopped.status || status);
    return { ok: stopped.ok, project, runId, dir, stopped, files, runtime };
  }

  if (action === "run_final_validation") {
    await mkdir(dir, { recursive: true });
    return await runExternalFinalValidation(dir, { ...status, project, runId }, params, String(params.reason || "manual"));
  }

  await mkdir(dir, { recursive: true });

  if (action === "answer_intervention") {
    const intervention = status?.implementationIntervention || await readJsonIfExists(String(status?.implementationInterventionPath || join(dir, "implementation_intervention.json")));
    if (!intervention?.id || !String(intervention?.question || "").trim()) {
      return { ok: false, error: "implementation_intervention_missing", project, runId, dir };
    }
    const requestedId = String(params.interventionId || "").trim();
    if (requestedId && requestedId !== String(intervention.id)) {
      return { ok: false, error: "intervention_id_mismatch", project, runId, dir, expected: intervention.id, received: requestedId };
    }
    const response = String(params.interventionResponse || params.feedbackText || params.direction || "").trim();
    if (!response) return { ok: false, error: "intervention_response_required", project, runId, dir, intervention };
    const answeredAt = new Date().toISOString();
    const responsePath = join(dir, "implementation_intervention_response.json");
    await saveJson(responsePath, { schemaVersion: 1, id: intervention.id, runId, project, response, answeredAt, sourceInterventionPath: status?.implementationInterventionPath || null });
    const durableInterventionPath = String(status?.implementationInterventionPath || join(dir, "implementation_intervention.json"));
    await saveJson(durableInterventionPath, { ...intervention, status: "answered", responsePath, answeredAt });
    await cycleStatus(dir, { implementationIntervention: { ...intervention, status: "answered", responsePath, answeredAt }, implementationInterventionResponsePath: responsePath, implementationInterventionAnsweredAt: answeredAt, nextAction: "Resuming implementation with the recorded human decision.", ...countedOnce(status, "interventionAnswerCount") });
    return await projectCycle({
      ...params,
      action: "start_implementation",
      project: rawProject,
      runId,
      projectRoot: String(status?.projectRoot || params.projectRoot || ""),
      projectWikiPath: String(status?.projectWikiPath || params.projectWikiPath || ""),
      planPath: String(status?.plan || params.planPath || ""),
      [resolvedCycleDir]: dir,
      [lifecycleLockHeld]: true,
      [interventionResume]: { id: intervention.id, response, responsePath, answeredAt, sourceAttemptId: intervention.sourceAttemptId || null },
    });
  }

  if (action === "request_plan") {
    // request_plan is always-allowed (it is the cycle restart escape hatch),
    // but it must not hijack a LIVE run: advancing the phase here would
    // orphan the running runner (reconcile only observes implementation_*/
    // corrections_* phases) and stop_implementation is blocked from the
    // planning phases. Require an explicit stop first.
    const livePhase = liveRunPhase(status?.phase);
    if (livePhase) {
      return { ok: false, error: "active_run_present", project, runId, dir, phase: livePhase, hint: "Call stop_implementation first, then request a new plan." };
    }
    const direction = String(params.direction || params.objective || "Create or validate the implementation plan for this development cycle.");
    const projectRoot = String(params.projectRoot || status.projectRoot || "");
    const projectWikiPath = resolveTrustedProjectWikiPath(rawProject, params.projectWikiPath, status.projectWikiPath);
    const existingPlanPath = String(params.planPath || "");
    const planningPack = await writePlanningPack(dir, { project, runId, projectRoot, projectWikiPath, direction, existingPlanPath });
    const text = `# Development plan request for external gate

Project: ${project}
Run: ${runId}
Wiki root: ${wikiRoot}
Project wiki path: ${projectWikiPath}
Project root / code checkout: ${projectRoot || "not supplied"}

## User direction

${direction}

## Existing plan path, if any

${existingPlanPath || "not supplied"}

## Planning pack files

- contextPack: ${planningPack.contextPack}
- operatorConstraints: ${planningPack.operatorConstraints}
- expectedPlanContract: ${planningPack.expectedPlanContract}

Read these files before writing the implementation plan. They contain project context, current git state, constraints, and the required plan contract.

## Your responsibility

You are responsible for the macro implementation plan. Do not implement. Do not ask Implementation to infer the project structure. The plan you return must include exact project paths so main can hand it to Implementation safely.

## Required project paths section

The final implementation plan must contain a section named "Project paths" with at least:

- projectWikiPath: ${projectWikiPath}
- projectRoot: the real code checkout directory; validate it exists before handoff; do not infer it from the project identifier
- planPath: where the approved plan will live, preferably under ${projectWikiPath}/plans/ or the active cycle run
- relevant code paths / affected files and directories
- expected output paths / artifacts
- protected or risky paths that require explicit human confirmation before edits

## Required external gate output

Create or validate the implementation plan only. Do not implement. The plan must be actionable for Implementation and safe for main to hand off. Include objective, project paths, required context/files, ordered implementation tasks, validation checks, stop conditions, expected artifacts, and explicit human-confirmation points for risky changes. A plan without projectRoot/projectWikiPath/relevant code paths is not ready for Implementation handoff.
`;
    const file = join(dir, "plan_request.md");
    await writeFile(file, text);
    // TOCTOU: `status` above was read before any of the writes in this
    // handler; a concurrent start_implementation may have recorded its launch
    // since. Re-read the freshest status and re-apply the live-run guard
    // immediately before the phase transition that would orphan the runner.
    const freshPhase = liveRunPhase((await loadJson(join(dir, "status.json")))?.phase);
    if (freshPhase) {
      return { ok: false, error: "active_run_present", project, runId, dir, phase: freshPhase, hint: "Call stop_implementation first, then request a new plan." };
    }
    const next = await cycleStatus(dir, { phase: "waiting_external_plan", owner: "external_gate_or_human", nextAction: "Send plan_request.md plus planning pack to an external gate or human reviewer, then call record_plan with planText or planPath.", project, runId, projectRoot, projectWikiPath, direction, planRequest: file, planningPack });
    const notice = await sendCycleNotice(params, runId, `Development plan needed: ${project}`, `Development plan request ready for an external gate or human reviewer validation: ${file}`);
    // A failing notice must not be silently dropped: persist the error into
    // status so later status reads show the gate was never notified.
    if (!notice.ok) await cycleStatus(dir, { externalGateNotice: { ...notice, sentAt: new Date().toISOString() } });
    return { ok: true, project, runId, dir, phase: next.phase, planRequest: file, notice };
  }

  if (action === "record_plan") {
    let planText = params.planText || "";
    if (!String(planText).trim() && params.planPath) {
      const pinnedProjectRootEarly = await pinTrustedProjectRoot(String(params.projectRoot || status.projectRoot || ""));
      const pinnedProjectWikiEarly = await pinContainedWikiDir(project, String(params.projectWikiPath || "") || String(status.projectWikiPath || ""));
      try {
        const loaded = await readAllowedTextFile(String(params.planPath), [pinnedProjectWikiEarly, dir, cycleRoot, projectsWikiRoot, wikiRoot, pinnedProjectRootEarly], "plan_path_outside_allowed_roots");
        if (!loaded.ok) return { ok: false, error: loaded.error, project, runId, dir, path: (loaded as any).path };
        planText = loaded.text;
      } finally {
        await pinnedProjectWikiEarly?.handle.close().catch(() => null);
        await pinnedProjectRootEarly?.handle.close().catch(() => null);
      }
    }
    if (!String(planText).trim()) return { ok: false, error: "planText_or_planPath_required", project, runId, dir };
    if (!params.force && looksLikePlanRequest(String(planText))) {
      return { ok: false, error: "plan_request_not_implementation_plan", project, runId, dir, nextAction: "Ask an external gate or human reviewer to write the actual implementation plan, then call record_plan with that plan. Use force only after explicit human confirmation." };
    }
    const projectRoot = String(params.projectRoot || status.projectRoot || "");
    const projectWikiPath = resolveTrustedProjectWikiPath(rawProject, params.projectWikiPath, status.projectWikiPath);
    const planAnalysis = analyzeImplementationPlan(String(planText), { projectRoot, projectWikiPath });
    if (!params.force && !planAnalysis.complete) {
      return {
        ok: false,
        error: "plan_incomplete",
        project,
        runId,
        dir,
        missing: planAnalysis.missing,
        evidence: planAnalysis.evidence,
        nextAction: "Add the missing semantic content to the approved plan. Development Cycle can normalize alternate headings automatically, but it will not invent tasks, validation, stop conditions, artifacts, or project paths. Use force=true only after explicit human confirmation.",
      };
    }
    const normalized = planAnalysis.complete && !planAnalysis.structurallyConformant;
    const recordedPlanText = normalized
      ? normalizeImplementationPlan(String(planText), { projectRoot, projectWikiPath }, planAnalysis)
      : String(planText);
    const planValidation = {
      normalized,
      forced: params.force === true,
      sourceStructurallyConformant: planAnalysis.structurallyConformant,
      unresolved: planAnalysis.missing,
      evidence: planAnalysis.evidence,
    };
    const file = join(dir, "implementation_plan.md");
    await writeFile(file, recordedPlanText);
    const canonicalPlan = await persistApprovedPlan(project, runId, projectWikiPath, recordedPlanText);
    const canonicalPlanGit = canonicalPlan ? await autoCommitCanonicalPlan(project, runId, canonicalPlan) : { ok: false, skipped: true, reason: "no_canonical_plan" };
    const next = await cycleStatus(dir, { phase: "plan_ready_for_implementation", owner: "main", nextAction: "Call start_implementation to run the configured adapter on the approved plan.", project, runId, projectRoot, projectWikiPath, plan: file, canonicalPlan: canonicalPlan || null, canonicalPlanGit, planValidation });
    return { ok: true, project, runId, dir, phase: next.phase, plan: file, canonicalPlan: canonicalPlan || null, canonicalPlanGit, planValidation };
  }

  if (action === "start_implementation") {
    const resumeDecision = params[interventionResume] || null;
    if (String(status?.phase || "") === "implementation_waiting_human" && !resumeDecision) {
      return { ok: false, error: "intervention_answer_required", project, runId, dir, intervention: status?.implementationIntervention || null, hint: "Call answer_intervention with interventionResponse; do not call start_implementation directly." };
    }
    const requestedProjectRoot = String(params.projectRoot || status.projectRoot || "");
    const projectWikiPath = resolveTrustedProjectWikiPath(rawProject, params.projectWikiPath, status.projectWikiPath);
    const pinnedProjectWiki = await pinContainedWikiDir(project, projectWikiPath);
    const containedProjectWikiPath = pinnedProjectWiki?.realPath || "";
    if (pinnedProjectWiki) {
      const readyFile = String(process.env.DEVELOPMENT_CYCLE_TEST_PINNED_WIKI_HANDOFF_READY_FILE || "").trim();
      if (readyFile) await writeFile(readyFile, "ready\n");
      const delayMs = Number(process.env.DEVELOPMENT_CYCLE_TEST_PINNED_WIKI_HANDOFF_DELAY_MS || 0);
      if (Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs);
    }
    if (!requestedProjectRoot) return { ok: false, error: "projectRoot_required", project, runId, dir, wikiRoot, projectWikiPath: containedProjectWikiPath || projectWikiPath, hint: "projectRoot must be the real code checkout; projectWikiPath is only docs/state." };
    const pinnedProjectRoot = await pinTrustedProjectRoot(requestedProjectRoot);
    const projectRoot = pinnedProjectRoot?.realPath || "";
    if (!projectRoot) return { ok: false, error: "projectRoot_missing_or_not_trusted_git_checkout", project, runId, dir, projectRoot: requestedProjectRoot, wikiRoot, projectWikiPath: containedProjectWikiPath || projectWikiPath, hint: "Pass an existing Git checkout, not a broad/system/docs root." };
    let plan = params.planText || "";
    let containedPlanPath = "";
    const requestedPlanPath = String(params.planPath || status.plan || "").trim();
    if (requestedPlanPath) {
      const loaded = await readAllowedTextFile(requestedPlanPath, [pinnedProjectWiki, dir, cycleRoot, projectsWikiRoot, wikiRoot, pinnedProjectRoot], "plan_path_outside_allowed_roots");
      if (!loaded.ok) {
        await pinnedProjectWiki?.handle.close().catch(() => null);
        await pinnedProjectRoot?.handle.close().catch(() => null);
        return { ok: false, error: loaded.error, project, runId, dir, path: (loaded as any).path };
      }
      containedPlanPath = loaded.path;
      if (!String(plan).trim()) plan = loaded.text;
    }
    if (!containedProjectWikiPath) {
      await pinnedProjectWiki?.handle.close().catch(() => null);
      await pinnedProjectRoot?.handle.close().catch(() => null);
      return { ok: false, error: "project_wiki_path_outside_allowed_root", project, runId, dir, projectWikiPath };
    }
    if (!String(plan).trim()) {
      const fallback = await readAllowedTextFile(join(dir, "implementation_plan.md"), [dir], "plan_path_outside_allowed_roots");
      if (fallback.ok) {
        containedPlanPath = fallback.path;
        plan = fallback.text;
      }
    }
    if (!String(plan).trim()) {
      await pinnedProjectWiki?.handle.close().catch(() => null);
      await pinnedProjectRoot?.handle.close().catch(() => null);
      return { ok: false, error: "missing_implementation_plan", project, runId, dir, expected: join(dir, "implementation_plan.md") };
    }
    await pinnedProjectWiki?.handle.close().catch(() => null);
    await pinnedProjectRoot?.handle.close().catch(() => null);
    const adapter = String(params.implementationAdapter || status.implementationAdapter || implementationConfig.adapter);
    const command = String(params.implementationCommand || (adapter === "octopus" ? "tangle" : "implement"));
    if (adapter === "octopus" && command !== "tangle") return { ok: false, error: "unsupported_octopus_command", supported: ["tangle"] };
    const resumeBlock = resumeDecision
      ? `\n\nHUMAN_INTERVENTION_RESOLUTION:\nIntervention: ${String(resumeDecision.id || "")}\nDecision: ${String(resumeDecision.response || "")}\n\nResume the same approved plan from the preserved repository state. Treat this human decision as authoritative for the blocked point only; do not broaden scope beyond what is necessary to continue.`
      : "";
    const prompt = `Run the approved development plan. Stay within the agreed scope. Stop and report before risky, destructive, protected, or out-of-scope changes that need a NEW human decision.\n\nHOST_AUTHORIZATION_CONTEXT:\nThe host explicitly authorized implementation for this run by invoking development_cycle start_implementation. Treat generic plan wording such as "draft for human approval", "after human approval", or "do not start until approved" as already satisfied for the approved scope. Do not request a second generic authorization merely to begin or continue the approved implementation.\n\nIf a NEW human decision is required after launch, do not leave the request only as prose in review/output. Use the supervised human-intervention protocol so the runner emits intervention.json and the control plane can enter implementation_waiting_human, notify the operator, and resume through answer_intervention.\n\nPROJECT_DOCUMENTATION_PATH:\n${containedProjectWikiPath}\n\nPROJECT_ROOT_CODE_CHECKOUT:\n${projectRoot}\n\nIMPLEMENTATION_ADAPTER:\n${adapter}\n\nAPPROVED_PLAN:\n${plan}${resumeBlock}`;
    const handoffRequest = join(dir, "implementation_request.md");
    const stdoutPath = join(dir, "implementation_delivery_stdout.txt");
    const stderrPath = join(dir, "implementation_delivery_stderr.txt");
    await writeFile(handoffRequest, prompt);
    const implementationAttemptBase = await clearActiveImplementationAttempt(dir);
    const observerObservationId = await createImplementationObserverSession(dir, { project, runId, command, projectRoot, projectWikiPath: containedProjectWikiPath, stdoutPath, stderrPath, status: "running", summary: `development_cycle ${command} ${project}`, message: "Development-cycle implementation run queued." });
    if (developmentCycleConfig.observer.enabled && !observerObservationId) {
      const next = await cycleStatus(dir, { phase: "implementation_failed", owner: "main", ok: false, error: "observer_root_session_creation_failed", projectRoot, projectWikiPath: containedProjectWikiPath, implementationCommand: command, implementationHandoffRequest: handoffRequest });
      return { ok: false, project, runId, dir, phase: next.phase, error: next.error };
    }
    const launch = await createImplementationRunnerSession(dir, { project, runId, projectRoot, projectWikiPath: containedProjectWikiPath, readScopeMode: params.readScopeMode, command, prompt, kind: "delivery", implementationAdapter: adapter, planPath: containedPlanPath, timeoutSeconds: Number(params.timeoutSeconds ?? params.timeout_ms ?? 0), observerObservationId, purpose: `development_cycle ${command} ${project}` });
    if (!launch.ok) {
      const observerFinalization = await finalizeObserverSessions(dir, { ...implementationAttemptBase, observerObservationId }, "failed");
      const failedAttempt = launch.statusPath ? { implementationSessionId: launch.sessionId, implementationAttemptId: launch.attemptId, directImplementationStatus: launch.statusPath, directImplementationStdout: launch.stdoutPath, directImplementationStderr: launch.stderrPath, implementationStdout: launch.stdoutPath, implementationStderr: launch.stderrPath } : {};
      const next = await cycleStatus(dir, { phase: "implementation_failed", owner: "main", ok: false, nextAction: "Fix direct runner launch blocker, then launch a new clean handoff.", error: launch.error || "direct_runner_launch_failed", projectRoot, projectWikiPath: containedProjectWikiPath, implementationCommand: command, codexSandbox: defaultCodexSandbox, observerObservationId, observerFinalization, implementationHandoffRequest: handoffRequest, ...failedAttempt });
      return { ok: false, project, runId, dir, phase: next.phase, error: next.error, observerObservationId, observerFinalization, ...(launch.statusPath ? { implementationSessionId: launch.sessionId, implementationAttemptId: launch.attemptId, directImplementationStatus: launch.statusPath } : {}) };
    }
    await updateImplementationObserverSession(dir, observerObservationId, { project, runId, command, projectRoot, projectWikiPath: containedProjectWikiPath, stdoutPath: launch.stdoutPath, stderrPath: launch.stderrPath, attemptId: launch.attemptId, pid: launch.status?.runnerPid, processGroup: launch.status?.processGroupId, status: "running", summary: `development_cycle ${command} ${project} running`, message: "Implementation runner launched and bound to the observer root process." });
    const launchRecord = join(dir, "implementation_launch.json");
    await writeFile(launchRecord, JSON.stringify(launch, null, 2) + "\n");
    const next = await cycleStatus(dir, { ...firstLaunch(status), phase: "implementation_launched", owner: "implementation", nextAction: "Use development_cycle status to watch the supervised implementation runner.", projectRoot, projectWikiPath: containedProjectWikiPath, implementationAdapter: launch.adapter, implementationCommand: command, codexSandbox: defaultCodexSandbox, implementationSessionId: launch.sessionId, implementationAttemptId: launch.attemptId, directImplementationStatus: launch.statusPath, directImplementationStdout: launch.stdoutPath, directImplementationStderr: launch.stderrPath, directCorrectionsStatus: null, directCorrectionsStdout: null, directCorrectionsStderr: null, correctionsStdout: null, correctionsStderr: null, observerCorrectionsObservationId: null, implementationCorrectionsSessionId: null, observerObservationId, implementationHandoffRequest: handoffRequest, implementationLaunch: launchRecord, implementationStdout: launch.stdoutPath, implementationStderr: launch.stderrPath, ...(resumeDecision ? { implementationInterventionResolved: { id: resumeDecision.id, response: resumeDecision.response, responsePath: resumeDecision.responsePath, answeredAt: resumeDecision.answeredAt, resumedAttemptId: launch.attemptId }, implementationInterventionResumedAt: new Date().toISOString() } : {}) });
    return { ok: true, project, runId, dir, phase: next.phase, implementationAdapter: launch.adapter, implementationSessionId: launch.sessionId, implementationAttemptId: launch.attemptId, observerObservationId, launchState: launch.status?.launchState || null, directImplementationStatus: launch.statusPath };

  }

  if (action === "record_delivery") {
    let deliveryText = params.deliveryText || "";
    if (!String(deliveryText).trim() && params.deliveryPath) {
      const wikiRootA = await pinContainedWikiDir(project, String(status?.projectWikiPath || ""));
      const wikiRootB = await pinContainedWikiDir(project, String(params.projectWikiPath || ""));
      const projectRootA = await pinTrustedProjectRoot(String(status?.projectRoot || ""));
      const projectRootB = await pinTrustedProjectRoot(String(params.projectRoot || ""));
      const loaded = await readAllowedTextFile(String(params.deliveryPath), [wikiRootA, wikiRootB, dir, cycleRoot, projectsWikiRoot, wikiRoot, projectRootA, projectRootB], "delivery_path_outside_allowed_roots");
      if (!loaded.ok) {
        await wikiRootA?.handle.close().catch(() => null);
        await wikiRootB?.handle.close().catch(() => null);
        await projectRootA?.handle.close().catch(() => null);
        await projectRootB?.handle.close().catch(() => null);
        return { ok: false, error: loaded.error, project, runId, dir, path: (loaded as any).path };
      }
      deliveryText = loaded.text;
      await wikiRootA?.handle.close().catch(() => null);
      await wikiRootB?.handle.close().catch(() => null);
      await projectRootA?.handle.close().catch(() => null);
      await projectRootB?.handle.close().catch(() => null);
    }
    if (!String(deliveryText).trim()) return { ok: false, error: "deliveryText_or_deliveryPath_required", project, runId, dir };
    const file = join(dir, "implementation_delivery.md");
    await writeFile(file, String(deliveryText));
    const next = await cycleStatus(dir, { phase: "implementation_delivered", owner: "main", nextAction: "Call request_final_validation.", implementationDelivery: file });
    return { ok: true, project, runId, dir, phase: next.phase, implementationDelivery: file };
  }

  if (action === "request_final_validation") {
    const validationError = await requiredValidationError(status);
    if (validationError) return { ok: false, error: validationError, project, runId, dir };
    const validationPack = await writeFinalValidationPack(dir, project, runId, status);
    const names = ["implementation_plan.md", "delivery_summary.md", "test_evidence.md", "risk_checklist.md", "observer_sessions.json", "artifact_manifest.json", "implementation_delivery_error.txt"];
    const parts: string[] = [];
    for (const name of names) {
      const text = await readTextIfExists(join(dir, name));
      if (text.trim()) parts.push(`## ${name}\n\n${excerpt(text, name.endsWith(".json") ? 8000 : 12000)}`);
    }
    const file = join(dir, "final_validation_request.md");
    await writeFile(file, `# Final validation request for external gate\n\nProject: ${project}\nRun: ${runId}\n\nReview the approved plan, delivery summary, test evidence, Observer sessions and risk checklist. Return exactly one decision as the first token: go | revise | stop.\n\nGO only if the plan was fulfilled, evidence is adequate, no protected/risky paths were changed without explicit authorization, worktree state is understood, and required docs/runbooks/state were updated. If revise, include direct delta-only correction instructions for Implementation. If stop, explain the blocker for the operator.\n\nValidation pack files:\n- deliverySummary: ${validationPack.deliverySummary}\n- artifactManifest: ${validationPack.artifactManifest}\n- observerSessions: ${validationPack.observerSessions}\n- testEvidence: ${validationPack.testEvidence}\n- riskChecklist: ${validationPack.riskChecklist}\n\n${parts.join("\n\n---\n\n")}\n`);
    const next = await cycleStatus(dir, { phase: "waiting_final_validation", owner: "external_gate_or_human", nextAction: "Send final_validation_request.md plus validation pack to an external gate or human reviewer, then call record_final_validation.", finalValidationRequest: file, validationPack });
    const notice = await sendCycleNotice(params, runId, `Final validation needed: ${project}`, `Final validation request ready for an external gate or human reviewer: ${file}`);
    // A failing notice must not be silently dropped: persist the error into
    // status so later status reads show the gate was never notified.
    if (!notice.ok) await cycleStatus(dir, { externalGateNotice: { ...notice, sentAt: new Date().toISOString() } });
    return { ok: true, project, runId, dir, phase: next.phase, finalValidationRequest: file, validationPack, notice };
  }

  if (action === "record_final_validation") {
    let validationText = params.validationText || params.feedbackText || "";
    if (!String(validationText).trim() && (params.validationPath || params.feedbackPath)) {
      const pathValue = String(params.validationPath || params.feedbackPath);
      const wikiRootA = await pinContainedWikiDir(project, String(status?.projectWikiPath || ""));
      const wikiRootB = await pinContainedWikiDir(project, String(params.projectWikiPath || ""));
      const projectRootA = await pinTrustedProjectRoot(String(status?.projectRoot || ""));
      const projectRootB = await pinTrustedProjectRoot(String(params.projectRoot || ""));
      const loaded = await readAllowedTextFile(pathValue, [wikiRootA, wikiRootB, dir, cycleRoot, projectsWikiRoot, wikiRoot, projectRootA, projectRootB], "validation_path_outside_allowed_roots");
      if (!loaded.ok) {
        await wikiRootA?.handle.close().catch(() => null);
        await wikiRootB?.handle.close().catch(() => null);
        await projectRootA?.handle.close().catch(() => null);
        await projectRootB?.handle.close().catch(() => null);
        return { ok: false, error: loaded.error, project, runId, dir, path: (loaded as any).path };
      }
      validationText = loaded.text;
      await wikiRootA?.handle.close().catch(() => null);
      await wikiRootB?.handle.close().catch(() => null);
      await projectRootA?.handle.close().catch(() => null);
      await projectRootB?.handle.close().catch(() => null);
    }
    if (!String(validationText).trim()) return { ok: false, error: "validationText_or_validationPath_required", project, runId, dir };
    const parsedDecision = parseFinalDecision(validationText);
    if (!parsedDecision.ok) return { project, runId, dir, ...parsedDecision };
    if (parsedDecision.decision === "go") {
      const validationError = await requiredValidationError(status);
      if (validationError) return { ok: false, error: validationError, project, runId, dir };
    }
    const file = join(dir, "final_validation_response.md");
    await writeFile(file, String(validationText));
    const phase = parsedDecision.decision === "go" ? "final_validated" : parsedDecision.decision === "stop" ? "stopped" : "final_revised";
    const nextAction = repositoryDeliveryConfig.enabled
      ? "Repository delivery will materialize this terminal run outcome."
      : "Call finalize_delivery to materialize this terminal run outcome.";
    const next = await cycleStatus(dir, { phase, owner: "main", nextAction, finalValidation: file });
    if (repositoryDeliveryConfig.enabled) {
      const finalized = await finalizeRepositoryDeliveryState(dir, { ...next, project, runId }, params);
      return { ok: finalized.ok, project, runId, dir, phase: finalized.phase, finalValidation: file, delivery: finalized.delivery };
    }
    return { ok: true, project, runId, dir, phase: next.phase, finalValidation: file };
  }

  if (action === "start_corrections") {
    const projectRoot = String(params.projectRoot || status.projectRoot || "");
    if (!projectRoot) return { ok: false, error: "projectRoot_required", project, runId, dir };
    const plan = await readTextIfExists(join(dir, "implementation_plan.md"));
    let validation = params.feedbackText || params.validationText || "";
    if (!String(validation).trim() && params.feedbackPath) {
      const wikiRootA = await pinContainedWikiDir(project, String(status?.projectWikiPath || ""));
      const wikiRootB = await pinContainedWikiDir(project, String(params.projectWikiPath || ""));
      const pinnedFeedbackProjectRoot = await pinTrustedProjectRoot(String(projectRoot || ""));
      const loaded = await readAllowedTextFile(String(params.feedbackPath), [wikiRootA, wikiRootB, dir, cycleRoot, projectsWikiRoot, wikiRoot, pinnedFeedbackProjectRoot], "feedback_path_outside_allowed_roots");
      if (!loaded.ok) {
        await wikiRootA?.handle.close().catch(() => null);
        await wikiRootB?.handle.close().catch(() => null);
        await pinnedFeedbackProjectRoot?.handle.close().catch(() => null);
        return { ok: false, error: loaded.error, project, runId, dir, path: (loaded as any).path };
      }
      validation = loaded.text;
      await wikiRootA?.handle.close().catch(() => null);
      await wikiRootB?.handle.close().catch(() => null);
      await pinnedFeedbackProjectRoot?.handle.close().catch(() => null);
    }
    if (!String(validation).trim()) validation = await readTextIfExists(join(dir, "final_validation_response.md"));
    if (!String(validation).trim()) return { ok: false, error: "missing_final_validation_feedback", project, runId, dir };
    const adapter = String(params.implementationAdapter || status.implementationAdapter || implementationConfig.adapter);
    const command = String(params.implementationCommand || (adapter === "octopus" ? "tangle" : "correct"));
    if (adapter === "octopus" && command !== "tangle") return { ok: false, error: "unsupported_octopus_command", supported: ["tangle"] };
    const prompt = `Apply only the direct correction feedback from final validation. Do not restart the whole cycle. Preserve already-correct work and stop before risky or protected changes needing human approval.\n\nPROJECT_ROOT_CODE_CHECKOUT:\n${projectRoot}\n\nIMPLEMENTATION_ADAPTER:\n${adapter}\n\nAPPROVED_PLAN:\n${plan}\n\nFINAL_VALIDATION_FEEDBACK:\n${validation}`;
    const requestPath = join(dir, "corrections_request.md");
    await writeFile(requestPath, prompt);
    const stdoutPath = join(dir, "implementation_corrections_stdout.txt");
    const stderrPath = join(dir, "implementation_corrections_stderr.txt");
    const correctionsAttemptBase = await clearActiveCorrectionsAttempt(dir);
    const observerObservationId = await createImplementationObserverSession(dir, { project, runId, command: "corrections", projectRoot, projectWikiPath: correctionsAttemptBase.projectWikiPath || status.projectWikiPath || "", stdoutPath, stderrPath, status: "running", summary: `development_cycle corrections ${project}`, message: "Development-cycle corrections run queued." });
    if (developmentCycleConfig.observer.enabled && !observerObservationId) {
      const next = await cycleStatus(dir, { phase: "corrections_failed", owner: "main", ok: false, error: "observer_root_session_creation_failed", projectRoot, implementationCorrectionsRequest: requestPath });
      return { ok: false, project, runId, dir, phase: next.phase, error: next.error };
    }
    const launch = await createImplementationRunnerSession(dir, { project, runId: `${runId}-corrections`, projectRoot, projectWikiPath: resolveTrustedProjectWikiPath(params.project || project, params.projectWikiPath, status.projectWikiPath), readScopeMode: params.readScopeMode, command, prompt, kind: "corrections", implementationAdapter: adapter, planPath: String(status.plan || join(dir, "implementation_plan.md")), validationPath: String(status.finalValidation || join(dir, "final_validation_response.md")), timeoutSeconds: Number(params.timeoutSeconds ?? params.timeout_ms ?? 0), observerObservationId, purpose: `development_cycle corrections ${project}` });
    if (!launch.ok) {
      const observerFinalization = await finalizeObserverSessions(dir, { ...correctionsAttemptBase, observerCorrectionsObservationId: observerObservationId }, "failed");
      const failedAttempt = launch.statusPath ? { implementationCorrectionsSessionId: launch.sessionId, correctionsAttemptId: launch.attemptId, directCorrectionsStatus: launch.statusPath, directCorrectionsStdout: launch.stdoutPath, directCorrectionsStderr: launch.stderrPath, correctionsStdout: launch.stdoutPath, correctionsStderr: launch.stderrPath } : {};
      const next = await cycleStatus(dir, { phase: "corrections_failed", owner: "main", ok: false, error: launch.error || "direct_runner_launch_failed", projectRoot, codexSandbox: defaultCodexSandbox, observerCorrectionsObservationId: observerObservationId, observerFinalization, implementationCorrectionsRequest: requestPath, ...failedAttempt });
      return { ok: false, project, runId, dir, phase: next.phase, error: next.error, observerObservationId, observerFinalization, ...(launch.statusPath ? { implementationCorrectionsSessionId: launch.sessionId, correctionsAttemptId: launch.attemptId, directCorrectionsStatus: launch.statusPath } : {}) };
    }
    await updateImplementationObserverSession(dir, observerObservationId, { project, runId, command: "corrections", projectRoot, projectWikiPath: status.projectWikiPath || "", stdoutPath: launch.stdoutPath, stderrPath: launch.stderrPath, attemptId: launch.attemptId, status: "running", summary: `development_cycle corrections ${project} running`, message: "Corrections runner launched; observer integration is optional." });
    const launchRecord = join(dir, "implementation_corrections_launch.json");
    await writeFile(launchRecord, JSON.stringify(launch, null, 2) + "\n");
    const next = await cycleStatus(dir, { ...countedOnce(status, "correctionRoundCount"), phase: "corrections_launched", owner: "implementation", nextAction: "Use development_cycle status to watch the supervised corrections runner.", projectRoot, implementationAdapter: launch.adapter, implementationCorrectionsSessionId: launch.sessionId, correctionsAttemptId: launch.attemptId, directCorrectionsStatus: launch.statusPath, directCorrectionsStdout: launch.stdoutPath, directCorrectionsStderr: launch.stderrPath, observerCorrectionsObservationId: observerObservationId, implementationCorrectionsRequest: requestPath, implementationCorrectionsLaunch: launchRecord, correctionsStdout: launch.stdoutPath, correctionsStderr: launch.stderrPath });
    return { ok: true, project, runId, dir, phase: next.phase, implementationAdapter: launch.adapter, implementationCorrectionsSessionId: launch.sessionId, correctionsAttemptId: launch.attemptId, observerObservationId, launchState: launch.status?.launchState || null, directCorrectionsStatus: launch.statusPath };

  }

  if (action === "finalize_delivery") {
    const finalized = await finalizeRepositoryDeliveryState(dir, { ...status, project, runId }, params);
    return { ok: finalized.ok, project, runId, dir, phase: finalized.phase, delivery: finalized.delivery };
  }

  if (action === "close") {
    const next = await cycleStatus(dir, { phase: "closed", owner: "main", nextAction: "none", closedAt: new Date().toISOString() });
    return { ok: true, project, runId, dir, phase: next.phase };
  }
  return { ok: false, error: "action_not_implemented", action };
}



const cycleParameters = Type.Object({
  action: lit(...ACTIONS),
  project: Type.String(),
  runId: Type.Optional(Type.String()),
  projectRoot: Type.Optional(Type.String({ description: "Real code checkout directory for Implementation. Must exist; do not infer it from the project wiki id." })),
  projectWikiPath: Type.Optional(Type.String({ description: "Project documentation folder. Defaults under DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT and is separate from the source checkout." })),
  direction: Type.Optional(Type.String()),
  objective: Type.Optional(Type.String()),
  planText: Type.Optional(Type.String()),
  planPath: Type.Optional(Type.String()),
  feedbackText: Type.Optional(Type.String()),
  feedbackPath: Type.Optional(Type.String()),
  deliveryText: Type.Optional(Type.String()),
  deliveryPath: Type.Optional(Type.String()),
  validationText: Type.Optional(Type.String()),
  validationPath: Type.Optional(Type.String()),
  outputPath: Type.Optional(Type.String()),
  implementationAdapter: Type.Optional(lit("command", "octopus")),
  readScopeMode: Type.Optional(lit("strict", "contextual")),
  implementationCommand: Type.Optional(Type.String()),
  force: Type.Optional(Type.Boolean()),
  timeoutSeconds: Type.Optional(Type.Number()),
  timeout_ms: Type.Optional(Type.Number()),
  stopReason: Type.Optional(Type.String()),
  interventionId: Type.Optional(Type.String({ description: "Pending implementation intervention id, when answering a human gate." })),
  interventionResponse: Type.Optional(Type.String({ description: "Human decision for a pending implementation intervention. answer_intervention resumes the same run automatically." })),
  reason: Type.Optional(Type.String()),
  validationConfigPath: Type.Optional(Type.String()),
  autoStopStalled: Type.Optional(Type.Boolean()),
  autoRunFinalValidation: Type.Optional(Type.Boolean()),
  autoRunCouncilReview: Type.Optional(Type.Boolean()),
  autoCouncilCorrections: Type.Optional(Type.Boolean()),
  autoCouncilCorrectionsMax: Type.Optional(Type.Number()),
  councilDepth: Type.Optional(Type.String()),
  councilMembers: Type.Optional(Type.Number()),
  councilMaxCost: Type.Optional(Type.String()),
  councilAutoProviders: Type.Optional(Type.String()),
  councilProviders: Type.Optional(Type.String()),
  councilCodexModel: Type.Optional(Type.String()),
  councilTimeoutMs: Type.Optional(Type.Number()),
  notify: Type.Optional(Type.Boolean({ description: "Send a lifecycle notification through an OpenClaw-supported channel." })),
  notificationChannel: Type.Optional(Type.String({ description: "OpenClaw channel name, for example slack, telegram, whatsapp, signal, discord or matrix." })),
  notificationTarget: Type.Optional(Type.String({ description: "Channel-specific recipient or destination." })),
  notificationAccount: Type.Optional(Type.String({ description: "Optional OpenClaw channel account id." })),
  notificationDeliveryJson: Type.Optional(Type.String({ description: "Optional JSON string parsed into the Gateway message tool's delivery argument." })),
  notificationDryRun: Type.Optional(Type.Boolean()),
  notifyExternalGate: Type.Optional(Type.Boolean()),
  notifyMain: Type.Optional(Type.Boolean()),
  emitMainUpdates: Type.Optional(Type.Boolean()),
  dryRunMainUpdate: Type.Optional(Type.Boolean()),
  mainUpdateTimeoutMs: Type.Optional(Type.Number()),
  mainUpdateExecTimeoutMs: Type.Optional(Type.Number()),
  stallQuietSeconds: Type.Optional(Type.Number()),
  deliveryClassification: Type.Optional(lit("success", "partial", "invalid")),
  repositoryBaseBranch: Type.Optional(Type.String()),
  repositoryDeliveryTimeoutMs: Type.Optional(Type.Number()),
});

export default defineToolPlugin({
  id: "development-cycle",
  name: "Development Cycle",
  description: "Adapter-agnostic supervised development cycles for OpenClaw with durable state, process supervision, validation gates, and correction loops.",
  tools: (tool) => [
    tool({
      name: "development_cycle",
      label: "Development Cycle",
      description: "Supervised development-cycle control plane. It records plans, launches a configured implementation adapter, persists evidence, coordinates validation and corrections, and closes the cycle. Project documentation and the source checkout are separate paths. Observers, channel notifications, and external gates are optional.",
      parameters: cycleParameters,
      execute: async (params) => {
        cycleMessageDeliveryQueue.beginExecution();
        try {
          return await projectCycle(params);
        } catch (error: any) {
          if (String(error?.message || "").startsWith("state_unreadable:")) return { ok: false, error: "state_unreadable", detail: error.message, nextAction: "Preserve the damaged state and inspect status.previous.json before explicitly restoring it." };
          throw error;
        } finally {
          cycleMessageDeliveryQueue.endExecution();
        }
      },
    }),
  ],
});
