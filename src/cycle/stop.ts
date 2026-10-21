import { writeFile } from "node:fs/promises";
import { cleanId } from "../core/ids.js";
import { nextStallQuietAccounting } from "../core/stall-accounting.js";
import { readProcessIdentity, stopVerifiedProcessGroup } from "../runtime/processes.js";
import { readJsonIfExists, fileInfo } from "./files.js";
import type { createCycleStore } from "./cycle-store.js";
import type { createObserver } from "./observer.js";
import type { createRuntimeObservation } from "./runtime-observation.js";
import type { createFinalValidation } from "./final-validation.js";

export interface StopDeps {
  runnerHeartbeatIntervalSeconds: number;
  saveJson: ReturnType<typeof createCycleStore>["saveJson"];
  cycleStatus: ReturnType<typeof createCycleStore>["cycleStatus"];
  collectObserverSessions: ReturnType<typeof createObserver>["collectObserverSessions"];
  finalizeObserverSessions: ReturnType<typeof createObserver>["finalizeObserverSessions"];
  runtimeProcessSnapshot: ReturnType<typeof createRuntimeObservation>["runtimeProcessSnapshot"];
  loadProjectValidationConfig: ReturnType<typeof createFinalValidation>["loadProjectValidationConfig"];
  runExternalFinalValidation: ReturnType<typeof createFinalValidation>["runExternalFinalValidation"];
}

export function createStop(deps: StopDeps) {
  const { runnerHeartbeatIntervalSeconds, saveJson, cycleStatus, collectObserverSessions, finalizeObserverSessions, runtimeProcessSnapshot, loadProjectValidationConfig, runExternalFinalValidation } = deps;

  function numericPid(value: any) {
    const pid = Number(value);
    return Number.isFinite(pid) && pid > 1 ? Math.trunc(pid) : 0;
  }

  function signalPid(target: number, signal: NodeJS.Signals) {
    try {
      process.kill(target, signal);
      return { ok: true, target, signal };
    } catch (err: any) {
      return { ok: false, target, signal, error: String(err?.code || err?.message || err) };
    }
  }

  async function stopDirectImplementationRunnerSession(statusPath: string, reason: string) {
    const session = await readJsonIfExists(statusPath);
    if (!session) return { ok: false, skipped: true, reason: "session_status_missing", statusPath };
    const runnerPid = numericPid(session.runnerPid || session.pid);
    const processGroupId = numericPid(session.processGroupId || session.runnerPid || session.pid);
    if (!processGroupId && !runnerPid) return { ok: false, skipped: true, reason: "runner_pid_missing", statusPath, session };

    const signals: any[] = [];
    const exited = ["completed", "failed", "stopped"].includes(String(session.status)) && session.launchState === "exited";
    if (exited && !session.runnerIdentity) return { ok: true, skipped: true, reason: "runner_already_exited", statusPath };
    const verified = await stopVerifiedProcessGroup(session.runnerIdentity, readProcessIdentity, (target, signal) => {
      const result = signalPid(target, signal);
      signals.push(result);
      if (!result.ok && result.error !== "ESRCH") throw new Error(result.error);
      return true;
    });
    if (exited && !verified.ok) return { ok: true, skipped: true, reason: "runner_already_exited", statusPath };
    if (!verified.ok || verified.skipped) return { ...verified, statusPath };
    // The runner already finished; only its leftover subtasks were stopped, so its own outcome stands.
    if (exited) return { ok: true, skipped: true, reason: "runner_already_exited", sessionDrained: true, statusPath, signals };

    const stoppedAt = new Date().toISOString();
    if (session.exitCodePath) await writeFile(String(session.exitCodePath), "143\n").catch(() => null);
    if (session.exitedAtPath) await writeFile(String(session.exitedAtPath), `${stoppedAt}\n`).catch(() => null);
    const next = {
      ...session,
      status: "stopped",
      launchState: "stopped",
      ok: false,
      exitCode: 143,
      stoppedAt,
      stoppedReason: reason,
      processGroupStopped: Boolean(processGroupId),
      processGroupId: processGroupId || null,
      runnerPid: runnerPid || session.runnerPid || null,
      stopSignals: signals,
      updatedAt: stoppedAt,
      message: "Implementation direct runner stopped by development_cycle terminating its whole session.",
    };
    await saveJson(statusPath, next);
    return { ok: true, statusPath, runnerPid, processGroupId, stoppedAt, signals };
  }

  async function stopLaunchedImplementation(dir: string, status: any, reason: string) {
    const targets = [status?.directImplementationStatus, status?.directCorrectionsStatus].filter(Boolean).map(String);
    if (!targets.length) return { ok: false, stopped: [], reason: "no_direct_implementation_status_paths" };
    const stopped = [];
    for (const target of targets) stopped.push(await stopDirectImplementationRunnerSession(target, reason));
    if (stopped.some((result) => !result.ok)) return { ok: false, stopped, status };
    const stoppedAt = new Date().toISOString();
    const observerFinalization = await finalizeObserverSessions(dir, status, "stopped");
    const next = await cycleStatus(dir, {
      phase: "stopped",
      owner: "main",
      status: "stopped",
      launchState: "stopped",
      ok: false,
      exitCode: 143,
      stoppedAt,
      stoppedReason: reason,
      processGroupStopResults: stopped,
      observerFinalization,
      nextAction: "Inspect logs and dirty worktree before deciding whether to clean/relaunch.",
      error: reason,
    });
    return { ok: true, stopped, status: next };
  }

  async function latestRunActivityMtime(status: any) {
    const paths = [status?.implementationStdout, status?.implementationStderr, status?.correctionsStdout, status?.correctionsStderr, status?.directImplementationStdout, status?.directImplementationStderr].filter(Boolean).map(String);
    const infos = [] as any[];
    for (const p of paths) { const info = await fileInfo(p); if (info) infos.push(info); }
    const latest = infos.reduce((max, x) => Math.max(max, Number(x.mtimeMs || 0)), 0);
    return { latest, files: infos };
  }

  async function maybeHandleStalledRun(dir: string, status: any, params: any = {}) {
    const phase = String(status?.phase || "");
    if (!(phase.includes("launched") || phase.includes("running"))) return null;
    const project = cleanId(params.project || status?.project || "default");
    const loaded = await loadProjectValidationConfig(project, status, params);
    const stall = loaded.config.stall || {};
    if (stall.enabled === false || stall.autoStop === false || params.autoStopStalled === false) return null;
    const quietSeconds = Number(params.stallQuietSeconds || stall.quietSeconds || 900);
    if (!Number.isFinite(quietSeconds) || quietSeconds <= 0) return null;
    const sessions = await collectObserverSessions(status || {});
    const processSnapshot = await runtimeProcessSnapshot(status || {}, sessions);
    const activeRoots = (processSnapshot.roots || []).filter((p: any) => !String(p.stat || "").includes("Z"));
    const activeProviders = [...(processSnapshot.descendants || []), ...activeRoots].filter((p: any) => /^(codex|claude|gemini|agy|node-MainThread|node)$/.test(String(p.comm || "")) && !String(p.stat || "").includes("Z"));
    if (!activeRoots.length || !activeProviders.length) return null;
    const activity = await latestRunActivityMtime(status);
    if (!activity.latest) return null;
    const nowMs = Date.now();
    const heartbeatIntervalSeconds = Number(
      params.heartbeatIntervalSeconds || status?.heartbeatIntervalSeconds || runnerHeartbeatIntervalSeconds,
    );
    const next = nextStallQuietAccounting({
      nowMs,
      activityLatestMs: activity.latest,
      stallQuietAccumMs: Number(status?.stallQuietAccumMs || 0),
      stallLastCheckAt: Number(status?.stallLastCheckAt || 0),
      stallLastActivityMtime: Number(status?.stallLastActivityMtime || 0),
      quietThresholdMs: quietSeconds * 1000,
      heartbeatIntervalMs: heartbeatIntervalSeconds * 1000,
    });
    await cycleStatus(dir, {
      stallQuietAccumMs: next.stallQuietAccumMs,
      stallLastCheckAt: next.stallLastCheckAt,
      stallLastActivityMtime: next.stallLastActivityMtime,
    });
    if (!next.shouldStop) return null;
    const quietMs = next.stallQuietAccumMs;
    const reason = `development_cycle stall detector: provider alive but runner artifacts quiet for ${Math.round(quietMs / 1000)}s (threshold ${quietSeconds}s).`;
    const stopped = await stopLaunchedImplementation(dir, status, reason);
    const validation = await runExternalFinalValidation(dir, stopped.status || status, { ...params, project }, "stalled_provider");
    return { stalled: true, reason, quietSeconds, quietMs, activeProviders, activeRoots, activityFiles: activity.files, stopped, validation, status: validation.status || stopped.status };
  }

  return { stopLaunchedImplementation, maybeHandleStalledRun };
}
