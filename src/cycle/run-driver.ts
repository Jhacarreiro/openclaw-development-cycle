import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

// Phases where the run is finished, or waits on a person or an external plan, so reconcile has nothing to drive.
const RESTING_PHASES = new Set([
  "",
  "waiting_external_plan",
  "plan_ready_for_implementation",
  "implementation_waiting_human",
  "waiting_final_validation",
  "merged",
  "closed",
  "closed_success",
  "closed_invalid",
]);

export function runNeedsDriving(status: any, maxIdleMs: number, now: number) {
  const phase = String(status?.phase || "");
  // A follow-up linked before a restart rests in these phases until reconcile records and launches it.
  const unlaunchedFollowUp = status?.followUp && ["", "plan_ready_for_implementation"].includes(phase);
  if (RESTING_PHASES.has(phase) && !unlaunchedFollowUp) return false;
  // A non-converged partial delivery still has its follow-up to start until one is linked or refused.
  if (phase === "closed_partial" && (status?.failureClass !== "review_non_convergence" || status?.followUpRunId || status?.followUpBlocked)) return false;
  const updatedAt = Date.parse(String(status?.updatedAt || ""));
  return Number.isFinite(updatedAt) && now - updatedAt <= maxIdleMs;
}

export async function projectsWithRuns(runsRoot: string) {
  const root = await lstat(runsRoot).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) return [];
  return (await readdir(runsRoot, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

// What a reconcile that moves the run forward changes. Reconcile rewrites status.json, and so updatedAt, even when
// nothing moved, so the driver measures idleness by this instead.
function progressSignature(status: any) {
  return JSON.stringify([status?.phase, status?.nextAction, status?.failureClass, status?.followUpRunId, status?.implementationAttemptId,
    status?.correctionsAttemptId, status?.externalValidation, status?.councilReviewSummary]);
}

// The project's latest run, if it still has something for reconcile to drive. Older runs of a project are
// superseded by its latest one and are never driven.
export async function runToDrive(project: string, latestRunDir: (project: string) => Promise<string>, maxIdleMs: number, now = Date.now()) {
  const dir = await latestRunDir(project).catch(() => "");
  if (!dir) return null;
  const status = await readFile(join(dir, "status.json"), "utf8").then(JSON.parse).catch(() => null);
  return runNeedsDriving(status, maxIdleMs, now) ? { project, runId: basename(dir), progress: progressSignature(status) } : null;
}

type DrivenRun = { project: string; runId: string; progress?: string };

export function createRunDriver(options: {
  intervalMs: number;
  maxIdleMs: number;
  now?: () => number;
  listProjects: () => Promise<string[]>;
  // Resolved right before each reconcile, so a run superseded while an earlier project was being driven is skipped.
  resolveRun: (project: string) => Promise<DrivenRun | null>;
  drive: (run: DrivenRun) => Promise<unknown>;
}) {
  const now = options.now || Date.now;
  // When each run's progress signature last changed; a run left unchanged by the driver's own reconciles for longer
  // than maxIdleMs is left for an operator.
  const lastProgress = new Map<string, { progress: string; since: number }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let active: Promise<void> | null = null;
  let stopped = false;
  async function drainRuns() {
    try {
      for (const project of await options.listProjects()) {
        // A stopped driver starts no further reconcile; the one in flight finishes before stop() returns.
        if (stopped) return;
        const run = await options.resolveRun(project);
        if (!run || stopped) continue;
        const key = `${run.project}/${run.runId}`;
        const seen = lastProgress.get(key);
        if (!seen || seen.progress !== run.progress) lastProgress.set(key, { progress: String(run.progress), since: now() });
        else if (now() - seen.since > options.maxIdleMs) continue;
        await options.drive(run).catch((error: any) => console.error("[development-cycle] run driver reconcile failed:", run.project, run.runId, String(error?.message || error)));
      }
    } catch (error: any) {
      console.error("[development-cycle] run driver failed:", String(error?.message || error));
    }
  }
  function tick() {
    if (!active) active = drainRuns().finally(() => { active = null; });
    return active;
  }
  return {
    tick,
    start() {
      if (timer) return;
      stopped = false;
      void tick();
      timer = setInterval(() => { void tick(); }, options.intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    },
  };
}
