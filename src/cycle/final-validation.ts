import { lstat, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultValidationConfig, mergeValidationConfig, parseGitPorcelain, validationRuleMatches, type ValidationConfig } from "../core/validation-config.js";
import { cleanId } from "../core/ids.js";
import { captureCheckoutIdentity } from "../runtime/validation-evidence.js";
import { execSupervisedCommand } from "../runtime/processes.js";
import { readTextIfExists, excerpt, readJsonIfExists, execSummary } from "./files.js";
import type { createCycleStore } from "./cycle-store.js";
import type { createPlanningPack } from "./planning-pack.js";
import type { createPinnedFs } from "./pinned-fs.js";
import type { createOctopusOutput } from "./octopus-output.js";
import type { createObserver } from "./observer.js";

export interface FinalValidationDeps {
  cycleRoot: string;
  wikiRoot: string;
  projectsWikiRoot: string;
  saveJson: ReturnType<typeof createCycleStore>["saveJson"];
  cycleStatus: ReturnType<typeof createCycleStore>["cycleStatus"];
  packageScriptsBrief: ReturnType<typeof createPlanningPack>["packageScriptsBrief"];
  resolveTrustedProjectWikiPath: ReturnType<typeof createPinnedFs>["resolveTrustedProjectWikiPath"];
  pinTrustedProjectRoot: ReturnType<typeof createPinnedFs>["pinTrustedProjectRoot"];
  readAllowedTextFile: ReturnType<typeof createPinnedFs>["readAllowedTextFile"];
  pinContainedWikiDir: ReturnType<typeof createPinnedFs>["pinContainedWikiDir"];
  effectiveImplementationRoot: ReturnType<typeof createOctopusOutput>["effectiveImplementationRoot"];
  collectObserverSessions: ReturnType<typeof createObserver>["collectObserverSessions"];
}

export function createFinalValidation(deps: FinalValidationDeps) {
  const { cycleRoot, wikiRoot, projectsWikiRoot, saveJson, cycleStatus, packageScriptsBrief, resolveTrustedProjectWikiPath, pinTrustedProjectRoot, readAllowedTextFile, pinContainedWikiDir, effectiveImplementationRoot, collectObserverSessions } = deps;

  async function readTextSection(path: string, max = 6000) { const t = await readTextIfExists(path); return t.trim() ? excerpt(t, max) : "not present"; }
  async function writeFinalValidationPack(dir: string, project: string, runId: string, status: any) {
    const sourceProjectRoot = String(status?.projectRoot || "");
    const implementationRoot = effectiveImplementationRoot(status);
    const gitStatus = implementationRoot ? await execSummary("git", ["status", "--short", "--branch"], implementationRoot) : "implementation root not supplied";
    const gitDiffStat = implementationRoot ? await execSummary("git", ["diff", "--stat"], implementationRoot) : "implementation root not supplied";
    const sessions = await collectObserverSessions(status || {});
    const files = (await readdir(dir).catch(() => [])).sort();
    const manifest: any[] = [];
    for (const name of files) { const path = join(dir, name); const st = await stat(path).catch(() => null); if (st?.isFile()) manifest.push({ name, path, size: st.size, mtimeMs: st.mtimeMs }); }
    const deliverySummary = join(dir, "delivery_summary.md");
    await writeFile(deliverySummary, `# Delivery summary\n\nProject: ${project}\nRun: ${runId}\nPhase: ${status?.phase || "unknown"}\nOwner: ${status?.owner || "unknown"}\nNext action: ${status?.nextAction || "unknown"}\n\n## Paths\n\n- projectRoot: ${sourceProjectRoot || "not supplied"}\n- projectWikiPath: ${status?.projectWikiPath || "not supplied"}\n- plan: ${status?.plan || "not supplied"}\n- canonicalPlan: ${status?.canonicalPlan || "not supplied"}\n- outputPath: ${status?.outputPath || "not supplied"}\n- effectiveImplementationRoot: ${implementationRoot || "not supplied"}\n\n## Implementation evidence\n\n- stdout: ${status?.implementationStdout || status?.correctionsStdout || "not supplied"}\n- stderr: ${status?.implementationStderr || status?.correctionsStderr || "not supplied"}\n- observerSessionId: ${status?.observerSessionId || "not supplied"}\n- observerCorrectionsSessionId: ${status?.observerCorrectionsSessionId || "not supplied"}\n\n## Git status\n\n\`\`\`text\n${excerpt(gitStatus, 6000)}\n\`\`\`\n\n## Git diff stat\n\n\`\`\`text\n${excerpt(gitDiffStat, 4000)}\n\`\`\`\n`);
    const artifactManifest = join(dir, "artifact_manifest.json");
    await writeFile(artifactManifest, JSON.stringify({ project, runId, generatedAt: new Date().toISOString(), files: manifest }, null, 2) + "\n");
    const observerSessions = join(dir, "observer_sessions.json");
    await writeFile(observerSessions, JSON.stringify({ project, runId, generatedAt: new Date().toISOString(), sessions }, null, 2) + "\n");
    const testEvidence = join(dir, "test_evidence.md");
    await writeFile(testEvidence, `# Test evidence\n\n## Detected package scripts\n\n${implementationRoot ? await packageScriptsBrief(implementationRoot) : "implementation root not supplied"}\n\n## Implementation stdout excerpt\n\n\`\`\`text\n${await readTextSection(String(status?.implementationStdout || status?.correctionsStdout || join(dir, "implementation_delivery_stdout.txt")), 10000)}\n\`\`\`\n\n## Implementation stderr excerpt\n\n\`\`\`text\n${await readTextSection(String(status?.implementationStderr || status?.correctionsStderr || join(dir, "implementation_delivery_stderr.txt")), 6000)}\n\`\`\`\n`);
    const riskChecklist = join(dir, "risk_checklist.md");
    await writeFile(riskChecklist, `# Final validation risk checklist\n\nReturn GO only if all relevant checks pass.\n\n- [ ] Approved plan was followed; no unrelated scope expansion.\n- [ ] projectRoot is the real code checkout, not only a wiki/docs folder.\n- [ ] No secrets/auth/env/cookie/OAuth files were exposed or edited.\n- [ ] No protected OpenClaw config/state file was edited without explicit authorization.\n- [ ] No third-party/upstream runtime patch was left as architecture without PR-style handling.\n- [ ] Worktree state is understood; unexpected dirty files are explained.\n- [ ] Validation commands/smokes were run or blockers are documented.\n- [ ] Required wiki/runbook/state documentation was updated.\n- [ ] Restart/recreate/persistence survival was considered where relevant.\n- [ ] Observer parent/child session state is coherent enough to audit.\n\nDecision must be exactly one of: go | revise | stop.\n`);
    return { deliverySummary, artifactManifest, observerSessions, testEvidence, riskChecklist };
  }

  async function loadProjectValidationConfig(project: string, status: any, params: any = {}, borrowedProjectRoot: any = null) {
    const lexicalProjectWikiPath = resolveTrustedProjectWikiPath(params.project || status?.project || project, params.projectWikiPath, status?.projectWikiPath);
    const pinnedProjectWiki = await pinContainedWikiDir(project, lexicalProjectWikiPath);
    const projectWikiPath = pinnedProjectWiki?.realPath || "";
    const ownsProjectRoot = !borrowedProjectRoot;
    const pinnedProjectRoot = borrowedProjectRoot || await pinTrustedProjectRoot(String(params.projectRoot || status?.projectRoot || ""));
    if (pinnedProjectRoot) {
      const readyFile = String(process.env.DEVELOPMENT_CYCLE_TEST_PINNED_PROJECT_ROOT_READ_READY_FILE || "").trim();
      if (readyFile) await writeFile(readyFile, "ready\n");
      const delayMs = Number(process.env.DEVELOPMENT_CYCLE_TEST_PINNED_PROJECT_ROOT_READ_DELAY_MS || 0);
      if (Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs);
    }
    const allowedRoots = [pinnedProjectWiki, projectsWikiRoot, wikiRoot, cycleRoot, pinnedProjectRoot];
    let config = defaultValidationConfig();
    let path = "default";

    try {
    if (params.validationConfigPath) {
      const requested = resolve(String(params.validationConfigPath));
      const loaded = await readAllowedTextFile(requested, allowedRoots, "validation_config_path_outside_allowed_roots");
      if (!loaded.ok) {
        return {
          config,
          path,
          projectWikiPath,
          rejectedValidationConfigPath: requested,
          error: loaded.error,
        };
      }
      try {
        config = mergeValidationConfig(config, JSON.parse(loaded.text));
        path = loaded.path;
      } catch (error: any) {
        return { config, path, projectWikiPath, rejectedValidationConfigPath: requested, error: error?.message === "validation_config_invalid_shape" ? error.message : "validation_config_invalid_json" };
      }
      return { config, path, projectWikiPath };
    }

    if (projectWikiPath) {
      const defaultCandidate = join(projectWikiPath, "validation.json");
      const loaded = await readAllowedTextFile(defaultCandidate, [pinnedProjectWiki], "validation_config_path_unreadable");
      if (loaded.ok) {
        try {
          config = mergeValidationConfig(config, JSON.parse(loaded.text));
          path = loaded.path;
        } catch (error: any) {
          return { config, path, projectWikiPath, rejectedValidationConfigPath: defaultCandidate, error: error?.message === "validation_config_invalid_shape" ? error.message : "validation_config_invalid_json" };
        }
      } else if (await lstat(defaultCandidate).catch(() => null)) {
        return { config, path, projectWikiPath, rejectedValidationConfigPath: defaultCandidate, error: loaded.error };
      }
    }
    return { config, path, projectWikiPath };
    } finally {
      await pinnedProjectWiki?.handle.close().catch(() => null);
      if (ownsProjectRoot) await pinnedProjectRoot?.handle.close().catch(() => null);
    }
  }

  async function execValidationCommand(command: string, cwd: string, timeoutMs: number) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    try {
      const res = await execSupervisedCommand("sh", ["-lc", command], { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
      return { ok: true, command, exitCode: 0, startedAt, durationMs: Date.now() - started, stdout: res.stdout || "", stderr: res.stderr || "" };
    } catch (err: any) {
      return { ok: false, command, exitCode: Number.isFinite(Number(err?.code)) ? Number(err.code) : null, signal: err?.signal || null, timedOut: [124, 137].includes(Number(err?.code)) || /timed out|timeout/i.test(String(err?.message || "")) || err?.killed === true, startedAt, durationMs: Date.now() - started, stdout: err?.stdout || "", stderr: err?.stderr || "", error: String(err?.message || err) };
    }
  }

  async function preserveValidationDiff(dir: string, projectRoot: string, prefix: string) {
    const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const worktreePatch = join(dir, `${prefix}-worktree-${ts}.patch`);
    const indexPatch = join(dir, `${prefix}-index-${ts}.patch`);
    const worktree = await execValidationCommand("git diff", projectRoot, 30000);
    const index = await execValidationCommand("git diff --staged", projectRoot, 30000);
    await writeFile(worktreePatch, worktree.stdout || "");
    await writeFile(indexPatch, index.stdout || "");
    return { worktreePatch, indexPatch, worktreeBytes: (worktree.stdout || "").length, indexBytes: (index.stdout || "").length };
  }

  async function inferValidationCommands(projectRoot: string, config: any) {
    if (Array.isArray(config.commands)) return config.commands.map(String).filter(Boolean);
    const commands: string[] = [];
    const pkg = await readJsonIfExists(join(projectRoot, "package.json"));
    const scripts = pkg?.scripts || {};
    if (scripts.check) commands.push("npm run check");
    if (scripts["test:all"]) commands.push("npm run test:all");
    else if (scripts.test && !/no test specified/i.test(String(scripts.test))) commands.push("npm test");
    if (!commands.some((c) => c === "git diff --check")) commands.push("git diff --check");
    if (await stat(join(projectRoot, "go.mod")).catch(() => null)) commands.splice(commands.length - 1, 0, "go test ./...");
    if (await stat(join(projectRoot, "Cargo.toml")).catch(() => null)) commands.splice(commands.length - 1, 0, "cargo test");
    if ((await stat(join(projectRoot, "pyproject.toml")).catch(() => null)) || (await stat(join(projectRoot, "pytest.ini")).catch(() => null))) commands.splice(commands.length - 1, 0, "python -m pytest -q");
    return [...new Set(commands)];
  }

  async function portsFreeCheck(ports: any[]) {
    const failures: any[] = [];
    if (!ports?.length) return failures;
    const res = await execValidationCommand("(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || true)", "/", 10000);
    const text = `${res.stdout || ""}\n${res.stderr || ""}`;
    for (const port of ports.map((p) => Number(p)).filter((p) => Number.isFinite(p) && p > 0)) {
      const re = new RegExp(`[:.]${port}\\b`);
      const lines = text.split(/\r?\n/).filter((line) => re.test(line));
      if (lines.length) failures.push({ check: "portsMustBeFree", port, severity: "revise", reason: `port ${port} has listener(s)`, lines: lines.slice(0, 5) });
    }
    return failures;
  }

  async function requiredOpenApiPathCheck(projectRoot: string, paths: any[]) {
    const failures: any[] = [];
    if (!paths?.length) return failures;
    const files = ["serverModules/swaggerSetup.js", "serverModules/apiRoutes.js", "api/terminal.js"];
    const haystack = (await Promise.all(files.map(async (f) => await readTextIfExists(join(projectRoot, f))))).join("\n");
    for (const required of paths.map(String).filter(Boolean)) {
      if (!haystack.includes(required)) failures.push({ check: "requiredOpenApiPaths", path: required, severity: "revise", reason: `${required} not found in OpenAPI/route source files` });
    }
    return failures;
  }

  async function dirtyWorktreeCheck(projectRoot: string, config: any) {
    const failures: any[] = [];
    const res = await execValidationCommand("git status --porcelain -z", projectRoot, 30000);
    if (!res.ok) return { entries: [], ignored: [], considered: [], unexpected: [], failures: [{ check: "dirtyWorktree", severity: "stop", reason: res.error }] };
    const entries = parseGitPorcelain(res.stdout || "");
    const ignored = entries.filter((e) => validationRuleMatches(e.path, config.ignoredDirty || []));
    const considered = entries.filter((e) => !validationRuleMatches(e.path, config.ignoredDirty || []));
    const forbidden = considered.filter((e) => validationRuleMatches(e.path, config.forbiddenPaths || []));
    const protectedDirty = considered.filter((e) => validationRuleMatches(e.path, config.protectedDirty || []));
    const unexpected = considered.filter((e) => !validationRuleMatches(e.path, config.allowedDirty || []) && !validationRuleMatches(e.path, config.forbiddenPaths || []) && !validationRuleMatches(e.path, config.protectedDirty || []));
    for (const e of forbidden) failures.push({ check: "forbiddenPaths", path: e.path, status: e.status, severity: "revise", reason: `${e.path} is forbidden by validation config` });
    for (const e of protectedDirty) failures.push({ check: "protectedDirty", path: e.path, status: e.status, severity: "stop", reason: `${e.path} is protected by validation config` });
    if (config.strictDirty === true) {
      for (const e of unexpected) failures.push({ check: "allowedDirty", path: e.path, status: e.status, severity: "revise", reason: `${e.path} is dirty but not allowed/ignored by validation config` });
    }
    return { entries, ignored, considered, unexpected, failures };
  }

  async function existingForbiddenPathCheck(projectRoot: string, config: any) {
    const failures: any[] = [];
    for (const raw of config.forbiddenPaths || []) {
      const rel = String(raw || "").replace(/^\.\//, "");
      if (!rel || rel.endsWith("/")) continue;
      const st = await stat(join(projectRoot, rel)).catch(() => null);
      if (st) failures.push({ check: "forbiddenPathsExist", path: rel, severity: "revise", reason: `${rel} exists after validation` });
    }
    return failures;
  }

  async function runExternalFinalValidation(dir: string, status: any, params: any = {}, reason = "manual") {
    const project = cleanId(params.project || status?.project || "default");
    const runId = cleanId(params.runId || status?.runId || "run");
    const requestedSourceProjectRoot = String(params.projectRoot || status?.projectRoot || "");
    const requestedImplementationRoot = effectiveImplementationRoot(status, params);
    const pinnedSourceProjectRoot = await pinTrustedProjectRoot(requestedSourceProjectRoot);
    const pinnedImplementationRoot = await pinTrustedProjectRoot(requestedImplementationRoot);
    const projectRoot = pinnedSourceProjectRoot?.realPath || requestedSourceProjectRoot;
    const implementationRoot = pinnedImplementationRoot?.realPath || requestedImplementationRoot;
    const validationRoot = pinnedImplementationRoot?.procPath || "";
    const loaded = pinnedSourceProjectRoot
      ? await loadProjectValidationConfig(project, status, { ...params, projectRoot: requestedSourceProjectRoot }, pinnedSourceProjectRoot)
      : { config: defaultValidationConfig(), path: "default", rejectedValidationConfigPath: null, error: "project_root_not_trusted_git_checkout" };
    const config: ValidationConfig & { resolvedCommands?: string[] } = loaded.config;
    await mkdir(dir, { recursive: true });
    const stdoutPath = join(dir, "validation_stdout.log");
    const stderrPath = join(dir, "validation_stderr.log");
    const resultPath = join(dir, "validation_result.json");
    const summaryPath = join(dir, "validation_summary.md");
    const failures: any[] = [];
    if (loaded.error) failures.push({ check: "validationConfig", severity: "stop", reason: loaded.error });
    const commandResults: any[] = [];
    let preservedDiff: any = null;

    try {
    const rootStat = validationRoot ? await stat(validationRoot).catch(() => null) : null;
    if (!rootStat?.isDirectory()) failures.push({ check: "implementationRoot", severity: "stop", reason: "implementation root must be an existing trusted Git checkout on a supported Linux host", projectRoot, implementationRoot: requestedImplementationRoot });
    if (rootStat?.isDirectory()) {
      const readyFile = String(process.env.DEVELOPMENT_CYCLE_TEST_VALIDATION_ROOT_READY_FILE || "").trim();
      if (readyFile) await writeFile(readyFile, "ready\n");
      const delayMs = Number(process.env.DEVELOPMENT_CYCLE_TEST_VALIDATION_ROOT_DELAY_MS || 0);
      if (Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs);
    }
    if (rootStat?.isDirectory() && !loaded.error && config.preserveDiff !== false) preservedDiff = await preserveValidationDiff(dir, validationRoot, `validation-${reason}`);

    if (rootStat?.isDirectory() && !loaded.error) {
      const validationCommands = await inferValidationCommands(validationRoot, config);
      config.resolvedCommands = validationCommands;
      for (const command of validationCommands) {
        const result = await execValidationCommand(String(command), validationRoot, Number(config.commandTimeoutMs || 900000));
        commandResults.push({ ...result, stdout: excerpt(result.stdout || "", 20000), stderr: excerpt(result.stderr || "", 20000) });
        if (!result.ok) failures.push({ check: "command", command, severity: "revise", reason: result.error || `command exited ${result.exitCode}`, exitCode: result.exitCode, timedOut: result.timedOut || false });
      }
      const dirty = await dirtyWorktreeCheck(validationRoot, config);
      failures.push(...dirty.failures);
      failures.push(...await existingForbiddenPathCheck(validationRoot, config));
      failures.push(...await portsFreeCheck(config.portsMustBeFree || []));
      failures.push(...await requiredOpenApiPathCheck(validationRoot, config.requiredOpenApiPaths || []));
    }

    let validationEvidence: any = null;
    if (failures.length === 0) {
      try {
        validationEvidence = {
          attemptId: String(status?.correctionsAttemptId || status?.implementationAttemptId || ""),
          implementationRoot,
          generatedAt: new Date().toISOString(),
          identity: await captureCheckoutIdentity(validationRoot),
        };
      } catch (error: any) {
        failures.push({ check: "validationIdentity", severity: "stop", reason: String(error?.message || error) });
      }
    }
    const stop = failures.some((f) => f.severity === "stop");
    const ok = failures.length === 0;
    const decision = ok ? "go" : stop ? "stop" : "revise";
    const result = { ok, decision, reason, project, runId, generatedAt: new Date().toISOString(), projectRoot, outputPath: status?.outputPath || null, implementationRoot, validationEvidence, validationConfigPath: loaded.path, rejectedValidationConfigPath: loaded.rejectedValidationConfigPath || null, error: loaded.error || null, config, preservedDiff, commandResults, failures };
    await saveJson(resultPath, result);
    await writeFile(stdoutPath, commandResults.map((r) => `# ${r.command}\n\n${r.stdout || ""}`).join("\n\n---\n\n"));
    await writeFile(stderrPath, commandResults.map((r) => `# ${r.command}\n\n${r.stderr || r.error || ""}`).join("\n\n---\n\n"));
    await writeFile(summaryPath, `# Mechanical final validation\n\nProject: ${project}\nRun: ${runId}\nReason: ${reason}\nDecision: ${decision}\nOK: ${ok}\nGenerated: ${result.generatedAt}\nConfig: ${loaded.path}\nRejected config: ${loaded.rejectedValidationConfigPath || "none"}${loaded.error ? `\nConfig error: ${loaded.error}` : ""}\n\n## Commands\n\n${commandResults.map((r) => `- ${r.ok ? "PASS" : "FAIL"}: ${r.command}${r.timedOut ? " (timed out)" : ""}`).join("\n") || "none"}\n\n## Failures\n\n${failures.length ? failures.map((f) => `- [${f.severity || "revise"}] ${f.check}: ${f.reason || f.path || f.command}`).join("\n") : "none"}\n\n## Preserved diff\n\n${preservedDiff ? `- worktree: ${preservedDiff.worktreePatch} (${preservedDiff.worktreeBytes} bytes)\n- index: ${preservedDiff.indexPatch} (${preservedDiff.indexBytes} bytes)` : "not preserved"}\n`);
    const phase = ok ? "external_validation_passed" : decision === "stop" ? "external_validation_stopped" : "external_validation_needs_revision";
    const nextAction = ok ? "Mechanical validation passed; human/AI final review may record go or close when appropriate." : decision === "stop" ? "Stop and report the validation blocker to the operator." : "Send delta-only corrections to Implementation or apply a minimal manual fix, then rerun run_final_validation.";
    const next = await cycleStatus(dir, { phase, owner: "main", ok, validationEvidence, councilReviewSummary: "", councilReviewSynthesis: "", councilReviewNeedsCorrections: null, councilReviewAttempts: 0, councilDecision: null, councilReviewFindings: [], externalValidationDecision: decision, externalValidation: resultPath, validationSummary: summaryPath, validationStdout: stdoutPath, validationStderr: stderrPath, validationConfigPath: loaded.path, rejectedValidationConfigPath: loaded.rejectedValidationConfigPath || null, validationConfigError: loaded.error || null, nextAction });
    return { ok, decision, project, runId, dir, phase: next.phase, validationResult: resultPath, validationSummary: summaryPath, validationStdout: stdoutPath, validationStderr: stderrPath, failures, commandResults: commandResults.map((r) => ({ command: r.command, ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut || false, durationMs: r.durationMs })), preservedDiff, rejectedValidationConfigPath: loaded.rejectedValidationConfigPath || null, validationConfigError: loaded.error || null, status: next };
    } finally {
      await pinnedImplementationRoot?.handle.close().catch(() => null);
      await pinnedSourceProjectRoot?.handle.close().catch(() => null);
    }
  }

  return { writeFinalValidationPack, loadProjectValidationConfig, runExternalFinalValidation };
}
