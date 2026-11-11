import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonIfExists } from "./files.js";

// This is an adapter/runner contract, not a classifier for application output.
// Review prose, diagnostic excerpts and previous explanations are not evidence
// that a provider operation failed.
const policies = {
  rate_limited: { severity: "warning", humanRequired: false, autoStopRecommended: false, recommendedAction: "Observe active work. Back off the failed operation; retry only through a bounded supervised policy that preserves progress." },
  auth_failed: { severity: "blocking", humanRequired: true, autoStopRecommended: true, recommendedAction: "Resolve the attributed provider authentication failure, preserving the current worktree for supervised continuation." },
  billing_or_quota_blocked: { severity: "blocking", humanRequired: true, autoStopRecommended: true, recommendedAction: "Resolve the attributed billing/quota failure or explicitly choose an alternate provider; retain completed work." },
  provider_fleet_failed: { severity: "blocking", humanRequired: true, autoStopRecommended: false, recommendedAction: "Inspect the attributed provider failures and preserve completed work before deciding how to continue." },
  local_runtime_fault: { severity: "blocking", humanRequired: true, autoStopRecommended: true, recommendedAction: "Resolve the attributed runner fault and continue from preserved work after verification." },
} as const;

export async function classifyOperationalFailure(status: any) {
  const corrections = String(status?.phase || "").startsWith("corrections_");
  const attemptId = corrections ? status?.correctionsAttemptId : status?.implementationAttemptId;
  const statusPath = corrections ? status?.directCorrectionsStatus : status?.directImplementationStatus;
  if (!attemptId || !statusPath) return null;
  const session = await readJsonIfExists(String(statusPath));
  if (session?.attemptId !== attemptId) return null;
  // The filename is owned by the runner; never follow a backend-supplied path.
  const path = join(dirname(String(statusPath)), "operational-failure.json");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile() || st.size > 16384) return null;
    const evidence = JSON.parse(await handle.readFile("utf8"));
    if (evidence?.schemaVersion !== 1 || evidence.attemptId !== attemptId || !Object.hasOwn(policies, evidence.failureClass)) return null;
    if (!["provider", "runner"].includes(evidence.source) || typeof evidence.errorCode !== "string" || !evidence.errorCode.trim() || evidence.errorCode.length > 128 || typeof evidence.occurredAt !== "string" || !Number.isFinite(Date.parse(evidence.occurredAt))) return null;
    if (evidence.source === "provider" && (typeof evidence.provider !== "string" || !evidence.provider.trim() || evidence.provider.length > 200)) return null;
    if (evidence.source === "runner" && evidence.failureClass !== "local_runtime_fault") return null;
    const policy = policies[evidence.failureClass as keyof typeof policies];
    return { failureClass: evidence.failureClass, ...policy, safeToAutoRetry: false,
      matched: { name: "attributed_operation", source: evidence.source, provider: evidence.provider ?? null, errorCode: evidence.errorCode, attemptId, evidencePath: path, occurredAt: evidence.occurredAt } };
  } catch { return null; }
  finally { await handle?.close(); }
}
