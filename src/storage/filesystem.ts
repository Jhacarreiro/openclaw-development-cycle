import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cleanId } from "../core/ids.js";

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

  // Serialize read-modify-write per status path so concurrent updateStatus
  // calls cannot drop each other's fields (last-writer-wins RMW race).
  const statusChains = new Map<string, Promise<unknown>>();
  const withStatusLock = async <T>(path: string, fn: () => Promise<T>): Promise<T> => {
    const prev = statusChains.get(path) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate, () => gate);
    statusChains.set(path, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (statusChains.get(path) === tail) statusChains.delete(path);
    }
  };

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
    return withStatusLock(path, async () => {
      const current = await loadJson<Record<string, unknown>>(path);
      const next = { ...current, ...patch, updatedAt: now().toISOString() } as T & { updatedAt: string };
      await saveJson(path, next);
      return next;
    });
  };

  const appendJsonl = async (path: string, data: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(data)}\n`);
  };

  return { runDir, loadJson, saveJson, updateStatus, appendJsonl };
}
