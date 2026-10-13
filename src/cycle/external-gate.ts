import { readFile } from "node:fs/promises";

export interface ExternalGateDeps {
  secretPath: string;
  defaultUrl: string;
}

export function createExternalGate(deps: ExternalGateDeps) {
  const { secretPath, defaultUrl } = deps;

  async function loadConfig() {
    const cfg: Record<string, string> = {};
    const text = await readFile(secretPath, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      cfg[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return { url: (cfg.EXTERNAL_GATE_URL || defaultUrl).replace(/\/$/, ""), token: cfg.EXTERNAL_GATE_TOKEN || "" };
  }

  async function request(path: string, options: any = {}) {
    let cfg: { url: string; token: string };
    try {
      cfg = await loadConfig();
    } catch (error: any) {
      return { ok: false, error: `external_gate_config_unreadable: ${String(error?.message || error)}`, secretPath };
    }
    if (!cfg.token) return { ok: false, error: "missing_external_gate_token", secretPath };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
    try {
      const res = await fetch(`${cfg.url}${path}`, {
        method: options.method || "GET",
        headers: { "Authorization": `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      return { ok: res.ok, status: res.status, statusText: res.statusText, result: json ?? text };
    } catch (err: any) {
      return { ok: false, error: err?.name === "AbortError" ? "timeout" : String(err?.message || err) };
    } finally {
      clearTimeout(timeout);
    }
  }


  async function sendCycleNotice(params: any, runId: string, title: string, text: string) {
    if (params.notifyExternalGate === false) return { ok: true, skipped: true, reason: "external_gate_notice_disabled" };
    if (!secretPath || !defaultUrl) return { ok: true, skipped: true, reason: "external_gate_not_configured" };
    return await request("/api/notices", {
      method: "POST",
      timeoutMs: params.timeout_ms || 10000,
      body: { text, level: "interrupt", source: "development-cycle", ttlSeconds: 86400, taskId: runId, taskTitle: title },
    });
  }

  return { request, sendCycleNotice };
}
