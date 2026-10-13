import { join } from "node:path";
import { phaseNotificationForTransition } from "../core/phase-notifications.js";
import type { createNotificationService } from "../runtime/notifications.js";
import type { FilesystemStore } from "../storage/filesystem.js";

export interface CycleStoreDeps {
  filesystemStore: FilesystemStore;
  cycleMessageDeliveryQueue: ReturnType<typeof createNotificationService>;
}

export function createCycleStore(deps: CycleStoreDeps) {
  const { filesystemStore, cycleMessageDeliveryQueue } = deps;

  const cycleDir = filesystemStore.runDir;
  const loadJson = filesystemStore.loadJson;
  const saveJson = filesystemStore.saveJson;
  async function cycleStatus(dir: string, patch: any) {
    const previous = await filesystemStore.loadJson<any>(join(dir, "status.json"));
    // A new run starts its own lifecycle record; older runs keep these fields absent instead of guessed.
    const created = Object.keys(previous || {}).length === 0
      ? { createdAt: new Date().toISOString(), interventionAnswerCount: 0, correctionRoundCount: 0 }
      : {};
    const next = await filesystemStore.updateStatus(dir, { ...created, ...patch });
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

  return { cycleDir, loadJson, saveJson, cycleStatus, appendJsonl, sendCycleMessage, clearActiveImplementationAttempt, clearActiveCorrectionsAttempt };
}
