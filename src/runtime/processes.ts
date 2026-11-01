import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

export interface ProcessIdentity { pid: number; pgid: number; sid?: number; startTime: string; bootId: string; runMarker?: string; }
/** Environment variable a runner exports so its subtasks can be told apart from a later session that reused its id. */
export const RUN_MARKER_ENV = "DEVELOPMENT_CYCLE_RUN_ATTEMPT";
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
    // An exiting task reports group and session 0 before it turns zombie; it is gone, not a different process.
    if (["Z", "X", "x"].includes(fields[0]) || !fields[19] || Number(fields[2]) === 0 || Number(fields[3]) === 0) return null;
    return { pid, pgid: Number(fields[2]), sid: Number(fields[3]), startTime: fields[19], bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(String((error as NodeJS.ErrnoException)?.code))) return null;
    throw error;
  }
}
export function sameProcess(left: ProcessIdentity | null | undefined, right: ProcessIdentity | null | undefined): boolean {
  return Boolean(left && right && left.pid === right.pid && left.pgid === right.pgid && left.startTime === right.startTime && left.bootId === right.bootId && (left.sid === undefined || right.sid === undefined || left.sid === right.sid));
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
export async function carriesRunMarker(pid: number, marker: string): Promise<boolean> {
  const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
  return environ.split("\0").includes(`${RUN_MARKER_ENV}=${marker}`);
}
async function currentBootId() { return (await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "")).trim(); }
export async function stopVerifiedProcessGroup(expected: ProcessIdentity | null | undefined, readIdentity = readProcessIdentity, signal: (pid: number, signal: NodeJS.Signals) => boolean = process.kill.bind(process), graceMs = 5000, listSession = sessionMembers, hasMarker = carriesRunMarker, bootId = currentBootId) {
  if (!expected) return { ok: false, reason: "runner_identity_missing" };
  const current = await readIdentity(expected.pid);
  if (current && (!sameProcess(expected, current) || expected.pid !== expected.pgid)) return { ok: false, reason: "runner_identity_changed" };
  // Only a runner recorded as its session's leader gets session-wide signals; older identities get the group alone.
  // While the runner lives it holds its pid, so the session is the run's. Once it is gone the id can be reused by an
  // unrelated session, so only members on the same boot that carry this launch's marker are taken as the run's.
  const leadsSession = expected.sid === expected.pid;
  const sameBoot = leadsSession && Boolean(expected.runMarker) && (await bootId()) === expected.bootId;
  const seenWithRunner = new Set<number>();
  const stragglers = async () => {
    if (!leadsSession) return [];
    const members = (await listSession(expected.pid)).filter((pid) => pid !== expected.pid);
    if (sameProcess(expected, await readIdentity(expected.pid))) { for (const pid of members) seenWithRunner.add(pid); return members; }
    const owned: number[] = [];
    for (const pid of members) if (seenWithRunner.has(pid) || (sameBoot && await hasMarker(pid, String(expected.runMarker)))) owned.push(pid);
    return owned;
  };
  if (!current && !(await stragglers()).length) return { ok: true, skipped: true, reason: "runner_already_exited" };
  const signalRun = async (name: NodeJS.Signals, runnerAlive: boolean) => {
    // List the session before signalling the group, while a live runner still vouches for its members.
    const members = await stragglers();
    if (runnerAlive) signal(-expected.pgid, name);
    for (const pid of members) { try { signal(pid, name); } catch {} }
  };
  await signalRun("SIGTERM", Boolean(current));
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const remaining = await readIdentity(expected.pid);
    if (remaining && !sameProcess(expected, remaining)) return { ok: false, reason: "runner_identity_changed" };
    if (!remaining && !(await stragglers()).length) return { ok: true };
    await sleep(50);
  }
  const finalIdentity = await readIdentity(expected.pid);
  if (finalIdentity && !sameProcess(expected, finalIdentity)) return { ok: false, reason: "runner_identity_changed" };
  await signalRun("SIGKILL", Boolean(finalIdentity));
  return { ok: true };
}

const execFileAsync = promisify(execFile);
export async function execSupervisedCommand(file: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }) {
  return execFileAsync("timeout", ["--kill-after=2s", `${Math.max(0.001, options.timeout / 1000)}s`, file, ...args], {
    ...options, timeout: options.timeout + 5000,
  });
}
