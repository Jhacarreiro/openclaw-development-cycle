import { statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

function containedRelative(rel: string): boolean {
  return Boolean(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/");
}

function sameFilesystemIdentity(left: string, right: string): boolean {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function unicodeMatchingAncestor(candidate: string, nfcRoot: string): string | null {
  let current = candidate;
  while (true) {
    if (current.normalize("NFC") === nfcRoot) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * True when candidate is the root or a descendant.
 * NFC/NFD spellings of the same directory are accepted only when they
 * name the same inode (macOS/APFS). Distinct Unicode-form siblings and
 * non-existent aliases stay rejected.
 */
export function pathWithin(root: string, candidate: string): boolean {
  if (!root || !candidate) return false;
  const a = resolve(root);
  const b = resolve(candidate);
  if (a === b) return true;

  // Relative containment uses the original resolved strings so a distinct
  // NFC/NFD sibling cannot look like a child after Unicode normalization.
  const rel = relative(a, b).replace(/\\/g, "/");
  if (containedRelative(rel)) return true;

  const nfcA = a.normalize("NFC");
  const nfcB = b.normalize("NFC");
  if (nfcA === nfcB) return sameFilesystemIdentity(a, b);

  const nfcRel = relative(nfcA, nfcB).replace(/\\/g, "/");
  if (!containedRelative(nfcRel)) return false;
  const ancestor = unicodeMatchingAncestor(b, nfcA);
  return ancestor !== null && sameFilesystemIdentity(a, ancestor);
}

/**
 * Descendant-only relative path from root to candidate.
 * For NFC/NFD aliases, walks from the inode-matched ancestor so the
 * result never contains `..` segments.
 */
export function containedRelativePath(root: string, candidate: string): string | null {
  if (!pathWithin(root, candidate)) return null;
  const a = resolve(root);
  const b = resolve(candidate);
  if (a === b) return "";
  const rel = relative(a, b).replace(/\\/g, "/");
  if (containedRelative(rel)) return rel;
  const nfcA = a.normalize("NFC");
  if (a.normalize("NFC") === b.normalize("NFC") && sameFilesystemIdentity(a, b)) return "";
  const ancestor = unicodeMatchingAncestor(b, nfcA);
  if (ancestor && sameFilesystemIdentity(a, ancestor)) {
    const inner = relative(ancestor, b).replace(/\\/g, "/");
    if (inner === "") return "";
    if (containedRelative(inner)) return inner;
  }
  return null;
}
