import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { projectPathCandidates } from "../core/ids.js";

function timestampFromId(name: string): number {
  const timestamp = name.match(/-(\d{14,17})(?:-[a-z0-9]+)?$/i)?.[1];
  if (!timestamp) return Number.NaN;
  return Date.parse(`${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}.${timestamp.slice(14).padEnd(3, "0")}Z`);
}

async function recordedCreationTime(statusPath: string): Promise<number> {
  // Do not follow a replaced status symlink or block on a substituted FIFO.
  const file = await open(statusPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!file) return Number.NaN;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024) return Number.NaN;
    // Bound the read itself too, including a file growing after stat().
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 1024 * 1024) return Number.NaN;
    const status = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    return typeof status?.createdAt === "string" ? Date.parse(status.createdAt) : Number.NaN;
  } catch {
    return Number.NaN;
  } finally {
    await file.close();
  }
}

export async function latestRunDir(runsRoot: string, project: string): Promise<string> {
  const rootInfo = await lstat(runsRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return "";
  const realRunsRoot = await realpath(runsRoot).catch(() => "");
  if (!realRunsRoot) return "";

  const containedDir = async (path: string) => {
    const info = await lstat(path).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    const realPath = await realpath(path).catch(() => "");
    if (!realPath) return null;
    const rel = relative(realRunsRoot, realPath);
    if (!rel || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith(sep)) return null;
    return info;
  };

  const entries: Array<{ dir: string; name: string; created: number }> = [];
  for (const dirName of projectPathCandidates(project)) {
    const base = join(runsRoot, dirName);
    if (!(await containedDir(base))) continue;
    const children = await readdir(base, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory() || !child.name || child.name === "." || child.name === ".." || child.name === ".git") continue;
      const dir = join(base, child.name);
      const info = await containedDir(dir);
      if (!info) continue;
      const statusPath = join(dir, "status.json");
      const statusInfo = await lstat(statusPath).catch(() => null);
      if (!statusInfo?.isFile() || statusInfo.isSymbolicLink()) continue;

      const recorded = await recordedCreationTime(statusPath);
      const named = timestampFromId(child.name);
      // createdAt survives reconciles and supports caller-supplied IDs. Legacy
      // runs retain their ID time; filesystem times are the last resort only.
      const created = Number.isFinite(recorded) ? recorded : Number.isFinite(named) ? named
        : info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
      entries.push({ dir, name: child.name, created });
    }
  }
  entries.sort((a, b) => a.created - b.created || a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
  return entries.at(-1)?.dir || "";
}
