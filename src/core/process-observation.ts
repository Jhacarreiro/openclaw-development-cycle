export type ObservedProcess = {
  pid: number;
  ppid?: number;
  stat?: string;
  comm?: string;
};

export function isZombieProcess(process: ObservedProcess) {
  return String(process?.stat || "").includes("Z");
}

export function findProviderProcessesOutsideObservedTree(
  providers: ObservedProcess[] = [],
  descendants: ObservedProcess[] = [],
  roots: ObservedProcess[] = [],
) {
  const observed = new Set<number>([
    ...descendants.map((process) => Number(process.pid)),
    ...roots.map((process) => Number(process.pid)),
  ].filter((pid) => Number.isFinite(pid) && pid > 0));

  return providers.filter((process) => {
    const pid = Number(process?.pid);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (isZombieProcess(process)) return false;
    return !observed.has(pid);
  });
}
