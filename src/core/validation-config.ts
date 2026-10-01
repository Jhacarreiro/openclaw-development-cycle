export interface ValidationConfig {
  commands: "auto" | string[];
  commandTimeoutMs: number;
  preserveDiff: boolean;
  strictDirty: boolean;
  allowedDirty: string[];
  ignoredDirty: string[];
  forbiddenPaths: string[];
  protectedDirty: string[];
  portsMustBeFree: number[];
  requiredOpenApiPaths: string[];
  stall: { enabled: boolean; autoStop: boolean; quietSeconds: number };
}

export function defaultValidationConfig(): ValidationConfig {
  return {
    commands: "auto", commandTimeoutMs: 120000, preserveDiff: true, strictDirty: false,
    allowedDirty: [], ignoredDirty: [".claude-implementation/", "node_modules/", "dist/", "build/", "coverage/"],
    forbiddenPaths: [".env", ".env.local", "config.json.test-backup"], protectedDirty: [".env", ".env.local"],
    portsMustBeFree: [], requiredOpenApiPaths: [], stall: { enabled: true, autoStop: true, quietSeconds: 900 },
  };
}

export function mergeValidationConfig(base: ValidationConfig, extra: unknown): ValidationConfig {
  const invalid = () => { throw new Error("validation_config_invalid_shape"); };
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return invalid();
  const value = extra as Record<string, unknown>;
  for (const key of ["commands", "allowedDirty", "ignoredDirty", "forbiddenPaths", "protectedDirty", "requiredOpenApiPaths"]) {
    if (!(key in value) || (key === "commands" && value[key] === "auto")) continue;
    if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every(item => typeof item === "string" && item.trim())) invalid();
  }
  for (const key of ["preserveDiff", "strictDirty"]) {
    if (key in value && typeof value[key] !== "boolean") invalid();
  }
  if ("commandTimeoutMs" in value && !(typeof value.commandTimeoutMs === "number" && Number.isFinite(value.commandTimeoutMs) && value.commandTimeoutMs > 0)) invalid();
  if ("portsMustBeFree" in value && (!Array.isArray(value.portsMustBeFree) || !value.portsMustBeFree.every(p => Number.isInteger(p) && p > 0 && p <= 65535))) invalid();
  if ("stall" in value) {
    if (!value.stall || typeof value.stall !== "object" || Array.isArray(value.stall)) invalid();
    const stall = value.stall as Record<string, unknown>;
    for (const key of ["enabled", "autoStop"]) if (key in stall && typeof stall[key] !== "boolean") invalid();
    if ("quietSeconds" in stall && !(typeof stall.quietSeconds === "number" && Number.isFinite(stall.quietSeconds) && stall.quietSeconds > 0)) invalid();
  }
  const patch = value as Partial<ValidationConfig>;
  return { ...base, ...patch, stall: { ...base.stall, ...patch.stall } };
}

export function validationRuleMatches(path: string, rules: readonly string[]): boolean {
  const p = path.replace(/^\.\//, "");
  return rules.some(raw => {
    const rule = raw.replace(/^\.\//, "");
    return rule !== "" && (rule.endsWith("/") ? p === rule.slice(0, -1) || p.startsWith(rule) : p === rule);
  });
}

export function parseGitPorcelain(text: string): { status: string; path: string }[] {
  const entries = text.split("\0");
  const result = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry) continue;
    const status = entry.slice(0, 2);
    result.push({ status, path: entry.slice(3) });
    if (/[RC]/.test(status)) i++; // -z puts the destination first, then the source.
  }
  return result;
}
