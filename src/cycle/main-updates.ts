import { join } from "node:path";
import { transientRuntimeObservationRecoveryPatch } from "../core/runtime-failure.js";
import { execFileAsync } from "./exec.js";
import { textTail } from "./files.js";
import type { createCycleStore } from "./cycle-store.js";

export interface MainUpdatesDeps {
  runtimeHome: string;
  loadJson: ReturnType<typeof createCycleStore>["loadJson"];
  saveJson: ReturnType<typeof createCycleStore>["saveJson"];
  cycleStatus: ReturnType<typeof createCycleStore>["cycleStatus"];
  appendJsonl: ReturnType<typeof createCycleStore>["appendJsonl"];
}

export function createMainUpdates(deps: MainUpdatesDeps) {
  const { runtimeHome, loadJson, saveJson, cycleStatus, appendJsonl } = deps;

  function dcShort(x: any, n = 1200) { const s = String(x || ""); return s.length <= n ? s : s.slice(0, n - 3) + "..."; }
  function dcAlerts(runtime: any): string[] { return [...new Set<string>((runtime?.richObservation?.alerts || []).map((a: any) => String(a?.code || "")).filter(Boolean))].sort(); }
  function dcLines(runtime: any) { return (runtime?.richObservation?.latestTimeline || []).map((x: any) => String(x?.line || "")).filter(Boolean).join("\n"); }
  function dcMatch(text: string, pairs: any[]) { for (const [name, re] of pairs) { const m = re.exec(text); if (m) return { name, pattern: String(re), match: dcShort(m[0], 220) }; } return null; }
  // Alerts about the run's root process only mean something while a supervised run is still active.
  // A provider still working in the attempt outside the observed tree blocks in any phase.
  const dcRuntimeActivePhases = new Set(["implementation_launched", "implementation_running", "corrections_launched", "corrections_running"]);
  const dcActiveRunAlerts = new Set(["status_running_but_root_missing", "root_process_zombie", "wall_clock_timeout_seen"]);
  async function dcClassify(dir: string, status: any, runtime: any) {
    const out = String(status?.implementationStdout || status?.correctionsStdout || status?.directImplementationStdout || "");
    const err = String(status?.implementationStderr || status?.correctionsStderr || status?.directImplementationStderr || "");
    const text = [status?.error, status?.reason, status?.validationSummary, status?.councilReviewSummary, dcLines(runtime), out ? await textTail(out, 30000) : "", err ? await textTail(err, 30000) : ""].filter(Boolean).join("\n");
    const phase = String(status?.phase || "");
    const policies: any[] = [
      ["auth_failed","blocking",true,false,true,"Resolve provider authentication/OAuth/bearer token state, then launch a clean Implementation handoff. Do not retry this run automatically.",[["401_unauthorized",/401\s+Unauthorized/i],["last_status_401",/last status:\s*401/i],["missing_bearer",/missing bearer/i],["invalid_api_key",/invalid api key|incorrect api key|unauthorized request/i]]],
      ["billing_or_quota_blocked","blocking",true,false,true,"Resolve provider billing/quota/credits or explicitly choose an alternate provider. Do not retry automatically.",[["quota_exceeded",/quota.*exceed|exceed.*quota|current quota/i],["billing_blocked",/billing|payment required|billing hard limit/i],["credits_exhausted",/insufficient credits|out of credits|credit balance|account balance|spend limit/i]]],
      ["rate_limited","warning",false,false,false,"Back off and resume only through an explicit supervised retry policy; do not spin retries in-place.",[["http_429",/\b429\b|Too Many Requests/i],["rate_limit",/rate limit|rate_limit|temporarily rate limited/i],["retry_limit",/exceeded retry limit/i]]],
      ["provider_fleet_failed","blocking",true,false,false,"Inspect provider routing/model availability and decomposition artifacts before relaunching a clean run.",[["all_providers_failed",/Decomposition failed with all providers|all providers failed/i],["no_substantive_inputs",/no substantive inputs/i],["synthesis_cannot_proceed",/Synthesis cannot proceed/i]]],
      ["local_runtime_fault","blocking",true,false,true,"Fix local permissions/sandbox/rollout-recorder state, then relaunch a clean run after inspecting dirty worktree.",[["permission_denied",/Permission denied|EACCES/i],["rollout_recorder",/failed to initialize rollout recorder/i],["sandbox_fault",/LandlockRestrict|error running landlock|linux-sandbox/i]]]
    ];
    let c: any = phase === "implementation_waiting_human"
      ? {
          failureClass: "implementation_waiting_human",
          severity: "warning",
          humanRequired: true,
          safeToAutoRetry: false,
          autoStopRecommended: false,
          recommendedAction: "Reply to main with the requested decision; main should call development_cycle answer_intervention for this run.",
          matched: { name: "human_intervention", pattern: "durable_phase", match: "implementation_waiting_human" },
        }
      : status?.reviewNonConvergence?.ok
      ? {
          failureClass: "review_non_convergence",
          severity: "warning",
          humanRequired: false,
          safeToAutoRetry: false,
          autoStopRecommended: false,
          recommendedAction: "Review did not converge within the Octopus correction ceiling. The partial output is delivered and each remaining blocking finding becomes a follow-up issue; do not relaunch this run.",
          matched: status.reviewNonConvergence.matched || { name: "review_non_convergence", pattern: "durable_status", match: "reviewNonConvergence" },
        }
      : phase === "review_infrastructure_failed"
      ? {
          failureClass: "review_infrastructure_failed",
          severity: "blocking",
          humanRequired: true,
          safeToAutoRetry: false,
          autoStopRecommended: false,
          recommendedAction: "Call resume_finalization only for this preserved Octopus output, then run mechanical final validation. Do not relaunch implementation automatically.",
          matched: status?.reviewInfrastructureFailure?.matched || { name: "review_infrastructure_failure", pattern: "durable_phase", match: "review_infrastructure_failed" },
        }
      : null;
    if (!c) for (const p of policies) { const m = dcMatch(text, p[6]); if (m) { c = { failureClass:p[0], severity:p[1], humanRequired:p[2], safeToAutoRetry:p[3], autoStopRecommended:p[4], recommendedAction:p[5], matched:m }; break; } }
    const codes = dcAlerts(runtime); if (!c) { const b = codes.filter((x: string) => x === "provider_processes_outside_observed_tree" || (dcActiveRunAlerts.has(x) && dcRuntimeActivePhases.has(phase))); if (b.length) c = { failureClass:"runtime_observation_blocker", severity:"warning", humanRequired:true, safeToAutoRetry:false, autoStopRecommended:false, recommendedAction:"Inspect Observer runtime observation before deciding whether to stop or relaunch.", matched:{name:"runtime_alert", pattern:b.join(","), match:b.join(", ")} }; }
    const important = new Set(["implementation_launched","implementation_waiting_human","implementation_delivered","implementation_failed","review_infrastructure_failed","corrections_launched","corrections_completed","corrections_failed","external_validation_passed","external_validation_failed","stopped","closed"]);
    return { eventType:"development_cycle.update", phase, phaseSeverity:/failed|blocked|stopped/i.test(phase)?"blocking":"info", classification:c, shouldNotifyMain:Boolean(c)||important.has(phase), alertCodes:codes, evidencePaths:[join(dir,"status.json"),join(dir,"runtime_alerts.json"),join(dir,"runtime_observation.json"),out,err].filter(Boolean), textExcerpt:dcShort(text.replace(/\s+/g," ").trim(),1600) };
  }
  async function dcPersistFailure(dir: string, status: any, ev: any) { const c = ev?.classification; if (!c?.failureClass) { const recovery = transientRuntimeObservationRecoveryPatch(status, c); if (!recovery) return {status,changed:false}; return {status:await cycleStatus(dir,recovery),changed:true}; } if (status?.failureClass===c.failureClass && status?.failureMatched?.name===c.matched?.name) { if (status?.nextAction===c.recommendedAction) return {status,changed:false}; return {status:await cycleStatus(dir,{failureReplacedNextAction:status?.nextAction??null,nextAction:c.recommendedAction}),changed:true}; } return {status:await cycleStatus(dir,{failureClass:c.failureClass,failureSeverity:c.severity,failureHumanRequired:c.humanRequired,failureSafeToAutoRetry:c.safeToAutoRetry,failureAutoStopRecommended:c.autoStopRecommended,failureRecommendedAction:c.recommendedAction,failureMatched:c.matched,failureDetectedAt:new Date().toISOString(),failureReplacedNextAction:status?.failureClass?(status?.failureReplacedNextAction??null):(status?.nextAction??null),nextAction:c.recommendedAction}),changed:true}; }
  function dcSig(project: string, runId: string, status: any, ev: any) { const c=ev?.classification||{}; return JSON.stringify({project,runId,phase:status?.phase||ev?.phase||"",failureClass:c.failureClass||status?.failureClass||"",matched:c?.matched?.name||status?.failureMatched?.name||"",alerts:ev?.alertCodes||[],externalValidation:status?.externalValidation||""}); }
  function dcMainText(project: string, runId: string, dir: string, status: any, ev: any) { const c=ev?.classification; return ["[development_cycle.update]",`Project: ${project}`,`Run: ${runId}`,`Phase: ${status?.phase||ev?.phase||"unknown"}`,`Severity: ${c?.severity||ev?.phaseSeverity||"info"}`,c?.failureClass?`Failure class: ${c.failureClass}`:"",c?.matched?.name?`Matched: ${c.matched.name} (${c.matched.match})`:"",`Human required: ${c?String(Boolean(c.humanRequired)):"false"}`,`Safe to auto-retry: ${c?String(Boolean(c.safeToAutoRetry)):"unknown"}`,`Recommended action: ${c?.recommendedAction||status?.nextAction||"Inspect development_cycle status before acting."}`,`Run dir: ${dir}`,`Evidence: ${(ev?.evidencePaths||[]).join(" | ")}`,"","Do not retry automatically when Safe to auto-retry is false. Use development_cycle status/stop_implementation as the control plane."].filter(Boolean).join("\n"); }
  async function dcNotifyMain(dir: string, project: string, runId: string, status: any, params: any, ev: any) { if (params.notifyMain===false || params.emitMainUpdates===false) return {ok:true,skipped:true,reason:"notifyMain_disabled"}; if (!ev?.shouldNotifyMain) return {ok:true,skipped:true,reason:"not_notifiable"}; const statePath=join(dir,"main_update_state.json"), eventsPath=join(dir,"main_update_events.jsonl"), sig=dcSig(project,runId,status,ev), state=await loadJson(statePath); if (state?.lastSignature===sig) return {ok:true,skipped:true,reason:"duplicate_signature",statePath,eventsPath}; const event={eventType:"development_cycle.update",createdAt:new Date().toISOString(),project,runId,dir,phase:status?.phase||ev?.phase||"",classification:ev?.classification||null,alertCodes:ev?.alertCodes||[],recommendedAction:ev?.classification?.recommendedAction||status?.nextAction||"",evidencePaths:ev?.evidencePaths||[],signature:sig}; await appendJsonl(eventsPath,event); await saveJson(statePath,{lastSignature:sig,lastEvent:event,updatedAt:event.createdAt}); const text=dcMainText(project,runId,dir,status,ev); if (params.dryRunMainUpdate===true) return {ok:true,skipped:true,reason:"dry_run",event,statePath,eventsPath,text}; try { const r=await execFileAsync("openclaw",["system","event","--mode","now","--timeout",String(params.mainUpdateTimeoutMs||15000),"--text",text,"--json"],{timeout:Number(params.mainUpdateExecTimeoutMs||20000),maxBuffer:512*1024,env:{...process.env,HOME: runtimeHome}}); let parsed:any=null; try{parsed=JSON.parse(String(r.stdout||"{}"));}catch{} return {ok:true,event,statePath,eventsPath,systemEvent:parsed||{stdout:dcShort(r.stdout,2000),stderr:dcShort(r.stderr,2000)}}; } catch(e:any) { return {ok:false,event,statePath,eventsPath,error:String(e?.message||e),stdout:dcShort(e?.stdout||"",2000),stderr:dcShort(e?.stderr||"",2000)}; } }

  return { dcClassify, dcPersistFailure, dcNotifyMain };
}
