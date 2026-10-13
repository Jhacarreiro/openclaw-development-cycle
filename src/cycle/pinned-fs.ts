import { lstat, mkdir, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanId, idPathCandidates } from "../core/ids.js";
import { pathWithin as nfcPathWithin, containedRelativePath } from "../core/paths.js";

export interface PinnedFsDeps {
  cycleRoot: string;
  wikiRoot: string;
  projectsWikiRoot: string;
}

export function createPinnedFs(deps: PinnedFsDeps) {
  const { cycleRoot, wikiRoot, projectsWikiRoot } = deps;

  function resolveTrustedProjectWikiPath(project: string, ...candidates: unknown[]): string {
    const wikiRootAbs = resolve(projectsWikiRoot);
    for (const c of candidates) {
      if (typeof c !== "string" || !c) continue;
      const abs = resolve(c);
      if (pathWithin(projectsWikiRoot, abs) && abs !== wikiRootAbs) return abs;
    }
    for (const id of idPathCandidates(project || "default")) {
      const candidate = resolve(join(projectsWikiRoot, id));
      if (candidate === wikiRootAbs || !pathWithin(projectsWikiRoot, candidate)) continue;
      if (existsSync(candidate)) return candidate;
    }
    let fallback = resolve(join(projectsWikiRoot, cleanId(project || "default")));
    if (!pathWithin(projectsWikiRoot, fallback) || fallback === wikiRootAbs) {
      fallback = resolve(join(projectsWikiRoot, "default"));
    }
    return fallback;
  }

  // NFC-aware containment with inode verification for Unicode-form aliases
  // (from fix/pathwithin-nfc-normalize); same call contract as the lexical version.
  function pathWithin(root: string, candidate: string) {
    if (!root || !candidate) return false;
    const a = resolve(root);
    const b = resolve(candidate);
    // Descendant-only: the shared wiki/docs root (and NFC/NFD aliases of it)
    // must not count as a project wiki destination.
    if (a === b || a.normalize("NFC") === b.normalize("NFC")) return false;
    return nfcPathWithin(a, b);
  }

  function isExactBroadProjectRoot(value: string): boolean {
    const real = resolve(String(value || ""));
    return ["/home", "/root", "/opt", "/srv"].map((p) => resolve(p)).includes(real);
  }

  async function openStableDirectory(pathValue: string) {
    const abs = resolve(String(pathValue || ""));
    let expectedReal = "";
    let expected: any = null;
    let handle: any = null;
    try {
      expectedReal = await realpath(abs);
      expected = await stat(expectedReal);
      if (!expected.isDirectory()) return null;
      const readyFile = String(process.env.DEVELOPMENT_CYCLE_TEST_STABLE_ROOT_READY_FILE || "").trim();
      if (readyFile) await writeFile(readyFile, "ready\n");
      const delayMs = Number(process.env.DEVELOPMENT_CYCLE_TEST_STABLE_ROOT_DELAY_MS || 0);
      if (Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs);
      handle = await open(expectedReal, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      const opened = await handle.stat();
      const openedReal = await realpath(`/proc/self/fd/${handle.fd}`);
      if (opened.dev !== expected.dev || opened.ino !== expected.ino || openedReal !== expectedReal) {
        await handle.close();
        return null;
      }
      return { handle, realPath: openedReal, procPath: `/proc/self/fd/${handle.fd}` };
    } catch {
      await handle?.close().catch(() => null);
      return null;
    }
  }

  async function openOrCreateStableDirectory(pathValue: string) {
    const abs = resolve(String(pathValue || ""));
    const existing = await openStableDirectory(abs);
    if (existing) return existing;
    const parts = abs.split("/").filter(Boolean);
    let current: any = null;
    try {
      current = await open("/", fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      for (const segment of parts) {
        const child = `/proc/self/fd/${current.fd}/${segment}`;
        let next: any = null;
        try {
          next = await open(child, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        } catch (e: any) {
          if (e?.code !== "ENOENT") throw e;
          const readyFile = String(process.env.DEVELOPMENT_CYCLE_TEST_PINNED_CREATE_READY_FILE || "").trim();
          if (readyFile) await writeFile(readyFile, "ready\n");
          const delayMs = Number(process.env.DEVELOPMENT_CYCLE_TEST_PINNED_CREATE_DELAY_MS || 0);
          if (Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs);
          try {
            await mkdir(child);
          } catch (mkdirError: any) {
            if (mkdirError?.code !== "EEXIST") throw mkdirError;
          }
          next = await open(child, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        }
        await current.close();
        current = next;
      }
      const realPath = await realpath(`/proc/self/fd/${current.fd}`);
      return { handle: current, realPath, procPath: `/proc/self/fd/${current.fd}` };
    } catch {
      await current?.close().catch(() => null);
      return null;
    }
  }

  /** Pin an existing trusted Git checkout; else null. */
  async function pinTrustedProjectRoot(value: string) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const pinned = await openStableDirectory(raw);
    if (!pinned) return null;
    let keep = false;
    try {
      const real = pinned.realPath;
      if (real === resolve("/")) return null;
      const blockedTrees = ["/etc", "/var", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/proc", "/sys", "/dev", "/run", "/boot"];
      for (const b of blockedTrees) {
        const br = resolve(b);
        if (real === br || real.startsWith(br + "/")) return null;
      }
      if (real === resolve("/tmp") || real === resolve("/var/tmp")) return null;
      if (isExactBroadProjectRoot(real)) return null;
      const gitMarker = await lstat(`${pinned.procPath}/.git`).catch(() => null);
      if (!gitMarker || gitMarker.isSymbolicLink()) return null;
      for (const owned of [cycleRoot, projectsWikiRoot, wikiRoot]) {
        if (!owned) continue;
        const ownedPinned = await openStableDirectory(String(owned));
        if (!ownedPinned) continue;
        try {
          const rel = relative(real, ownedPinned.realPath).replace(/\\/g, "/");
          if (rel === "" || (rel && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/"))) return null;
        } finally {
          await ownedPinned.handle.close().catch(() => null);
        }
      }
      keep = true;
      return pinned;
    } finally {
      if (!keep) await pinned.handle.close().catch(() => null);
    }
  }


  async function readAllowedTextFile(pathValue: string, roots: Array<any>, errorCode: string) {
    const raw = String(pathValue || "").trim();
    if (!raw) return { ok: false as const, error: errorCode };
    const abs = resolve(raw);
    for (const rootValue of roots) {
      if (!rootValue) continue;
      const borrowed = typeof rootValue === "object" && rootValue.handle && rootValue.procPath;
      const absRoot = resolve(String(borrowed ? (rootValue.lexicalPath || rootValue.realPath || rootValue.procPath) : rootValue));
      let rootHandle: any = null;
      let current: any = null;
      try {
        const pinnedRoot = borrowed ? rootValue : await openStableDirectory(absRoot);
        if (!pinnedRoot) continue;
        rootHandle = pinnedRoot.handle;
        current = rootHandle;
        const pinnedRealRoot = pinnedRoot.realPath || await realpath(pinnedRoot.procPath);
        let rel = containedRelativePath(absRoot, abs);
        if (rel == null) rel = containedRelativePath(pinnedRealRoot, abs);
        if (!rel) continue;

        const parts = rel.split("/").filter(Boolean);
        const readyFile = String(process.env.DEVELOPMENT_CYCLE_TEST_PINNED_ALLOWED_READ_READY_FILE || "").trim();
        if (readyFile) await writeFile(readyFile, "ready\n");
        const delayMs = Number(process.env.DEVELOPMENT_CYCLE_TEST_PINNED_ALLOWED_READ_DELAY_MS || 0);
        if (Number.isFinite(delayMs) && delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));

        for (const segment of parts.slice(0, -1)) {
          const next = await open(`/proc/self/fd/${current.fd}/${segment}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
          if (current !== rootHandle) await current.close();
          current = next;
        }
        const fileHandle = await open(`/proc/self/fd/${current.fd}/${parts.at(-1)}`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          const realCandidate = await realpath(`/proc/self/fd/${fileHandle.fd}`);
          const text = await fileHandle.readFile({ encoding: "utf8" });
          return { ok: true as const, path: realCandidate, text: String(text) };
        } finally {
          await fileHandle.close().catch(() => null);
        }
      } catch {}
      finally {
        if (current && current !== rootHandle) await current.close().catch(() => null);
        if (!borrowed) await rootHandle?.close().catch(() => null);
      }
    }
    return { ok: false as const, error: errorCode, path: abs };
  }

  async function openPinnedContainedDir(target: string, root: string, create = false) {
    const absRoot = resolve(root);
    const absTarget = resolve(target);
    const pinnedRoot = create ? await openOrCreateStableDirectory(absRoot) : await openStableDirectory(absRoot);
    if (!pinnedRoot) return null;
    const realRoot = pinnedRoot.realPath;
    let targetRel = containedRelativePath(absRoot, absTarget);
    if (targetRel == null) targetRel = containedRelativePath(realRoot, absTarget);
    if (targetRel == null) {
      await pinnedRoot.handle.close().catch(() => null);
      return null;
    }
    let current: any = pinnedRoot.handle;
    try {
      for (const segment of targetRel.split("/").filter(Boolean)) {
        const child = `/proc/self/fd/${current.fd}/${segment}`;
        let next: any = null;
        try {
          next = await open(child, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        } catch (e: any) {
          if (!create || e?.code !== "ENOENT") throw e;
          try {
            await mkdir(child);
          } catch (mkdirError: any) {
            if (mkdirError?.code !== "EEXIST") throw mkdirError;
          }
          next = await open(child, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        }
        const realNext = await realpath(`/proc/self/fd/${next.fd}`);
        const rel = relative(realRoot, realNext).replace(/\\/g, "/");
        if (!(rel === "" || (rel && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/")))) {
          await next.close();
          await current.close();
          current = null;
          return null;
        }
        await current.close();
        current = next;
      }
      return { handle: current, procPath: `/proc/self/fd/${current.fd}` };
    } catch {
      await current?.close().catch(() => null);
      return null;
    }
  }

  async function writePinnedFile(dir: string, root: string, name: string, content: string, replace = false) {
    const pinned = await openPinnedContainedDir(dir, root, true);
    if (!pinned) return "";
    const { handle, procPath } = pinned;
    const readyFile = String(process.env.DEVELOPMENT_CYCLE_TEST_PINNED_WRITE_READY_FILE || "").trim();
    if (readyFile) await writeFile(readyFile, "ready\n");
    const delayMs = Number(process.env.DEVELOPMENT_CYCLE_TEST_PINNED_WRITE_DELAY_MS || 0);
    if (Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs);
    const target = `${procPath}/${name}`;
    const tmpName = `.${name}.${process.pid}.${Date.now().toString(16)}.tmp`;
    const tmp = `${procPath}/${tmpName}`;
    let file: any = null;
    try {
      const writePath = replace ? tmp : target;
      file = await open(writePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      await file.writeFile(content, { encoding: "utf8" });
      await file.close();
      file = null;
      if (replace) await rename(tmp, target);
      const realDir = await realpath(procPath);
      return join(realDir, name);
    } catch {
      await file?.close().catch(() => null);
      if (replace) await rm(tmp, { force: true }).catch(() => null);
      return "";
    } finally {
      await handle.close().catch(() => null);
    }
  }

  async function pinContainedWikiDir(project: string, projectWikiPath: string) {
    const raw = String(projectWikiPath || "").trim();
    const target = raw ? resolve(raw) : resolveTrustedProjectWikiPath(project);
    const pinned = await openPinnedContainedDir(target, projectsWikiRoot, true);
    if (!pinned) return null;
    try {
      return { ...pinned, realPath: await realpath(pinned.procPath), lexicalPath: target };
    } catch {
      await pinned.handle.close().catch(() => null);
      return null;
    }
  }

  async function resolveContainedWikiDir(project: string, projectWikiPath: string): Promise<string> {
    const pinned = await pinContainedWikiDir(project, projectWikiPath);
    if (!pinned) return "";
    try { return pinned.realPath; }
    finally { await pinned.handle.close().catch(() => null); }
  }

  async function persistApprovedPlan(project: string, runId: string, projectWikiPath: string, planText: string) {
    const normalized = await resolveContainedWikiDir(project, projectWikiPath);
    if (!normalized) return "";
    const plansDir = join(normalized, "plans");
    const name = `${new Date().toISOString().slice(0, 10)}-${cleanId(runId)}-implementation-plan.md`;
    return await writePinnedFile(plansDir, projectsWikiRoot, name, String(planText).trim() + "\n", true);
  }

  async function pinAllowedCanonicalPlan(path: string) {
    const pinnedWiki = await openStableDirectory(wikiRoot);
    if (!pinnedWiki) return null;
    let pinnedProjects: any = null;
    let keepWiki = false;
    try {
      pinnedProjects = await openStableDirectory(projectsWikiRoot);
      if (!pinnedProjects) return null;
      const realPlan = await realpath(path);
      if (!pathWithin(pinnedProjects.realPath, realPlan) || !pathWithin(pinnedWiki.realPath, realPlan)) return null;
      const rel = relative(pinnedWiki.realPath, realPlan).replace(/\\/g, "/");
      if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) return null;
      if (!/(?:^|\/)plans\/[^/]+\.md$/.test(rel)) return null;
      keepWiki = true;
      return { rel, wiki: pinnedWiki };
    } finally {
      await pinnedProjects?.handle.close().catch(() => null);
      if (!keepWiki) await pinnedWiki.handle.close().catch(() => null);
    }
  }

  return { resolveTrustedProjectWikiPath, isExactBroadProjectRoot, pinTrustedProjectRoot, readAllowedTextFile, openPinnedContainedDir, writePinnedFile, pinContainedWikiDir, resolveContainedWikiDir, persistApprovedPlan, pinAllowedCanonicalPlan };
}
