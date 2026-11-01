import { open, realpath, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { excerpt, readJsonIfExists, execSummary, safeDirEntries } from "./files.js";
import type { createPinnedFs } from "./pinned-fs.js";

export interface PlanningPackDeps {
  projectsWikiRoot: string;
  pinTrustedProjectRoot: ReturnType<typeof createPinnedFs>["pinTrustedProjectRoot"];
  openPinnedContainedDir: ReturnType<typeof createPinnedFs>["openPinnedContainedDir"];
  resolveContainedWikiDir: ReturnType<typeof createPinnedFs>["resolveContainedWikiDir"];
}

export function createPlanningPack(deps: PlanningPackDeps) {
  const { projectsWikiRoot, pinTrustedProjectRoot, openPinnedContainedDir, resolveContainedWikiDir } = deps;

  async function projectWikiBrief(projectWikiPath: string) {
    const wanted = ["README.md", "status.md", "ROADMAP.md", "RUNS.md", "architecture.md", "runbook.md"];
    const parts: string[] = [];
    for (const name of wanted) {
      let handle: any = null;
      try {
        handle = await open(join(projectWikiPath, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const text = String(await handle.readFile({ encoding: "utf8" }));
        if (text.trim()) parts.push(`### ${name}\n\n${excerpt(text, 2500)}`);
      } catch {}
      finally { await handle?.close().catch(() => null); }
    }
    return parts.length ? parts.join("\n\n") : "No standard project wiki files found.";
  }
  async function packageScriptsBrief(projectRoot: string) {
    const pkg = await readJsonIfExists(join(projectRoot, "package.json"));
    if (!pkg?.scripts) return "No package.json scripts detected.";
    return Object.entries(pkg.scripts).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  }
  async function writePlanningPack(dir: string, params: any) {
    const rawProjectRoot = String(params.projectRoot || "").trim();
    const pinnedProjectRoot = rawProjectRoot ? await pinTrustedProjectRoot(rawProjectRoot) : null;
    const projectRoot = pinnedProjectRoot?.realPath || "";
    // Resolve through symlinks so a wiki dir under projectsWikiRoot cannot redirect recon reads.
    const trustedWiki = params.projectWikiPath
      ? await resolveContainedWikiDir(String(params.project || "default"), String(params.projectWikiPath))
      : "";
    const pinnedWiki = trustedWiki ? await openPinnedContainedDir(trustedWiki, projectsWikiRoot, false) : null;
    const rootStat = pinnedProjectRoot ? await pinnedProjectRoot.handle.stat().catch(() => null) : null;
    let projectWikiPath = "";
    let wikiStat: any = null;
    let wikiEntries = "projectWikiPath missing or not supplied";
    let wikiBrief = "projectWikiPath missing or not supplied";
    if (pinnedWiki) {
      try {
        projectWikiPath = await realpath(pinnedWiki.procPath);
        wikiStat = await pinnedWiki.handle.stat();
        const readyFile = String(process.env.DEVELOPMENT_CYCLE_TEST_PINNED_READ_READY_FILE || "").trim();
        if (readyFile) await writeFile(readyFile, "ready\n");
        const delayMs = Number(process.env.DEVELOPMENT_CYCLE_TEST_PINNED_READ_DELAY_MS || 0);
        if (Number.isFinite(delayMs) && delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
        if (wikiStat?.isDirectory()) {
          wikiEntries = (await safeDirEntries(pinnedWiki.procPath)).join("\n");
          wikiBrief = await projectWikiBrief(pinnedWiki.procPath);
        }
      } finally {
        await pinnedWiki.handle.close().catch(() => null);
      }
    }
    const pinnedProjectPath = pinnedProjectRoot?.procPath || "";
    const gitStatus = rootStat?.isDirectory() ? await execSummary("git", ["status", "--short", "--branch"], pinnedProjectPath) : "projectRoot missing or not supplied";
    const gitRemote = rootStat?.isDirectory() ? await execSummary("git", ["remote", "-v"], pinnedProjectPath) : "projectRoot missing or not supplied";
    const gitDiffStat = rootStat?.isDirectory() ? await execSummary("git", ["diff", "--stat"], pinnedProjectPath) : "projectRoot missing or not supplied";
    const rootEntries = rootStat?.isDirectory() ? (await safeDirEntries(pinnedProjectPath)).join("\n") : "projectRoot missing or not supplied";
    const packageScripts = rootStat?.isDirectory() ? await packageScriptsBrief(pinnedProjectPath) : "projectRoot missing or not supplied";
    await pinnedProjectRoot?.handle.close().catch(() => null);
    const contextPack = join(dir, "context_pack.md");
    await writeFile(contextPack, `# Development cycle context pack\n\nProject: ${params.project}\nRun: ${params.runId}\nGenerated: ${new Date().toISOString()}\n\n## User direction\n\n${params.direction || "not supplied"}\n\n## Paths\n\n- projectWikiPath: ${projectWikiPath || "not supplied"}\n- projectWikiPath exists: ${Boolean(wikiStat?.isDirectory())}\n- projectRoot: ${projectRoot || "not supplied"}\n- projectRoot exists: ${Boolean(rootStat?.isDirectory())}\n- existingPlanPath: ${params.existingPlanPath || "not supplied"}\n\n## Project wiki directory\n\n${wikiEntries}\n\n## Project root directory\n\n${rootEntries}\n\n## Git status\n\n\`\`\`text\n${excerpt(gitStatus, 6000)}\n\`\`\`\n\n## Git remotes\n\n\`\`\`text\n${excerpt(gitRemote, 3000)}\n\`\`\`\n\n## Git diff stat\n\n\`\`\`text\n${excerpt(gitDiffStat, 3000)}\n\`\`\`\n\n## Package scripts / validation commands detected\n\n${packageScripts}\n\n## Project wiki brief\n\n${wikiBrief}\n`);
    const operatorConstraints = join(dir, "operator_constraints.md");
    await writeFile(operatorConstraints, `# Operator constraints\n\nProject: ${params.project}\nRun: ${params.runId}\n\n## Hard constraints\n\n- Do not edit secrets, tokens, cookies, OAuth files, auth profiles, .env files, generated credentials, or production state.\n- Do not edit protected OpenClaw configuration unless the operator explicitly authorizes the exact path.\n- Do not patch third-party/upstream runtime code as architecture. If upstream changes are needed, use a branch/PR-style patch with rollback notes.\n- Do not ask Implementation to infer the code checkout from the wiki folder. Use the real projectRoot.\n- Stop before destructive actions, broad chown/chmod, database migrations, service recreation, external publishing, merge/release/tag, or irreversible file deletion.\n- Prefer typed tools/plugins and documented interfaces over loose scripts.\n\n## Required plan gates\n\n- Identify risky/protected paths before implementation.\n- Define validation commands and smoke checks before implementation.\n- Define expected artifacts and where they will be written.\n- Define stop conditions and human-confirmation points.\n`);
    const expectedPlanContract = join(dir, "expected_plan_contract.md");
    await writeFile(expectedPlanContract, `# Expected implementation plan contract\n\nThe plan returned by an external planner or human reviewer must be an implementation plan, not another planning request.\n\n## Required sections\n\n1. Objective and non-goals\n2. Project paths: projectWikiPath, projectRoot, planPath, affected paths, artifacts, protected/risky paths\n3. Current state summary from context_pack.md\n4. Ordered implementation tasks\n5. Observer / Implementation observation plan\n6. Validation checks and smoke tests\n7. Stop conditions and human-confirmation points\n8. Rollback or recovery notes\n9. Final acceptance criteria\n\nA plan without projectRoot, affected files, validation checks, stop conditions and expected artifacts is not ready for Implementation handoff.\n`);
    return { contextPack, operatorConstraints, expectedPlanContract };
  }

  /** Prefer caller-supplied wiki path only when it stays under projectsWikiRoot. */

  return { packageScriptsBrief, writePlanningPack };
}
