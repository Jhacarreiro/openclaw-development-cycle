import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { idPathCandidates, projectPathCandidates } from "../core/ids.js";

// mkdir-based lock: atomic on POSIX. An owner token (pid:nonce) is written
// into the lock dir so release/write can refuse to touch a replacement lock.
// Stale takeover requires age beyond the stale grace and a dead owner pid; a live
// holder is never evicted just because it paused past the timeout.
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

type StatusLock = {
  isHeld: () => Promise<boolean>;
  release: () => Promise<void>;
};

export async function acquireLock(lockDir: string, timeoutMs = 5000, renameLock = rename): Promise<StatusLock> {
  const ownerId = `${process.pid}:${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const ownerPath = join(lockDir, "owner");
  const acquireDir = `${lockDir}.acquire-${ownerId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
  const acquireOwnerPath = join(acquireDir, "owner");
  const deadline = Date.now() + timeoutMs;
  const staleAfterMs = Math.min(timeoutMs, 5000);
  for (;;) {
    try {
      await mkdir(acquireDir);
      await writeFile(acquireOwnerPath, ownerId);
      const published = await readFile(acquireOwnerPath, "utf8").catch(() => "");
      if (published !== ownerId) throw new Error("status_lock_owner_publication_failed");
      await rename(acquireDir, lockDir);
      break;
    } catch {
      await rm(acquireDir, { recursive: true, force: true }).catch(() => undefined);

      const observed = await readFile(ownerPath, "utf8").catch(() => "");
      const ownerMatch = /^(\d+):(.+)$/.exec(observed);
      const ownerStat = ownerMatch ? await stat(ownerPath).catch(() => null) : null;
      const lockStat = await stat(lockDir).catch(() => null);
      const ownerPid = ownerMatch ? Number.parseInt(ownerMatch[1] ?? "", 10) : Number.NaN;
      const ownerlessStale = !ownerMatch && lockStat && Date.now() - lockStat.mtimeMs > staleAfterMs;
      const ownedStale = ownerMatch && ownerStat && Date.now() - ownerStat.mtimeMs > staleAfterMs && !isProcessAlive(ownerPid);

      if (ownerlessStale || ownedStale) {
        const recoveryDir = join(lockDir, ".recovery");
        const recoveryOwnerPath = join(recoveryDir, "owner");
        const recoveryOwnerId = `${process.pid}:${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
        let recoveryClaimed = false;
        try {
          await mkdir(recoveryDir);
          await writeFile(recoveryOwnerPath, recoveryOwnerId);
          recoveryClaimed = (await readFile(recoveryOwnerPath, "utf8").catch(() => "")) === recoveryOwnerId;
        } catch {
          const recoveryStat = await stat(recoveryDir).catch(() => null);
          const recoveryOwner = await readFile(recoveryOwnerPath, "utf8").catch(() => "");
          const recoveryMatch = /^(\d+):(.+)$/.exec(recoveryOwner);
          const recoveryPid = recoveryMatch ? Number.parseInt(recoveryMatch[1] ?? "", 10) : Number.NaN;
          const recoveryAgeMs = recoveryStat ? Date.now() - recoveryStat.mtimeMs : 0;
          const recoveryGraceMs = Math.min(250, Math.max(25, Math.floor(timeoutMs / 4)));
          if (recoveryStat && ((!recoveryMatch && recoveryAgeMs > recoveryGraceMs) || (recoveryMatch && !isProcessAlive(recoveryPid)))) {
            const abandoned = join(lockDir, `.recovery-abandoned-${process.pid}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
            try {
              await rename(recoveryDir, abandoned);
              await rm(abandoned, { recursive: true, force: true }).catch(() => undefined);
            } catch {}
          }
        }
        if (recoveryClaimed) {
          const trash = `${lockDir}.stale-${process.pid}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
          try {
            const still = await readFile(ownerPath, "utf8").catch(() => "");
            const stillMatch = /^(\d+):(.+)$/.exec(still);
            const stillPid = stillMatch ? Number.parseInt(stillMatch[1] ?? "", 10) : Number.NaN;
            const currentLockStat = await stat(lockDir).catch(() => null);
            const sameLockInstance = Boolean(lockStat && currentLockStat && lockStat.dev === currentLockStat.dev && lockStat.ino === currentLockStat.ino);
            const stillOwnerlessStale = !stillMatch && sameLockInstance && Boolean(lockStat && Date.now() - lockStat.mtimeMs > staleAfterMs);
            const stillOwnedStale = still === observed && stillMatch && sameLockInstance && !isProcessAlive(stillPid);
            if (stillOwnerlessStale || stillOwnedStale) {
              await renameLock(lockDir, trash);
              await rm(trash, { recursive: true, force: true }).catch(() => undefined);
            }
          } catch {} finally {
            const currentRecoveryOwner = await readFile(recoveryOwnerPath, "utf8").catch(() => "");
            if (currentRecoveryOwner === recoveryOwnerId) {
              const released = join(lockDir, `.recovery-released-${process.pid}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
              try {
                await rename(recoveryDir, released);
                await rm(released, { recursive: true, force: true }).catch(() => undefined);
              } catch {}
            }
            await rm(trash, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring status lock ${lockDir}`);
      }
      await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 50)));
    }
  }
  const isHeld = async () => (await readFile(ownerPath, "utf8").catch(() => null)) === ownerId;
  let releasePromise: Promise<void> | null = null;
  const release = async () => {
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      if (!(await isHeld())) return;
      const trash = `${lockDir}.release-${ownerId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
      const releaseDeadline = Date.now() + 5000;
      for (;;) {
        if (!(await isHeld())) return;
        try {
          await renameLock(lockDir, trash);
          break;
        } catch (error: any) {
          if (!["EPERM", "EACCES", "EBUSY"].includes(String(error?.code)) || Date.now() >= releaseDeadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      await rm(trash, { recursive: true, force: true }).catch(() => undefined);
    })();
    return releasePromise;
  };
  return { isHeld, release };
}

export interface FilesystemStore {
  runDir(project: unknown, runId: unknown): string;
  loadJson<T extends object = Record<string, unknown>>(path: string): Promise<T>;
  saveJson(path: string, data: unknown): Promise<void>;
  updateStatus<T extends object = Record<string, unknown>>(dir: string, patch: T): Promise<T & { updatedAt: string }>;
  appendJsonl(path: string, data: unknown): Promise<void>;
}

function existingContainedDir(path: string, root: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const realRoot = realpathSync(root);
    const realPath = realpathSync(path);
    const rel = relative(realRoot, realPath);
    return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !rel.startsWith(sep);
  } catch {
    return false;
  }
}

function canonicalFallbackPath(runsRoot: string, projectId: string, runId: string): string {
  const projectDir = join(runsRoot, projectId);
  const candidate = join(projectDir, runId);
  try {
    const runsInfo = lstatSync(runsRoot);
    if (!runsInfo.isDirectory() || runsInfo.isSymbolicLink()) throw new Error("unsafe runs root: " + runsRoot);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    return candidate;
  }
  try {
    const projectInfo = lstatSync(projectDir);
    if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink() || !existingContainedDir(projectDir, runsRoot)) throw new Error("unsafe canonical project directory: " + projectDir);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    return candidate;
  }
  try {
    const candidateInfo = lstatSync(candidate);
    if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink() || !existingContainedDir(candidate, runsRoot)) throw new Error("unsafe canonical run directory: " + candidate);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  return candidate;
}

export function createFilesystemStore(stateRoot: string, now: () => Date = () => new Date()): FilesystemStore {
  const runsRoot = join(stateRoot, "runs");
  const runDir = (project: unknown, runId: unknown) => {
    const projects = projectPathCandidates(project);
    const runs = idPathCandidates(runId);
    const canonical = [projects[0]!, runs[0]!] as const;
    const legacy = [projects[1] ?? projects[0]!, runs[1] ?? runs[0]!] as const;
    const pairs = canonical[0] === legacy[0] && canonical[1] === legacy[1] ? [canonical] : [canonical, legacy];
    for (const [projectId, run] of pairs) {
      const projectDir = join(runsRoot, projectId);
      const candidate = join(projectDir, run);
      if (!existingContainedDir(projectDir, runsRoot)) continue;
      if (existingContainedDir(candidate, runsRoot)) return candidate;
    }
    return canonicalFallbackPath(runsRoot, canonical[0], canonical[1]);
  };

  const loadJson = async <T extends object = Record<string, unknown>>(path: string): Promise<T> => {
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("state_object_required");
      return value as T;
    } catch (err: any) {
      if (err?.code === "ENOENT") return {} as T;
      throw new Error(`state_unreadable: ${path}`, { cause: err });
    }
  };

  const saveJson = async (path: string, data: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
        await handle.sync();
      } finally { await handle.close(); }
      const renameDeadline = Date.now() + 5000;
      for (;;) {
        try { await rename(temporaryPath, path); break; }
        catch (error: any) {
          if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(String(error?.code)) || Date.now() >= renameDeadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      if (process.platform !== "win32") {
        const parent = await open(dirname(path), "r");
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const updateStatus = async <T extends object = Record<string, unknown>>(
    dir: string,
    patch: T,
  ): Promise<T & { updatedAt: string }> => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "status.json");
    // mkdir lock: two OpenClaw plugin instances sharing a stateRoot
    // otherwise interleave load->merge->save and drop each other's
    // updates (last-writer-wins).
    const lockDir = join(dir, ".status.lock");
    const lock = await acquireLock(lockDir, 30000);
    try {
      const current = await loadJson<Record<string, unknown>>(path);
      const next = { ...current, ...patch, updatedAt: now().toISOString() } as T & { updatedAt: string };
      if (!(await lock.isHeld())) {
        throw new Error(`lost status lock ${lockDir} before write`);
      }
      if (Object.keys(current).length > 0) await saveJson(join(dir, "status.previous.json"), current);
      await saveJson(path, next);
      return next;
    } finally {
      await lock.release();
    }
  };

  const appendJsonl = async (path: string, data: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(data)}\n`);
  };

  return { runDir, loadJson, saveJson, updateStatus, appendJsonl };
}
