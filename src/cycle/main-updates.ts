import { join } from "node:path";
import { classifyOperationalFailure } from "./operational-failure.js";
import { legacyFailureRecoveryPatch, transientRuntimeObservationRecoveryPatch } from "../core/runtime-failure.js";
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
  // Alerts about the run's root process only mean something while a supervised run is still active.
  // A provider still working in the attempt outside the observed tree blocks in any phase and outranks every
  // other classification: nothing should act on output that is still changing.
  const dcRuntimeActivePhases = new Set(["implementation_launched", "implementation_running", "corrections_launched", "corrections_running"]);
  const dcActiveRunAlerts = new Set(["status_running_but_root_missing", "root_process_zombie", "wall_clock_timeout_seen"]);
  async function dcClassify(dir: string, status: any, runtime: any) {
    const out = String(status?.implementationStdout || status?.correctionsStdout || status?.directImplementationStdout || "");
    const err = String(status?.implementationStderr || status?.correctionsStderr || status?.directImplementationStderr || "");
    const text = [status?.error, status?.reason, status?.validationSummary, status?.councilReviewSummary, dcLines(runtime), out ? await textTail(out, 30000) : "", err ? await textTail(err, 30000) : ""].filter(Boolean).join("\n");
    const phase = String(status?.phase || "");
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
    if (!c) c = await classifyOperationalFailure(status);
    const codes = dcAlerts(runtime); const providerStillWorking = codes.includes("provider_processes_outside_observed_tree"); if (!c || providerStillWorking) { const b = codes.filter((x: string) => x === "provider_processes_outside_observed_tree" || (dcActiveRunAlerts.has(x) && dcRuntimeActivePhases.has(phase))); if (b.length) c = { failureClass:"runtime_observation_blocker", severity:"warning", humanRequired:true, safeToAutoRetry:false, autoStopRecommended:false, recommendedAction:"Inspect Observer runtime observation before deciding whether to stop or relaunch.", matched:{name:"runtime_alert", pattern:b.join(","), match:b.join(", ")} }; }
    const important = new Set(["implementation_launched","implementation_waiting_human","implementation_delivered","implementation_failed","review_infrastructure_failed","corrections_launched","corrections_completed","corrections_failed","external_validation_passed","external_validation_failed","stopped","closed"]);
    return { eventType:"development_cycle.update", phase, phaseSeverity:/failed|blocked|stopped/i.test(phase)?"blocking":"info", classification:c, shouldNotifyMain:Boolean(c)||important.has(phase), alertCodes:codes, evidencePaths:[join(dir,"status.json"),join(dir,"runtime_alerts.json"),join(dir,"runtime_observation.json"),c?.matched?.evidencePath,out,err].filter(Boolean), textExcerpt:dcShort(text.replace(/\s+/g," ").trim(),1600) };
  }
  async function dcPersistFailure(dir: string, status: any, ev: any) { const c = ev?.classification; if (!c?.failureClass) { const recovery = transientRuntimeObservationRecoveryPatch(status, c) || legacyFailureRecoveryPatch(status, c); if (!recovery) return {status,changed:false}; return {status:await cycleStatus(dir,recovery),changed:true}; } if (status?.failureClass===c.failureClass && status?.failureMatched?.name===c.matched?.name) { if (c.failureClass!=="runtime_observation_blocker" || status?.nextAction===c.recommendedAction) return {status,changed:false}; return {status:await cycleStatus(dir,{failureReplacedNextAction:status?.nextAction??null,nextAction:c.recommendedAction}),changed:true}; } return {status:await cycleStatus(dir,{failureClass:c.failureClass,failureSeverity:c.severity,failureHumanRequired:c.humanRequired,failureSafeToAutoRetry:c.safeToAutoRetry,failureAutoStopRecommended:c.autoStopRecommended,failureRecommendedAction:c.recommendedAction,failureMatched:c.matched,failureDetectedAt:new Date().toISOString(),failureReplacedNextAction:status?.failureClass?(status?.failureReplacedNextAction??null):(status?.nextAction??null),nextAction:c.recommendedAction}),changed:true}; }
  function dcSig(project: string, runId: string, status: any, ev: any) { const c=ev?.classification||{}; return JSON.stringify({project,runId,phase:status?.phase||ev?.phase||"",failureClass:c.failureClass||status?.failureClass||"",matched:c?.matched?.name||status?.failureMatched?.name||"",alerts:ev?.alertCodes||[],externalValidation:status?.externalValidation||""}); }
  function dcMainText(project: string, runId: string, dir: string, status: any, ev: any) { const c=ev?.classification; return ["[development_cycle.update]",`Project: ${project}`,`Run: ${runId}`,`Phase: ${status?.phase||ev?.phase||"unknown"}`,`Severity: ${c?.severity||ev?.phaseSeverity||"info"}`,c?.failureClass?`Failure class: ${c.failureClass}`:"",c?.matched?.name?`Matched: ${c.matched.name} (${c.matched.match})`:"",`Human required: ${c?String(Boolean(c.humanRequired)):"false"}`,`Safe to auto-retry: ${c?String(Boolean(c.safeToAutoRetry)):"unknown"}`,`Automatic stop recommended: ${c?String(Boolean(c.autoStopRecommended)):"false"}`,`Recommended action: ${c?.recommendedAction||status?.nextAction||"Inspect development_cycle status before acting."}`,`Run dir: ${dir}`,`Evidence: ${(ev?.evidencePaths||[]).join(" | ")}`,"","A retry prohibition is not a cancellation request. Keep observing active work unless a separate verified stop condition or explicit operator cancellation applies. Use the control plane for any authorized action."].filter(Boolean).join("\n"); }
  async function dcNotifyMain(dir: string, project: string, runId: string, status: any, params: any, ev: any) { if (params.notifyMain===false || params.emitMainUpdates===false) return {ok:true,skipped:true,reason:"notifyMain_disabled"}; if (!ev?.shouldNotifyMain) return {ok:true,skipped:true,reason:"not_notifiable"}; const statePath=join(dir,"main_update_state.json"), eventsPath=join(dir,"main_update_events.jsonl"), sig=dcSig(project,runId,status,ev), state=await loadJson(statePath); if (state?.lastSignature===sig) return {ok:true,skipped:true,reason:"duplicate_signature",statePath,eventsPath}; const event={eventType:"development_cycle.update",createdAt:new Date().toISOString(),project,runId,dir,phase:status?.phase||ev?.phase||"",classification:ev?.classification||null,alertCodes:ev?.alertCodes||[],recommendedAction:ev?.classification?.recommendedAction||status?.nextAction||"",evidencePaths:ev?.evidencePaths||[],signature:sig}; await appendJsonl(eventsPath,event); await saveJson(statePath,{lastSignature:sig,lastEvent:event,updatedAt:event.createdAt}); const text=dcMainText(project,runId,dir,status,ev); if (params.dryRunMainUpdate===true) return {ok:true,skipped:true,reason:"dry_run",event,statePath,eventsPath,text}; try { const r=await execFileAsync("openclaw",["system","event","--mode","now","--timeout",String(params.mainUpdateTimeoutMs||15000),"--text",text,"--json"],{timeout:Number(params.mainUpdateExecTimeoutMs||20000),maxBuffer:512*1024,env:{...process.env,HOME: runtimeHome}}); let parsed:any=null; try{parsed=JSON.parse(String(r.stdout||"{}"));}catch{} return {ok:true,event,statePath,eventsPath,systemEvent:parsed||{stdout:dcShort(r.stdout,2000),stderr:dcShort(r.stderr,2000)}}; } catch(e:any) { return {ok:false,event,statePath,eventsPath,error:String(e?.message||e),stdout:dcShort(e?.stdout||"",2000),stderr:dcShort(e?.stderr||"",2000)}; } }

  return { dcClassify, dcPersistFailure, dcNotifyMain };
}
