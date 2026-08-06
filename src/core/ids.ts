export function cleanId(input: unknown, fallback = "run", maxLength = 120): string {
  const cleaned = String(input ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  // path.join treats "." / ".." as traversal; pure-dot tokens must not become dir names.
  if (!cleaned || cleaned === "." || cleaned === ".." || /^\.+$/.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

export function newRunId(project: unknown, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${cleanId(project)}-${timestamp}`;
}
