import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export interface CheckoutIdentity { head: string; fingerprint: string; }
export interface ValidationEvidence {
  attemptId: string;
  implementationRoot: string;
  generatedAt: string;
  identity: CheckoutIdentity;
}

export async function captureCheckoutIdentity(root: string): Promise<CheckoutIdentity> {
  const git = async (...args: string[]) => String((await execFileAsync("git", args, {
    cwd: root, timeout: 30000, maxBuffer: 32 * 1024 * 1024,
  })).stdout);
  const head = (await git("rev-parse", "HEAD")).trim();
  const hash = createHash("sha256").update(head).update("\0");
  hash.update(await git("diff", "--binary", "HEAD", "--")).update("\0");
  hash.update(await git("diff", "--cached", "--binary", "--")).update("\0");
  const paths = (await git("ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean).sort();
  for (const path of paths) {
    hash.update(path).update("\0");
    const file = join(root, path);
    const info = await lstat(file);
    hash.update(String(info.mode)).update("\0");
    if (info.isSymbolicLink()) { hash.update(await readlink(file)); continue; }
    if (!info.isFile()) throw new Error("validation_identity_unsupported_file");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.alloc(65536);
      for (;;) {
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, null);
        if (!bytesRead) break;
        hash.update(bytes.subarray(0, bytesRead));
      }
    } finally { await handle.close(); }
    hash.update("\0");
  }
  return { head, fingerprint: hash.digest("hex") };
}

export function validationEvidenceMatches(evidence: ValidationEvidence | null | undefined, attemptId: string, root: string, identity: CheckoutIdentity): boolean {
  return Boolean(evidence && evidence.attemptId === attemptId && evidence.implementationRoot === root
    && evidence.identity.head === identity.head && evidence.identity.fingerprint === identity.fingerprint);
}
