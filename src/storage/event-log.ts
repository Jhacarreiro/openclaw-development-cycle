import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

export interface EventLogPolicy {
  maxBytes: number;
  archivesToKeep: number; // 0 retains every archive; deletion must be explicitly configured.
}

export const defaultEventLogPolicy: EventLogPolicy = { maxBytes: 8 * 1024 * 1024, archivesToKeep: 0 };
type LockProvider = (path: string, timeoutMs: number) => Promise<{ release(): Promise<void> }>;

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function archive(path: string, directory: string): Promise<void> {
  const root = dirname(directory);
  await mkdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("event_log_archive_directory_unsafe");
  await mkdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("event_log_archive_directory_unsafe");
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.jsonl`;
  const source = join(directory, name);
  const temporary = `${source}.gz.tmp`;
  const compressed = `${source}.gz`;
  await rename(path, source);
  await syncDirectory(dirname(path));
  await syncDirectory(directory);
  try {
    await pipeline(createReadStream(source), createGzip(), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    const handle = await open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, compressed);
    await syncDirectory(directory);
    await rm(source);
    await syncDirectory(directory);
  } catch (error) {
    // A crash or failed compression leaves the original archive available.
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function prune(directory: string, keep: number): Promise<void> {
  if (keep === 0) return;
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const completed = entries.filter(entry => entry.isFile() && /^\d{4}-.*\.jsonl\.gz$/.test(entry.name)).map(entry => entry.name).sort();
  for (const name of completed.slice(0, Math.max(0, completed.length - keep))) await rm(join(directory, name));
  if (completed.length > keep) await syncDirectory(directory);
}

export function createEventLogWriter(policy: EventLogPolicy, acquire: LockProvider) {
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1 || !Number.isSafeInteger(policy.archivesToKeep) || policy.archivesToKeep < 0) {
    throw new Error("event_log_policy_invalid");
  }
  return async (path: string, data: unknown): Promise<void> => {
    const line = `${JSON.stringify(data)}\n`;
    await mkdir(dirname(path), { recursive: true });
    const lock = await acquire(`${path}.lock`, 30000);
    try {
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("event_log_path_unsafe");
      const directory = join(dirname(path), "event-archives", basename(path));
      if (info && info.size > 0 && info.size + Buffer.byteLength(line) > policy.maxBytes) {
        await archive(path, directory);
        await prune(directory, policy.archivesToKeep);
      }
      const handle = await open(path, "a", 0o600);
      try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
    } finally { await lock.release(); }
  };
}
