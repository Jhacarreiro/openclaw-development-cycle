import { readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { findProviderProcessesOutsideObservedTree } from "../core/process-observation.js";
import { execFileAsync } from "./exec.js";
import { readJsonIfExists, execSummary, fileInfo, textTail } from "./files.js";
import type { createCycleStore } from "./cycle-store.js";
import type { createOctopusOutput } from "./octopus-output.js";
import type { createObserver } from "./observer.js";

export interface RuntimeObservationDeps {
  observerHookLog: string;
  observerLocalBaseUrl: string;
  saveJson: ReturnType<typeof createCycleStore>["saveJson"];
  effectiveImplementationRoot: ReturnType<typeof createOctopusOutput>["effectiveImplementationRoot"];
  collectObserverSessions: ReturnType<typeof createObserver>["collectObserverSessions"];
}

export function createRuntimeObservation(deps: RuntimeObservationDeps) {
  const { observerHookLog, observerLocalBaseUrl, saveJson, effectiveImplementationRoot, collectObserverSessions } = deps;

  function runtimeTimelineFromText(label: string, text: string) {
    const patterns = /Design review|Step [0-9]|Decomposed|Spawned|Progress:|Quality Gate|Contextual code review|Round [123]|findings|Correction round|Applying contextual|Re-running validation|Skipping ink|Delivery|no diff found|warning|WARN|ERROR|SUCCESS|failed|stalled|progress observed|timeout=|timed out|zombie/i;
    return String(text || "")
      .split(/\r?\n/)
      .filter((line) => patterns.test(line))
      .slice(-200)
      .map((line) => ({ source: label, line: line.replace(/\x1b\[[0-9;]*m/g, "") }));
  }

  async function runtimeObservedPids(status: any, sessions: any[]) {
    const pids: any[] = [status?.pid, status?.runnerPid, status?.directRunnerPid, status?.processGroupId]
      .concat(sessions.map((s) => s?.runnerPid || s?.pid || s?.processGroupId).filter(Boolean));
    for (const path of [status?.directImplementationStatus, status?.directCorrectionsStatus]) {
      const direct = path ? await readJsonIfExists(String(path)) : null;
      if (direct?.runnerPid) pids.push(direct.runnerPid);
      if (direct?.processGroupId) pids.push(direct.processGroupId);
      if (direct?.pid) pids.push(direct.pid);
    }
    return [...new Set(pids.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
  }

  async function runtimeProcessSnapshot(status: any, sessions: any[]) {
    const pids = await runtimeObservedPids(status, sessions);
    let table = "";
    try { table = (await execFileAsync("ps", ["-eo", "pid,ppid,etime,stat,comm"], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout || ""; } catch {}
    const rows = table.split(/\r?\n/).slice(1).map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), elapsed: m[3], stat: m[4], comm: m[5] } : null;
    }).filter(Boolean) as any[];
    const rootSet = new Set(pids);
    const children = new Map<number, any[]>();
    for (const r of rows) {
      if (!children.has(r.ppid)) children.set(r.ppid, []);
      children.get(r.ppid)!.push(r);
    }
    const seen = new Set<number>();
    const tree: any[] = [];
    const stack = [...pids];
    while (stack.length) {
      const pid = stack.pop()!;
      for (const r of children.get(pid) || []) {
        if (seen.has(r.pid)) continue;
        seen.add(r.pid); tree.push(r); stack.push(r.pid);
      }
    }
    const roots = rows.filter((r) => rootSet.has(r.pid));
    const providers = rows.filter((r) => /^(codex|claude|gemini|agy|command-code|node)$/.test(String(r.comm || "")));
    return { roots, descendants: tree, providers, zombies: rows.filter((r) => String(r.stat || "").includes("Z")), observedPids: pids };
  }

  async function runtimeGitSnapshot(projectRoot: string) {
    if (!projectRoot) return { available: false, reason: "projectRoot_not_supplied" };
    const st = await stat(projectRoot).catch(() => null);
    if (!st?.isDirectory()) return { available: false, reason: "projectRoot_missing", projectRoot };
    return {
      available: true,
      projectRoot,
      status: await execSummary("git", ["status", "--short", "--branch"], projectRoot, 10000),
      diffStat: await execSummary("git", ["diff", "--stat"], projectRoot, 10000),
    };
  }

  // The run's own checkouts: the source checkout, the materialized output and
  // the linked worktrees named after this run's current attempts. Other runs'
  // worktrees of the same repository are not this run's.
  async function runtimeWorkRoots(status: any) {
    const roots = new Set<string>([status?.projectRoot, effectiveImplementationRoot(status)].filter(Boolean).map(String));
    const attempts = [status?.implementationAttemptId, status?.correctionsAttemptId].filter(Boolean).map(String);
    if (status?.projectRoot && attempts.length) {
      try {
        const out = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: String(status.projectRoot), timeout: 10000, maxBuffer: 1024 * 1024 })).stdout || "";
        for (const line of out.split(/\r?\n/)) {
          const path = line.startsWith("worktree ") ? line.slice("worktree ".length) : "";
          if (path && attempts.some((attempt) => path.split("/").includes(attempt))) roots.add(path);
        }
      } catch {}
    }
    return [...roots];
  }

  // Working directories are read only for attribution and never persisted, so
  // the observation does not record unrelated processes' paths.
  async function withWorkingDirectories(processes: any[]) {
    return Promise.all(processes.map(async (p) => ({ ...p, cwd: await readlink(`/proc/${p.pid}/cwd`).catch(() => null) })));
  }

  async function runtimeArtifacts(dir: string, status: any) {
    const paths = new Set<string>();
    for (const p of [status?.implementationStdout, status?.implementationStderr, status?.correctionsStdout, status?.correctionsStderr, status?.directImplementationStatus, status?.directCorrectionsStatus, status?.outputPath]) if (p) paths.add(String(p));
    const runFiles = (await readdir(dir).catch(() => [])).filter((x) => /status|implementation|artifact|evidence|summary|validation|observer|runtime|timeline|alerts/i.test(x)).map((x) => join(dir, x));
    for (const p of runFiles) paths.add(p);
    const out: any[] = [];
    for (const p of [...paths].sort()) {
      const info = await fileInfo(p);
      if (info) out.push(info);
    }
    return out.slice(-200);
  }

  function runtimeAlerts(status: any, process: any, git: any, timeline: any[], artifacts: any[], workRoots: string[] = [], providersWithCwd: any[] = process.providers || []) {
    const alerts: any[] = [];
    const phase = String(status?.phase || "");
    if (phase.includes("running") || phase.includes("launched")) {
      if (!process.roots?.length) alerts.push({ severity: "warning", code: "status_running_but_root_missing", message: "status phase implies active run, but root process was not found" });
      if (process.roots?.some((r: any) => String(r.stat || "").includes("Z"))) alerts.push({ severity: "warning", code: "root_process_zombie", message: "root process is zombie; status may be stale" });
    }
    if (process.zombies?.length) alerts.push({ severity: "info", code: "zombie_processes_present", count: process.zombies.length });
    const providerOrphans = findProviderProcessesOutsideObservedTree(providersWithCwd, process.descendants || [], process.roots || [], workRoots);
    if (providerOrphans.length) alerts.push({ severity: "warning", code: "provider_processes_outside_observed_tree", count: providerOrphans.length, providers: providerOrphans.slice(0, 20) });
    const text = timeline.map((x) => x.line).join("\n");
    if (/no diff found/i.test(text)) alerts.push({ severity: "warning", code: "review_no_diff", message: "contextual review reported no diff" });
    if (/Quality Gate: FAILED|Quality gate FAILED/i.test(text)) alerts.push({ severity: "warning", code: "quality_gate_failed" });
    if (/timed out|Operation timed out/i.test(text)) alerts.push({ severity: "warning", code: "wall_clock_timeout_seen" });
    if (/Skipping ink/i.test(text)) alerts.push({ severity: "info", code: "ink_skipped" });
    if (git?.available && /^## .*\n?$/m.test(String(git.status || "")) && !artifacts.some((a) => /review-findings|tangle-validation|delivery/.test(a.path))) alerts.push({ severity: "info", code: "clean_worktree_with_limited_artifacts" });
    return alerts;
  }

  async function writeRichRuntimeObservation(dir: string, status: any, sessions: any[]) {
    const stdoutPath = String(status?.implementationStdout || status?.correctionsStdout || status?.directImplementationStdout || "");
    const stderrPath = String(status?.implementationStderr || status?.correctionsStderr || status?.directImplementationStderr || "");
    const stdoutTail = await textTail(stdoutPath);
    const stderrTail = await textTail(stderrPath);
    const timeline = runtimeTimelineFromText("stdout", stdoutTail).concat(runtimeTimelineFromText("stderr", stderrTail)).slice(-300);
    const process = await runtimeProcessSnapshot(status, sessions);
    const git = await runtimeGitSnapshot(effectiveImplementationRoot(status));
    const artifacts = await runtimeArtifacts(dir, status);
    const alerts = runtimeAlerts(status, process, git, timeline, artifacts, await runtimeWorkRoots(status), await withWorkingDirectories(process.providers || []));
    const observation = { generatedAt: new Date().toISOString(), phase: status?.phase || null, owner: status?.owner || null, nextAction: status?.nextAction || null, process, git, artifacts, timelineTail: timeline.slice(-80), alerts };
    const observationPath = join(dir, "runtime_observation.json");
    const timelinePath = join(dir, "runtime_timeline.json");
    const alertsPath = join(dir, "runtime_alerts.json");
    await saveJson(observationPath, observation);
    await saveJson(timelinePath, { generatedAt: observation.generatedAt, events: timeline });
    await saveJson(alertsPath, { generatedAt: observation.generatedAt, alerts });
    return { observationPath, timelinePath, alertsPath, observation };
  }

  async function cycleRuntimeSummary(dir: string, status: any) {
    const sessions = await collectObserverSessions(status || {});
    const rootIds = [status?.observerSessionId, status?.observerCorrectionsSessionId, status?.observerObservationId, status?.observerCorrectionsObservationId].filter(Boolean).map(String);
    const rich = await writeRichRuntimeObservation(dir, status || {}, sessions);
    return { nextAction: status?.nextAction || null, owner: status?.owner || null, phase: status?.phase || null, observerRootSessions: rootIds.map((id) => ({ id, attachUrl: `${observerLocalBaseUrl}/sessions/${id}` })), observerChildSessions: sessions.filter((s) => !rootIds.includes(String(s.id))), observerSessions: sessions, hookLog: observerHookLog, knownArtifacts: (await readdir(dir).catch(() => [])).filter((x) => /plan|context|validation|implementation|artifact|evidence|summary|status|runtime|timeline|alerts/i.test(x)).sort(), richObservation: { observationPath: rich.observationPath, timelinePath: rich.timelinePath, alertsPath: rich.alertsPath, alerts: rich.observation.alerts, latestTimeline: rich.observation.timelineTail } };
  }

  return { runtimeProcessSnapshot, runtimeAlerts, cycleRuntimeSummary };
}
