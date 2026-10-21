import { stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { cleanId } from "../core/ids.js";
import { readProcessIdentity, sameProcess } from "../runtime/processes.js";
import { readTextIfExists, readJsonIfExists } from "./files.js";
import type { createCycleStore } from "./cycle-store.js";
import type { createOctopusOutput } from "./octopus-output.js";
import type { createObserver } from "./observer.js";

export interface ImplementationStatusDeps {
  adapterSessionsRoot: string;
  saveJson: ReturnType<typeof createCycleStore>["saveJson"];
  cycleStatus: ReturnType<typeof createCycleStore>["cycleStatus"];
  resolveOctopusAttemptOutput: ReturnType<typeof createOctopusOutput>["resolveOctopusAttemptOutput"];
  detectOctopusReviewInfrastructureFailure: ReturnType<typeof createOctopusOutput>["detectOctopusReviewInfrastructureFailure"];
  detectOctopusReviewNonConvergence: ReturnType<typeof createOctopusOutput>["detectOctopusReviewNonConvergence"];
  finalizeObserverSessions: ReturnType<typeof createObserver>["finalizeObserverSessions"];
  sendCycleMessage: ReturnType<typeof createCycleStore>["sendCycleMessage"];
}

export function createImplementationStatus(deps: ImplementationStatusDeps) {
  const { adapterSessionsRoot, saveJson, cycleStatus, resolveOctopusAttemptOutput, detectOctopusReviewInfrastructureFailure, detectOctopusReviewNonConvergence, finalizeObserverSessions, sendCycleMessage } = deps;

  async function refreshLaunchedImplementationStatus(dir: string, status: any) {
    const phase = String(status?.phase || "");
    if (!["implementation_launched", "implementation_running", "implementation_failed", "implementation_delivered", "corrections_launched", "corrections_running", "corrections_failed", "corrections_completed"].includes(phase)) return status;
    const isCorrectionsRun = phase.startsWith("corrections_");
    const statusPath = isCorrectionsRun
      ? status?.directCorrectionsStatus
      : status?.directImplementationStatus;
    let session: any = statusPath ? await readJsonIfExists(String(statusPath)) : null;
    if (!session) {
      const sid = isCorrectionsRun ? status?.observerCorrectionsSessionId : status?.observerSessionId;
      if (sid) session = await readJsonIfExists(join(adapterSessionsRoot, String(sid), "status.json"));
    }
    if (!session) return status;
    const activeAttemptId = String(isCorrectionsRun ? (status?.correctionsAttemptId || "") : (status?.implementationAttemptId || ""));
    const observedAttemptId = String(session?.attemptId || session?.developmentCycle?.attemptId || "");
    if (activeAttemptId && observedAttemptId !== activeAttemptId) {
      return await cycleStatus(dir, {
        runnerAttemptMismatch: {
          activeAttemptId,
          observedAttemptId: observedAttemptId || null,
          statusPath: statusPath || null,
          detectedAt: new Date().toISOString(),
        },
      });
    }
    const stdoutPath = session.stdoutPath || session.logs?.stdout || (isCorrectionsRun ? status?.correctionsStdout : status?.implementationStdout);
    const stderrPath = session.stderrPath || session.logs?.stderr || (isCorrectionsRun ? status?.correctionsStderr : status?.implementationStderr);
    const exitText = session.exitCodePath ? await readTextIfExists(String(session.exitCodePath)) : "";
    const exitCode = exitText.trim() ? Number(exitText.trim()) : null;
    const runnerPid = Number(session.runnerPid || session.pid || 0);
    if (exitCode === null && String(session.status || '').toLowerCase() === 'running' && runnerPid > 0) {
      let runnerAlive = true;
      try {
        const identity = await readProcessIdentity(runnerPid);
        runnerAlive = session.runnerIdentity ? sameProcess(session.runnerIdentity, identity) : Boolean(identity);
      } catch { runnerAlive = false; }
      const heartbeatPath = String(session.heartbeatPath || '');
      const heartbeatStat = heartbeatPath ? await stat(heartbeatPath).catch(() => null) : null;
      const heartbeatAgeMs = heartbeatStat ? Date.now() - heartbeatStat.mtimeMs : null;
      if (!runnerAlive) {
        const interruptedAt = new Date().toISOString();
        if (statusPath) await saveJson(String(statusPath), { ...session, status: 'interrupted', launchState: 'runner_missing', interruptedAt, updatedAt: interruptedAt, message: 'Implementation runner process disappeared without an exit marker.' });
        const patch = isCorrectionsRun
          ? { phase: 'corrections_failed', owner: 'main', ok: false, error: 'implementation_runner_process_missing', correctionsStdout: stdoutPath, correctionsStderr: stderrPath, directCorrectionsStatus: statusPath }
          : { phase: 'implementation_failed', owner: 'main', ok: false, nextAction: 'Inspect Implementation stdout/stderr and agent manifest; reconcile or launch a clean handoff.', error: 'implementation_runner_process_missing', implementationStdout: stdoutPath, implementationStderr: stderrPath, directImplementationStatus: statusPath };
        const observerFinalization = await finalizeObserverSessions(dir, status, "failed");
        return await cycleStatus(dir, { ...patch, observerFinalization });
      }
      if (heartbeatAgeMs !== null && heartbeatAgeMs > 10 * 60 * 1000 && statusPath) {
        await saveJson(String(statusPath), { ...session, stalled: true, heartbeatAgeMs, updatedAt: new Date().toISOString(), message: 'Runner is alive but heartbeat is stale; no wall timeout is enforced.' });
      }
    }
    if (exitCode !== null && Number.isFinite(exitCode)) {
      const exitedAtPath = session.exitedAtPath ? String(session.exitedAtPath) : "";
      const exitedAtText = exitedAtPath ? (await readTextIfExists(exitedAtPath)).trim() : "";
      const exitedAt = exitedAtText || new Date().toISOString();
      if (statusPath) {
        await saveJson(String(statusPath), {
          ...session,
          status: exitCode === 0 ? "completed" : "failed",
          launchState: "exited",
          exitCode,
          exitedAt,
          updatedAt: new Date().toISOString(),
          message: exitCode === 0 ? "Implementation direct runner exited successfully." : "Implementation direct runner exited non-zero: " + exitCode,
        });
      }
      const interventionPath = String(session?.interventionPath || (statusPath ? join(dirname(String(statusPath)), "intervention.json") : ""));
      const rawIntervention = !isCorrectionsRun && interventionPath ? await readJsonIfExists(interventionPath) : null;
      const interventionQuestion = String(rawIntervention?.question || "").trim();
      const normalizedIntervention = !isCorrectionsRun && rawIntervention && interventionQuestion ? {
        schemaVersion: 1,
        id: cleanId(rawIntervention.id || `intervention-${observedAttemptId || activeAttemptId || Date.now()}`, "intervention"),
        status: "pending",
        kind: String(rawIntervention.kind || "human_decision"),
        question: interventionQuestion,
        context: String(rawIntervention.context || ""),
        options: Array.isArray(rawIntervention.options) ? rawIntervention.options.map(String).slice(0, 12) : [],
        recommendedOption: rawIntervention.recommendedOption == null ? null : String(rawIntervention.recommendedOption),
        sourceAttemptId: observedAttemptId || activeAttemptId || null,
        sourcePath: interventionPath,
        createdAt: String(rawIntervention.createdAt || new Date().toISOString()),
      } : null;
      const durableInterventionPath = join(dir, "implementation_intervention.json");
      if (exitCode === 0) {
        let outputHandoff: any = null;
        if (!isCorrectionsRun && String(session?.adapter || status?.implementationAdapter || "") === "octopus") {
          outputHandoff = await resolveOctopusAttemptOutput(String(status?.projectRoot || session?.projectRoot || ""), observedAttemptId || activeAttemptId);
        }
        const patch = isCorrectionsRun
          ? { phase: "corrections_completed", owner: "main", nextAction: "Run mechanical validation and council code review again for the corrected delivery.", ok: true, correctionsStdout: stdoutPath, correctionsStderr: stderrPath, directCorrectionsStatus: statusPath, externalValidation: "", validationSummary: "", councilReviewSummary: "", councilReviewSynthesis: "", councilReviewNeedsCorrections: null, councilReviewAttempts: 0 }
          : outputHandoff && !outputHandoff.ok
            ? {
                phase: "implementation_failed",
                owner: "main",
                nextAction: "Fix the Octopus output handoff before retrying implementation.",
                ok: false,
                error: "octopus_output_handoff_failed",
                implementationStdout: stdoutPath,
                implementationStderr: stderrPath,
                directImplementationStatus: statusPath,
                implementationOutputHandoff: outputHandoff,
              }
            : {
                phase: "implementation_delivered",
                owner: "main",
                nextAction: "Run mechanical final validation, then council code review.",
                ok: true,
                implementationStdout: stdoutPath,
                implementationStderr: stderrPath,
                directImplementationStatus: statusPath,
                ...(outputHandoff?.ok ? { outputPath: outputHandoff.outputPath, implementationOutputHandoff: outputHandoff } : {}),
              };
        const observerFinalization = await finalizeObserverSessions(dir, status, "completed");
        // A seat that finished its work can still leave a decision it was not allowed to make. The delivery goes
        // ahead, but the question is recorded and asked, and the delivery PR waits for it instead of merging.
        const pendingDecision = patch.phase === "implementation_delivered" && normalizedIntervention && status?.pendingDecision?.id !== normalizedIntervention.id
          ? normalizedIntervention : null;
        if (pendingDecision) await saveJson(durableInterventionPath, pendingDecision);
        const delivered = await cycleStatus(dir, { ...patch, observerFinalization, ...(pendingDecision ? { pendingDecision, pendingDecisionPath: durableInterventionPath } : {}) });
        if (!pendingDecision) return delivered;
        const optionText = pendingDecision.options.length ? `
Options: ${pendingDecision.options.join(" | ")}` : "";
        const notification = await sendCycleMessage({}, `🧑‍💻 Development Cycle delivered with a decision pending — ${status?.project || "project"}`, `Run: ${status?.runId || ""}
Decision: ${pendingDecision.id}

${pendingDecision.question}${optionText}

The delivery PR stays open until this is answered.`);
        return await cycleStatus(dir, { pendingDecisionNotification: notification });
      }
      if (normalizedIntervention) {
        const interventionId = normalizedIntervention.id;
        await saveJson(durableInterventionPath, normalizedIntervention);
        const observerFinalization = await finalizeObserverSessions(dir, status, "waiting_human");
        const waiting = await cycleStatus(dir, {
          phase: "implementation_waiting_human",
          owner: "main",
          ok: false,
          nextAction: "Reply to main with the requested decision; main should call development_cycle answer_intervention for this run.",
          error: null,
          implementationIntervention: normalizedIntervention,
          implementationInterventionPath: durableInterventionPath,
          implementationInterventionRequestedAt: new Date().toISOString(),
          implementationStdout: stdoutPath,
          implementationStderr: stderrPath,
          directImplementationStatus: statusPath,
          observerFinalization,
        });
        const optionText = normalizedIntervention.options.length ? `
Options: ${normalizedIntervention.options.join(" | ")}` : "";
        const recommendedText = normalizedIntervention.recommendedOption ? `
Recommended: ${normalizedIntervention.recommendedOption}` : "";
        const notification = await sendCycleMessage({}, `🧑‍💻 Development Cycle needs your input — ${status?.project || "project"}`, `Run: ${status?.runId || ""}
Intervention: ${interventionId}

${normalizedIntervention.question}${optionText}${recommendedText}

Reply to main; the run will resume after answer_intervention.`);
        return await cycleStatus(dir, { ...waiting, implementationInterventionNotification: notification });
      }

      let failedOutputHandoff: any = null;
      if (!isCorrectionsRun && String(session?.adapter || status?.implementationAdapter || "") === "octopus") {
        failedOutputHandoff = await resolveOctopusAttemptOutput(String(status?.projectRoot || session?.projectRoot || ""), observedAttemptId || activeAttemptId);
      }
      const reviewInfrastructureFailure = !isCorrectionsRun && failedOutputHandoff?.ok
        ? await detectOctopusReviewInfrastructureFailure(stdoutPath, stderrPath)
        : null;
      const reviewNonConvergence = !isCorrectionsRun && failedOutputHandoff?.ok && !reviewInfrastructureFailure?.resumeEligible
        ? await detectOctopusReviewNonConvergence(stderrPath)
        : null;
      let reviewInfrastructureFailureEvidence = "";
      if (reviewInfrastructureFailure?.ok && reviewInfrastructureFailure.resumeEligible) {
        reviewInfrastructureFailureEvidence = join(dir, "review_infrastructure_failure.json");
        await saveJson(reviewInfrastructureFailureEvidence, {
          schemaVersion: 1,
          detectedAt: new Date().toISOString(),
          exitCode,
          attemptId: observedAttemptId || activeAttemptId || null,
          outputHandoff: failedOutputHandoff,
          failure: reviewInfrastructureFailure,
        });
      }
      const patch = isCorrectionsRun
        ? { phase: "corrections_failed", owner: "main", ok: false, error: `Implementation exited non-zero: ${exitCode}`, correctionsStdout: stdoutPath, correctionsStderr: stderrPath, directCorrectionsStatus: statusPath }
        : reviewInfrastructureFailure?.ok && reviewInfrastructureFailure.resumeEligible
          ? {
              phase: "review_infrastructure_failed",
              owner: "main",
              ok: false,
              nextAction: "Call resume_finalization to revalidate this exact Octopus output, then run run_final_validation. Do not relaunch implementation automatically.",
              error: `Implementation adapter exited non-zero after review infrastructure failure: ${exitCode}`,
              failureClass: "review_infrastructure_failed",
              implementationStdout: stdoutPath,
              implementationStderr: stderrPath,
              directImplementationStatus: statusPath,
              outputPath: failedOutputHandoff.outputPath,
              implementationOutputHandoff: failedOutputHandoff,
              reviewInfrastructureFailure,
              reviewInfrastructureFailureEvidence: reviewInfrastructureFailureEvidence || null,
              reviewInfrastructureResumeEligible: true,
            }
          : {
              phase: "implementation_failed",
              owner: "main",
              ok: false,
              nextAction: reviewNonConvergence?.ok
                ? "Review did not converge: deliver the partial Octopus output and open one issue per remaining blocking finding."
                : failedOutputHandoff?.ok
                ? "A validated partial Octopus output is available for repository delivery."
                : "Inspect Implementation stdout/stderr, fix blockers, then launch a new clean handoff.",
              error: `Implementation exited non-zero: ${exitCode}`,
              ...(reviewNonConvergence?.ok ? { failureClass: "review_non_convergence", reviewNonConvergence } : {}),
              implementationStdout: stdoutPath,
              implementationStderr: stderrPath,
              directImplementationStatus: statusPath,
              ...(failedOutputHandoff?.ok
                ? { outputPath: failedOutputHandoff.outputPath, implementationOutputHandoff: failedOutputHandoff }
                : failedOutputHandoff
                  ? { implementationOutputHandoff: failedOutputHandoff }
                  : {}),
            };
      const observerFinalization = await finalizeObserverSessions(dir, status, "failed");
      return await cycleStatus(dir, { ...patch, observerFinalization });
    }
    return status;
  }

  return { refreshLaunchedImplementationStatus };
}
