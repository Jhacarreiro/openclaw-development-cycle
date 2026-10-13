import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildGatewayMessageInvokePayload } from "../core/message-notifications.js";
import { createDeferredDeliveryQueue } from "../core/deferred-delivery.js";
import { pathWithin } from "../core/paths.js";
import { acquireLock, type FilesystemStore } from "../storage/filesystem.js";
import type { DevelopmentCycleConfig } from "../config.js";

export interface NotificationParams {
  notify?: boolean;
  notificationChannel?: string;
  notificationTarget?: string;
  notificationAccount?: string;
  notificationDeliveryJson?: string;
  notificationDryRun?: boolean;
  __notificationAudit?: { eventsPath: string; event: Record<string, unknown> };
}
interface NotificationJob {
  id: string;
  payload: ReturnType<typeof buildGatewayMessageInvokePayload>;
  createdAt: string;
  attempts: number;
  nextAttemptAt: number;
  failed?: boolean;
  audit?: NotificationParams["__notificationAudit"];
}
export interface NotificationResult { ok: boolean; error?: string; response?: unknown; }

export async function invokeGatewayMessage(payload: NotificationJob["payload"]): Promise<NotificationResult> {
  const url = String(process.env.DEVELOPMENT_CYCLE_GATEWAY_URL || process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789").trim().replace(/\/$/, "");
  const token = String(process.env.OPENCLAW_GATEWAY_TOKEN || "").trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${url}/tools/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload), signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) return { ok: false, error: `gateway_message_http_${response.status}` };
    let parsed: { ok?: boolean; result?: { ok?: boolean; isError?: boolean; details?: { ok?: boolean }; error?: unknown } };
    try { parsed = JSON.parse(raw); } catch { return { ok: false, error: "gateway_message_invalid_json" }; }
    if (!parsed || parsed.ok === false || !parsed.result || parsed.result.ok === false || parsed.result.isError || parsed.result.details?.ok === false) {
      return { ok: false, error: String(parsed?.result?.error || "gateway_message_tool_failed") };
    }
    return { ok: true, response: parsed };
  } catch (error) { return { ok: false, error: String((error as Error)?.message || error) }; }
  finally { clearTimeout(timeout); }
}

export function createNotificationService(store: FilesystemStore, stateRoot: string, config: DevelopmentCycleConfig["notifications"], deliver = invokeGatewayMessage) {
  const root = join(stateRoot, "notification-outbox");
  let disposed = false;
  let lastDeliveryError: string | null = null;
  const scheduled = new Set<string>();
  const queue = createDeferredDeliveryQueue<string, NotificationResult>(async (path) => {
    let lock: Awaited<ReturnType<typeof acquireLock>> | undefined;
    try {
      if (disposed) return { ok: true };
      lock = await acquireLock(`${path}.lock`, 500);
      const job = await store.loadJson<NotificationJob>(path);
      if (!job.id || job.failed || job.nextAttemptAt > Date.now()) return { ok: true };
      const result = await deliver(job.payload).catch(error => ({ ok: false, error: String(error?.message || error) }));
      if (job.audit && pathWithin(stateRoot, job.audit.eventsPath)) {
        await store.appendJsonl(job.audit.eventsPath, { ...job.audit.event, createdAt: new Date().toISOString(), notification: result, notificationId: job.id, attempt: job.attempts + 1 });
      }
      if (result.ok) await rm(path, { force: true });
      else {
        job.attempts += 1;
        job.failed = job.attempts >= 5;
        job.nextAttemptAt = Date.now() + Math.min(300000, 1000 * 2 ** job.attempts);
        await store.saveJson(path, { ...job, lastResult: result });
      }
      return result;
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message || error) };
    } finally { await lock?.release(); scheduled.delete(path); }
  });
  function schedule(path: string) {
    if (scheduled.has(path)) return;
    scheduled.add(path);
    queue.enqueue({ payload: path, onResult(result) { lastDeliveryError = result.ok ? null : result.error || "notification_delivery_failed"; } });
  }
  const recover = async () => {
    if (disposed) return;
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !/^[a-f0-9-]+\.json$/.test(entry.name)) continue;
      const path = join(root, entry.name);
      try {
        const job = await store.loadJson<NotificationJob>(path);
        if (job.id && !job.failed && job.nextAttemptAt <= Date.now()) schedule(path);
      } catch (error) { console.error("[notification-outbox] recovery failed:", String(error)); }
    }
  };
  const timer = setInterval(() => { void recover(); }, 30000);
  timer.unref();
  setImmediate(() => { void recover(); });
  return {
    beginExecution: queue.beginExecution,
    endExecution: queue.endExecution,
    snapshot() { return { ...queue.snapshot(), lastDeliveryError }; },
    recover,
    dispose() { disposed = true; clearInterval(timer); },
    async send(params: NotificationParams, title: string, text: string) {
      if (!(params.notify ?? config.enabled)) return { ok: true, skipped: true, reason: "notifications_disabled" };
      const channel = String(params.notificationChannel || config.channel || "").trim();
      const target = String(params.notificationTarget || config.target || "").trim();
      if (!channel || !target) return { ok: true, skipped: true, reason: "notification_destination_missing" };
      let payload: NotificationJob["payload"];
      try {
        payload = buildGatewayMessageInvokePayload({ channel, target, message: `${title}\n\n${text.slice(0, 2500)}`, account: params.notificationAccount || config.account || undefined, deliveryJson: params.notificationDeliveryJson || config.deliveryJson || undefined, dryRun: params.notificationDryRun });
      } catch (error) { return { ok: false, error: String((error as Error)?.message || error) }; }
      const id = randomUUID();
      const job: NotificationJob = { id, payload, createdAt: new Date().toISOString(), attempts: 0, nextAttemptAt: 0, audit: params.__notificationAudit };
      const path = join(root, `${id}.json`);
      try { await store.saveJson(path, job); }
      catch (error) { return { ok: false, error: String((error as Error)?.message || error) }; }
      schedule(path);
      return { ok: true, queued: true, notificationId: id, queuedAt: job.createdAt, channel, target, pending: queue.snapshot().pending };
    },
  };
}
