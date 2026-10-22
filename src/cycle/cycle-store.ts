import { randomBytes } from "node:crypto";
import { link, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { phaseNotificationForTransition } from "../core/phase-notifications.js";
import { execSupervisedCommand } from "../runtime/processes.js";
import { excerpt } from "./files.js";
import type { createNotificationService } from "../runtime/notifications.js";
import type { FilesystemStore } from "../storage/filesystem.js";

export interface CycleStoreDeps {
  filesystemStore: FilesystemStore;
  cycleMessageDeliveryQueue: ReturnType<typeof createNotificationService>;
  developmentCycleConfig?: { runEnd?: { command: string; args: string[]; timeoutSeconds: number } };
}

// Phases a run does not leave; the run-end command runs once when a run enters one. The close action then moves a run
// from one of them to "closed", which is still closed and does not run it again.
const CLOSED_PHASES = new Set(["merged", "closed_success", "closed_partial", "closed_invalid", "closed"]);

// Run-end commands this process is running, shared by every cycle store in it.
const runningRunEnd = new Set<string>();

export function createCycleStore(deps: CycleStoreDeps) {
  const { filesystemStore, cycleMessageDeliveryQueue } = deps;
  const runEnd = deps.developmentCycleConfig?.runEnd;
  const runEndCommands = new Set<Promise<void>>();

  // An optional operator command (for example a decision-map generator) that gets the closed run's directory as its
  // last argument. It runs in the background so closing a run never waits on it; its outcome is kept in the run.
  // The request is recorded as pending before it starts, so a gateway restart that interrupts it can run it again.
  const RUN_END_FILE = "run_end_command.json";
  async function queueRunEndCommand(dir: string, phase: string) {
    const request = { schemaVersion: 1, state: "pending", phase, command: runEnd?.command || "", queuedAt: new Date().toISOString() };
    await filesystemStore.saveJson(join(dir, RUN_END_FILE), request);
    return request;
  }
  // A run's command is claimed with a claim file kept while it runs, so two gateways sharing the state root (or a
  // resume racing a close) never start it twice. The file is published whole with link(), which fails if a claim
  // exists, so a claim is never seen half written. The command is stopped at its time limit even if the gateway that
  // started it died, so a claim is live until that limit plus a grace period and is taken over only after it; a
  // command blocked by a live claim tries again once the claim expires.
  const RUN_END_CLAIM = "run_end_command.claim";
  const claimLifetimeMs = () => ((runEnd?.timeoutSeconds || 300) + 60) * 1000;
  const claimSuffix = () => `${Date.now().toString(16)}-${randomBytes(6).toString("hex")}`;
  const readClaim = (path: string) => readFile(path, "utf8").then((text) => JSON.parse(text)).catch(() => null);
  const claimExpiresAt = (claim: any) => {
    const claimedAt = Date.parse(String(claim?.claimedAt ?? ""));
    // An unreadable claim is aged by nothing it says; give it one full lifetime from now.
    return Number.isFinite(claimedAt) ? claimedAt + claimLifetimeMs() : Number.NaN;
  };
  async function takeOverStaleClaim(claimPath: string, seen: any) {
    const moved = `${claimPath}.stale-${claimSuffix()}`;
    if (!(await rename(claimPath, moved).then(() => true, () => false))) return;
    // Another process may have replaced the claim between the read and the move; if so, put it back.
    const taken = await readClaim(moved);
    if (JSON.stringify(taken) !== JSON.stringify(seen)) await link(moved, claimPath).catch(() => undefined);
    await unlink(moved).catch(() => undefined);
  }
  async function claimRunEndCommand(dir: string): Promise<{ release?: () => Promise<void>; retryAt?: number }> {
    // Reserved before any await, so a second start in this process sees it at once.
    if (runningRunEnd.has(dir)) return {};
    runningRunEnd.add(dir);
    const claimPath = join(dir, RUN_END_CLAIM);
    const claim = { host: hostname(), pid: process.pid, claimedAt: new Date().toISOString(), id: claimSuffix() };
    const draft = `${claimPath}.new-${claim.id}`;
    let claimed = false;
    let retryAt: number | undefined;
    try {
      await writeFile(draft, JSON.stringify(claim), { flag: "wx" });
      for (let attempt = 0; attempt < 2 && !claimed; attempt += 1) {
        claimed = await link(draft, claimPath).then(() => true, () => false);
        if (claimed) break;
        const seen = await readClaim(claimPath);
        const expiresAt = claimExpiresAt(seen);
        if (seen && expiresAt > Date.now()) {
          retryAt = expiresAt;
          break;
        }
        if (!seen) {
          // Unreadable (or just removed): judge it by its file age instead.
          const age = await stat(claimPath).then((info) => Date.now() - info.mtimeMs, () => Number.POSITIVE_INFINITY);
          if (age < claimLifetimeMs()) {
            retryAt = Date.now() + claimLifetimeMs() - age;
            break;
          }
        }
        await takeOverStaleClaim(claimPath, seen);
      }
    } catch {
      claimed = false;
    } finally {
      await unlink(draft).catch(() => undefined);
    }
    const release = async () => {
      const held = await readClaim(claimPath);
      if (held?.id === claim.id) await unlink(claimPath).catch(() => undefined);
      runningRunEnd.delete(dir);
    };
    const current = claimed ? await filesystemStore.loadJson<any>(join(dir, RUN_END_FILE)).catch(() => null) : null;
    if (!claimed || current?.state !== "pending") {
      if (claimed) await release();
      else runningRunEnd.delete(dir);
      return { retryAt };
    }
    return { release };
  }
  function startRunEndCommand(dir: string, request: any) {
    if (!runEnd?.command) return;
    const job = (async () => {
      const lock = await claimRunEndCommand(dir);
      if (!lock.release) {
        if (lock.retryAt) setTimeout(() => startRunEndCommand(dir, request), Math.max(0, lock.retryAt - Date.now()) + 1000).unref();
        return;
      }
      try {
        const base = { ...request, command: runEnd.command, startedAt: new Date().toISOString() };
        let result: any;
        try {
          const out = await execSupervisedCommand(runEnd.command, [...runEnd.args, dir], {
            cwd: dir, timeout: runEnd.timeoutSeconds * 1000, maxBuffer: 1024 * 1024,
          });
          result = { ...base, ok: true, exitCode: 0, stdout: excerpt(String(out.stdout || ""), 2000) };
        } catch (err: any) {
          result = {
            ...base, ok: false, exitCode: typeof err?.code === "number" ? err.code : null,
            error: excerpt(String(err?.message || err), 1000),
            stdout: excerpt(String(err?.stdout || ""), 2000), stderr: excerpt(String(err?.stderr || ""), 2000),
          };
        }
        await filesystemStore.saveJson(join(dir, RUN_END_FILE), { ...result, state: "finished", finishedAt: new Date().toISOString() });
      } finally {
        await lock.release().catch(() => undefined);
      }
    })().catch(() => undefined);
    runEndCommands.add(job);
    job.finally(() => runEndCommands.delete(job));
  }
  // Runs again every run-end command still pending in any run, for example after the gateway stopped while one ran.
  // A finished command, successful or not, is not repeated.
  async function resumeRunEndCommands(runsRoot: string) {
    if (!runEnd?.command) return 0;
    const dirs = async (path: string) => (await readdir(path, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => join(path, entry.name));
    let resumed = 0;
    for (const projectDir of await dirs(runsRoot)) {
      for (const dir of await dirs(projectDir)) {
        const request = await filesystemStore.loadJson<any>(join(dir, RUN_END_FILE)).catch(() => null);
        if (request?.state !== "pending") continue;
        // The request is written just before the closing status; if the gateway stopped in between, the run is not
        // closed and a later close queues it again.
        const status = await filesystemStore.loadJson<any>(join(dir, "status.json")).catch(() => null);
        if (!CLOSED_PHASES.has(String(status?.phase || ""))) continue;
        startRunEndCommand(dir, request);
        resumed += 1;
      }
    }
    return resumed;
  }
  async function settleRunEndCommands() {
    await Promise.all([...runEndCommands]);
  }

  const cycleDir = filesystemStore.runDir;
  const loadJson = filesystemStore.loadJson;
  const saveJson = filesystemStore.saveJson;
  async function cycleStatus(dir: string, patch: any) {
    const previous = await filesystemStore.loadJson<any>(join(dir, "status.json"));
    // A new run starts its own lifecycle record; older runs keep these fields absent instead of guessed.
    const created = Object.keys(previous || {}).length === 0
      ? { createdAt: new Date().toISOString(), interventionAnswerCount: 0, correctionRoundCount: 0 }
      : {};
    // A closing run's run-end command is recorded before the status, so a stop between the two writes cannot lose it.
    const closingPhase = String(patch?.phase ?? previous?.phase ?? "");
    const closing = Boolean(runEnd?.command) && CLOSED_PHASES.has(closingPhase) && !CLOSED_PHASES.has(String(previous?.phase || ""));
    const runEndRequest = closing ? await queueRunEndCommand(dir, closingPhase) : null;
    const next = await filesystemStore.updateStatus(dir, { ...created, ...patch });
    if (runEndRequest) startRunEndCommand(dir, runEndRequest);
    const notice = phaseNotificationForTransition(previous, next);
    if (!notice) return next;

    const statePath = join(dir, "phase_notification_state.json");
    const eventsPath = join(dir, "phase_notification_events.jsonl");
    const signature = JSON.stringify({ phase: notice.phase, project: next?.project || "", runId: next?.runId || "" });
    // Runs started before the rename keep their dedupe state in the legacy file.
    let state = await filesystemStore.loadJson<any>(statePath);
    if (!state?.lastSignature) state = await filesystemStore.loadJson<any>(join(dir, "telegram_update_state.json"));
    if (state?.lastSignature === signature) return next;

    const result = await sendCycleMessage({ __notificationAudit: { eventsPath, event: {
      eventType: "development_cycle.phase_notification_delivery", project: next?.project || previous?.project || "",
      runId: next?.runId || previous?.runId || "", phase: notice.phase, title: notice.title, signature,
    } } }, notice.title, notice.text).catch((error: any) => ({ ok: false, error: String(error?.message || error) }));
    const event = {
      eventType: "development_cycle.phase_notification",
      createdAt: new Date().toISOString(),
      project: next?.project || previous?.project || "",
      runId: next?.runId || previous?.runId || "",
      previousPhase: previous?.phase || "",
      phase: notice.phase,
      title: notice.title,
      notification: result,
      signature,
    };
    await filesystemStore.appendJsonl(eventsPath, event);
    await filesystemStore.saveJson(statePath, {
      lastSignature: signature,
      lastEvent: event,
      updatedAt: event.createdAt,
    });
    return next;
  }
  const appendJsonl = filesystemStore.appendJsonl;
  async function sendCycleMessage(params: any, title: string, text: string) {
    return cycleMessageDeliveryQueue.send(params, title, text);
  }

  async function clearActiveImplementationAttempt(dir: string) {
    return await cycleStatus(dir, {
      implementationAttemptId: null,
      implementationSessionId: null,
      directImplementationStatus: null,
      directImplementationStdout: null,
      directImplementationStderr: null,
      implementationStdout: null,
      implementationStderr: null,
      observerObservationId: null,
      implementationLaunch: null,
      requiredMechanicalValidation: false,
      validationEvidence: null,
      externalValidationDecision: null,
      repositoryDeliverySourcePhase: null,
      reviewNonConvergence: null,
      implementationAttemptResetAt: new Date().toISOString(),
    });
  }

  async function clearActiveCorrectionsAttempt(dir: string) {
    return await cycleStatus(dir, {
      correctionsAttemptId: null,
      directCorrectionsStatus: null,
      directCorrectionsStdout: null,
      directCorrectionsStderr: null,
      correctionsStdout: null,
      correctionsStderr: null,
      observerCorrectionsSessionId: null,
      observerCorrectionsObservationId: null,
      implementationCorrectionsSessionId: null,
      implementationCorrectionsLaunch: null,
      correctionsAttemptResetAt: new Date().toISOString(),
    });
  }

  return { cycleDir, loadJson, saveJson, cycleStatus, resumeRunEndCommands, settleRunEndCommands, appendJsonl, sendCycleMessage, clearActiveImplementationAttempt, clearActiveCorrectionsAttempt };
}
