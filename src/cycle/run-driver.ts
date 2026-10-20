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
  if (RESTING_PHASES.has(phase)) return false;
  // A non-converged partial delivery still has its follow-up to start until one is linked or refused.
  if (phase === "closed_partial" && (status?.failureClass !== "review_non_convergence" || status?.followUpRunId || status?.followUpBlocked)) return false;
  const updatedAt = Date.parse(String(status?.updatedAt || ""));
  return Number.isFinite(updatedAt) && now - updatedAt <= maxIdleMs;
}

// The latest run of each project, if it still has something for reconcile to drive. Older runs of a project
// are superseded by its latest one and are never driven.
export async function runsToDrive(runsRoot: string, latestRunDir: (project: string) => Promise<string>, maxIdleMs: number, now = Date.now()) {
  const root = await lstat(runsRoot).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) return [];
  const runs: Array<{ project: string; runId: string }> = [];
  for (const entry of await readdir(runsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const dir = await latestRunDir(entry.name).catch(() => "");
    if (!dir) continue;
    const status = await readFile(join(dir, "status.json"), "utf8").then(JSON.parse).catch(() => null);
    if (runNeedsDriving(status, maxIdleMs, now)) runs.push({ project: entry.name, runId: basename(dir) });
  }
  return runs;
}

export function createRunDriver(options: {
  intervalMs: number;
  listRuns: () => Promise<Array<{ project: string; runId: string }>>;
  drive: (run: { project: string; runId: string }) => Promise<unknown>;
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const run of await options.listRuns()) {
        await options.drive(run).catch((error: any) => console.error("[development-cycle] run driver reconcile failed:", run.project, run.runId, String(error?.message || error)));
      }
    } catch (error: any) {
      console.error("[development-cycle] run driver failed:", String(error?.message || error));
    } finally {
      ticking = false;
    }
  }
  return {
    tick,
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => { void tick(); }, options.intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
