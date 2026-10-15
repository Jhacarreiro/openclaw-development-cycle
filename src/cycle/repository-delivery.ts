import { open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { cleanId } from "../core/ids.js";
import { inferDeliveryClassification } from "../core/delivery-classification.js";
import { captureCheckoutIdentity, validationEvidenceMatches } from "../runtime/validation-evidence.js";
import { execSupervisedCommand } from "../runtime/processes.js";
import { excerpt } from "./files.js";
import type { createCycleStore } from "./cycle-store.js";
import type { createPinnedFs } from "./pinned-fs.js";
import type { createOctopusOutput } from "./octopus-output.js";
import type { DevelopmentCycleConfig } from "../config.js";

export interface RepositoryDeliveryDeps {
  repositoryDeliveryConfig: DevelopmentCycleConfig["repositoryDelivery"];
  loadJson: ReturnType<typeof createCycleStore>["loadJson"];
  saveJson: ReturnType<typeof createCycleStore>["saveJson"];
  cycleStatus: ReturnType<typeof createCycleStore>["cycleStatus"];
  pinTrustedProjectRoot: ReturnType<typeof createPinnedFs>["pinTrustedProjectRoot"];
  pinAllowedCanonicalPlan: ReturnType<typeof createPinnedFs>["pinAllowedCanonicalPlan"];
  execGit: ReturnType<typeof createOctopusOutput>["execGit"];
  effectiveImplementationRoot: ReturnType<typeof createOctopusOutput>["effectiveImplementationRoot"];
  repositoryDeliveryMissingRequiredOutput: ReturnType<typeof createOctopusOutput>["repositoryDeliveryMissingRequiredOutput"];
  resolveOctopusAttemptOutput: ReturnType<typeof createOctopusOutput>["resolveOctopusAttemptOutput"];
}

export function createRepositoryDelivery(deps: RepositoryDeliveryDeps) {
  const { repositoryDeliveryConfig, loadJson, saveJson, cycleStatus, pinTrustedProjectRoot, pinAllowedCanonicalPlan, execGit, effectiveImplementationRoot, repositoryDeliveryMissingRequiredOutput, resolveOctopusAttemptOutput } = deps;

  async function resumeReviewInfrastructureFinalization(dir: string, status: any) {
    if (String(status?.phase || "") !== "review_infrastructure_failed") {
      return { ok: false, error: "review_infrastructure_phase_required" };
    }
    if (status?.reviewInfrastructureResumeEligible !== true) {
      return { ok: false, error: "review_infrastructure_resume_not_eligible", hint: "Resolve the review blocker or start a new clean implementation handoff." };
    }
    if (String(status?.implementationAdapter || "") !== "octopus") {
      return { ok: false, error: "octopus_adapter_required" };
    }
    const attemptId = String(status?.implementationAttemptId || status?.implementationOutputHandoff?.attemptId || "").trim();
    const projectRoot = String(status?.projectRoot || "").trim();
    if (!attemptId || !projectRoot) return { ok: false, error: "review_resume_identity_missing", attemptId: attemptId || null, projectRoot: projectRoot || null };

    const outputHandoff = await resolveOctopusAttemptOutput(projectRoot, attemptId);
    if (!outputHandoff?.ok) return { ok: false, error: "octopus_output_revalidation_failed", outputHandoff };
    const previousOutputPath = String(status?.outputPath || "").trim();
    if (previousOutputPath && previousOutputPath !== outputHandoff.outputPath) {
      return { ok: false, error: "octopus_output_path_changed", previousOutputPath, revalidatedOutputPath: outputHandoff.outputPath };
    }

    const recoveredAt = new Date().toISOString();
    const recoveryPath = join(dir, "review_infrastructure_recovery.json");
    const recovery = {
      schemaVersion: 1,
      recoveredAt,
      fromPhase: "review_infrastructure_failed",
      attemptId,
      projectRoot,
      outputPath: outputHandoff.outputPath,
      outputHandoff,
      failure: status?.reviewInfrastructureFailure || null,
      nextRequiredAction: "run_final_validation",
    };
    await saveJson(recoveryPath, recovery);
    const next = await cycleStatus(dir, {
      phase: "implementation_delivered",
      owner: "main",
      ok: true,
      error: null,
      failureClass: null,
      failureSeverity: null,
      failureHumanRequired: null,
      failureSafeToAutoRetry: null,
      failureAutoStopRecommended: null,
      failureRecommendedAction: null,
      failureMatched: null,
      outputPath: outputHandoff.outputPath,
      implementationOutputHandoff: outputHandoff,
      reviewInfrastructureResumeEligible: false,
      reviewInfrastructureRecoveredAt: recoveredAt,
      reviewInfrastructureRecovery: recoveryPath,
      resumedFromPhase: "review_infrastructure_failed",
      requiredMechanicalValidation: true,
      validationEvidence: null,
      nextAction: "Run run_final_validation against the preserved Octopus output before final review or repository delivery.",
    });
    return { ok: true, phase: next.phase, recoveryPath, outputHandoff, status: next };
  }

  function repositoryFindings(status: any, max = 12) {
    const raw = [...(status?.councilReviewFindings || [])];
    const residue = status?.reviewNonConvergence?.ok && Array.isArray(status.reviewNonConvergence.remaining) ? status.reviewNonConvergence.remaining : null;
    if (residue) {
      // One issue per finding the review left blocking; the failure's own
      // recommended action describes the run, not work left in the code.
      for (const f of residue) raw.push(`${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}${f.detail ? `: ${f.detail}` : ""}`);
      // Octopus reported blocking findings but its findings file could not be
      // read: keep one follow-up so the residue is never dropped silently.
      if (!residue.length && Number(status.reviewNonConvergence.blockingCount) > 0) {
        raw.push(`Review stopped after ${status.reviewNonConvergence.roundCeiling} correction round(s) with ${status.reviewNonConvergence.blockingCount} blocking finding(s) left, but the findings file could not be read: re-review this branch.`);
      }
    } else if (status?.failureRecommendedAction) raw.push(String(status.failureRecommendedAction));
    const out: string[] = [];
    for (const value of raw) {
      const text = String(value || "").trim().replace(/\s+/g, " ");
      if (!text || out.includes(text)) continue;
      out.push(text);
      if (out.length >= max) break;
    }
    return out;
  }

  async function requiredValidationError(status: any): Promise<string | null> {
    if (!status?.requiredMechanicalValidation && !status?.validationEvidence) return null;
    if (status?.externalValidationDecision !== "go" || !status?.validationEvidence) return "mechanical_validation_required";
    const pinned = await pinTrustedProjectRoot(effectiveImplementationRoot(status));
    if (!pinned) return "validation_checkout_untrusted";
    try {
      const identity = await captureCheckoutIdentity(pinned.procPath);
      const attemptId = String(status?.correctionsAttemptId || status?.implementationAttemptId || "");
      return validationEvidenceMatches(status.validationEvidence, attemptId, pinned.realPath, identity) ? null : "validation_evidence_stale";
    } catch { return "validation_identity_unreadable"; }
    finally { await pinned.handle.close(); }
  }

  async function runRepositoryDeliveryAdapter(dir: string, status: any, params: any) {
    const project = cleanId(params.project || status?.project || "default");
    const runId = cleanId(params.runId || status?.runId || "run");
    const missingRequiredOutput = repositoryDeliveryMissingRequiredOutput(status);
    const projectRoot = missingRequiredOutput ? "" : effectiveImplementationRoot(status, params);
    const sourceProjectRoot = String(params.projectRoot || status?.projectRoot || "");
    const sourcePhase = String(status?.phase || "");
    const requestPath = join(dir, "repository_delivery_request.json");
    const previousRequest = await loadJson(requestPath);
    const operation = params.repositoryDeliveryOperation || "publish";
    const classificationPhase = sourcePhase === "repository_delivery_failed" || sourcePhase === "delivery_published"
      ? String(status?.repositoryDeliverySourcePhase || previousRequest.acceptedSourcePhase || previousRequest.sourcePhase || "") : sourcePhase;
    const classification = missingRequiredOutput
      ? "invalid"
      : operation === "status" ? String(status?.repositoryDelivery?.classification || "invalid")
      : inferDeliveryClassification(classificationPhase, params.deliveryClassification || status?.repositoryDelivery?.classification);
    if (classification === "success" && operation !== "status") {
      const validationError = await requiredValidationError(status);
      if (validationError) return { ok: false, classification, error: validationError };
    }
    const resultPath = join(dir, "repository_delivery.json");
    const request = {
      schemaVersion: 1,
      operation,
      project,
      runId,
      projectRoot,
      sourceProjectRoot,
      outputPath: status?.outputPath || null,
      sourcePhase,
      acceptedSourcePhase: classificationPhase,
      classification,
      baseBranch: String(params.repositoryBaseBranch || repositoryDeliveryConfig.baseBranch || "main"),
      autoMerge: operation !== "status" && classification === "success" && repositoryDeliveryConfig.autoMergeSuccessful,
      findings: repositoryFindings(status),
      existingDelivery: status?.repositoryDelivery || null,
      createdAt: new Date().toISOString(),
    };
    await saveJson(requestPath, request);
    if (classification === "invalid") {
      const result = { ok: false, skipped: true, classification, reason: missingRequiredOutput ? "octopus_output_path_missing" : "delivery_classified_invalid", requestPath, projectRoot, sourceProjectRoot, outputPath: status?.outputPath || null };
      await saveJson(resultPath, result);
      return { ...result, resultPath };
    }
    if (!repositoryDeliveryConfig.enabled) {
      const result = {
        ok: true,
        skipped: true,
        localOnly: true,
        classification,
        reason: "repository_delivery_disabled",
        requestPath,
        completedAt: new Date().toISOString(),
      };
      await saveJson(resultPath, result);
      return { ...result, resultPath };
    }
    if (!projectRoot) return { ok: false, classification, error: "projectRoot_missing", requestPath, resultPath };
    if (!repositoryDeliveryConfig.command) return { ok: false, classification, error: "repository_delivery_command_missing", requestPath, resultPath };
    let execResult: any;
    try {
      execResult = await execSupervisedCommand(repositoryDeliveryConfig.command, [...repositoryDeliveryConfig.args, requestPath], {
        cwd: projectRoot,
        timeout: Number(params.repositoryDeliveryTimeoutMs || 120000),
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch (err: any) {
      const result = {
        ok: false,
        classification,
        error: String(err?.message || err),
        stdout: excerpt(err?.stdout || "", 4000),
        stderr: excerpt(err?.stderr || "", 4000),
        requestPath,
      };
      await saveJson(resultPath, result);
      return { ...result, resultPath };
    }
    let parsed: any = null;
    try { parsed = JSON.parse(String(execResult.stdout || "").trim()); } catch {}
    const result = parsed && typeof parsed === "object" ? { ...parsed, classification, requestPath, completedAt: new Date().toISOString() } : {
      ok: false,
      classification,
      error: "repository_delivery_invalid_json",
      stdout: excerpt(execResult.stdout || "", 4000),
      stderr: excerpt(execResult.stderr || "", 4000),
      requestPath,
    };
    await saveJson(resultPath, result);
    return { ...result, resultPath };
  }

  async function finalizeRepositoryDeliveryState(dir: string, status: any, params: any) {
    if (["final_validated", "council_validated"].includes(String(status?.phase || ""))) {
      await cycleStatus(dir, { repositoryDeliverySourcePhase: status.phase });
    }
    const delivery = await runRepositoryDeliveryAdapter(dir, status, params);
    if (delivery.localOnly) {
      const phase = delivery.classification === "success" ? "closed_success" : "closed_partial";
      const next = await cycleStatus(dir, {
        phase,
        owner: "main",
        ok: true,
        repositoryDelivery: delivery,
        nextAction: "none",
      });
      return { ok: true, phase: next.phase, status: next, delivery };
    }
    if (!delivery.ok) {
      const phase = delivery.skipped ? "closed_invalid" : "repository_delivery_failed";
      const next = await cycleStatus(dir, {
        phase,
        owner: "main",
        ok: false,
        repositoryDelivery: delivery,
        nextAction: delivery.skipped ? "none" : "Fix repository delivery and retry finalize_delivery.",
      });
      return { ok: false, phase: next.phase, status: next, delivery };
    }
    const phase = delivery.classification === "success"
      ? (delivery.merged ? "merged" : "delivery_published")
      : "closed_partial";
    const next = await cycleStatus(dir, {
      phase,
      owner: "main",
      ok: true,
      repositoryDelivery: delivery,
      nextAction: phase === "delivery_published" ? "Wait for repository checks/auto-merge." : "none",
    });
    return { ok: true, phase: next.phase, status: next, delivery };
  }

  async function reconcileRepositoryDeliveryState(dir: string, status: any, params: any) {
    if (!repositoryDeliveryConfig.enabled || String(status?.phase || "") !== "delivery_published") return null;
    const checked = await runRepositoryDeliveryAdapter(dir, status, { ...params, repositoryDeliveryOperation: "status" });
    if (!checked.ok) return { ok: false, status, delivery: checked };
    if (!checked.merged) return { ok: true, status: { ...status, repositoryDelivery: checked }, delivery: checked };
    const next = await cycleStatus(dir, {
      phase: "merged",
      owner: "main",
      ok: true,
      repositoryDelivery: checked,
      nextAction: "none",
    });
    return { ok: true, status: next, delivery: checked };
  }

  async function autoCommitCanonicalPlan(project: string, runId: string, canonicalPlan: string) {
    const pinned = await pinAllowedCanonicalPlan(canonicalPlan);
    if (!pinned) return { ok: false, skipped: true, reason: "canonical_plan_path_not_allowlisted", canonicalPlan };
    const { rel, wiki } = pinned;
    try {
      const fileHandle = await open(`${wiki.procPath}/${rel}`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null);
      if (!fileHandle) return { ok: false, skipped: true, reason: "canonical_plan_missing", canonicalPlan };
      try {
        const st = await fileHandle.stat();
        if (!st.isFile()) return { ok: false, skipped: true, reason: "canonical_plan_missing", canonicalPlan };
      } finally {
        await fileHandle.close().catch(() => null);
      }

      const stagedBefore = await execGit(["diff", "--cached", "--name-only"], wiki.procPath);
      if (!stagedBefore.ok) return { ok: false, skipped: true, reason: "git_staged_check_failed", detail: excerpt(`${stagedBefore.error || ""}\n${stagedBefore.stderr || ""}`, 2000) };
      const staged = stagedBefore.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      const foreignStaged = staged.filter((x) => x !== rel);
      if (foreignStaged.length) return { ok: false, skipped: true, reason: "foreign_staged_changes_present", staged: foreignStaged.slice(0, 20) };

      const add = await execGit(["add", "--", rel], wiki.procPath);
      if (!add.ok) return { ok: false, skipped: true, reason: "git_add_failed", detail: excerpt(`${add.error || ""}\n${add.stderr || ""}`, 2000), canonicalPlan };

      const status = await execGit(["status", "--short", "--", rel], wiki.procPath);
      if (!status.ok) return { ok: false, skipped: true, reason: "git_status_failed", detail: excerpt(`${status.error || ""}\n${status.stderr || ""}`, 2000), canonicalPlan };
      if (!status.stdout.trim()) return { ok: true, skipped: true, reason: "no_plan_changes_to_commit", canonicalPlan, relativePath: rel };

      const stagedAfter = await execGit(["diff", "--cached", "--name-only"], wiki.procPath);
      if (!stagedAfter.ok) return { ok: false, skipped: true, reason: "git_staged_after_check_failed", detail: excerpt(`${stagedAfter.error || ""}\n${stagedAfter.stderr || ""}`, 2000), canonicalPlan };
      const stagedAfterFiles = stagedAfter.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      const unexpected = stagedAfterFiles.filter((x) => x !== rel);
      if (unexpected.length) return { ok: false, skipped: true, reason: "unexpected_staged_changes_present", staged: unexpected.slice(0, 20), canonicalPlan };

      const message = `development-cycle: track approved plan for ${cleanId(project)} ${cleanId(runId)}`;
      const commit = await execGit(["commit", "-m", message, "--", rel], wiki.procPath, 20000);
      if (!commit.ok) return { ok: false, skipped: true, reason: "git_commit_failed", detail: excerpt(`${commit.error || ""}\n${commit.stdout || ""}\n${commit.stderr || ""}`, 3000), canonicalPlan, relativePath: rel };

      const rev = await execGit(["rev-parse", "--short", "HEAD"], wiki.procPath);
      return { ok: true, skipped: false, commit: rev.ok ? rev.stdout.trim() : "", message, canonicalPlan, relativePath: rel };
    } finally {
      await wiki.handle.close().catch(() => null);
    }
  }

  return { resumeReviewInfrastructureFinalization, requiredValidationError, finalizeRepositoryDeliveryState, reconcileRepositoryDeliveryState, autoCommitCanonicalPlan };
}
