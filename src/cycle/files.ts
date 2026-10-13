import { readFile, readdir, stat } from "node:fs/promises";
import { readTextTail } from "../storage/text.js";
import { execFileAsync } from "./exec.js";

export async function readTextIfExists(path: string) {
  try { return await readFile(path, "utf8"); } catch { return ""; }
}

export function excerpt(text: string, max = 4000) {
  const s = String(text || "").trim();
  return s.length <= max ? s : `${s.slice(0, max)}\n\n[truncated: ${s.length - max} chars omitted]`;
}
export async function readJsonIfExists(path: string) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
export async function execSummary(file: string, args: string[], cwd: string, timeout = 10000) {
  if (!cwd) return "not supplied";
  try {
    const res = await execFileAsync(file, args, { cwd, timeout, maxBuffer: 1024 * 1024 });
    return `${res.stdout || ""}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`.trim() || "ok, no output";
  } catch (err: any) {
    const out = `${err?.stdout || ""}${err?.stderr ? `\n[stderr]\n${err.stderr}` : ""}`.trim();
    return `command failed: ${file} ${args.join(" ")}\n${err?.message || err}${out ? `\n${excerpt(out, 3000)}` : ""}`;
  }
}
export async function safeDirEntries(path: string, max = 60) {
  try {
    const entries = await readdir(path, { withFileTypes: true } as any);
    return entries.map((e: any) => `${e.isDirectory() ? "d" : e.isFile() ? "f" : "?"} ${e.name}`)
      .filter((x: string) => !/(^| )\.env(\.|$)|secret|token|auth|credential|cookie/i.test(x)).sort().slice(0, max);
  } catch (err: any) { return [`unavailable: ${err?.message || err}`]; }
}
export async function fileInfo(path: string) {
  if (!path) return null;
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) return null;
  return { path, size: st.size, mtimeMs: st.mtimeMs, mtime: st.mtime.toISOString() };
}

export async function textTail(path: string, max = 40000) {
  return readTextTail(path, max);
}
