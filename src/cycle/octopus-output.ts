import { realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { cleanId } from "../core/ids.js";
import { execFileAsync } from "./exec.js";
import { readJsonIfExists, textTail } from "./files.js";
import type { createPinnedFs } from "./pinned-fs.js";

export interface OctopusOutputDeps {
  wikiRoot: string;
  runtimeHome: string;
  pinTrustedProjectRoot: ReturnType<typeof createPinnedFs>["pinTrustedProjectRoot"];
}

export function createOctopusOutput(deps: OctopusOutputDeps) {
  const { wikiRoot, runtimeHome, pinTrustedProjectRoot } = deps;

  async function execGit(args: string[], cwd = wikiRoot, timeout = 10000) {
    try {
      const res = await execFileAsync("git", args, { cwd, timeout, maxBuffer: 1024 * 1024 });
      return { ok: true, stdout: String(res.stdout || ""), stderr: String(res.stderr || "") };
    } catch (err: any) {
      return { ok: false, stdout: String(err?.stdout || ""), stderr: String(err?.stderr || ""), error: String(err?.message || err) };
    }
  }

  function effectiveImplementationRoot(status: any, params: any = {}) {
    return String(status?.outputPath || params?.projectRoot || status?.projectRoot || "").trim();
  }

  function octopusDeliveryRequiresOutputPath(status: any) {
    return String(status?.implementationAdapter || "").trim() === "octopus";
  }

  function hasMaterializedImplementationOutput(status: any) {
    return Boolean(String(status?.outputPath || "").trim());
  }

  function repositoryDeliveryMissingRequiredOutput(status: any) {
    return octopusDeliveryRequiresOutputPath(status) && !hasMaterializedImplementationOutput(status);
  }

  async function resolveOctopusAttemptOutput(projectRoot: string, attemptId: string) {
    const safeAttemptId = cleanId(attemptId || "", "attempt");
    const manifestPath = join(runtimeHome, ".claude-octopus", "results", `.tangle-${safeAttemptId}-git.json`);
    if (!safeAttemptId) return { ok: false, error: "octopus_attempt_id_missing", manifestPath };
    const manifest = await readJsonIfExists(manifestPath);
    if (!manifest) return { ok: false, error: "octopus_output_manifest_missing", manifestPath, attemptId: safeAttemptId };

    const manifestSource = String(manifest.sourceRepository || "").trim();
    const runWorktree = String(manifest.runWorktree || "").trim();
    const runBranch = String(manifest.runBranch || "").trim();
    const expectedBranch = `octopus/run/${safeAttemptId}/integration`;
    if (!manifestSource || !runWorktree || !runBranch) {
      return { ok: false, error: "octopus_output_manifest_incomplete", manifestPath, attemptId: safeAttemptId };
    }

    const sourcePinned = await pinTrustedProjectRoot(projectRoot);
    const manifestSourcePinned = await pinTrustedProjectRoot(manifestSource);
    const outputPinned = await pinTrustedProjectRoot(runWorktree);
    try {
      if (!sourcePinned || !manifestSourcePinned || !outputPinned) {
        return { ok: false, error: "octopus_output_manifest_untrusted_checkout", manifestPath, attemptId: safeAttemptId };
      }
      if (sourcePinned.realPath !== manifestSourcePinned.realPath) {
        return { ok: false, error: "octopus_output_source_mismatch", manifestPath, attemptId: safeAttemptId, expectedSource: sourcePinned.realPath, manifestSource: manifestSourcePinned.realPath };
      }
      if (runBranch !== expectedBranch) {
        return { ok: false, error: "octopus_output_branch_mismatch", manifestPath, attemptId: safeAttemptId, expectedBranch, manifestBranch: runBranch };
      }
      const top = await execGit(["rev-parse", "--show-toplevel"], outputPinned.procPath, 10000);
      const branch = await execGit(["symbolic-ref", "--quiet", "--short", "HEAD"], outputPinned.procPath, 10000);
      if (!top.ok || !branch.ok) {
        return { ok: false, error: "octopus_output_git_probe_failed", manifestPath, attemptId: safeAttemptId };
      }
      const topReal = await realpath(String(top.stdout || "").trim()).catch(() => "");
      const actualBranch = String(branch.stdout || "").trim();
      if (!topReal || topReal !== outputPinned.realPath) {
        return { ok: false, error: "octopus_output_worktree_mismatch", manifestPath, attemptId: safeAttemptId, expectedWorktree: outputPinned.realPath, gitTopLevel: topReal || null };
      }
      if (actualBranch !== runBranch) {
        return { ok: false, error: "octopus_output_checked_out_branch_mismatch", manifestPath, attemptId: safeAttemptId, manifestBranch: runBranch, actualBranch };
      }
      return { ok: true, attemptId: safeAttemptId, manifestPath, outputPath: outputPinned.realPath, sourceRepository: sourcePinned.realPath, sourceCommit: String(manifest.sourceCommit || "").trim() || null, runBranch };
    } finally {
      await sourcePinned?.handle.close().catch(() => null);
      await manifestSourcePinned?.handle.close().catch(() => null);
      await outputPinned?.handle.close().catch(() => null);
    }
  }

  async function detectOctopusReviewInfrastructureFailure(stdoutPath: string, stderrPath: string) {
    const stdout = stdoutPath ? await textTail(stdoutPath, 60000) : "";
    const stderr = stderrPath ? await textTail(stderrPath, 30000) : "";
    const text = `${stdout}\n${stderr}`;
    const lower = text.toLowerCase();
    const noChangesIndex = lower.lastIndexOf("no changes found to review");
    if (noChangesIndex < 0) return { ok: false, resumeEligible: false, contraindication: null };

    // Octopus review output is not stable enough to require one literal heading.
    // Prefer the nearest known review boundary before the final no-changes verdict.
    const reviewBoundaries = [
      lower.lastIndexOf("contextual code review", noChangesIndex),
      lower.lastIndexOf("quality gate:", noChangesIndex),
      lower.lastIndexOf("/octo:review", noChangesIndex),
      lower.lastIndexOf("proof packet:", noChangesIndex),
    ].filter((index) => index >= 0);
    const reviewMarker = reviewBoundaries.length ? Math.max(...reviewBoundaries) : Math.max(0, noChangesIndex - 12000);
    const reviewText = text.slice(reviewMarker);
    const noChanges = reviewText.match(/No changes found to review/i);
    const reviewEvidence = reviewText.match(/Contextual code review|\/octo:review|Quality Gate:|Proof packet:|This is NOT a clean review|zero providers returned results/i);
    const contraindication = reviewText.match(/(?:\b401\b|\b403\b|unauthori[sz]ed|missing bearer|authentication (?:failed|error)|oauth (?:failed|error)|\b429\b|rate[ -]?limit|quota|insufficient_quota|billing|payment required|timed out|timeout (?:exceeded|after|while|waiting|reached)|exit(?:ed)?(?: code)? 124|provider (?:failed|error)|network (?:failed|error)|connection (?:failed|reset|refused))/i);
    if (!noChanges || !reviewEvidence || contraindication) {
      return {
        ok: false,
        resumeEligible: false,
        contraindication: contraindication
          ? { name: "review_resume_contraindication", pattern: "auth_quota_timeout_provider_network", match: contraindication[0] }
          : null,
      };
    }
    return {
      ok: true,
      resumeEligible: true,
      failureClass: "review_infrastructure_failed",
      reason: "octopus_contextual_review_reported_no_changes",
      matched: { name: "octopus_contextual_review_no_changes", pattern: "No changes found to review", match: noChanges[0] },
      stdoutPath: stdoutPath || null,
      stderrPath: stderrPath || null,
    };
  }

  // Octopus stops its review/correction loop at a fixed round ceiling and names
  // the last findings file in the error line. Those findings are the residue the
  // cycle hands on as follow-up issues, so read them from the trusted results dir.
  async function detectOctopusReviewNonConvergence(stderrPath: string) {
    const stderr = stderrPath ? await textTail(stderrPath, 30000) : "";
    const match = stderr.replace(/\x1b\[[0-9;]*m/g, "").match(/Correction loop hit the absolute round ceiling \((\d+)\) with (\d+) blocking finding\(s\) remaining: (\S+\.json)/);
    if (!match) return { ok: false };
    const resultsDir = join(runtimeHome, ".claude-octopus", "results");
    let findingsPath = "";
    try {
      const [real, realDir] = await Promise.all([realpath(match[3]), realpath(resultsDir)]);
      const rel = relative(realDir, real);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) findingsPath = real;
    } catch {}
    const doc = findingsPath ? await readJsonIfExists(findingsPath) : null;
    const remaining = (Array.isArray(doc?.findings) ? doc.findings : [])
      .filter((f: any) => String(f?.severity || "") === "normal")
      .map((f: any) => ({
        file: String(f?.file || ""),
        line: Number.isFinite(Number(f?.line)) ? Number(f.line) : null,
        category: String(f?.category || ""),
        title: String(f?.title || "").trim(),
        detail: String(f?.detail || "").trim(),
      }))
      .filter((f: any) => f.title);
    return {
      ok: true,
      failureClass: "review_non_convergence",
      roundCeiling: Number(match[1]),
      blockingCount: Number(match[2]),
      findingsPath: findingsPath || null,
      remaining,
      matched: { name: "octopus_correction_round_ceiling", pattern: "Correction loop hit the absolute round ceiling", match: match[0].slice(0, 220) },
    };
  }

  async function octopusAttemptPristine(status: any) {
    const attemptId = cleanId(status?.implementationAttemptId || "", "attempt");
    const projectRoot = String(status?.projectRoot || "").trim();
    if (!attemptId || !projectRoot) return { pristine: false, reason: "attempt_or_project_root_missing" };
    const worktreePath = join(runtimeHome, ".claude-octopus", "worktrees", "tangle", attemptId, "integration");
    const sourcePinned = await pinTrustedProjectRoot(projectRoot);
    const worktreePinned = await pinTrustedProjectRoot(worktreePath);
    try {
      if (!sourcePinned || !worktreePinned) return { pristine: false, reason: "worktree_missing_or_untrusted", worktreePath };
      const [sourceHead, worktreeHead, worktreeStatus] = await Promise.all([
        execGit(["rev-parse", "HEAD"], sourcePinned.procPath, 10000),
        execGit(["rev-parse", "HEAD"], worktreePinned.procPath, 10000),
        execGit(["status", "--porcelain"], worktreePinned.procPath, 10000),
      ]);
      if (!sourceHead.ok || !worktreeHead.ok || !worktreeStatus.ok) return { pristine: false, reason: "git_probe_failed", worktreePath };
      const source = String(sourceHead.stdout || "").trim();
      const head = String(worktreeHead.stdout || "").trim();
      const dirty = String(worktreeStatus.stdout || "").trim();
      return {
        pristine: Boolean(source && head && source === head && !dirty),
        reason: source !== head ? "worktree_has_commits" : dirty ? "worktree_dirty" : "pristine",
        worktreePath: worktreePinned.realPath,
        sourceHead: source,
        worktreeHead: head,
      };
    } finally {
      await sourcePinned?.handle.close().catch(() => null);
      await worktreePinned?.handle.close().catch(() => null);
    }
  }

  return { execGit, effectiveImplementationRoot, repositoryDeliveryMissingRequiredOutput, resolveOctopusAttemptOutput, detectOctopusReviewInfrastructureFailure, detectOctopusReviewNonConvergence, octopusAttemptPristine };
}
