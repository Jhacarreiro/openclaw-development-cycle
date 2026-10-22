import { readdir } from "node:fs/promises";
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

// Phases a run does not leave; the run-end command runs once when a run enters one.
const CLOSED_PHASES = new Set(["merged", "closed_success", "closed_partial", "closed_invalid"]);

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
  function startRunEndCommand(dir: string, request: any) {
    if (!runEnd?.command) return;
    const base = { ...request, command: runEnd.command, startedAt: new Date().toISOString() };
    const job = (async () => {
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
