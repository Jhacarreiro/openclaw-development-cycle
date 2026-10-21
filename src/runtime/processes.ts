import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

export interface ProcessIdentity { pid: number; pgid: number; startTime: string; bootId: string; }
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (fields[0] === "Z" || !fields[19]) return null;
    return { pid, pgid: Number(fields[2]), startTime: fields[19], bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(String((error as NodeJS.ErrnoException)?.code))) return null;
    throw error;
  }
}
export function sameProcess(left: ProcessIdentity | null | undefined, right: ProcessIdentity | null | undefined): boolean {
  return Boolean(left && right && left.pid === right.pid && left.pgid === right.pgid && left.startTime === right.startTime && left.bootId === right.bootId);
}
/**
 * Live processes in a session. Runners lead their own session, and Octopus starts some subtasks in
 * process groups of their own that outlive their parent there, so the group alone does not hold the run.
 */
export async function sessionMembers(sid: number): Promise<number[]> {
  const members: number[] = [];
  for (const name of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const text = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (fields[0] !== "Z" && Number(fields[3]) === sid) members.push(Number(name));
    } catch {}
  }
  return members;
}
export async function stopVerifiedProcessGroup(expected: ProcessIdentity | null | undefined, readIdentity = readProcessIdentity, signal: (pid: number, signal: NodeJS.Signals) => boolean = process.kill.bind(process), graceMs = 5000, listSession = sessionMembers) {
  if (!expected) return { ok: false, reason: "runner_identity_missing" };
  const current = await readIdentity(expected.pid);
  if (!current) return { ok: true, skipped: true, reason: "runner_already_exited" };
  if (!sameProcess(expected, current) || expected.pid !== expected.pgid) return { ok: false, reason: "runner_identity_changed" };
  const signalRun = async (name: NodeJS.Signals) => {
    signal(-expected.pgid, name);
    for (const pid of await listSession(expected.pid)) if (pid !== expected.pid) { try { signal(pid, name); } catch {} }
  };
  await signalRun("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const remaining = await readIdentity(expected.pid);
    if (remaining && !sameProcess(expected, remaining)) return { ok: false, reason: "runner_identity_changed" };
    if (!remaining && !(await listSession(expected.pid)).length) return { ok: true };
    await sleep(50);
  }
  const finalIdentity = await readIdentity(expected.pid);
  if (finalIdentity && !sameProcess(expected, finalIdentity)) return { ok: false, reason: "runner_identity_changed" };
  if (finalIdentity) await signalRun("SIGKILL");
  else for (const pid of await listSession(expected.pid)) { try { signal(pid, "SIGKILL"); } catch {} }
  return { ok: true };
}

const execFileAsync = promisify(execFile);
export async function execSupervisedCommand(file: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }) {
  return execFileAsync("timeout", ["--kill-after=2s", `${Math.max(0.001, options.timeout / 1000)}s`, file, ...args], {
    ...options, timeout: options.timeout + 5000,
  });
}
