import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileAsync } from "./exec.js";
import { readJsonIfExists } from "./files.js";
import type { DevelopmentCycleConfig } from "../config.js";

export interface ObserverDeps {
  developmentCycleConfig: DevelopmentCycleConfig;
  observerObserveHelper: string;
  adapterSessionsRoot: string;
  observerLocalBaseUrl: string;
  runtimeHome: string;
  observerRepository: string;
  observerBranch: string;
  observerRuntime: string;
  observerOwner: string;
}

export function createObserver(deps: ObserverDeps) {
  const { developmentCycleConfig, observerObserveHelper, adapterSessionsRoot, observerLocalBaseUrl, runtimeHome, observerRepository, observerBranch, observerRuntime, observerOwner } = deps;

  async function observerObservation(dir: string, payload: any) {
    if (!developmentCycleConfig.observer.enabled) return { ok: true, skipped: true, reason: "observer_disabled" };
    try {
      const helperStat = await stat(observerObserveHelper).catch(() => null);
      if (!helperStat?.isFile()) return { ok: false, skipped: true, reason: "observer_observe_helper_missing", helper: observerObserveHelper };
      const file = join(dir, `observer_observation_${Date.now()}.json`);
      await writeFile(file, JSON.stringify(payload, null, 2) + "\n");
      const res = await execFileAsync("node", [observerObserveHelper, file], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: runtimeHome, TMPDIR: process.env.TMPDIR, USER: process.env.USER },
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      let parsed: any = null;
      try { parsed = JSON.parse(res.stdout || "{}"); } catch {}
      const id = parsed?.status?.id || "";
      return { ok: Boolean(id), id, raw: parsed, file };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async function createImplementationObserverSession(dir: string, params: any) {
    if (!developmentCycleConfig.observer.enabled) return "";
    const observation = await observerObservation(dir, {
      repo: observerRepository,
      branch: observerBranch,
      runtime: observerRuntime,
      command: `development_cycle ${params.command || "implementation"} ${params.project || ""}`.trim(),
      owner: observerOwner,
      status: "ready",
      cwd: params.projectRoot,
      projectRoot: params.projectRoot,
      resultsRoot: dir,
      stdoutPath: params.stdoutPath,
      stderrPath: params.stderrPath,
      summary: `Development cycle Implementation ${params.command || "handoff"} for ${params.project || "project"}`,
      message: `Development cycle Implementation ${params.command || "handoff"} requested for ${params.project || "project"}`,
      control: { type: "process", stopAllowed: true, interruptAllowed: true, messageAllowed: true, correctionAllowed: true, useProcessGroup: true },
      developmentCycle: {
        enabled: false,
        project: params.project || "",
        runId: params.runId || "",
        attemptId: params.attemptId || "",
        projectRoot: params.projectRoot || "",
        projectWikiPath: params.projectWikiPath || "",
        intervalSeconds: Number(params.watchIntervalSeconds || 60),
        stallQuietSeconds: Number(params.stallQuietSeconds || 900),
      },
    });
    return observation?.ok ? String(observation.id) : "";
  }

  async function updateImplementationObserverSession(dir: string, id: string, params: any) {
    if (!developmentCycleConfig.observer.enabled || !id) return null;
    return await observerObservation(dir, {
      id,
      repo: observerRepository,
      branch: observerBranch,
      runtime: observerRuntime,
      command: `development_cycle ${params.command || "implementation"} ${params.project || ""}`.trim(),
      owner: observerOwner,
      status: params.status || "completed",
      cwd: params.projectRoot,
      projectRoot: params.projectRoot,
      resultsRoot: dir,
      stdoutPath: params.stdoutPath,
      stderrPath: params.stderrPath,
      summary: params.summary || `Development cycle Implementation ${params.status || "completed"}`,
      message: params.message || `Development cycle Implementation ${params.status || "completed"}`,
      pid: Number(params.pid || 0) || undefined,
      processGroup: Number(params.processGroup || 0) || undefined,
      control: { type: "process", stopAllowed: true, interruptAllowed: true, messageAllowed: true, correctionAllowed: true, useProcessGroup: true },
      developmentCycle: {
        enabled: true,
        project: params.project || "",
        runId: params.runId || "",
        attemptId: params.attemptId || "",
        projectRoot: params.projectRoot || "",
        projectWikiPath: params.projectWikiPath || "",
        intervalSeconds: Number(params.watchIntervalSeconds || 60),
        stallQuietSeconds: Number(params.stallQuietSeconds || 900),
      },
    });
  }

  async function collectObserverSessions(status: any) {
    if (!developmentCycleConfig.observer.enabled || !adapterSessionsRoot) return [];
    const roots = [status?.observerSessionId, status?.observerCorrectionsSessionId, status?.observerObservationId, status?.observerCorrectionsObservationId].filter(Boolean).map(String);
    if (!roots.length) return [];
    const out: any[] = [];
    const seen = new Set<string>();
    async function add(id: string) {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const s = await readJsonIfExists(join(adapterSessionsRoot, id, "status.json"));
      const p = await readJsonIfExists(join(adapterSessionsRoot, id, "payload.json"));
      out.push({ id, parentSessionId: p?.parentSessionId || s?.parentSessionId || null, rootSessionId: p?.rootSessionId || s?.rootSessionId || null, status: s?.status || p?.status || null, command: s?.command || p?.command || null, attachUrl: s?.attachUrl || s?.statusUrl || `${observerLocalBaseUrl}/sessions/${id}`, message: s?.message || p?.message || null, stdoutPath: s?.stdoutPath || p?.stdoutPath || s?.stdout?.path || null, stderrPath: s?.stderrPath || p?.stderrPath || s?.stderr?.path || null, resultFiles: s?.resultFiles || [], updatedAt: s?.updatedAt || null });
    }
    for (const id of roots) await add(id);
    try {
      const names = await readdir(adapterSessionsRoot);
      for (const name of names.slice(-300)) {
        const p = await readJsonIfExists(join(adapterSessionsRoot, name, "payload.json"));
        if (p && (roots.includes(String(p.rootSessionId || "")) || roots.includes(String(p.parentSessionId || "")))) await add(name);
      }
    } catch {}
    return out;
  }


  async function finalizeObserverSessions(dir: string, status: any, terminal: string) {
    if (!developmentCycleConfig.observer.enabled) return { ok: true, skipped: true, reason: "observer_disabled" };
    const ids = [
      status?.observerSessionId,
      status?.observerCorrectionsSessionId,
      status?.observerObservationId,
      status?.observerCorrectionsObservationId,
    ].filter(Boolean).map(String);
    if (!ids.length) return { ok: true, skipped: true, reason: "no_observer_roots" };
    const results: any[] = [];
    for (const id of ids) {
      try {
        const result = await updateImplementationObserverSession(dir, id, {
          project: status?.project,
          runId: status?.runId,
          projectRoot: status?.projectRoot,
          projectWikiPath: status?.projectWikiPath,
          status: terminal,
          summary: `development_cycle ${terminal} ${status?.project || ""}`,
          message: `Development cycle ${terminal} for ${status?.project || "project"}`,
        });
        if (!result || result.ok !== true) {
          results.push({ id, ok: false, result: result || { ok: false, error: "observer_update_unsuccessful" } });
          continue;
        }
        results.push({ id, ok: true, result });
      } catch (err: any) {
        results.push({ id, ok: false, result: { ok: false, error: String(err?.message || err) } });
      }
    }
    return { ok: results.every((entry) => entry.ok), terminal, results };
  }

  return { createImplementationObserverSession, updateImplementationObserverSession, collectObserverSessions, finalizeObserverSessions };
}
