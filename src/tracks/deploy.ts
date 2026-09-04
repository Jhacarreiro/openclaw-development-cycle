import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cleanId } from "../core/ids.js";
import { acquireLock } from "../storage/filesystem.js";

export function deployTrackDir(stateRoot: string, project: unknown, deployId: unknown): string {
  return join(stateRoot, "tracks", "deploy", cleanId(project), cleanId(deployId, "deploy"));
}
export const deployStatusPath = (dir: string) => join(dir, "deploy_status.json");
export const deployManifestPath = (dir: string) => join(dir, "deploy_manifest.json");
export const deployRollbackPath = (dir: string) => join(dir, "rollback.json");
export const deployAuthorizationPath = (dir: string) => join(dir, "authorization_evidence.md");

export async function loadDeployJson(path: string): Promise<any> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}
export async function saveDeployJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(16)}`;
  try { await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`); await rename(tmp, path); }
  catch (e) { await rm(tmp, { force: true }).catch(() => undefined); throw e; }
}
export async function updateDeployStatus(dir: string, patch: Record<string, unknown>): Promise<any> {
  await mkdir(dir, { recursive: true });
  const path = deployStatusPath(dir);
  const lock = await acquireLock(join(dir, ".deploy.lock"), 5000);
  try {
    const current = (await loadDeployJson(path)) || {};
    const normalized = { ...patch } as any;
    if (normalized.phase && !normalized.status) normalized.status = normalized.phase;
    if (normalized.status && !normalized.phase) normalized.phase = normalized.status;
    const next = { ...current, ...normalized, updatedAt: new Date().toISOString() };
    if (!(await lock.isHeld())) throw new Error(`lost deploy lock ${dir}`);
    await saveDeployJson(path, next);
    return next;
  } finally { await lock.release(); }
}
