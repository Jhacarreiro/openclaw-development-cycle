import { isAbsolute, relative, resolve } from "node:path";

export type ObservedProcess = {
  pid: number;
  ppid?: number;
  sid?: number;
  stat?: string;
  comm?: string;
  cwd?: string | null;
};

export function isZombieProcess(process: ObservedProcess) {
  return String(process?.stat || "").includes("Z");
}

/**
 * The processes of a run: the descendants of its root processes, plus every
 * process in a root's session and their descendants. Runners are session
 * leaders, and Octopus starts some subtasks in process groups of their own;
 * when their parent exits they are reparented to the supervisor (a subreaper)
 * but stay in the runner's session.
 */
export function observedRunTree(rows: ObservedProcess[], rootPids: number[]) {
  const roots = new Set(rootPids);
  // Only a root that leads its own session claims the session; a root in a shared one (a shell, the gateway) does not.
  const sessions = new Set(rows.filter((row) => roots.has(row.pid) && Number(row.sid) === row.pid).map((row) => row.pid));
  const children = new Map<number, ObservedProcess[]>();
  for (const row of rows) children.set(Number(row.ppid), [...(children.get(Number(row.ppid)) || []), row]);
  const seen = new Set<number>(rootPids);
  const tree: ObservedProcess[] = [];
  const visit = (row: ObservedProcess) => {
    if (seen.has(row.pid)) return;
    seen.add(row.pid);
    tree.push(row);
    for (const child of children.get(row.pid) || []) visit(child);
  };
  for (const pid of rootPids) for (const child of children.get(pid) || []) visit(child);
  for (const row of rows) if (sessions.has(Number(row.sid))) visit(row);
  return tree;
}

function isInside(path: string, root: string) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Provider processes that are not in the observed run tree but still work in
 * this run's checkouts (its source checkout or its current attempt's
 * worktree), such as an implementer CLI that outlived the helper that launched
 * it. Providers elsewhere (the host's own agent harnesses, interactive
 * sessions, other runs) are not this run's, and a process whose working
 * directory cannot be read is not attributed to it.
 */
export function findProviderProcessesOutsideObservedTree(
  providers: ObservedProcess[] = [],
  descendants: ObservedProcess[] = [],
  roots: ObservedProcess[] = [],
  workRoots: string[] = [],
) {
  const observed = new Set<number>([
    ...descendants.map((process) => Number(process.pid)),
    ...roots.map((process) => Number(process.pid)),
  ].filter((pid) => Number.isFinite(pid) && pid > 0));
  const runRoots = workRoots.filter((root) => typeof root === "string" && isAbsolute(root));

  return providers.filter((process) => {
    const pid = Number(process?.pid);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (isZombieProcess(process)) return false;
    if (observed.has(pid)) return false;
    const cwd = String(process?.cwd || "");
    return Boolean(cwd) && runRoots.some((root) => isInside(cwd, root));
  });
}
