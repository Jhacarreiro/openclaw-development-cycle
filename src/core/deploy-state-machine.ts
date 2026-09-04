export type DeployTrackStatus =
  | "prepared" | "prepare_failed" | "execution_launched" | "execution_running"
  | "deployed" | "execution_failed" | "verification_running" | "verified"
  | "verification_failed" | "stopped";

export type DeployTrackAction = "deploy_prepare" | "deploy_execute" | "deploy_verify" | "deploy_status" | "deploy_stop";

export function checkDeployActionTransition(action: DeployTrackAction, status: string): { ok: boolean; error?: string } {
  if (action === "deploy_status") return { ok: true };
  if (action === "deploy_prepare") return ["", "prepare_failed", "prepared"].includes(status) ? { ok: true } : { ok: false, error: `deploy_prepare_not_allowed_from:${status}` };
  if (action === "deploy_execute") return ["prepared", "execution_failed"].includes(status) ? { ok: true } : { ok: false, error: `deploy_execute_requires_prepared:${status || "missing"}` };
  if (action === "deploy_verify") return ["deployed", "verification_failed"].includes(status) ? { ok: true } : { ok: false, error: `deploy_verify_requires_deployed:${status || "missing"}` };
  if (action === "deploy_stop") return ["execution_launched", "execution_running", "verification_running"].includes(status) ? { ok: true } : { ok: false, error: `deploy_stop_requires_running_attempt:${status || "missing"}` };
  return { ok: false, error: `unknown_deploy_action:${action}` };
}
