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
    const next = await filesystemStore.updateStatus(dir, patch);
    const notice = phaseNotificationForTransition(previous, next);
    if (!notice) return next;

    const statePath = join(dir, "telegram_update_state.json");
    const eventsPath = join(dir, "telegram_update_events.jsonl");
    const signature = JSON.stringify({ phase: notice.phase, project: next?.project || "", runId: next?.runId || "" });
    const state = await filesystemStore.loadJson<any>(statePath);
    if (state?.lastSignature === signature) return next;

    const result = await sendCycleMessage({ __notificationAudit: { eventsPath, event: {
      eventType: "development_cycle.telegram_delivery", project: next?.project || previous?.project || "",
      runId: next?.runId || previous?.runId || "", phase: notice.phase, title: notice.title, signature,
    } } }, notice.title, notice.text).catch((error: any) => ({ ok: false, error: String(error?.message || error) }));
    const event = {
      eventType: "development_cycle.telegram_update",
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
