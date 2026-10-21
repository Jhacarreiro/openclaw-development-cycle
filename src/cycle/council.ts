import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validationRuleMatches } from "../core/validation-config.js";
import { cleanId } from "../core/ids.js";
import { parseCouncilDecision, resolveAutoCouncilCorrectionsMax } from "../core/council-policy.js";
import { execSupervisedCommand } from "../runtime/processes.js";
import { readTextIfExists, excerpt, readJsonIfExists, execSummary } from "./files.js";
import type { createCycleStore } from "./cycle-store.js";
import type { createRunnerSession } from "./runner-session.js";
import type { createObserver } from "./observer.js";
import type { createPinnedFs } from "./pinned-fs.js";
import type { createOctopusOutput } from "./octopus-output.js";
import type { createExternalGate } from "./external-gate.js";
import type { DevelopmentCycleConfig } from "../config.js";
import { DEVELOPMENT_CYCLE_BIN_DIR, octopusCouncilSeats } from "../adapters/implementation.js";

export interface CouncilDeps {
  developmentCycleConfig: DevelopmentCycleConfig;
  projectsWikiRoot: string;
  implementationConfig: DevelopmentCycleConfig["implementation"];
  defaultCodexSandbox: string;
  cycleStatus: ReturnType<typeof createCycleStore>["cycleStatus"];
  createImplementationRunnerSession: ReturnType<typeof createRunnerSession>["createImplementationRunnerSession"];
  createImplementationObserverSession: ReturnType<typeof createObserver>["createImplementationObserverSession"];
  updateImplementationObserverSession: ReturnType<typeof createObserver>["updateImplementationObserverSession"];
  resolveTrustedProjectWikiPath: ReturnType<typeof createPinnedFs>["resolveTrustedProjectWikiPath"];
  writePinnedFile: ReturnType<typeof createPinnedFs>["writePinnedFile"];
  resolveContainedWikiDir: ReturnType<typeof createPinnedFs>["resolveContainedWikiDir"];
  effectiveImplementationRoot: ReturnType<typeof createOctopusOutput>["effectiveImplementationRoot"];
  finalizeObserverSessions: ReturnType<typeof createObserver>["finalizeObserverSessions"];
  sendCycleMessage: ReturnType<typeof createCycleStore>["sendCycleMessage"];
  clearActiveCorrectionsAttempt: ReturnType<typeof createCycleStore>["clearActiveCorrectionsAttempt"];
  sendCycleNotice: ReturnType<typeof createExternalGate>["sendCycleNotice"];
}

// Lets the council endgate re-run a review whose first attempt was inconclusive.
const retryInconclusiveCouncil = Symbol("retryInconclusiveCouncil");

export function createCouncil(deps: CouncilDeps) {
  const { developmentCycleConfig, projectsWikiRoot, implementationConfig, defaultCodexSandbox, cycleStatus, createImplementationRunnerSession, createImplementationObserverSession, updateImplementationObserverSession, resolveTrustedProjectWikiPath, writePinnedFile, resolveContainedWikiDir, effectiveImplementationRoot, finalizeObserverSessions, sendCycleMessage, clearActiveCorrectionsAttempt, sendCycleNotice } = deps;

  async function findFilesByName(root: string, name: string, depth = 5): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string, d: number) {
      if (d < 0) return;
      let entries: any[] = [];
      try { entries = await readdir(dir, { withFileTypes: true } as any); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isFile && e.isFile() && e.name === name) out.push(p);
        else if (e.isDirectory && e.isDirectory()) await walk(p, d - 1);
      }
    }
    await walk(root, depth);
    return out;
  }

  async function latestFileByMtime(paths: string[]) {
    const rows: any[] = [];
    for (const p of paths) {
      const st = await stat(p).catch(() => null);
      if (st?.isFile()) rows.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    }
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return rows[0] || null;
  }

  function extractCouncilFindings(text: string, max = 10) {
    const lines = String(text || "").split(/\r?\n/);
    const hits = lines.filter((line) => /\b(HIGH|MEDIUM|LOW|CRITICAL|Must fix|Fix before|Blocker|SAFE_MODE|OpenAPI|exitCode|403)\b/i.test(line.trim()))
      .map((line) => line.trim().replace(/^[-*#\s]+/, ""))
      .filter(Boolean);
    return [...new Set(hits)].slice(0, max);
  }

  async function buildCouncilCodeReviewTask(dir: string, project: string, runId: string, status: any) {
    const projectRoot = effectiveImplementationRoot(status);
    const validationSummary = await readTextIfExists(String(status?.validationSummary || join(dir, "validation_summary.md")));
    const plan = await readTextIfExists(join(dir, "implementation_plan.md"));
    const gitStatus = projectRoot ? await execSummary("git", ["status", "--short", "--branch"], projectRoot, 15000) : "projectRoot not supplied";
    const gitStat = projectRoot ? await execSummary("git", ["diff", "--stat"], projectRoot, 15000) : "projectRoot not supplied";
    const gitNames = projectRoot ? await execSummary("git", ["diff", "--name-only"], projectRoot, 15000) : "projectRoot not supplied";
    const gitUntracked = projectRoot ? await execSummary("git", ["ls-files", "--others", "--exclude-standard"], projectRoot, 15000) : "projectRoot not supplied";
    const gitDiff = projectRoot ? await execSummary("git", ["diff"], projectRoot, 30000) : "projectRoot not supplied";
    let untrackedContents = "";
    if (projectRoot && gitUntracked && !gitUntracked.startsWith("command failed") && gitUntracked !== "ok, no output") {
      const names = gitUntracked.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 30);
      for (const name of names) {
        if (validationRuleMatches(name, [".env", ".env.local", ".git/", "node_modules/"])) continue;
        const text = await readTextIfExists(join(projectRoot, name));
        if (text.trim()) untrackedContents += `\n### ${name}\n\n\`\`\`text\n${excerpt(text, 6000)}\n\`\`\`\n`;
      }
    }
    const task = `# Council code review input\n\nProject: ${project}\nRun: ${runId}\nProject root: ${projectRoot || "not supplied"}\n\nReview the current implementation diff only. Validate safety, correctness, API compatibility, OpenAPI/schema accuracy, test adequacy, operational risk, and deploy readiness. Do not implement changes. Return concrete findings with severity and file:line where possible. Call out whether corrections are required before ship.\n\n## Approved work summary / plan excerpt\n\n${excerpt(plan, 8000)}\n\n## Mechanical validation\n\n${excerpt(validationSummary, 6000)}\n\n## Git status\n\n\`\`\`text\n${excerpt(gitStatus, 4000)}\n\`\`\`\n\n## Diff stat\n\n\`\`\`text\n${excerpt(gitStat, 4000)}\n\`\`\`\n\n## Changed files\n\n\`\`\`text\n${excerpt(gitNames, 4000)}\n\`\`\`\n\n## Untracked files\n\n\`\`\`text\n${excerpt(gitUntracked, 4000)}\n\`\`\`\n\n## Untracked file contents\n\n${excerpt(untrackedContents, 24000)}\n\n## Full diff\n\n\`\`\`diff\n${excerpt(gitDiff, 90000)}\n\`\`\`\n`;
    const inputDir = join(dir, "council-code-review-input");
    await mkdir(inputDir, { recursive: true });
    const taskPath = join(inputDir, "task.md");
    await writeFile(taskPath, task);
    return { task, taskPath, gitStatus, gitStat, gitNames, gitUntracked };
  }

  async function runCouncilCodeReview(dir: string, status: any, params: any = {}) {
    const adapter = String(params.implementationAdapter || status?.implementationAdapter || implementationConfig.adapter);
    if (adapter !== "octopus") return { ok: true, skipped: true, reason: "council_requires_octopus_adapter", status };
    const project = cleanId(params.project || status?.project || "default");
    const runId = cleanId(params.runId || status?.runId || "run");
    const projectRoot = effectiveImplementationRoot(status, params);
    if (!projectRoot) return { ok: false, skipped: true, reason: "implementation_root_missing" };
    if (!params[retryInconclusiveCouncil] && status?.councilReviewSummary && await stat(String(status.councilReviewSummary)).catch(() => null)) return { ok: true, skipped: true, reason: "council_review_already_done", summaryPath: status.councilReviewSummary, status };
    const input = await buildCouncilCodeReviewTask(dir, project, runId, { ...status, projectRoot });
    const outputRoot = join(dir, "council-code-review", randomUUID());
    await mkdir(outputRoot, { recursive: true });
    const stdoutPath = join(dir, "council-code-review.stdout");
    const stderrPath = join(dir, "council-code-review.stderr");
    const scriptPath = join(implementationConfig.octopusRoot, "scripts", "orchestrate.sh");
    // Seats follow the configured Octopus routing, handed to Octopus as its default council policy
    // (the policy accepts model-qualified seats); without routing, Octopus's own provider mix applies.
    const routedSeats = octopusCouncilSeats();
    const explicitProviders = String(params.councilProviders || params.councilAutoProviders || process.env.OCTOPUS_COUNCIL_AUTO_PROVIDERS || "");
    const councilProviders = explicitProviders || routedSeats?.providers || "auto";
    const councilModelEnv: Record<string, string> = Object.fromEntries(Object.entries(routedSeats?.env || {}).filter(([name]) => !process.env[name]));
    if (!explicitProviders && routedSeats && !process.env.OCTOPUS_COUNCIL_DEFAULT_PROVIDERS) councilModelEnv.OCTOPUS_COUNCIL_DEFAULT_PROVIDERS = routedSeats.providers;
    // Octopus seats 3, 5 or 7 members; take the smallest that holds every routed seat.
    const routedSeatCount = routedSeats ? routedSeats.providers.split(",").length : 0;
    const councilMembers = params.councilMembers || (routedSeatCount > 5 ? 7 : 5);
    const councilCodexModel = String(params.councilCodexModel || process.env.DEVELOPMENT_CYCLE_COUNCIL_CODEX_MODEL || "");
    if (councilCodexModel) councilModelEnv.OCTOPUS_CODEX_MODEL = councilCodexModel;
    const args = ["--dir", projectRoot, "council", "--goal", "review", "--domain", "security", "--style", "red-team", "--depth", String(params.councilDepth || "standard"), "--members", String(councilMembers), "--providers", explicitProviders || "auto", "--implement", "never", "--worktree", "off", "--max-cost", String(params.councilMaxCost || "2.00"), "--output-dir", outputRoot, "--json", input.task];
    const startedAt = new Date().toISOString();
    // Codex seats go through the cycle's OpenClaw-login shim, as in implementation. An inherited CODEX_HOME
    // makes Octopus take Codex for the host runtime and leave the Codex seat without a vote.
    const { CODEX_HOME: _codexHome, ...inheritedEnv } = process.env;
    let execResult: any;
    try {
      execResult = await execSupervisedCommand(scriptPath, args, { cwd: projectRoot, env: { ...inheritedEnv, PATH: `${DEVELOPMENT_CYCLE_BIN_DIR}:${process.env.PATH || ""}`, OCTOPUS_PROJECT_DIR: projectRoot, OCTOPUS_CONTEXT_BUDGET: String(implementationConfig.octopusContextBudget), OCTOPUS_COUNCIL_AUTO_PROVIDERS: councilProviders, ...councilModelEnv }, timeout: Number(params.councilTimeoutMs || 900000), maxBuffer: 8 * 1024 * 1024 });
    } catch (err: any) {
      execResult = { failed: true, code: err?.code ?? null, signal: err?.signal ?? null, stdout: err?.stdout || "", stderr: err?.stderr || "", error: String(err?.message || err) };
    }
    await writeFile(stdoutPath, execResult.stdout || "");
    await writeFile(stderrPath, `${execResult.stderr || ""}${execResult.error ? `\n[error]\n${execResult.error}` : ""}`);
    const latest = await latestFileByMtime(await findFilesByName(outputRoot, "summary.json", 5));
    const summaryPath = latest?.path || "";
    const summary = summaryPath ? await readJsonIfExists(summaryPath) : null;
    const councilDir = summaryPath ? summaryPath.replace(/\/summary\.json$/, "") : outputRoot;
    const synthesisPath = summaryPath ? join(councilDir, "synthesis.md") : "";
    const synthesis = synthesisPath ? await readTextIfExists(synthesisPath) : "";
    // Octopus reports a quorum that answered but approved nothing as partial, without a synthesis.
    // Every answering seat asking for changes is still a verdict: revise.
    const respondedSeats = (Array.isArray(summary?.seats) ? summary.seats : []).filter((seat: any) => seat?.status === "responded");
    const unanimousObjection = summary?.status === "partial" && summary?.quorum
      && Number(summary.quorum.received_non_chair) >= Number(summary.quorum.required_non_chair)
      && respondedSeats.length > 0
      && respondedSeats.every((seat: any) => ["REVISE", "BLOCK", "STOP", "REJECT"].includes(String(seat?.verdict || "").toUpperCase()));
    const seatResponses = unanimousObjection ? (await Promise.all((await readdir(join(councilDir, "responses")).catch(() => [])).sort().map((name) => readTextIfExists(join(councilDir, "responses", name))))).join("\n") : "";
    const hardVeto = respondedSeats.some((seat: any) => ["BLOCK", "STOP", "REJECT"].includes(String(seat?.verdict || "").toUpperCase()));
    const councilDecision = unanimousObjection ? (hardVeto ? "stop" : "revise") : parseCouncilDecision(synthesis, summary?.decision || summary?.verdict);
    const needsCorrections = councilDecision === "revise" || councilDecision === "stop";
    const findings = extractCouncilFindings(synthesis || seatResponses || JSON.stringify(summary || {}));
    const ok = Boolean(summaryPath && (unanimousObjection || (summary?.status === "completed" && !execResult.failed)) && councilDecision !== "unknown");
    const councilReviewAttempts = Number(status?.councilReviewAttempts ?? (status?.councilReviewSummary || status?.phase === "council_review_failed" ? 1 : 0)) + 1;
    const nextAction = !ok && councilReviewAttempts < 2 ? "Council review was inconclusive; the next reconcile with council review on runs it once more."
      : !ok ? "Resolve the failed or inconclusive council review before acceptance."
      : councilDecision === "stop" ? "Council rejected delivery; inspect findings before requesting corrections."
      : needsCorrections ? "Launch Implementation corrections from council feedback."
      : "Council review passed; write/read one-pager and close or deploy.";
    const next = await cycleStatus(dir, { phase: ok ? (needsCorrections ? "council_review_needs_corrections" : "council_validated") : "council_review_failed", owner: "main", ok: ok && !needsCorrections, councilDecision, councilReviewAttempts, councilReviewStartedAt: startedAt, councilReviewCompletedAt: new Date().toISOString(), councilReviewSummary: summaryPath, councilReviewSynthesis: synthesisPath, councilReviewStdout: stdoutPath, councilReviewStderr: stderrPath, councilReviewInput: input.taskPath, councilReviewNeedsCorrections: needsCorrections, councilReviewFindings: findings, nextAction });
    return { ok, decision: councilDecision, project, runId, summaryPath, synthesisPath, stdoutPath, stderrPath, inputPath: input.taskPath, needsCorrections, findings, synthesis: excerpt(synthesis || seatResponses, 12000), status: next, execFailed: Boolean(execResult.failed) };
  }

  async function writeCouncilOnePager(dir: string, status: any, council: any, params: any = {}) {
    const project = cleanId(params.project || status?.project || "default");
    const runId = cleanId(params.runId || status?.runId || "run");
    const projectRoot = String(status?.projectRoot || params.projectRoot || "");
    const gitStat = projectRoot ? await execSummary("git", ["diff", "--stat"], projectRoot, 15000) : "projectRoot not supplied";
    const gitNames = projectRoot ? await execSummary("git", ["diff", "--name-only"], projectRoot, 15000) : "projectRoot not supplied";
    const validation = await readTextIfExists(String(status?.validationSummary || join(dir, "validation_summary.md")));
    const synthesis = council?.synthesis || (status?.councilReviewSynthesis ? await readTextIfExists(String(status.councilReviewSynthesis)) : "");
    const findings = council?.findings || status?.councilReviewFindings || extractCouncilFindings(synthesis);
    const decision = council?.needsCorrections ? "Corrections required before ship" : council?.ok ? "Council validated" : "Council review failed or inconclusive";
    const nextSteps = !council?.ok || council?.decision === "stop" ? "Inspect the failed or rejected review before any acceptance or retry."
      : council?.needsCorrections ? "Run corrections from council feedback, then repeat mechanical validation and council review."
      : "Ready for human deploy/commit decision after checking the worktree and excluding local runtime artifacts.";
    const content = `# ${project} — code review one-pager\n\nRun: ${runId}\nGenerated: ${new Date().toISOString()}\nDecision: **${decision}**\n\n## What the work was\n\nImplement the approved development-cycle plan for ${project}. The council reviewed the resulting code diff, not the planning document.\n\n## What changed\n\n\`\`\`text\n${excerpt(gitStat, 3000)}\n\`\`\`\n\nChanged files:\n\n\`\`\`text\n${excerpt(gitNames, 2000)}\n\`\`\`\n\n## Mechanical validation\n\n${excerpt(validation, 2500)}\n\n## Council verdict\n\n${excerpt(synthesis, 4500)}\n\n## Key findings\n\n${findings.length ? findings.map((f: string) => `- ${f}`).join("\n") : "- No key findings extracted."}\n\n## Next steps\n\n${nextSteps}\n\n## Artifacts\n\n- Council summary: ${council?.summaryPath || status?.councilReviewSummary || "not available"}\n- Council synthesis: ${council?.synthesisPath || status?.councilReviewSynthesis || "not available"}\n- Mechanical validation: ${status?.externalValidation || "not available"}\n- Run directory: ${dir}\n`;
    const projectWikiPath = await resolveContainedWikiDir(project, String(params.projectWikiPath || status?.projectWikiPath || ""));
    if (!projectWikiPath) {
      // Fall back to cycle dir when wiki path escapes or is missing.
      const reportsDir = join(dir, "reports");
      await mkdir(reportsDir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
      const out = join(reportsDir, `${stamp}-${runId}-code-review-one-pager.md`);
      const fallbackContent = `${content}(wiki path untrusted; wrote under cycle dir)\n`;
      await writeFile(out, fallbackContent);
      const next = await cycleStatus(dir, { councilOnePagerWikiPath: out, councilOnePagerGeneratedAt: new Date().toISOString() });
      return { path: out, content: fallbackContent, status: next };
    }
    const reportsDir = join(projectWikiPath, "reports");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const name = `${stamp}-${runId}-code-review-one-pager.md`;
    const out = await writePinnedFile(reportsDir, projectsWikiRoot, name, content, false);
    if (!out) {
      const fallbackDir = join(dir, "reports");
      await mkdir(fallbackDir, { recursive: true });
      const stamp2 = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
      const out2 = join(fallbackDir, `${stamp2}-${runId}-code-review-one-pager.md`);
      const fallbackContent = `${content}(wiki report path unsafe; wrote under cycle dir)\n`;
      await writeFile(out2, fallbackContent);
      const next2 = await cycleStatus(dir, { councilOnePagerWikiPath: out2, councilOnePagerGeneratedAt: new Date().toISOString() });
      return { path: out2, content: fallbackContent, status: next2 };
    }

    const next = await cycleStatus(dir, { councilOnePagerWikiPath: out, councilOnePagerGeneratedAt: new Date().toISOString() });
    return { path: out, content, status: next };
  }

  async function launchCouncilCorrections(dir: string, status: any, council: any, params: any = {}) {
    const adapter = String(params.implementationAdapter || status?.implementationAdapter || implementationConfig.adapter);
    if (adapter !== "octopus") return { ok: true, skipped: true, reason: "council_corrections_require_octopus_adapter", status };
    const project = cleanId(params.project || status?.project || "default");
    const runId = cleanId(params.runId || status?.runId || "run");
    const projectRoot = String(params.projectRoot || status?.projectRoot || "");
    const projectWikiPath = resolveTrustedProjectWikiPath(params.project || status?.project || project, params.projectWikiPath, status?.projectWikiPath);
    const count = Number(status?.councilCorrectionCount || 0);
    const max = resolveAutoCouncilCorrectionsMax(params.autoCouncilCorrectionsMax);
    if (!projectRoot) return { ok: false, error: "projectRoot_required" };
    if (count >= max) {
      const next = await cycleStatus(dir, { phase: "council_review_waiting_human", owner: "main", ok: false, nextAction: "Council requested corrections but auto-correction limit was reached." });
      return { ok: false, limitReached: true, status: next };
    }
    const plan = await readTextIfExists(join(dir, "implementation_plan.md"));
    const synthesis = council?.synthesis || (status?.councilReviewSynthesis ? await readTextIfExists(String(status.councilReviewSynthesis)) : "");
    const feedback = `Council code review requires corrections before ship. Apply only these targeted fixes; do not restart the whole cycle and do not broaden scope.\n\nCOUNCIL_SUMMARY_JSON:\n${council?.summaryPath || status?.councilReviewSummary || "not available"}\n\nCOUNCIL_SYNTHESIS:\n${synthesis}\n`;
    const feedbackPath = join(dir, `council_corrections_feedback_${count + 1}.md`);
    await writeFile(feedbackPath, feedback);
    await writeFile(join(dir, "final_validation_response.md"), `revise\n\n${feedback}`);
    const prompt = `Apply only the direct correction feedback from council code review. Do not restart the whole cycle. Preserve already-correct work and stop before risky/protected changes needing human approval.\n\nPROJECT_ROOT_CODE_CHECKOUT:\n${projectRoot}\n\nCODEX_SANDBOX:\n${defaultCodexSandbox}\n\nAPPROVED_PLAN:\n${plan}\n\nCOUNCIL_CORRECTION_FEEDBACK:\n${feedback}`;
    const requestPath = join(dir, "council_corrections_request.md");
    await writeFile(requestPath, prompt);
    const stdoutPath = join(dir, "implementation_corrections_stdout.txt");
    const stderrPath = join(dir, "implementation_corrections_stderr.txt");
    status = await clearActiveCorrectionsAttempt(dir);
    const observerObservationId = await createImplementationObserverSession(dir, { project, runId, command: "council-corrections", projectRoot, projectWikiPath, stdoutPath, stderrPath, status: "running", summary: `development_cycle council corrections ${project}`, message: "Development-cycle queued Octopus council corrections." });
    if (developmentCycleConfig.observer.enabled && !observerObservationId) return { ok: false, error: "observer_root_session_creation_failed" };
    const launch = await createImplementationRunnerSession(dir, { project, runId: `${runId}-council-corrections-${count + 1}`, projectRoot, projectWikiPath: projectWikiPath, readScopeMode: params.readScopeMode, command: "tangle", prompt, kind: "corrections", implementationAdapter: "octopus", planPath: join(dir, "implementation_plan.md"), validationPath: feedbackPath, timeoutSeconds: Number(params.timeoutSeconds ?? params.timeout_ms ?? 0), observerObservationId, purpose: `development_cycle council corrections ${project}` });
    if (!launch.ok) {
      const observerFinalization = await finalizeObserverSessions(dir, { ...status, observerCorrectionsObservationId: observerObservationId }, "failed");
      const failedAttempt = launch.statusPath ? { implementationCorrectionsSessionId: launch.sessionId, correctionsAttemptId: launch.attemptId, directCorrectionsStatus: launch.statusPath, directCorrectionsStdout: launch.stdoutPath, directCorrectionsStderr: launch.stderrPath, correctionsStdout: launch.stdoutPath, correctionsStderr: launch.stderrPath } : {};
      const next = await cycleStatus(dir, { phase: "corrections_failed", owner: "main", ok: false, error: launch.error || "direct_runner_launch_failed", projectRoot, codexSandbox: defaultCodexSandbox, councilCorrectionFeedback: feedbackPath, observerCorrectionsObservationId: observerObservationId, observerFinalization, implementationCorrectionsRequest: requestPath, ...failedAttempt });
      return { ok: false, error: launch.error, status: next, ...(launch.statusPath ? { correctionsAttemptId: launch.attemptId, directCorrectionsStatus: launch.statusPath } : {}) };
    }
    await updateImplementationObserverSession(dir, observerObservationId, { project, runId, command: "council-corrections", projectRoot, projectWikiPath, stdoutPath: launch.stdoutPath, stderrPath: launch.stderrPath, attemptId: launch.attemptId, status: "running", summary: `development_cycle council corrections ${project} running`, message: "Octopus council corrections runner launched; observer integration is optional." });
    const launchRecord = join(dir, "implementation_council_corrections_launch.json");
    await writeFile(launchRecord, JSON.stringify(launch, null, 2) + "\n");
    const next = await cycleStatus(dir, { phase: "corrections_launched", owner: "implementation", implementationAdapter: launch.adapter, ok: false, councilCorrectionCount: count + 1, councilCorrectionFeedback: feedbackPath, nextAction: "Use development_cycle status to watch council corrections. Validation/council will rerun after corrections exit.", projectRoot, projectWikiPath, codexSandbox: defaultCodexSandbox, implementationCorrectionsSessionId: launch.sessionId, correctionsAttemptId: launch.attemptId, directCorrectionsStatus: launch.statusPath, directCorrectionsStdout: launch.stdoutPath, directCorrectionsStderr: launch.stderrPath, observerCorrectionsObservationId: observerObservationId, implementationCorrectionsRequest: requestPath, implementationCorrectionsLaunch: launchRecord, correctionsStdout: launch.stdoutPath, correctionsStderr: launch.stderrPath, externalValidation: "", validationSummary: "", councilReviewSummary: "", councilReviewSynthesis: "", councilReviewNeedsCorrections: null, councilReviewAttempts: 0 });
    return { ok: true, launch, feedbackPath, status: next };
  }

  async function maybeRunCouncilEndgate(dir: string, status: any, params: any = {}) {
    const adapter = String(params.implementationAdapter || status?.implementationAdapter || implementationConfig.adapter);
    if (adapter !== "octopus" || params.autoRunCouncilReview === false) return null;
    const phase = String(status?.phase || "");
    // An inconclusive review (no summary, a failed run or no verdict) gets one more attempt.
    const retry = phase === "council_review_failed" && Number(status?.councilReviewAttempts ?? 1) < 2;
    if (phase !== "external_validation_passed" && !retry) return null;
    if (status?.councilReviewSummary && !retry) return null;
    const council = await runCouncilCodeReview(dir, status, { ...params, [retryInconclusiveCouncil]: retry });
    const onePager = await writeCouncilOnePager(dir, council.status || status, council, params);
    const verdict = !council.ok ? "failed or inconclusive" : council.decision === "stop" ? "rejected" : council.needsCorrections ? "corrections needed" : "validated";
    const title = `${cleanId(params.project || status?.project || "project")} council review: ${verdict}`;
    const text = `One-pager: ${onePager.path}\nCouncil summary: ${council.summaryPath || "not available"}\nDecision: ${verdict}\nFindings:\n${(council.findings || []).slice(0, 6).map((f: string) => `- ${f}`).join("\n") || "- none extracted"}`;
    const notice = await sendCycleNotice(params, String(params.runId || status?.runId || "run"), title, text).catch((e: any) => ({ ok: false, error: String(e?.message || e) }));
    const notification = await sendCycleMessage(params, title, text);
    let corrections: any = null;
    let effectiveStatus = onePager.status || council.status || status;
    if (council.ok && council.decision === "revise" && params.autoCouncilCorrections !== false) {
      corrections = await launchCouncilCorrections(dir, effectiveStatus, council, params);
      effectiveStatus = corrections.status || effectiveStatus;
    }
    const next = await cycleStatus(dir, { councilNotice: notice, councilNotification: notification, councilAutoCorrections: corrections ? { ok: corrections.ok, feedbackPath: corrections.feedbackPath, limitReached: corrections.limitReached || false } : null });
    return { council, onePager, notice, notification, corrections, status: corrections?.status || next };
  }

  return { maybeRunCouncilEndgate };
}
