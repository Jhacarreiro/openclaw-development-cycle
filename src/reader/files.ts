import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type UnavailableReason = "not_recorded" | "unreadable" | "pruned";
export type ReadResult<T> = { value: T; reason?: never } | { value: null; reason: UnavailableReason };
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const failed = (reason: UnavailableReason): ReadResult<never> => ({ value: null, reason });

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/** Only read operations are exposed. Every component is checked before opening a file. */
export class ReadonlyState {
  private constructor(readonly root: string, private readonly device: number, private readonly inode: number) {}

  static async create(path: string): Promise<ReadResult<ReadonlyState>> {
    try {
      const root = resolve(path);
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) return failed("unreadable");
      const canonical = await realpath(root);
      // Reject a supplied root reached through a symlink, including an ancestor link.
      if (relative(root, canonical) !== "") return failed("unreadable");
      return { value: new ReadonlyState(root, info.dev, info.ino) };
    } catch { return failed("unreadable"); }
  }

  pointer(value: string): string | null {
    if (!value || value.includes("\0")) return null;
    if (process.platform !== "win32" && (/^[a-z]:[\\/]/i.test(value) || value.startsWith("\\"))) return null;
    const path = resolve(this.root, value);
    if (!contained(this.root, path) || path === this.root) return null;
    return relative(this.root, path).split(sep).join("/");
  }

  async inspect(path: string, kind: "file" | "directory") {
    try {
      const absolute = resolve(this.root, path);
      if (!contained(this.root, absolute)) return failed("unreadable");
      const rootInfo = await lstat(this.root);
      if (rootInfo.isSymbolicLink() || rootInfo.dev !== this.device || rootInfo.ino !== this.inode) return failed("unreadable");
      const components = relative(this.root, absolute).split(sep).filter(Boolean);
      let current = this.root;
      let info = rootInfo;
      for (let i = 0; i < components.length; i++) {
        current = join(current, components[i]!);
        info = await lstat(current);
        if (info.isSymbolicLink()) return failed("unreadable");
        if (i < components.length - 1 && !info.isDirectory()) return failed("unreadable");
      }
      if (kind === "file" ? !info.isFile() : !info.isDirectory()) return failed("unreadable");
      if (!contained(this.root, await realpath(absolute))) return failed("unreadable");
      return { value: info };
    } catch (error) {
      return failed((error as NodeJS.ErrnoException).code === "ENOENT" ? "not_recorded" : "unreadable");
    }
  }

  async list(path: string): Promise<ReadResult<string[]>> {
    const checked = await this.inspect(path, "directory");
    if (!checked.value) return failed(checked.reason);
    try { return { value: (await readdir(resolve(this.root, path))).sort() }; }
    catch { return failed("unreadable"); }
  }

  async read(path: string): Promise<ReadResult<Buffer>> {
    const checked = await this.inspect(path, "file");
    if (!checked.value) return failed(checked.reason);
    if (checked.value.size > MAX_SOURCE_BYTES) return failed("unreadable");
    try {
      const handle = await open(resolve(this.root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        const current = await this.inspect(path, "file");
        if (!current.value || !opened.isFile() || opened.dev !== checked.value.dev || opened.ino !== checked.value.ino || opened.size > MAX_SOURCE_BYTES) return failed("unreadable");
        // A bounded descriptor read also protects against a file growing after stat.
        const chunks: Buffer[] = [];
        let size = 0;
        for (;;) {
          const buffer = Buffer.alloc(64 * 1024);
          const { bytesRead } = await handle.read(buffer);
          if (!bytesRead) break;
          size += bytesRead;
          if (size > MAX_SOURCE_BYTES) return failed("unreadable");
          chunks.push(buffer.subarray(0, bytesRead));
        }
        return { value: Buffer.concat(chunks) };
      } finally { await handle.close(); }
    } catch { return failed("unreadable"); }
  }

  async json(path: string): Promise<ReadResult<Record<string, unknown>>> {
    const result = await this.read(path);
    if (!result.value) return failed(result.reason);
    try {
      const value: unknown = JSON.parse(result.value.toString("utf8"));
      if (!isRecord(value)) return failed("unreadable");
      return { value };
    } catch { return failed("unreadable"); }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
