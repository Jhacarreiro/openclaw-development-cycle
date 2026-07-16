import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((file) => file !== "scripts/audit-public.mjs");

const textExtensions = new Set([
  "", ".cjs", ".css", ".d.ts", ".env", ".html", ".js", ".json", ".md",
  ".mjs", ".py", ".sh", ".toml", ".ts", ".txt", ".yaml", ".yml",
]);

const checks = [
  ["private IPv4 address", /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g],
  ["fixed Unix operator path", /\/(?:data|home)\/[A-Za-z0-9._-]+\/(?:workspace|\.openclaw)(?:\/|\b)/g],
  ["fixed Windows user path", /[A-Z]:\\Users\\[A-Za-z0-9._-]+\\/gi],
  ["local-only branch reference", /(?:refs\/heads\/local\/|["\']branch["\']\s*[:=]\s*["\']local\/)/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["OpenAI-style secret", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["bearer credential", /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/g],
];

const findings = [];
for (const file of files) {
  if (!textExtensions.has(extname(file)) && !["LICENSE", ".gitignore"].includes(file)) continue;
  const text = await readFile(resolve(root, file), "utf8").catch(() => "");
  for (const [label, pattern] of checks) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push(`${file}:${line}: ${label}`);
    }
  }
}

if (findings.length) {
  console.error("Public repository audit failed:\n" + findings.join("\n"));
  process.exit(1);
}

console.log(`Public repository audit passed (${files.length} tracked files scanned).`);
