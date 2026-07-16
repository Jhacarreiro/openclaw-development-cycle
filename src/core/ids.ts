export function cleanId(input: unknown, fallback = "run", maxLength = 120): string {
  const cleaned = String(input ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return cleaned || fallback;
}

export function newRunId(project: unknown, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${cleanId(project)}-${timestamp}`;
}
