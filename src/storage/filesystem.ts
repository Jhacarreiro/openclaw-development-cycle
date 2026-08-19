import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cleanId } from "../core/ids.js";

// mkdir-based lock: atomic on POSIX. An owner token (pid:nonce) is written
// into the lock dir so release/write can refuse to touch a replacement lock.
// Stale takeover requires both age > timeout and a dead owner pid; a live
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
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let created = false;
    let createdStat: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      await mkdir(lockDir);
      created = true;
      createdStat = await stat(lockDir);
      await writeFile(ownerPath, ownerId);
      const published = await readFile(ownerPath, "utf8").catch(() => "");
      const currentStat = await stat(lockDir).catch(() => null);
      if (!currentStat || !createdStat || currentStat.dev !== createdStat.dev || currentStat.ino !== createdStat.ino || published !== ownerId) {
        throw new Error("status_lock_owner_publication_failed");
      }
      break;
    } catch {
      if (created && createdStat) {
        const currentStat = await stat(lockDir).catch(() => null);
        if (currentStat && currentStat.dev === createdStat.dev && currentStat.ino === createdStat.ino) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        }
      } else {
        const st = await stat(lockDir).catch(() => null);
        if (st && Date.now() - st.mtimeMs > timeoutMs) {
          const observed = await readFile(ownerPath, "utf8").catch(() => "");
          const ownerMatch = /^(\d+):(.+)$/.exec(observed);
          const ownerPid = ownerMatch ? Number.parseInt(ownerMatch[1] ?? "", 10) : Number.NaN;
          if (ownerMatch && !isProcessAlive(ownerPid)) {
            const recoveryDir = join(lockDir, ".recovery");
            let recoveryClaimed = false;
            try {
              await mkdir(recoveryDir);
              recoveryClaimed = true;
            } catch {}
            if (recoveryClaimed) {
              const trash = `${lockDir}.stale-${process.pid}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
              try {
                const still = await readFile(ownerPath, "utf8").catch(() => "");
                const stillPid = Number.parseInt(still.split(":")[0] ?? "", 10);
                if (still === observed && !isProcessAlive(stillPid)) {
                  await renameLock(lockDir, trash);
                  await rm(trash, { recursive: true, force: true }).catch(() => undefined);
                }
              } catch {} finally {
                await rm(recoveryDir, { recursive: true, force: true }).catch(() => undefined);
                await rm(trash, { recursive: true, force: true }).catch(() => undefined);
              }
            }
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
      try {
        await renameLock(lockDir, trash);
      } catch {
        return;
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

export function createFilesystemStore(stateRoot: string, now: () => Date = () => new Date()): FilesystemStore {
  const runDir = (project: unknown, runId: unknown) =>
    join(stateRoot, "runs", cleanId(project), cleanId(runId));

  const loadJson = async <T extends object = Record<string, unknown>>(path: string): Promise<T> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return {} as T;
    }
  };

  const saveJson = async (path: string, data: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`);
      await rename(temporaryPath, path);
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
    const lock = await acquireLock(lockDir);
    try {
      const current = await loadJson<Record<string, unknown>>(path);
      const next = { ...current, ...patch, updatedAt: now().toISOString() } as T & { updatedAt: string };
      if (!(await lock.isHeld())) {
        throw new Error(`lost status lock ${lockDir} before write`);
      }
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
