import { isAbsolute, relative, resolve } from "node:path";

export type ObservedProcess = {
  pid: number;
  ppid?: number;
  stat?: string;
  comm?: string;
  cwd?: string | null;
};

export function isZombieProcess(process: ObservedProcess) {
  return String(process?.stat || "").includes("Z");
}

function isInside(path: string, root: string) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Provider processes that are not in the observed run tree but still work in
 * this run's checkout or one of its worktrees, such as an implementer CLI that
 * outlived the helper that launched it. Providers elsewhere (the host's own
 * agent harnesses, interactive sessions) are not this run's, and a process
 * whose working directory cannot be read is not attributed to it.
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
