import { join } from "node:path";
import { cleanId } from "../core/ids.js";
import { readTextIfExists } from "./files.js";
import type { createCycleStore } from "./cycle-store.js";
import type { createPinnedFs } from "./pinned-fs.js";
import type { createOctopusOutput } from "./octopus-output.js";
import type { createRepositoryDelivery } from "./repository-delivery.js";
import type { DevelopmentCycleConfig } from "../config.js";

export interface FollowUpDeps {
  repositoryDeliveryConfig: DevelopmentCycleConfig["repositoryDelivery"];
  cycleDir: ReturnType<typeof createCycleStore>["cycleDir"];
  loadJson: ReturnType<typeof createCycleStore>["loadJson"];
  execGit: ReturnType<typeof createOctopusOutput>["execGit"];
  pinTrustedProjectRoot: ReturnType<typeof createPinnedFs>["pinTrustedProjectRoot"];
  readRepositoryFollowUps: ReturnType<typeof createRepositoryDelivery>["readRepositoryFollowUps"];
}

// The plan a follow-up run executes: the open issues a partial delivery left,
// on top of the code that delivery already holds. The original plan travels
// along as fenced context so its own headings and paths stay out of this plan.
export function buildFollowUpPlan(input: {
  sourceRunId: string;
  pullRequestUrl: string;
  branch: string;
  projectRoot: string;
  projectWikiPath: string;
  issues: Array<{ number: number; title: string; body: string; url: string }>;
  originalPlan: string;
}) {
  const tasks = input.issues.map((issue, index) => {
    const finding = String(issue.body || "").split(/\n\s*Finding:\s*\n/)[1]?.split(/\n\s*Acceptance criteria:/)[0]?.trim()
      || String(issue.title || "").replace(/^Follow-up:\s*/i, "");
    return `${index + 1}. Resolve issue #${issue.number} (${issue.url}): ${finding.replace(/\s+/g, " ")}`;
  });
  return [
    `# Follow-up plan for ${input.sourceRunId}`,
    "",
    `The previous run's review stopped before it converged. Its work is delivered on ${input.pullRequestUrl} (branch \`${input.branch}\`), and projectRoot is a checkout of that branch. Keep that work; resolve only the open issues below.`,
    "",
    "## Ordered implementation tasks",
    "",
    ...tasks,
    "",
    "## Validation checks",
    "",
    "- Each issue above is resolved in code and covered where the original plan's tests already reach that behaviour.",
    "- The validation checks of the original approved plan still pass.",
    "",
    "## Stop conditions",
    "",
    "- Stop and report before risky, destructive or protected changes, or when an issue needs a product decision the original plan does not settle.",
    "- Do not redo or restructure work the original plan already delivered.",
    "",
    "## Expected artifacts",
    "",
    `- Commits on top of \`${input.branch}\` that resolve the issues above.`,
    "",
    "## Project paths",
    "",
    `- projectRoot: ${input.projectRoot}`,
    `- projectWikiPath: ${input.projectWikiPath}`,
    "",
    "## Original approved plan (context, already implemented on this branch)",
    "",
    "````markdown",
    String(input.originalPlan || "").trim(),
    "````",
    "",
  ].join("\n");
}

export function createFollowUp(deps: FollowUpDeps) {
  const { repositoryDeliveryConfig, cycleDir, loadJson, execGit, pinTrustedProjectRoot, readRepositoryFollowUps } = deps;

  // Everything a follow-up run needs from the run whose partial delivery it
  // continues, or the reason it cannot start.
  async function prepareFollowUp(project: string, fromRunId: string, newDir: string) {
    const sourceRunId = cleanId(fromRunId || "", "");
    if (!sourceRunId) return { ok: false as const, error: "fromRunId_required" };
    const sourceDir = cycleDir(project, sourceRunId);
    const source: any = await loadJson(join(sourceDir, "status.json"));
    if (String(source?.phase || "") !== "closed_partial") return { ok: false as const, error: "followup_source_not_closed_partial", phase: source?.phase || null };
    const delivery: any = source?.repositoryDelivery || {};
    const pullRequestNumber = Number(delivery?.pullRequest?.number || 0);
    const branch = String(delivery?.branch || "");
    // A follow-up that did not converge either carries the issues it was given
    // as well as the ones its own delivery opened.
    const issueNumbers = [...new Set([...(source?.followUp?.issues || []), ...(delivery?.issues || [])]
      .map((issue: any) => Number(issue?.number)).filter((n: number) => Number.isInteger(n) && n > 0))];
    if (!delivery?.ok || !pullRequestNumber || !branch) return { ok: false as const, error: "followup_source_has_no_delivery_pull_request" };
    if (!issueNumbers.length) return { ok: false as const, error: "followup_source_has_no_issues" };
    const generation = Number(source?.followUp?.generation || 0) + 1;
    if (generation > repositoryDeliveryConfig.followUpMaxGenerations) {
      return { ok: false as const, error: "followup_generation_limit", generation, limit: repositoryDeliveryConfig.followUpMaxGenerations };
    }

    // The delivered checkout must still be at the commit the PR received, so
    // the follow-up builds on exactly what the PR holds.
    const pinned = await pinTrustedProjectRoot(String(source?.outputPath || ""));
    if (!pinned) return { ok: false as const, error: "followup_delivered_checkout_missing" };
    const projectRoot = pinned.realPath;
    await pinned.handle.close().catch(() => null);
    const head = await execGit(["rev-parse", "HEAD"], projectRoot);
    const clean = await execGit(["status", "--porcelain"], projectRoot);
    if (!head.ok || !clean.ok) return { ok: false as const, error: "followup_delivered_checkout_unreadable" };
    if (clean.stdout.trim()) return { ok: false as const, error: "followup_delivered_checkout_dirty" };

    const state = await readRepositoryFollowUps(newDir, projectRoot, issueNumbers, pullRequestNumber);
    if (!state?.ok) return { ok: false as const, error: "followup_issue_lookup_failed", detail: state?.error || null };
    const pullRequest = state.pullRequest || {};
    if (pullRequest.state !== "OPEN") return { ok: false as const, error: "followup_pull_request_not_open", pullRequest };
    if (String(pullRequest.headRefOid || "") !== head.stdout.trim()) {
      return { ok: false as const, error: "followup_pull_request_moved", expected: head.stdout.trim(), actual: pullRequest.headRefOid || null };
    }
    const issues = (state.issues || []).filter((issue: any) => String(issue?.state || "").toUpperCase() === "OPEN");
    if (!issues.length) return { ok: false as const, error: "followup_no_open_issues" };

    const originalPlan = await readTextIfExists(String(source?.followUp?.originalPlan || source?.plan || join(sourceDir, "implementation_plan.md")));
    const planText = buildFollowUpPlan({
      sourceRunId,
      pullRequestUrl: String(pullRequest.url || delivery.pullRequest.url || ""),
      branch,
      projectRoot,
      projectWikiPath: String(source?.projectWikiPath || ""),
      issues,
      originalPlan,
    });
    return {
      ok: true as const,
      sourceDir,
      projectRoot,
      projectWikiPath: String(source?.projectWikiPath || ""),
      implementationAdapter: source?.implementationAdapter || null,
      planText,
      followUp: {
        fromRunId: sourceRunId,
        rootRunId: String(source?.followUp?.rootRunId || sourceRunId),
        generation,
        branch,
        commit: head.stdout.trim(),
        pullRequest: { number: pullRequestNumber, url: String(pullRequest.url || "") },
        issues: issues.map((issue: any) => ({ number: issue.number, title: issue.title, url: issue.url })),
        originalPlan: String(source?.followUp?.originalPlan || source?.plan || join(sourceDir, "implementation_plan.md")),
      },
    };
  }

  return { prepareFollowUp };
}
