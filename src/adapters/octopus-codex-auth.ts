import { lstat, mkdir, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export type OctopusCodexAuthLinkResult = "present" | "linked" | "source_missing";

/**
 * Octopus's Codex health check only passes when `$HOME/.codex/auth.json`
 * exists, although Octopus-launched `codex exec` runs through the
 * development-cycle shim and authenticates with the OpenClaw `openai:default`
 * profile. `$HOME/.codex` is not on a persistent volume, so container updates
 * remove it. Before each Octopus launch, link it to the OpenClaw-managed
 * Codex auth file when it is missing. Never reads, copies or replaces an
 * existing file.
 */
export async function ensureOctopusCodexAuthLink(home: string, stateDir: string): Promise<OctopusCodexAuthLinkResult> {
  const linkPath = join(home, ".codex", "auth.json");
  if (await lstat(linkPath).then(() => true, () => false)) return "present";

  const source = join(stateDir, "codex", "auth.json");
  if (!(await stat(source).then((s) => s.isFile(), () => false))) return "source_missing";

  await mkdir(dirname(linkPath), { recursive: true, mode: 0o700 });
  try {
    await symlink(source, linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return "present";
    throw error;
  }
  return "linked";
}
