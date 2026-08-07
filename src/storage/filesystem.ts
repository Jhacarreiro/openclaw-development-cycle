import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cleanId } from "../core/ids.js";

// mkdir-based lock: atomic on POSIX, released by removing the dir.
// Serializes updateStatus read-modify-write ACROSS processes (two plugin
// instances sharing one stateRoot), which an in-memory promise chain
// cannot do. Stale-lock recovery: if the lock is older than the timeout,
// a crashed holder is assumed and the lock is taken over.
async function acquireLock(lockDir: string, timeoutMs = 5000): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch {
      const st = await stat(lockDir).catch(() => null);
      if (st && Date.now() - st.mtimeMs > timeoutMs) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring status lock ${lockDir}`);
      }
      await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 50)));
    }
  }
  return async () => {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  };
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
    const release = await acquireLock(lockDir);
    try {
      const current = await loadJson<Record<string, unknown>>(path);
      const next = { ...current, ...patch, updatedAt: now().toISOString() } as T & { updatedAt: string };
      await saveJson(path, next);
      return next;
    } finally {
      await release();
    }
  };

  const appendJsonl = async (path: string, data: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(data)}\n`);
  };

  return { runDir, loadJson, saveJson, updateStatus, appendJsonl };
}
