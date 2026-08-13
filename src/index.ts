// @ts-nocheck
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { ACTIONS, checkActionTransition } from "./core/state-machine.js";
import { parseFinalDecision } from "./core/decisions.js";
import { cleanId, newRunId as createRunId } from "./core/ids.js";
import { loadDevelopmentCycleConfig } from "./config.js";
import { createFilesystemStore } from "./storage/filesystem.js";
import { buildImplementationLaunchSpec, renderShellCommand, renderShellEnvironment } from "./adapters/implementation.js";

const developmentCycleConfig = loadDevelopmentCycleConfig();
const secretPath = developmentCycleConfig.externalGate.secretPath;
const defaultUrl = developmentCycleConfig.externalGate.url;
const lit = (...xs: string[]) => Type.Union(xs.map((x) => Type.Literal(x)));

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

function buildQuery(params: Record<string, any>) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

async function request(path: string, options: any = {}) {
  const cfg = await loadConfig();
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


const execFileAsync = promisify(execFile);
const cycleRoot = developmentCycleConfig.stateRoot;
const wikiRoot = developmentCycleConfig.projectDocsGitRoot;
const projectsWikiRoot = developmentCycleConfig.projectDocsRoot;
const implementationConfig = developmentCycleConfig.implementation;
const observerObserveHelper = developmentCycleConfig.observer.observeHelperPath;
const observerAgentHook = developmentCycleConfig.observer.agentHookPath;
const observerHookLog = developmentCycleConfig.observer.hookLogPath;
const adapterSessionsRoot = developmentCycleConfig.observer.sessionsRoot;
const observerLocalBaseUrl = developmentCycleConfig.observer.baseUrl;
const defaultCodexSandbox = implementationConfig.octopusSandbox;
const runtimeHome = process.env.HOME || process.cwd();
const observerRepository = developmentCycleConfig.observer.repository;
const observerBranch = developmentCycleConfig.observer.branch;
const observerRuntime = developmentCycleConfig.observer.runtime;
const observerOwner = developmentCycleConfig.observer.owner || "operator";
const runnerSupervisorPath = developmentCycleConfig.runner.supervisorPath;
const runnerSupervisorSocket = developmentCycleConfig.runner.supervisorSocket;
const runnerHeartbeatIntervalSeconds = developmentCycleConfig.runner.heartbeatIntervalSeconds;
const runnerDefaultTimeoutSeconds = developmentCycleConfig.runner.defaultTimeoutSeconds;
const filesystemStore = createFilesystemStore(cycleRoot);

async function ensureRunnerSupervisor() {
  const ping = async () => {
    const res = await execFileAsync("python3", [runnerSupervisorPath, "--socket", runnerSupervisorSocket, "ping"], { timeout: 2000, maxBuffer: 64 * 1024 });
    const parsed = JSON.parse(String(res.stdout || "{}"));
    if (!parsed?.ok || !parsed?.subreaper) throw new Error("runner_supervisor_ping_invalid");
    return parsed;
  };
  try { return await ping(); } catch {}
  await execFileAsync("sh", ["-c", 'rm -f "$1"; nohup setsid python3 "$2" --socket "$1" serve >/tmp/development-cycle-runner-supervisor.log 2>&1 < /dev/null &', "development-cycle-supervisor-launcher", runnerSupervisorSocket, runnerSupervisorPath], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    try { return await ping(); } catch {}
  }
  throw new Error("runner_supervisor_start_failed");
}
const cycleDir = filesystemStore.runDir;
const loadJson = filesystemStore.loadJson;
const saveJson = filesystemStore.saveJson;
const cycleStatus = filesystemStore.updateStatus;
const appendJsonl = filesystemStore.appendJsonl;
function newRunId(project: string) { return createRunId(project); }
function dcShort(x: any, n = 1200) { const s = String(x || ""); return s.length <= n ? s : s.slice(0, n - 3) + "..."; }
function dcAlerts(runtime: any) { return [...new Set((runtime?.richObservation?.alerts || []).map((a: any) => String(a?.code || "")).filter(Boolean))].sort(); }
function dcLines(runtime: any) { return (runtime?.richObservation?.latestTimeline || []).map((x: any) => String(x?.line || "")).filter(Boolean).join("\n"); }
function dcMatch(text: string, pairs: any[]) { for (const [name, re] of pairs) { const m = re.exec(text); if (m) return { name, pattern: String(re), match: dcShort(m[0], 220) }; } return null; }
async function dcClassify(dir: string, status: any, runtime: any) {
  const out = String(status?.implementationStdout || status?.correctionsStdout || status?.directImplementationStdout || "");
  const err = String(status?.implementationStderr || status?.correctionsStderr || status?.directImplementationStderr || "");
  const text = [status?.error, status?.reason, status?.validationSummary, status?.councilReviewSummary, dcLines(runtime), out ? await textTail(out, 30000) : "", err ? await textTail(err, 30000) : ""].filter(Boolean).join("\n");
  const policies: any[] = [
    ["auth_failed","blocking",true,false,true,"Resolve provider authentication/OAuth/bearer token state, then launch a clean Implementation handoff. Do not retry this run automatically.",[["401_unauthorized",/401\s+Unauthorized/i],["last_status_401",/last status:\s*401/i],["missing_bearer",/missing bearer/i],["invalid_api_key",/invalid api key|incorrect api key|unauthorized request/i]]],
    ["billing_or_quota_blocked","blocking",true,false,true,"Resolve provider billing/quota/credits or explicitly choose an alternate provider. Do not retry automatically.",[["quota_exceeded",/quota.*exceed|exceed.*quota|current quota/i],["billing_blocked",/billing|payment required|billing hard limit/i],["credits_exhausted",/insufficient credits|out of credits|credit balance|account balance|spend limit/i]]],
    ["rate_limited","warning",false,false,false,"Back off and resume only through an explicit supervised retry policy; do not spin retries in-place.",[["http_429",/\b429\b|Too Many Requests/i],["rate_limit",/rate limit|rate_limit|temporarily rate limited/i],["retry_limit",/exceeded retry limit/i]]],
    ["provider_fleet_failed","blocking",true,false,false,"Inspect provider routing/model availability and decomposition artifacts before relaunching a clean run.",[["all_providers_failed",/Decomposition failed with all providers|all providers failed/i],["no_substantive_inputs",/no substantive inputs/i],["synthesis_cannot_proceed",/Synthesis cannot proceed/i]]],
    ["local_runtime_fault","blocking",true,false,true,"Fix local permissions/sandbox/rollout-recorder state, then relaunch a clean run after inspecting dirty worktree.",[["permission_denied",/Permission denied|EACCES/i],["rollout_recorder",/failed to initialize rollout recorder/i],["sandbox_fault",/LandlockRestrict|error running landlock|linux-sandbox/i]]]
  ];
  let c: any = null; for (const p of policies) { const m = dcMatch(text, p[6]); if (m) { c = { failureClass:p[0], severity:p[1], humanRequired:p[2], safeToAutoRetry:p[3], autoStopRecommended:p[4], recommendedAction:p[5], matched:m }; break; } }
  const codes = dcAlerts(runtime); if (!c) { const b = codes.filter((x: string) => ["status_running_but_root_missing","root_process_zombie","wall_clock_timeout_seen","provider_processes_outside_observed_tree"].includes(x)); if (b.length) c = { failureClass:"runtime_observation_blocker", severity:"warning", humanRequired:true, safeToAutoRetry:false, autoStopRecommended:false, recommendedAction:"Inspect Observer runtime observation before deciding whether to stop or relaunch.", matched:{name:"runtime_alert", pattern:b.join(","), match:b.join(", ")} }; }
  const phase = String(status?.phase || ""); const important = new Set(["implementation_launched","implementation_delivered","implementation_failed","corrections_launched","corrections_completed","corrections_failed","external_validation_passed","external_validation_failed","stopped","closed"]);
  return { eventType:"development_cycle.update", phase, phaseSeverity:/failed|blocked|stopped/i.test(phase)?"blocking":"info", classification:c, shouldNotifyMain:Boolean(c)||important.has(phase), alertCodes:codes, evidencePaths:[join(dir,"status.json"),join(dir,"runtime_alerts.json"),join(dir,"runtime_observation.json"),out,err].filter(Boolean), textExcerpt:dcShort(text.replace(/\s+/g," ").trim(),1600) };
}
async function dcPersistFailure(dir: string, status: any, ev: any) { const c = ev?.classification; if (!c?.failureClass) return {status,changed:false}; if (status?.failureClass===c.failureClass && status?.failureMatched?.name===c.matched?.name) return {status,changed:false}; return {status:await cycleStatus(dir,{failureClass:c.failureClass,failureSeverity:c.severity,failureHumanRequired:c.humanRequired,failureSafeToAutoRetry:c.safeToAutoRetry,failureAutoStopRecommended:c.autoStopRecommended,failureRecommendedAction:c.recommendedAction,failureMatched:c.matched,failureDetectedAt:new Date().toISOString(),nextAction:c.recommendedAction}),changed:true}; }
function dcSig(project: string, runId: string, status: any, ev: any) { const c=ev?.classification||{}; return JSON.stringify({project,runId,phase:status?.phase||ev?.phase||"",failureClass:c.failureClass||status?.failureClass||"",matched:c?.matched?.name||status?.failureMatched?.name||"",alerts:ev?.alertCodes||[],externalValidation:status?.externalValidation||""}); }
function dcMainText(project: string, runId: string, dir: string, status: any, ev: any) { const c=ev?.classification; return ["[development_cycle.update]",`Project: ${project}`,`Run: ${runId}`,`Phase: ${status?.phase||ev?.phase||"unknown"}`,`Severity: ${c?.severity||ev?.phaseSeverity||"info"}`,c?.failureClass?`Failure class: ${c.failureClass}`:"",c?.matched?.name?`Matched: ${c.matched.name} (${c.matched.match})`:"",`Human required: ${c?String(Boolean(c.humanRequired)):"false"}`,`Safe to auto-retry: ${c?String(Boolean(c.safeToAutoRetry)):"unknown"}`,`Recommended action: ${c?.recommendedAction||status?.nextAction||"Inspect development_cycle status before acting."}`,`Run dir: ${dir}`,`Evidence: ${(ev?.evidencePaths||[]).join(" | ")}`,"","Do not retry automatically when Safe to auto-retry is false. Use development_cycle status/stop_implementation as the control plane."].filter(Boolean).join("\n"); }
async function dcNotifyMain(dir: string, project: string, runId: string, status: any, params: any, ev: any) { if (params.notifyMain===false || params.emitMainUpdates===false) return {ok:true,skipped:true,reason:"notifyMain_disabled"}; if (!ev?.shouldNotifyMain) return {ok:true,skipped:true,reason:"not_notifiable"}; const statePath=join(dir,"main_update_state.json"), eventsPath=join(dir,"main_update_events.jsonl"), sig=dcSig(project,runId,status,ev), state=await loadJson(statePath); if (state?.lastSignature===sig) return {ok:true,skipped:true,reason:"duplicate_signature",statePath,eventsPath}; const event={eventType:"development_cycle.update",createdAt:new Date().toISOString(),project,runId,dir,phase:status?.phase||ev?.phase||"",classification:ev?.classification||null,alertCodes:ev?.alertCodes||[],recommendedAction:ev?.classification?.recommendedAction||status?.nextAction||"",evidencePaths:ev?.evidencePaths||[],signature:sig}; await appendJsonl(eventsPath,event); await saveJson(statePath,{lastSignature:sig,lastEvent:event,updatedAt:event.createdAt}); const text=dcMainText(project,runId,dir,status,ev); if (params.dryRunMainUpdate===true) return {ok:true,skipped:true,reason:"dry_run",event,statePath,eventsPath,text}; try { const r=await execFileAsync("openclaw",["system","event","--mode","now","--timeout",String(params.mainUpdateTimeoutMs||15000),"--text",text,"--json"],{timeout:Number(params.mainUpdateExecTimeoutMs||20000),maxBuffer:512*1024,env:{...process.env,HOME: runtimeHome}}); let parsed:any=null; try{parsed=JSON.parse(String(r.stdout||"{}"));}catch{} return {ok:true,event,statePath,eventsPath,systemEvent:parsed||{stdout:dcShort(r.stdout,2000),stderr:dcShort(r.stderr,2000)}}; } catch(e:any) { return {ok:false,event,statePath,eventsPath,error:String(e?.message||e),stdout:dcShort(e?.stdout||"",2000),stderr:dcShort(e?.stderr||"",2000)}; } }

async function createImplementationRunnerSession(dir: string, params: any) {
  const projectRoot = String(params.projectRoot || "");
  const prompt = String(params.prompt || "");
  const command = String(params.command || "implement");
  const mode = String(params.kind || "delivery") === "corrections" ? "corrections" : "delivery";
  const timeoutSeconds = Number(params.timeoutSeconds ?? 0);
  const effectiveTimeoutSeconds = timeoutSeconds > 0 ? timeoutSeconds : runnerDefaultTimeoutSeconds;
  const observerRootSessionId = String(params.observerObservationId || "");
  if (developmentCycleConfig.observer.enabled && !observerRootSessionId) {
    return { ok: false, error: "observer_root_session_missing" };
  }

  const sessionId = cleanId(params.sessionId || `DC-${params.project || "project"}-${params.runId || Date.now()}-${Date.now()}`);
  const sessionDir = join(dir, mode === "corrections" ? "corrections_session" : "implementation_session");
  const logsDir = join(sessionDir, "logs");
  const statusPath = join(sessionDir, "status.json");
  const payloadPath = join(sessionDir, "payload.json");
  const requestPath = join(sessionDir, "request.json");
  const promptPath = join(sessionDir, "prompt.txt");
  const runnerPath = join(sessionDir, "run-implementation-session.sh");
  const exitCodePath = join(sessionDir, "exit-code.txt");
  const exitedAtPath = join(sessionDir, "exited-at.txt");
  const stdoutPath = join(logsDir, "stdout.log");
  const stderrPath = join(logsDir, "stderr.log");

  const rootStat = await stat(projectRoot).catch(() => null);
  if (!rootStat?.isDirectory()) {
    return { ok: false, error: "projectRoot_missing_or_not_directory", projectRoot };
  }

  await mkdir(logsDir, { recursive: true });
  await writeFile(promptPath, prompt);
  const request = {
    schemaVersion: 1,
    project: String(params.project || ""),
    runId: String(params.runId || ""),
    mode,
    projectRoot,
    promptPath,
    planPath: String(params.planPath || ""),
    validationPath: String(params.validationPath || ""),
    resultsRoot: dir,
    timeoutSeconds: effectiveTimeoutSeconds,
    command,
  };
  await saveJson(requestPath, request);

  let launchSpec: any;
  try {
    launchSpec = buildImplementationLaunchSpec(implementationConfig, {
      adapter: params.implementationAdapter,
      project: request.project,
      runId: request.runId,
      mode,
      projectRoot,
      requestPath,
      promptPath,
      prompt,
      timeoutSeconds: effectiveTimeoutSeconds,
      command,
      observer: {
        sessionId: observerRootSessionId,
        agentHookPath: observerAgentHook,
        hookLogPath: observerHookLog,
        repository: observerRepository,
        branch: observerBranch,
        owner: observerOwner,
      },
    });
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error), adapter: params.implementationAdapter || implementationConfig.adapter };
  }

  const executableStat = await stat(launchSpec.executable).catch(() => null);
  if (!executableStat?.isFile() || (executableStat.mode & 0o111) === 0) {
    return {
      ok: false,
      error: "implementation_executable_missing_or_not_executable",
      adapter: launchSpec.adapter,
      executable: launchSpec.executable,
    };
  }

  const environment = renderShellEnvironment({ ...launchSpec.env, HOME: runtimeHome });
  const commandLine = renderShellCommand(launchSpec);
  const runnerScript = `#!/bin/sh
set -u
${environment}
HEARTBEAT_FILE=${JSON.stringify(join(sessionDir, "heartbeat.json"))}
STATUS_FILE=${JSON.stringify(statusPath)}
heartbeat_pid=""
cleanup_process_group() {
  runner_pid=$$
  runner_pgid=$(ps -o pgid= -p "$runner_pid" | tr -d ' ')
  [ -n "$runner_pgid" ] || return 0

  cleanup_pids=$(ps -eo pid=,pgid=,stat= | awk -v pgid="$runner_pgid" -v self="$runner_pid" '$2 == pgid && $1 != self && $3 !~ /^Z/ { print $1 }')
  if [ -n "$cleanup_pids" ]; then
    kill -TERM $cleanup_pids 2>/dev/null || true
    sleep 1
  fi

  cleanup_pids=$(ps -eo pid=,pgid=,stat= | awk -v pgid="$runner_pgid" -v self="$runner_pid" '$2 == pgid && $1 != self && $3 !~ /^Z/ { print $1 }')
  [ -z "$cleanup_pids" ] || kill -KILL $cleanup_pids 2>/dev/null || true
}
finalize() {
  rc=$?
  trap - EXIT TERM INT HUP
  if [ -n "$heartbeat_pid" ]; then
    kill "$heartbeat_pid" 2>/dev/null || true
    wait "$heartbeat_pid" 2>/dev/null || true
  fi
  exited_at=$(date -Is)
  printf '%s\n' "$rc" > ${JSON.stringify(exitCodePath)}
  printf '%s\n' "$exited_at" > ${JSON.stringify(exitedAtPath)}
  terminal_status=completed
  [ "$rc" -eq 0 ] || terminal_status=failed
  status_tmp="\${STATUS_FILE}.tmp.$$"
  if jq --arg status "$terminal_status" --arg launchState exited --argjson exitCode "$rc" --arg exitedAt "$exited_at" --arg updatedAt "$exited_at" '.status = $status | .launchState = $launchState | .exitCode = $exitCode | .exitedAt = $exitedAt | .updatedAt = $updatedAt' "$STATUS_FILE" > "$status_tmp"; then
    mv "$status_tmp" "$STATUS_FILE"
  else
    rm -f "$status_tmp"
  fi
  cleanup_process_group
}
trap finalize EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
(while :; do printf '{"at":"%s","pid":%s,"observerSessionId":"%s"}\n' "$(date -Is)" "$$" "${observerRootSessionId}" > "$HEARTBEAT_FILE"; sleep ${runnerHeartbeatIntervalSeconds}; done) &
heartbeat_pid=$!
cd ${JSON.stringify(projectRoot)}
${commandLine} > ${JSON.stringify(stdoutPath)} 2> ${JSON.stringify(stderrPath)}
`;
  await writeFile(runnerPath, runnerScript, { mode: 0o755 } as any);

  const now = new Date().toISOString();
  const status: any = {
    id: sessionId,
    runtime: "development-cycle-runner",
    adapter: launchSpec.adapter,
    command: `${launchSpec.displayName} ${command}`.trim(),
    owner: observerOwner,
    status: "running",
    launchState: "running",
    timeoutSeconds: effectiveTimeoutSeconds,
    timeoutPolicy: "bounded-with-heartbeat-stall-detection",
    observerRootSessionId,
    heartbeatPath: join(sessionDir, "heartbeat.json"),
    message: `Implementation launched through the ${launchSpec.displayName} adapter.`,
    createdAt: now,
    updatedAt: now,
    projectRoot,
    executable: launchSpec.executable,
    runnerPath,
    requestPath,
    promptPath,
    exitCodePath,
    exitedAtPath,
    logs: { stdout: stdoutPath, stderr: stderrPath },
    stdoutPath,
    stderrPath,
  };
  await saveJson(payloadPath, {
    id: sessionId,
    project: request.project,
    runId: request.runId,
    mode,
    adapter: launchSpec.adapter,
    projectRoot,
    executable: launchSpec.executable,
    requestPath,
    promptPath,
    purpose: params.purpose || "development_cycle implementation",
  });
  await saveJson(statusPath, status);

  const supervisor = await ensureRunnerSupervisor();
  const launched = await execFileAsync("python3", [runnerSupervisorPath, "--socket", runnerSupervisorSocket, "launch", runnerPath, sessionDir], {
    cwd: sessionDir,
    env: { ...process.env, HOME: runtimeHome },
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  const launchInfo = JSON.parse(String(launched.stdout || "{}"));
  const runnerPid = Number(launchInfo?.pid || 0);
  if (!launchInfo?.ok || !Number.isInteger(runnerPid) || runnerPid <= 1) {
    throw new Error(`supervised_runner_pid_invalid:${String(launched.stdout || "").trim()}`);
  }
  status.runnerPid = runnerPid;
  status.processGroupId = Number(launchInfo?.pgid || runnerPid);
  status.runnerSupervisorPid = Number(launchInfo?.supervisorPid || supervisor?.pid || 0) || null;
  status.runnerSupervisorSocket = runnerSupervisorSocket;
  status.useProcessGroup = true;
  status.stopSignalPolicy = "process-group-term-kill";
  status.updatedAt = new Date().toISOString();
  await saveJson(statusPath, status);
  return {
    ok: true,
    adapter: launchSpec.adapter,
    sessionId,
    sessionDir,
    statusPath,
    payloadPath,
    requestPath,
    runnerPath,
    promptPath,
    exitCodePath,
    stdoutPath,
    stderrPath,
    status,
  };
}


async function observerObservation(dir: string, payload: any) {
  if (!developmentCycleConfig.observer.enabled) return { ok: true, skipped: true, reason: "observer_disabled" };
  try {
    const helperStat = await stat(observerObserveHelper).catch(() => null);
    if (!helperStat?.isFile()) return { ok: false, skipped: true, reason: "observer_observe_helper_missing", helper: observerObserveHelper };
    const file = join(dir, `observer_observation_${Date.now()}.json`);
    await writeFile(file, JSON.stringify(payload, null, 2) + "\n");
    const res = await execFileAsync("node", [observerObserveHelper, file], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: runtimeHome, TMPDIR: process.env.TMPDIR, USER: process.env.USER },
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    let parsed: any = null;
    try { parsed = JSON.parse(res.stdout || "{}"); } catch {}
    const id = parsed?.status?.id || "";
    return { ok: Boolean(id), id, raw: parsed, file };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function createImplementationObserverSession(dir: string, params: any) {
  if (!developmentCycleConfig.observer.enabled) return "";
  const observation = await observerObservation(dir, {
    repo: observerRepository,
    branch: observerBranch,
    runtime: observerRuntime,
    command: `development_cycle ${params.command || "implementation"} ${params.project || ""}`.trim(),
    owner: observerOwner,
    status: "ready",
    cwd: params.projectRoot,
    projectRoot: params.projectRoot,
    resultsRoot: dir,
    stdoutPath: params.stdoutPath,
    stderrPath: params.stderrPath,
    summary: `Development cycle Implementation ${params.command || "handoff"} for ${params.project || "project"}`,
    message: `Development cycle Implementation ${params.command || "handoff"} requested for ${params.project || "project"}`,
    control: { type: "process", stopAllowed: true, interruptAllowed: true, messageAllowed: true, correctionAllowed: true, useProcessGroup: true },
    developmentCycle: {
      enabled: true,
      project: params.project || "",
      runId: params.runId || "",
      projectRoot: params.projectRoot || "",
      projectWikiPath: params.projectWikiPath || "",
      intervalSeconds: Number(params.watchIntervalSeconds || 60),
      stallQuietSeconds: Number(params.stallQuietSeconds || 900),
    },
  });
  return observation?.ok ? String(observation.id) : "";
}

async function updateImplementationObserverSession(dir: string, id: string, params: any) {
  if (!developmentCycleConfig.observer.enabled || !id) return null;
  return await observerObservation(dir, {
    id,
    repo: observerRepository,
    branch: observerBranch,
    runtime: observerRuntime,
    command: `development_cycle ${params.command || "implementation"} ${params.project || ""}`.trim(),
    owner: observerOwner,
    status: params.status || "completed",
    cwd: params.projectRoot,
    projectRoot: params.projectRoot,
    resultsRoot: dir,
    stdoutPath: params.stdoutPath,
    stderrPath: params.stderrPath,
    summary: params.summary || `Development cycle Implementation ${params.status || "completed"}`,
    message: params.message || `Development cycle Implementation ${params.status || "completed"}`,
    control: { type: "process", stopAllowed: true, interruptAllowed: true, messageAllowed: true, correctionAllowed: true, useProcessGroup: true },
    developmentCycle: {
      enabled: true,
      project: params.project || "",
      runId: params.runId || "",
      projectRoot: params.projectRoot || "",
      projectWikiPath: params.projectWikiPath || "",
      intervalSeconds: Number(params.watchIntervalSeconds || 60),
      stallQuietSeconds: Number(params.stallQuietSeconds || 900),
    },
  });
}

function implementationNoDelivery(stdout: string, stderr: string) {
  const text = `${stdout || ""}
${stderr || ""}`;
  const patterns = [
    /Synthesis cannot proceed/i,
    /no substantive inputs/i,
    /Decomposition failed with all providers/i,
    /FAILED \(exit code/i,
    /failed to initialize rollout recorder/i,
    /Permission denied/i,
    /EACCES/i,
    /LandlockRestrict/i,
    /error running landlock/i,
    /linux-sandbox/i,
    /401 Unauthorized/i,
    /exceeded retry limit/i,
    /last status:\s*401/i,
  ];
  const matched = patterns.find((re) => re.test(text));
  return matched ? matched.source : "";
}
function looksLikePlanRequest(text: string) {
  const t = String(text || "").toLowerCase();
  const markers = [
    "plan request for implementation",
    "required implementation output",
    "cria um plano técnico",
    "produz um plano técnico",
    "create or validate the implementation plan only",
    "não implementar nada",
    "apenas planear",
    "output location",
    "gravar o plano final",
  ];
  return markers.filter((m) => t.includes(m)).length >= 2;
}
function looksLikeImplementationPlan(text: string) {
  const t = String(text || "").toLowerCase();
  const markers = [
    "ordered implementation",
    "implementation tasks",
    "validation checks",
    "stop conditions",
    "expected artifacts",
    "architecture overview",
    "test matrix",
    "shared core",
    "data models",
  ];
  const pathMarkers = [
    "project paths",
    "projectroot",
    "projectwikipath",
    "project_root_code_checkout",
    "project docs root",
    "source checkout",
    "relevant code paths",
    "affected files",
    "output paths",
  ];
  return markers.filter((m) => t.includes(m)).length >= 3 && pathMarkers.filter((m) => t.includes(m)).length >= 2;
}
async function readTextIfExists(path: string) {
  try { return await readFile(path, "utf8"); } catch { return ""; }
}

function excerpt(text: string, max = 4000) {
  const s = String(text || "").trim();
  return s.length <= max ? s : `${s.slice(0, max)}\n\n[truncated: ${s.length - max} chars omitted]`;
}
async function readJsonIfExists(path: string) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function execSummary(file: string, args: string[], cwd: string, timeout = 10000) {
  if (!cwd) return "not supplied";
  try {
    const res = await execFileAsync(file, args, { cwd, timeout, maxBuffer: 1024 * 1024 });
    return `${res.stdout || ""}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`.trim() || "ok, no output";
  } catch (err: any) {
    const out = `${err?.stdout || ""}${err?.stderr ? `\n[stderr]\n${err.stderr}` : ""}`.trim();
    return `command failed: ${file} ${args.join(" ")}\n${err?.message || err}${out ? `\n${excerpt(out, 3000)}` : ""}`;
  }
}
async function safeDirEntries(path: string, max = 60) {
  try {
    const entries = await readdir(path, { withFileTypes: true } as any);
    return entries.map((e: any) => `${e.isDirectory() ? "d" : e.isFile() ? "f" : "?"} ${e.name}`)
      .filter((x: string) => !/(^| )\.env(\.|$)|secret|token|auth|credential|cookie/i.test(x)).sort().slice(0, max);
  } catch (err: any) { return [`unavailable: ${err?.message || err}`]; }
}
async function projectWikiBrief(projectWikiPath: string) {
  const wanted = ["README.md", "status.md", "ROADMAP.md", "RUNS.md", "architecture.md", "runbook.md"];
  const parts: string[] = [];
  for (const name of wanted) {
    const text = await readTextIfExists(join(projectWikiPath, name));
    if (text.trim()) parts.push(`### ${name}\n\n${excerpt(text, 2500)}`);
  }
  return parts.length ? parts.join("\n\n") : "No standard project wiki files found.";
}
async function packageScriptsBrief(projectRoot: string) {
  const pkg = await readJsonIfExists(join(projectRoot, "package.json"));
  if (!pkg?.scripts) return "No package.json scripts detected.";
  return Object.entries(pkg.scripts).map(([k, v]) => `- ${k}: ${v}`).join("\n");
}
async function writePlanningPack(dir: string, params: any) {
  const projectRoot = params.projectRoot || "";
  // Resolve through symlinks so a wiki dir under projectsWikiRoot cannot redirect recon reads.
  const trustedWiki = params.projectWikiPath
    ? await resolveContainedWikiDir(String(params.project || "default"), String(params.projectWikiPath))
    : "";
  const projectWikiPath = trustedWiki;
  const rootStat = projectRoot ? await stat(projectRoot).catch(() => null) : null;
  const wikiStat = trustedWiki ? await stat(trustedWiki).catch(() => null) : null;
  const gitStatus = rootStat?.isDirectory() ? await execSummary("git", ["status", "--short", "--branch"], projectRoot) : "projectRoot missing or not supplied";
  const gitRemote = rootStat?.isDirectory() ? await execSummary("git", ["remote", "-v"], projectRoot) : "projectRoot missing or not supplied";
  const gitDiffStat = rootStat?.isDirectory() ? await execSummary("git", ["diff", "--stat"], projectRoot) : "projectRoot missing or not supplied";
  const rootEntries = rootStat?.isDirectory() ? (await safeDirEntries(projectRoot)).join("\n") : "projectRoot missing or not supplied";
  const wikiEntries = wikiStat?.isDirectory() ? (await safeDirEntries(trustedWiki)).join("\n") : "projectWikiPath missing or not supplied";
  const wikiBrief = wikiStat?.isDirectory() ? await projectWikiBrief(trustedWiki) : "projectWikiPath missing or not supplied";
  const packageScripts = rootStat?.isDirectory() ? await packageScriptsBrief(projectRoot) : "projectRoot missing or not supplied";
  const contextPack = join(dir, "context_pack.md");
  await writeFile(contextPack, `# Development cycle context pack\n\nProject: ${params.project}\nRun: ${params.runId}\nGenerated: ${new Date().toISOString()}\n\n## User direction\n\n${params.direction || "not supplied"}\n\n## Paths\n\n- projectWikiPath: ${projectWikiPath || "not supplied"}\n- projectWikiPath exists: ${Boolean(wikiStat?.isDirectory())}\n- projectRoot: ${projectRoot || "not supplied"}\n- projectRoot exists: ${Boolean(rootStat?.isDirectory())}\n- existingPlanPath: ${params.existingPlanPath || "not supplied"}\n\n## Project wiki directory\n\n${wikiEntries}\n\n## Project root directory\n\n${rootEntries}\n\n## Git status\n\n\`\`\`text\n${excerpt(gitStatus, 6000)}\n\`\`\`\n\n## Git remotes\n\n\`\`\`text\n${excerpt(gitRemote, 3000)}\n\`\`\`\n\n## Git diff stat\n\n\`\`\`text\n${excerpt(gitDiffStat, 3000)}\n\`\`\`\n\n## Package scripts / validation commands detected\n\n${packageScripts}\n\n## Project wiki brief\n\n${wikiBrief}\n`);
  const operatorConstraints = join(dir, "operator_constraints.md");
  await writeFile(operatorConstraints, `# Operator constraints\n\nProject: ${params.project}\nRun: ${params.runId}\n\n## Hard constraints\n\n- Do not edit secrets, tokens, cookies, OAuth files, auth profiles, .env files, generated credentials, or production state.\n- Do not edit protected OpenClaw configuration unless the operator explicitly authorizes the exact path.\n- Do not patch third-party/upstream runtime code as architecture. If upstream changes are needed, use a branch/PR-style patch with rollback notes.\n- Do not ask Implementation to infer the code checkout from the wiki folder. Use the real projectRoot.\n- Stop before destructive actions, broad chown/chmod, database migrations, service recreation, external publishing, merge/release/tag, or irreversible file deletion.\n- Prefer typed tools/plugins and documented interfaces over loose scripts.\n\n## Required plan gates\n\n- Identify risky/protected paths before implementation.\n- Define validation commands and smoke checks before implementation.\n- Define expected artifacts and where they will be written.\n- Define stop conditions and human-confirmation points.\n`);
  const expectedPlanContract = join(dir, "expected_plan_contract.md");
  await writeFile(expectedPlanContract, `# Expected implementation plan contract\n\nThe plan returned by an external planner or human reviewer must be an implementation plan, not another planning request.\n\n## Required sections\n\n1. Objective and non-goals\n2. Project paths: projectWikiPath, projectRoot, planPath, affected paths, artifacts, protected/risky paths\n3. Current state summary from context_pack.md\n4. Ordered implementation tasks\n5. Observer / Implementation observation plan\n6. Validation checks and smoke tests\n7. Stop conditions and human-confirmation points\n8. Rollback or recovery notes\n9. Final acceptance criteria\n\nA plan without projectRoot, affected files, validation checks, stop conditions and expected artifacts is not ready for Implementation handoff.\n`);
  return { contextPack, operatorConstraints, expectedPlanContract };
}

/** Prefer caller-supplied wiki path only when it stays under projectsWikiRoot. */
function resolveTrustedProjectWikiPath(project: string, ...candidates: Array<string | null | undefined>): string {
  let fallback = resolve(join(projectsWikiRoot, cleanId(project || "default")));
  // Dot-tokens (`.` / `..`) survive cleanId and would make the fallback the wiki root or its parent.
  if (!pathWithin(projectsWikiRoot, fallback) || fallback === resolve(projectsWikiRoot)) {
    fallback = resolve(join(projectsWikiRoot, "default"));
  }
  for (const c of candidates) {
    if (!c) continue;
    const abs = resolve(String(c));
    if (pathWithin(projectsWikiRoot, abs)) return abs;
  }
  return fallback;
}

function pathWithin(root: string, candidate: string) {
  if (!root || !candidate) return false;
  const rel = relative(resolve(root), resolve(candidate)).replace(/\\/g, "/");
  return Boolean(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/");
}

/** True if candidate resolves inside any allowed root (or equals a root). */
function pathWithinAny(roots: Array<string | null | undefined>, candidate: string) {
  const c = resolve(String(candidate || ""));
  for (const root of roots) {
    if (!root) continue;
    const r = resolve(String(root));
    if (c === r || pathWithin(r, c)) return true;
  }
  return false;
}

/** Realpath of value when it is an existing directory; else ''. Reject roots that would swallow cycle/wiki trees. */
async function trustedProjectRoot(value: string): Promise<string> {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const abs = resolve(raw);
    const st = await stat(abs);
    if (!st.isDirectory()) return "";
    const real = await realpath(abs);
    if (real === resolve("/")) return "";
    for (const owned of [cycleRoot, projectsWikiRoot, wikiRoot]) {
      if (!owned) continue;
      try {
        const ownedReal = await realpath(resolve(String(owned)));
        const rel = relative(real, ownedReal).replace(/\\/g, "/");
        if (rel === "" || (rel && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/"))) return "";
      } catch { /* owned root may not exist yet */ }
    }
    return real;
  } catch {
    return "";
  }
}

async function readAllowedTextFile(pathValue: string, roots: Array<string | null | undefined>, errorCode: string) {
  const raw = String(pathValue || "").trim();
  if (!raw) return { ok: false as const, error: errorCode };
  const abs = resolve(raw);
  let realCandidate: string;
  try {
    realCandidate = await realpath(abs);
  } catch (e: any) {
    return { ok: false as const, error: errorCode, path: abs, detail: String(e?.message || e) };
  }
  let allowed = false;
  for (const root of roots) {
    if (!root) continue;
    try {
      const realRoot = await realpath(resolve(String(root)));
      const rel = relative(realRoot, realCandidate).replace(/\\/g, "/");
      if (rel === "" || (Boolean(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/"))) {
        allowed = true;
        break;
      }
    } catch {
      // root may not exist
    }
  }
  if (!allowed) return { ok: false as const, error: errorCode, path: abs };
  try {
    const text = await readFile(realCandidate, "utf8");
    return { ok: true as const, path: realCandidate, text };
  } catch (e: any) {
    return { ok: false as const, error: errorCode, path: realCandidate, detail: String(e?.message || e) };
  }
}

async function resolveContainedWikiDir(project: string, projectWikiPath: string): Promise<string> {
  const trusted = resolveTrustedProjectWikiPath(project, projectWikiPath);
  // Resolve through symlinks when the wiki dir already exists so a symlink under
  // projectsWikiRoot cannot redirect writes outside the root.
  let normalized = trusted;
  try {
    normalized = await realpath(trusted);
  } catch {
    normalized = trusted;
  }
  let realRoot = resolve(projectsWikiRoot);
  try {
    realRoot = await realpath(projectsWikiRoot);
  } catch {
    /* root may not exist yet */
  }
  const rel = relative(realRoot, normalized).replace(/\\/g, "/");
  if (!(rel && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/"))) return "";
  return normalized;
}

async function persistApprovedPlan(project: string, runId: string, projectWikiPath: string, planText: string) {
  const normalized = await resolveContainedWikiDir(project, projectWikiPath);
  if (!normalized) return "";
  let realRoot = resolve(projectsWikiRoot);
  try {
    realRoot = await realpath(projectsWikiRoot);
  } catch {
    /* root may not exist yet */
  }
  const plansDir = join(normalized, "plans");
  await mkdir(plansDir, { recursive: true });
  try {
    const realPlansDir = await realpath(plansDir);
    const plansRel = relative(realRoot, realPlansDir).replace(/\\/g, "/");
    if (!(plansRel && plansRel !== ".." && !plansRel.startsWith("../") && !plansRel.startsWith("/"))) {
      return "";
    }
  } catch {
    return "";
  }
  const path = join(plansDir, `${new Date().toISOString().slice(0, 10)}-${cleanId(runId)}-implementation-plan.md`);
  await writeFile(path, String(planText).trim() + "\n");
  // Final containment check on the written path (handles TOCTOU / nested links).
  try {
    const realFile = await realpath(path);
    const fileRel = relative(realRoot, realFile).replace(/\\/g, "/");
    if (!(fileRel && fileRel !== ".." && !fileRel.startsWith("../") && !fileRel.startsWith("/"))) {
      return "";
    }
  } catch {
    /* file just written should exist */
  }
  return path;
}

function wikiRelativePath(path: string) {
  if (!wikiRoot || !pathWithin(wikiRoot, path)) return "";
  return relative(resolve(wikiRoot), resolve(String(path))).replace(/\\/g, "/");
}

function allowedCanonicalPlanPath(path: string) {
  if (!pathWithin(projectsWikiRoot, path)) return "";
  const rel = wikiRelativePath(path);
  if (!rel) return "";
  return /(?:^|\/)plans\/[^/]+\.md$/.test(rel) ? rel : "";
}

async function execGit(args: string[], cwd = wikiRoot, timeout = 10000) {
  try {
    const res = await execFileAsync("git", args, { cwd, timeout, maxBuffer: 1024 * 1024 });
    return { ok: true, stdout: String(res.stdout || ""), stderr: String(res.stderr || "") };
  } catch (err: any) {
    return { ok: false, stdout: String(err?.stdout || ""), stderr: String(err?.stderr || ""), error: String(err?.message || err) };
  }
}

async function autoCommitCanonicalPlan(project: string, runId: string, canonicalPlan: string) {
  const rel = allowedCanonicalPlanPath(canonicalPlan);
  if (!rel) return { ok: false, skipped: true, reason: "canonical_plan_path_not_allowlisted", canonicalPlan };
  const fileStat = await stat(canonicalPlan).catch(() => null);
  if (!fileStat?.isFile()) return { ok: false, skipped: true, reason: "canonical_plan_missing", canonicalPlan };

  const stagedBefore = await execGit(["diff", "--cached", "--name-only"]);
  if (!stagedBefore.ok) return { ok: false, skipped: true, reason: "git_staged_check_failed", detail: excerpt(`${stagedBefore.error || ""}\n${stagedBefore.stderr || ""}`, 2000) };
  const staged = stagedBefore.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const foreignStaged = staged.filter((x) => x !== rel);
  if (foreignStaged.length) return { ok: false, skipped: true, reason: "foreign_staged_changes_present", staged: foreignStaged.slice(0, 20) };

  const add = await execGit(["add", "--", rel]);
  if (!add.ok) return { ok: false, skipped: true, reason: "git_add_failed", detail: excerpt(`${add.error || ""}\n${add.stderr || ""}`, 2000), canonicalPlan };

  const status = await execGit(["status", "--short", "--", rel]);
  if (!status.ok) return { ok: false, skipped: true, reason: "git_status_failed", detail: excerpt(`${status.error || ""}\n${status.stderr || ""}`, 2000), canonicalPlan };
  if (!status.stdout.trim()) return { ok: true, skipped: true, reason: "no_plan_changes_to_commit", canonicalPlan, relativePath: rel };

  const stagedAfter = await execGit(["diff", "--cached", "--name-only"]);
  if (!stagedAfter.ok) return { ok: false, skipped: true, reason: "git_staged_after_check_failed", detail: excerpt(`${stagedAfter.error || ""}\n${stagedAfter.stderr || ""}`, 2000), canonicalPlan };
  const stagedAfterFiles = stagedAfter.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const unexpected = stagedAfterFiles.filter((x) => x !== rel);
  if (unexpected.length) return { ok: false, skipped: true, reason: "unexpected_staged_changes_present", staged: unexpected.slice(0, 20), canonicalPlan };

  const message = `development-cycle: track approved plan for ${cleanId(project)} ${cleanId(runId)}`;
  const commit = await execGit(["commit", "-m", message, "--", rel], wikiRoot, 20000);
  if (!commit.ok) return { ok: false, skipped: true, reason: "git_commit_failed", detail: excerpt(`${commit.error || ""}\n${commit.stdout || ""}\n${commit.stderr || ""}`, 3000), canonicalPlan, relativePath: rel };

  const rev = await execGit(["rev-parse", "--short", "HEAD"]);
  return { ok: true, skipped: false, commit: rev.ok ? rev.stdout.trim() : "", message, canonicalPlan, relativePath: rel };
}
async function collectObserverSessions(status: any) {
  if (!developmentCycleConfig.observer.enabled || !adapterSessionsRoot) return [];
  const roots = [status?.observerSessionId, status?.observerCorrectionsSessionId, status?.observerObservationId, status?.observerCorrectionsObservationId].filter(Boolean).map(String);
  if (!roots.length) return [];
  const out: any[] = [];
  const seen = new Set<string>();
  async function add(id: string) {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const s = await readJsonIfExists(join(adapterSessionsRoot, id, "status.json"));
    const p = await readJsonIfExists(join(adapterSessionsRoot, id, "payload.json"));
    out.push({ id, parentSessionId: p?.parentSessionId || s?.parentSessionId || null, rootSessionId: p?.rootSessionId || s?.rootSessionId || null, status: s?.status || p?.status || null, command: s?.command || p?.command || null, attachUrl: s?.attachUrl || s?.statusUrl || `${observerLocalBaseUrl}/sessions/${id}`, message: s?.message || p?.message || null, stdoutPath: s?.stdoutPath || p?.stdoutPath || s?.stdout?.path || null, stderrPath: s?.stderrPath || p?.stderrPath || s?.stderr?.path || null, resultFiles: s?.resultFiles || [], updatedAt: s?.updatedAt || null });
  }
  for (const id of roots) await add(id);
  try {
    const names = await readdir(adapterSessionsRoot);
    for (const name of names.slice(-300)) {
      const p = await readJsonIfExists(join(adapterSessionsRoot, name, "payload.json"));
      if (p && (roots.includes(String(p.rootSessionId || "")) || roots.includes(String(p.parentSessionId || "")))) await add(name);
    }
  } catch {}
  return out;
}

async function refreshLaunchedImplementationStatus(dir: string, status: any) {
  const phase = String(status?.phase || "");
  if (!["implementation_launched", "implementation_running", "implementation_failed", "implementation_delivered", "corrections_launched", "corrections_running", "corrections_failed", "corrections_completed"].includes(phase)) return status;
  const statusPath = status?.directImplementationStatus || status?.directCorrectionsStatus;
  let session: any = statusPath ? await readJsonIfExists(String(statusPath)) : null;
  if (!session) {
    const sid = status?.observerSessionId || status?.observerCorrectionsSessionId;
    if (sid) session = await readJsonIfExists(join(adapterSessionsRoot, String(sid), "status.json"));
  }
  if (!session) return status;
  const stdoutPath = session.stdoutPath || session.logs?.stdout || status?.implementationStdout || status?.correctionsStdout;
  const stderrPath = session.stderrPath || session.logs?.stderr || status?.implementationStderr || status?.correctionsStderr;
  const exitText = session.exitCodePath ? await readTextIfExists(String(session.exitCodePath)) : "";
  const exitCode = exitText.trim() ? Number(exitText.trim()) : null;
  const runnerPid = Number(session.runnerPid || session.pid || 0);
  if (exitCode === null && String(session.status || '').toLowerCase() === 'running' && runnerPid > 0) {
    let runnerAlive = true;
    try { process.kill(runnerPid, 0); } catch { runnerAlive = false; }
    const heartbeatPath = String(session.heartbeatPath || '');
    const heartbeatStat = heartbeatPath ? await stat(heartbeatPath).catch(() => null) : null;
    const heartbeatAgeMs = heartbeatStat ? Date.now() - heartbeatStat.mtimeMs : null;
    if (!runnerAlive) {
      const interruptedAt = new Date().toISOString();
      if (statusPath) await saveJson(String(statusPath), { ...session, status: 'interrupted', launchState: 'runner_missing', interruptedAt, updatedAt: interruptedAt, message: 'Implementation runner process disappeared without an exit marker.' });
      const patch = phase.startsWith('implementation_corrections')
        ? { phase: 'corrections_failed', owner: 'main', ok: false, error: 'implementation_runner_process_missing', correctionsStdout: stdoutPath, correctionsStderr: stderrPath, directCorrectionsStatus: statusPath }
        : { phase: 'implementation_failed', owner: 'main', ok: false, nextAction: 'Inspect Implementation stdout/stderr and agent manifest; reconcile or launch a clean handoff.', error: 'implementation_runner_process_missing', implementationStdout: stdoutPath, implementationStderr: stderrPath, directImplementationStatus: statusPath };
      return await cycleStatus(dir, patch);
    }
    if (heartbeatAgeMs !== null && heartbeatAgeMs > 10 * 60 * 1000 && statusPath) {
      await saveJson(String(statusPath), { ...session, stalled: true, heartbeatAgeMs, updatedAt: new Date().toISOString(), message: 'Runner is alive but heartbeat is stale; no wall timeout is enforced.' });
    }
  }
  if (exitCode !== null && Number.isFinite(exitCode)) {
    const exitedAtPath = session.exitedAtPath ? String(session.exitedAtPath) : "";
    const exitedAtText = exitedAtPath ? (await readTextIfExists(exitedAtPath)).trim() : "";
    const exitedAt = exitedAtText || new Date().toISOString();
    if (statusPath) {
      await saveJson(String(statusPath), {
        ...session,
        status: exitCode === 0 ? "completed" : "failed",
        launchState: "exited",
        exitCode,
        exitedAt,
        updatedAt: new Date().toISOString(),
        message: exitCode === 0 ? "Implementation direct runner exited successfully." : "Implementation direct runner exited non-zero: " + exitCode,
      });
    }
    if (exitCode === 0) {
      const patch = phase.startsWith("implementation_corrections")
        ? { phase: "corrections_completed", owner: "main", nextAction: "Run mechanical validation and council code review again for the corrected delivery.", ok: true, correctionsStdout: stdoutPath, correctionsStderr: stderrPath, directCorrectionsStatus: statusPath, externalValidation: "", validationSummary: "", councilReviewSummary: "", councilReviewSynthesis: "", councilReviewNeedsCorrections: null }
        : { phase: "implementation_delivered", owner: "main", nextAction: "Run mechanical final validation, then council code review.", ok: true, implementationStdout: stdoutPath, implementationStderr: stderrPath, directImplementationStatus: statusPath };
      return await cycleStatus(dir, patch);
    }
    const patch = phase.startsWith("implementation_corrections")
      ? { phase: "corrections_failed", owner: "main", ok: false, error: `Implementation exited non-zero: ${exitCode}`, correctionsStdout: stdoutPath, correctionsStderr: stderrPath, directCorrectionsStatus: statusPath }
      : { phase: "implementation_failed", owner: "main", ok: false, nextAction: "Inspect Implementation stdout/stderr, fix blockers, then launch a new clean handoff.", error: `Implementation exited non-zero: ${exitCode}`, implementationStdout: stdoutPath, implementationStderr: stderrPath, directImplementationStatus: statusPath };
    return await cycleStatus(dir, patch);
  }
  return status;
}

async function fileInfo(path: string) {
  if (!path) return null;
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) return null;
  return { path, size: st.size, mtimeMs: st.mtimeMs, mtime: st.mtime.toISOString() };
}

async function textTail(path: string, max = 40000) {
  const text = await readTextIfExists(path);
  if (!text) return "";
  return text.length <= max ? text : text.slice(text.length - max);
}

function runtimeTimelineFromText(label: string, text: string) {
  const patterns = /Design review|Step [0-9]|Decomposed|Spawned|Progress:|Quality Gate|Contextual code review|Round [123]|findings|Correction round|Applying contextual|Re-running validation|Skipping ink|Delivery|no diff found|warning|WARN|ERROR|SUCCESS|failed|stalled|progress observed|timeout=|timed out|zombie/i;
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => patterns.test(line))
    .slice(-200)
    .map((line) => ({ source: label, line: line.replace(/\x1b\[[0-9;]*m/g, "") }));
}

async function runtimeObservedPids(status: any, sessions: any[]) {
  const pids: any[] = [status?.pid, status?.runnerPid, status?.directRunnerPid, status?.processGroupId]
    .concat(sessions.map((s) => s?.runnerPid || s?.pid || s?.processGroupId).filter(Boolean));
  for (const path of [status?.directImplementationStatus, status?.directCorrectionsStatus]) {
    const direct = path ? await readJsonIfExists(String(path)) : null;
    if (direct?.runnerPid) pids.push(direct.runnerPid);
    if (direct?.processGroupId) pids.push(direct.processGroupId);
    if (direct?.pid) pids.push(direct.pid);
  }
  return [...new Set(pids.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
}

async function runtimeProcessSnapshot(status: any, sessions: any[]) {
  const pids = await runtimeObservedPids(status, sessions);
  let table = "";
  try { table = (await execFileAsync("ps", ["-eo", "pid,ppid,etime,stat,comm"], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout || ""; } catch {}
  const rows = table.split(/\r?\n/).slice(1).map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), elapsed: m[3], stat: m[4], comm: m[5] } : null;
  }).filter(Boolean) as any[];
  const rootSet = new Set(pids);
  const children = new Map<number, any[]>();
  for (const r of rows) {
    if (!children.has(r.ppid)) children.set(r.ppid, []);
    children.get(r.ppid)!.push(r);
  }
  const seen = new Set<number>();
  const tree: any[] = [];
  const stack = [...pids];
  while (stack.length) {
    const pid = stack.pop()!;
    for (const r of children.get(pid) || []) {
      if (seen.has(r.pid)) continue;
      seen.add(r.pid); tree.push(r); stack.push(r.pid);
    }
  }
  const roots = rows.filter((r) => rootSet.has(r.pid));
  const providers = rows.filter((r) => /^(codex|claude|gemini|agy|node)$/.test(String(r.comm || "")));
  return { roots, descendants: tree, providers, zombies: rows.filter((r) => String(r.stat || "").includes("Z")), observedPids: pids };
}

async function runtimeGitSnapshot(projectRoot: string) {
  if (!projectRoot) return { available: false, reason: "projectRoot_not_supplied" };
  const st = await stat(projectRoot).catch(() => null);
  if (!st?.isDirectory()) return { available: false, reason: "projectRoot_missing", projectRoot };
  return {
    available: true,
    projectRoot,
    status: await execSummary("git", ["status", "--short", "--branch"], projectRoot, 10000),
    diffStat: await execSummary("git", ["diff", "--stat"], projectRoot, 10000),
  };
}

async function runtimeArtifacts(dir: string, status: any, stdoutTail: string, stderrTail: string) {
  const paths = new Set<string>();
  for (const p of [status?.implementationStdout, status?.implementationStderr, status?.correctionsStdout, status?.correctionsStderr, status?.directImplementationStatus, status?.directCorrectionsStatus, status?.outputPath]) if (p) paths.add(String(p));
  const runFiles = (await readdir(dir).catch(() => [])).filter((x) => /status|implementation|artifact|evidence|summary|validation|observer|runtime|timeline|alerts/i.test(x)).map((x) => join(dir, x));
  for (const p of runFiles) paths.add(p);
  const out: any[] = [];
  for (const p of [...paths].sort()) {
    const info = await fileInfo(p);
    if (info) out.push(info);
  }
  return out.slice(-200);
}

function runtimeAlerts(status: any, process: any, git: any, timeline: any[], artifacts: any[]) {
  const alerts: any[] = [];
  const phase = String(status?.phase || "");
  if (phase.includes("running") || phase.includes("launched")) {
    if (!process.roots?.length) alerts.push({ severity: "warning", code: "status_running_but_root_missing", message: "status phase implies active run, but root process was not found" });
    if (process.roots?.some((r: any) => String(r.stat || "").includes("Z"))) alerts.push({ severity: "warning", code: "root_process_zombie", message: "root process is zombie; status may be stale" });
  }
  if (process.zombies?.length) alerts.push({ severity: "info", code: "zombie_processes_present", count: process.zombies.length });
  const providerOrphans = (process.providers || []).filter((p: any) => !process.descendants?.some((d: any) => d.pid === p.pid) && !process.roots?.some((r: any) => r.pid === p.pid));
  if (providerOrphans.length) alerts.push({ severity: "warning", code: "provider_processes_outside_observed_tree", count: providerOrphans.length, providers: providerOrphans.slice(0, 20) });
  const text = timeline.map((x) => x.line).join("\n");
  if (/no diff found/i.test(text)) alerts.push({ severity: "warning", code: "review_no_diff", message: "contextual review reported no diff" });
  if (/Quality Gate: FAILED|Quality gate FAILED/i.test(text)) alerts.push({ severity: "warning", code: "quality_gate_failed" });
  if (/timed out|Operation timed out/i.test(text)) alerts.push({ severity: "warning", code: "wall_clock_timeout_seen" });
  if (/Skipping ink/i.test(text)) alerts.push({ severity: "info", code: "ink_skipped" });
  if (git?.available && /^## .*\n?$/m.test(String(git.status || "")) && !artifacts.some((a) => /review-findings|tangle-validation|delivery/.test(a.path))) alerts.push({ severity: "info", code: "clean_worktree_with_limited_artifacts" });
  return alerts;
}

async function writeRichRuntimeObservation(dir: string, status: any, sessions: any[]) {
  const stdoutPath = String(status?.implementationStdout || status?.correctionsStdout || status?.directImplementationStdout || "");
  const stderrPath = String(status?.implementationStderr || status?.correctionsStderr || status?.directImplementationStderr || "");
  const stdoutTail = await textTail(stdoutPath);
  const stderrTail = await textTail(stderrPath);
  const timeline = runtimeTimelineFromText("stdout", stdoutTail).concat(runtimeTimelineFromText("stderr", stderrTail)).slice(-300);
  const process = await runtimeProcessSnapshot(status, sessions);
  const git = await runtimeGitSnapshot(String(status?.projectRoot || ""));
  const artifacts = await runtimeArtifacts(dir, status, stdoutTail, stderrTail);
  const alerts = runtimeAlerts(status, process, git, timeline, artifacts);
  const observation = { generatedAt: new Date().toISOString(), phase: status?.phase || null, owner: status?.owner || null, nextAction: status?.nextAction || null, process, git, artifacts, timelineTail: timeline.slice(-80), alerts };
  const observationPath = join(dir, "runtime_observation.json");
  const timelinePath = join(dir, "runtime_timeline.json");
  const alertsPath = join(dir, "runtime_alerts.json");
  await saveJson(observationPath, observation);
  await saveJson(timelinePath, { generatedAt: observation.generatedAt, events: timeline });
  await saveJson(alertsPath, { generatedAt: observation.generatedAt, alerts });
  return { observationPath, timelinePath, alertsPath, observation };
}

async function cycleRuntimeSummary(dir: string, status: any) {
  const sessions = await collectObserverSessions(status || {});
  const rootIds = [status?.observerSessionId, status?.observerCorrectionsSessionId, status?.observerObservationId, status?.observerCorrectionsObservationId].filter(Boolean).map(String);
  const rich = await writeRichRuntimeObservation(dir, status || {}, sessions);
  return { nextAction: status?.nextAction || null, owner: status?.owner || null, phase: status?.phase || null, observerRootSessions: rootIds.map((id) => ({ id, attachUrl: `${observerLocalBaseUrl}/sessions/${id}` })), observerChildSessions: sessions.filter((s) => !rootIds.includes(String(s.id))), observerSessions: sessions, hookLog: observerHookLog, knownArtifacts: (await readdir(dir).catch(() => [])).filter((x) => /plan|context|validation|implementation|artifact|evidence|summary|status|runtime|timeline|alerts/i.test(x)).sort(), richObservation: { observationPath: rich.observationPath, timelinePath: rich.timelinePath, alertsPath: rich.alertsPath, alerts: rich.observation.alerts, latestTimeline: rich.observation.timelineTail } };
}
async function readTextSection(path: string, max = 6000) { const t = await readTextIfExists(path); return t.trim() ? excerpt(t, max) : "not present"; }
async function writeFinalValidationPack(dir: string, project: string, runId: string, status: any) {
  const projectRoot = String(status?.projectRoot || "");
  const gitStatus = projectRoot ? await execSummary("git", ["status", "--short", "--branch"], projectRoot) : "projectRoot not supplied";
  const gitDiffStat = projectRoot ? await execSummary("git", ["diff", "--stat"], projectRoot) : "projectRoot not supplied";
  const sessions = await collectObserverSessions(status || {});
  const files = (await readdir(dir).catch(() => [])).sort();
  const manifest: any[] = [];
  for (const name of files) { const path = join(dir, name); const st = await stat(path).catch(() => null); if (st?.isFile()) manifest.push({ name, path, size: st.size, mtimeMs: st.mtimeMs }); }
  const deliverySummary = join(dir, "delivery_summary.md");
  await writeFile(deliverySummary, `# Delivery summary\n\nProject: ${project}\nRun: ${runId}\nPhase: ${status?.phase || "unknown"}\nOwner: ${status?.owner || "unknown"}\nNext action: ${status?.nextAction || "unknown"}\n\n## Paths\n\n- projectRoot: ${projectRoot || "not supplied"}\n- projectWikiPath: ${status?.projectWikiPath || "not supplied"}\n- plan: ${status?.plan || "not supplied"}\n- canonicalPlan: ${status?.canonicalPlan || "not supplied"}\n- outputPath: ${status?.outputPath || "not supplied"}\n\n## Implementation evidence\n\n- stdout: ${status?.implementationStdout || status?.correctionsStdout || "not supplied"}\n- stderr: ${status?.implementationStderr || status?.correctionsStderr || "not supplied"}\n- observerSessionId: ${status?.observerSessionId || "not supplied"}\n- observerCorrectionsSessionId: ${status?.observerCorrectionsSessionId || "not supplied"}\n\n## Git status\n\n\`\`\`text\n${excerpt(gitStatus, 6000)}\n\`\`\`\n\n## Git diff stat\n\n\`\`\`text\n${excerpt(gitDiffStat, 4000)}\n\`\`\`\n`);
  const artifactManifest = join(dir, "artifact_manifest.json");
  await writeFile(artifactManifest, JSON.stringify({ project, runId, generatedAt: new Date().toISOString(), files: manifest }, null, 2) + "\n");
  const observerSessions = join(dir, "observer_sessions.json");
  await writeFile(observerSessions, JSON.stringify({ project, runId, generatedAt: new Date().toISOString(), sessions }, null, 2) + "\n");
  const testEvidence = join(dir, "test_evidence.md");
  await writeFile(testEvidence, `# Test evidence\n\n## Detected package scripts\n\n${projectRoot ? await packageScriptsBrief(projectRoot) : "projectRoot not supplied"}\n\n## Implementation stdout excerpt\n\n\`\`\`text\n${await readTextSection(String(status?.implementationStdout || status?.correctionsStdout || join(dir, "implementation_delivery_stdout.txt")), 10000)}\n\`\`\`\n\n## Implementation stderr excerpt\n\n\`\`\`text\n${await readTextSection(String(status?.implementationStderr || status?.correctionsStderr || join(dir, "implementation_delivery_stderr.txt")), 6000)}\n\`\`\`\n`);
  const riskChecklist = join(dir, "risk_checklist.md");
  await writeFile(riskChecklist, `# Final validation risk checklist\n\nReturn GO only if all relevant checks pass.\n\n- [ ] Approved plan was followed; no unrelated scope expansion.\n- [ ] projectRoot is the real code checkout, not only a wiki/docs folder.\n- [ ] No secrets/auth/env/cookie/OAuth files were exposed or edited.\n- [ ] No protected OpenClaw config/state file was edited without explicit authorization.\n- [ ] No third-party/upstream runtime patch was left as architecture without PR-style handling.\n- [ ] Worktree state is understood; unexpected dirty files are explained.\n- [ ] Validation commands/smokes were run or blockers are documented.\n- [ ] Required wiki/runbook/state documentation was updated.\n- [ ] Restart/recreate/persistence survival was considered where relevant.\n- [ ] Observer parent/child session state is coherent enough to audit.\n\nDecision must be exactly one of: go | revise | stop.\n`);
  return { deliverySummary, artifactManifest, observerSessions, testEvidence, riskChecklist };
}

function defaultValidationConfig() {
  return {
    commands: "auto" as any,
    commandTimeoutMs: 120000,
    preserveDiff: true,
    strictDirty: false,
    allowedDirty: [] as string[],
    ignoredDirty: [".claude-implementation/", "node_modules/", "dist/", "build/", "coverage/"] as string[],
    forbiddenPaths: [".env", ".env.local", "config.json.test-backup"] as string[],
    protectedDirty: [".env", ".env.local"] as string[],
    portsMustBeFree: [] as number[],
    requiredOpenApiPaths: [] as string[],
    stall: { enabled: true, autoStop: true, quietSeconds: 900 },
  };
}

function mergeValidationConfig(base: any, extra: any) {
  if (!extra || typeof extra !== "object") return base;
  return {
    ...base,
    ...extra,
    commands: Array.isArray(extra.commands) || extra.commands === "auto" ? extra.commands : base.commands,
    allowedDirty: Array.isArray(extra.allowedDirty) ? extra.allowedDirty : base.allowedDirty,
    ignoredDirty: Array.isArray(extra.ignoredDirty) ? extra.ignoredDirty : base.ignoredDirty,
    forbiddenPaths: Array.isArray(extra.forbiddenPaths) ? extra.forbiddenPaths : base.forbiddenPaths,
    protectedDirty: Array.isArray(extra.protectedDirty) ? extra.protectedDirty : base.protectedDirty,
    portsMustBeFree: Array.isArray(extra.portsMustBeFree) ? extra.portsMustBeFree : base.portsMustBeFree,
    requiredOpenApiPaths: Array.isArray(extra.requiredOpenApiPaths) ? extra.requiredOpenApiPaths : base.requiredOpenApiPaths,
    stall: { ...(base.stall || {}), ...(extra.stall || {}) },
  };
}

async function loadProjectValidationConfig(project: string, status: any, params: any = {}) {
  const projectWikiPath = resolveTrustedProjectWikiPath(project, params.projectWikiPath, status?.projectWikiPath);
  const allowedRoots = [projectsWikiRoot, wikiRoot, projectWikiPath, cycleRoot];
  const candidates: string[] = [];
  if (params.validationConfigPath) {
    const requested = resolve(String(params.validationConfigPath));
    let realRequested = "";
    try {
      realRequested = await realpath(requested);
    } catch {
      return {
        config: defaultValidationConfig(),
        path: "default",
        projectWikiPath,
        rejectedValidationConfigPath: requested,
        error: "validation_config_path_unreadable",
      };
    }
    let allowed = false;
    for (const root of allowedRoots) {
      if (!root) continue;
      try {
        const realRoot = await realpath(resolve(String(root)));
        const rel = relative(realRoot, realRequested).replace(/\\/g, "/");
        if (rel === "" || (Boolean(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/"))) {
          allowed = true;
          break;
        }
      } catch {}
    }
    if (!allowed) {
      return {
        config: defaultValidationConfig(),
        path: "default",
        projectWikiPath,
        rejectedValidationConfigPath: requested,
        error: "validation_config_path_outside_allowed_roots",
      };
    }
    candidates.push(realRequested);
  }
  candidates.push(join(projectWikiPath, "validation.json"));
  let config = defaultValidationConfig();
  let path = "default";
  for (const candidate of candidates) {
    const loaded = await readJsonIfExists(candidate);
    if (loaded) { config = mergeValidationConfig(config, loaded); path = candidate; break; }
  }
  return { config, path, projectWikiPath };
}

function validationRuleMatches(path: string, rules: any[]) {
  const p = String(path || "").replace(/^\.\//, "");
  for (const raw of rules || []) {
    const rule = String(raw || "").replace(/^\.\//, "");
    if (!rule) continue;
    if (rule.endsWith("/")) { if (p === rule.slice(0, -1) || p.startsWith(rule)) return true; }
    else if (p === rule) return true;
  }
  return false;
}

function parseGitPorcelain(text: string) {
  return String(text || "").split(/\r?\n/).map((line) => {
    if (!line.trim()) return null;
    const status = line.slice(0, 2);
    let path = line.slice(3).trim();
    if (path.includes(" -> ")) path = path.split(" -> ").pop() || path;
    return { status, path };
  }).filter(Boolean) as any[];
}

async function execValidationCommand(command: string, cwd: string, timeoutMs: number) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const res = await execFileAsync("sh", ["-lc", command], { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, command, exitCode: 0, startedAt, durationMs: Date.now() - started, stdout: res.stdout || "", stderr: res.stderr || "" };
  } catch (err: any) {
    return { ok: false, command, exitCode: Number.isFinite(Number(err?.code)) ? Number(err.code) : null, signal: err?.signal || null, timedOut: /timed out|timeout/i.test(String(err?.message || "")) || err?.killed === true, startedAt, durationMs: Date.now() - started, stdout: err?.stdout || "", stderr: err?.stderr || "", error: String(err?.message || err) };
  }
}

async function preserveValidationDiff(dir: string, projectRoot: string, prefix: string) {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const worktreePatch = join(dir, `${prefix}-worktree-${ts}.patch`);
  const indexPatch = join(dir, `${prefix}-index-${ts}.patch`);
  const worktree = await execValidationCommand("git diff", projectRoot, 30000);
  const index = await execValidationCommand("git diff --staged", projectRoot, 30000);
  await writeFile(worktreePatch, worktree.stdout || "");
  await writeFile(indexPatch, index.stdout || "");
  return { worktreePatch, indexPatch, worktreeBytes: (worktree.stdout || "").length, indexBytes: (index.stdout || "").length };
}

async function inferValidationCommands(projectRoot: string, config: any) {
  if (Array.isArray(config.commands)) return config.commands.map(String).filter(Boolean);
  const commands: string[] = [];
  const pkg = await readJsonIfExists(join(projectRoot, "package.json"));
  const scripts = pkg?.scripts || {};
  if (scripts.check) commands.push("npm run check");
  if (scripts["test:all"]) commands.push("npm run test:all");
  else if (scripts.test && !/no test specified/i.test(String(scripts.test))) commands.push("npm test");
  if (!commands.some((c) => c === "git diff --check")) commands.push("git diff --check");
  if (await stat(join(projectRoot, "go.mod")).catch(() => null)) commands.splice(commands.length - 1, 0, "go test ./...");
  if (await stat(join(projectRoot, "Cargo.toml")).catch(() => null)) commands.splice(commands.length - 1, 0, "cargo test");
  if ((await stat(join(projectRoot, "pyproject.toml")).catch(() => null)) || (await stat(join(projectRoot, "pytest.ini")).catch(() => null))) commands.splice(commands.length - 1, 0, "python -m pytest -q");
  return [...new Set(commands)];
}

async function portsFreeCheck(ports: any[]) {
  const failures: any[] = [];
  if (!ports?.length) return failures;
  const res = await execValidationCommand("(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || true)", "/", 10000);
  const text = `${res.stdout || ""}\n${res.stderr || ""}`;
  for (const port of ports.map((p) => Number(p)).filter((p) => Number.isFinite(p) && p > 0)) {
    const re = new RegExp(`[:.]${port}\\b`);
    const lines = text.split(/\r?\n/).filter((line) => re.test(line));
    if (lines.length) failures.push({ check: "portsMustBeFree", port, severity: "revise", reason: `port ${port} has listener(s)`, lines: lines.slice(0, 5) });
  }
  return failures;
}

async function requiredOpenApiPathCheck(projectRoot: string, paths: any[]) {
  const failures: any[] = [];
  if (!paths?.length) return failures;
  const files = ["serverModules/swaggerSetup.js", "serverModules/apiRoutes.js", "api/terminal.js"];
  const haystack = (await Promise.all(files.map(async (f) => await readTextIfExists(join(projectRoot, f))))).join("\n");
  for (const required of paths.map(String).filter(Boolean)) {
    if (!haystack.includes(required)) failures.push({ check: "requiredOpenApiPaths", path: required, severity: "revise", reason: `${required} not found in OpenAPI/route source files` });
  }
  return failures;
}

async function dirtyWorktreeCheck(projectRoot: string, config: any) {
  const failures: any[] = [];
  const res = await execValidationCommand("git status --porcelain", projectRoot, 30000);
  const entries = parseGitPorcelain(res.stdout || "");
  const ignored = entries.filter((e) => validationRuleMatches(e.path, config.ignoredDirty || []));
  const considered = entries.filter((e) => !validationRuleMatches(e.path, config.ignoredDirty || []));
  const forbidden = considered.filter((e) => validationRuleMatches(e.path, config.forbiddenPaths || []));
  const protectedDirty = considered.filter((e) => validationRuleMatches(e.path, config.protectedDirty || []));
  const unexpected = considered.filter((e) => !validationRuleMatches(e.path, config.allowedDirty || []) && !validationRuleMatches(e.path, config.forbiddenPaths || []) && !validationRuleMatches(e.path, config.protectedDirty || []));
  for (const e of forbidden) failures.push({ check: "forbiddenPaths", path: e.path, status: e.status, severity: "revise", reason: `${e.path} is forbidden by validation config` });
  for (const e of protectedDirty) failures.push({ check: "protectedDirty", path: e.path, status: e.status, severity: "stop", reason: `${e.path} is protected by validation config` });
  if (config.strictDirty === true) {
    for (const e of unexpected) failures.push({ check: "allowedDirty", path: e.path, status: e.status, severity: "revise", reason: `${e.path} is dirty but not allowed/ignored by validation config` });
  }
  return { entries, ignored, considered, unexpected, failures };
}

async function existingForbiddenPathCheck(projectRoot: string, config: any) {
  const failures: any[] = [];
  for (const raw of config.forbiddenPaths || []) {
    const rel = String(raw || "").replace(/^\.\//, "");
    if (!rel || rel.endsWith("/")) continue;
    const st = await stat(join(projectRoot, rel)).catch(() => null);
    if (st) failures.push({ check: "forbiddenPathsExist", path: rel, severity: "revise", reason: `${rel} exists after validation` });
  }
  return failures;
}

async function runExternalFinalValidation(dir: string, status: any, params: any = {}, reason = "manual") {
  const project = cleanId(params.project || status?.project || "default");
  const runId = cleanId(params.runId || status?.runId || "run");
  const projectRoot = String(params.projectRoot || status?.projectRoot || "");
  const loaded = await loadProjectValidationConfig(project, status, params);
  const config = loaded.config;
  await mkdir(dir, { recursive: true });
  const stdoutPath = join(dir, "validation_stdout.log");
  const stderrPath = join(dir, "validation_stderr.log");
  const resultPath = join(dir, "validation_result.json");
  const summaryPath = join(dir, "validation_summary.md");
  const failures: any[] = [];
  const commandResults: any[] = [];
  let preservedDiff: any = null;

  const rootStat = projectRoot ? await stat(projectRoot).catch(() => null) : null;
  if (!rootStat?.isDirectory()) failures.push({ check: "projectRoot", severity: "stop", reason: "projectRoot missing or not a directory", projectRoot });
  if (rootStat?.isDirectory() && config.preserveDiff !== false) preservedDiff = await preserveValidationDiff(dir, projectRoot, `validation-${reason}`);

  if (rootStat?.isDirectory()) {
    const validationCommands = await inferValidationCommands(projectRoot, config);
    config.resolvedCommands = validationCommands;
    for (const command of validationCommands) {
      const result = await execValidationCommand(String(command), projectRoot, Number(config.commandTimeoutMs || 120000));
      commandResults.push({ ...result, stdout: excerpt(result.stdout || "", 20000), stderr: excerpt(result.stderr || "", 20000) });
      if (!result.ok) failures.push({ check: "command", command, severity: "revise", reason: result.error || `command exited ${result.exitCode}`, exitCode: result.exitCode, timedOut: result.timedOut || false });
    }
    const dirty = await dirtyWorktreeCheck(projectRoot, config);
    failures.push(...dirty.failures);
    failures.push(...await existingForbiddenPathCheck(projectRoot, config));
    failures.push(...await portsFreeCheck(config.portsMustBeFree || []));
    failures.push(...await requiredOpenApiPathCheck(projectRoot, config.requiredOpenApiPaths || []));
  }

  const stop = failures.some((f) => f.severity === "stop");
  const ok = failures.length === 0;
  const decision = ok ? "go" : stop ? "stop" : "revise";
  const result = { ok, decision, reason, project, runId, generatedAt: new Date().toISOString(), projectRoot, validationConfigPath: loaded.path, rejectedValidationConfigPath: loaded.rejectedValidationConfigPath || null, error: loaded.error || null, config, preservedDiff, commandResults, failures };
  await saveJson(resultPath, result);
  await writeFile(stdoutPath, commandResults.map((r) => `# ${r.command}\n\n${r.stdout || ""}`).join("\n\n---\n\n"));
  await writeFile(stderrPath, commandResults.map((r) => `# ${r.command}\n\n${r.stderr || r.error || ""}`).join("\n\n---\n\n"));
  await writeFile(summaryPath, `# Mechanical final validation\n\nProject: ${project}\nRun: ${runId}\nReason: ${reason}\nDecision: ${decision}\nOK: ${ok}\nGenerated: ${result.generatedAt}\nConfig: ${loaded.path}\nRejected config: ${loaded.rejectedValidationConfigPath || "none"}${loaded.error ? `\nConfig error: ${loaded.error}` : ""}\n\n## Commands\n\n${commandResults.map((r) => `- ${r.ok ? "PASS" : "FAIL"}: ${r.command}${r.timedOut ? " (timed out)" : ""}`).join("\n") || "none"}\n\n## Failures\n\n${failures.length ? failures.map((f) => `- [${f.severity || "revise"}] ${f.check}: ${f.reason || f.path || f.command}`).join("\n") : "none"}\n\n## Preserved diff\n\n${preservedDiff ? `- worktree: ${preservedDiff.worktreePatch} (${preservedDiff.worktreeBytes} bytes)\n- index: ${preservedDiff.indexPatch} (${preservedDiff.indexBytes} bytes)` : "not preserved"}\n`);
  const phase = ok ? "external_validation_passed" : decision === "stop" ? "external_validation_stopped" : "external_validation_needs_revision";
  const nextAction = ok ? "Mechanical validation passed; human/AI final review may record go or close when appropriate." : decision === "stop" ? "Stop and report the validation blocker to the operator." : "Send delta-only corrections to Implementation or apply a minimal manual fix, then rerun run_final_validation.";
  const next = await cycleStatus(dir, { phase, owner: "main", ok, externalValidationDecision: decision, externalValidation: resultPath, validationSummary: summaryPath, validationStdout: stdoutPath, validationStderr: stderrPath, validationConfigPath: loaded.path, rejectedValidationConfigPath: loaded.rejectedValidationConfigPath || null, validationConfigError: loaded.error || null, nextAction });
  return { ok, decision, project, runId, dir, phase: next.phase, validationResult: resultPath, validationSummary: summaryPath, validationStdout: stdoutPath, validationStderr: stderrPath, failures, commandResults: commandResults.map((r) => ({ command: r.command, ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut || false, durationMs: r.durationMs })), preservedDiff, rejectedValidationConfigPath: loaded.rejectedValidationConfigPath || null, validationConfigError: loaded.error || null, status: next };
}
async function latestRunActivityMtime(status: any) {
  const paths = [status?.implementationStdout, status?.implementationStderr, status?.correctionsStdout, status?.correctionsStderr, status?.directImplementationStdout, status?.directImplementationStderr].filter(Boolean).map(String);
  const infos = [] as any[];
  for (const p of paths) { const info = await fileInfo(p); if (info) infos.push(info); }
  const latest = infos.reduce((max, x) => Math.max(max, Number(x.mtimeMs || 0)), 0);
  return { latest, files: infos };
}

async function maybeHandleStalledRun(dir: string, status: any, params: any = {}) {
  const phase = String(status?.phase || "");
  if (!(phase.includes("launched") || phase.includes("running"))) return null;
  const project = cleanId(params.project || status?.project || "default");
  const loaded = await loadProjectValidationConfig(project, status, params);
  const stall = loaded.config.stall || {};
  if (stall.enabled === false || stall.autoStop === false || params.autoStopStalled === false) return null;
  const quietSeconds = Number(params.stallQuietSeconds || stall.quietSeconds || 900);
  if (!Number.isFinite(quietSeconds) || quietSeconds <= 0) return null;
  const sessions = await collectObserverSessions(status || {});
  const processSnapshot = await runtimeProcessSnapshot(status || {}, sessions);
  const activeRoots = (processSnapshot.roots || []).filter((p: any) => !String(p.stat || "").includes("Z"));
  const activeProviders = [...(processSnapshot.descendants || []), ...activeRoots].filter((p: any) => /^(codex|claude|gemini|agy|node-MainThread|node)$/.test(String(p.comm || "")) && !String(p.stat || "").includes("Z"));
  if (!activeRoots.length || !activeProviders.length) return null;
  const activity = await latestRunActivityMtime(status);
  if (!activity.latest) return null;
  const quietMs = Date.now() - activity.latest;
  if (quietMs < quietSeconds * 1000) return null;
  const reason = `development_cycle stall detector: provider alive but runner artifacts quiet for ${Math.round(quietMs / 1000)}s (threshold ${quietSeconds}s).`;
  const stopped = await stopLaunchedImplementation(dir, status, reason);
  const validation = await runExternalFinalValidation(dir, stopped.status || status, { ...params, project }, "stalled_provider");
  return { stalled: true, reason, quietSeconds, quietMs, activeProviders, activeRoots, activityFiles: activity.files, stopped, validation, status: validation.status || stopped.status };
}


async function findFilesByName(root: string, name: string, depth = 5): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, d: number) {
    if (d < 0) return;
    let entries: any[] = [];
    try { entries = await readdir(dir, { withFileTypes: true } as any); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isFile && e.isFile() && e.name === name) out.push(p);
      else if (e.isDirectory && e.isDirectory()) await walk(p, d - 1);
    }
  }
  await walk(root, depth);
  return out;
}

async function latestFileByMtime(paths: string[]) {
  const rows: any[] = [];
  for (const p of paths) {
    const st = await stat(p).catch(() => null);
    if (st?.isFile()) rows.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows[0] || null;
}

function councilNeedsCorrectionsText(text: string) {
  const t = String(text || "").toLowerCase();
  if (/\b(no blocking|no blockers|ready to ship|ship as-is|go\b)/i.test(text) && !/conditional go|must fix|blocker|before ship|before deploy|high\s+[—-]|critical\s+[—-]/i.test(text)) return false;
  return /conditional go|must fix|blocker|before ship|before deploy|do not ship|revise|high\s+[—-]|critical\s+[—-]/i.test(text) || t.includes("corrections required");
}

function extractCouncilFindings(text: string, max = 10) {
  const lines = String(text || "").split(/\r?\n/);
  const hits = lines.filter((line) => /\b(HIGH|MEDIUM|LOW|CRITICAL|Must fix|Fix before|Blocker|SAFE_MODE|OpenAPI|exitCode|403)\b/i.test(line.trim()))
    .map((line) => line.trim().replace(/^[-*#\s]+/, ""))
    .filter(Boolean);
  return [...new Set(hits)].slice(0, max);
}

async function buildCouncilCodeReviewTask(dir: string, project: string, runId: string, status: any) {
  const projectRoot = String(status?.projectRoot || "");
  const validationSummary = await readTextIfExists(String(status?.validationSummary || join(dir, "validation_summary.md")));
  const plan = await readTextIfExists(join(dir, "implementation_plan.md"));
  const gitStatus = projectRoot ? await execSummary("git", ["status", "--short", "--branch"], projectRoot, 15000) : "projectRoot not supplied";
  const gitStat = projectRoot ? await execSummary("git", ["diff", "--stat"], projectRoot, 15000) : "projectRoot not supplied";
  const gitNames = projectRoot ? await execSummary("git", ["diff", "--name-only"], projectRoot, 15000) : "projectRoot not supplied";
  const gitUntracked = projectRoot ? await execSummary("git", ["ls-files", "--others", "--exclude-standard"], projectRoot, 15000) : "projectRoot not supplied";
  const gitDiff = projectRoot ? await execSummary("git", ["diff"], projectRoot, 30000) : "projectRoot not supplied";
  let untrackedContents = "";
  if (projectRoot && gitUntracked && !gitUntracked.startsWith("command failed") && gitUntracked !== "ok, no output") {
    const names = gitUntracked.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 30);
    for (const name of names) {
      if (validationRuleMatches(name, [".env", ".env.local", ".git/", "node_modules/"])) continue;
      const text = await readTextIfExists(join(projectRoot, name));
      if (text.trim()) untrackedContents += `\n### ${name}\n\n\`\`\`text\n${excerpt(text, 6000)}\n\`\`\`\n`;
    }
  }
  const task = `# Council code review input\n\nProject: ${project}\nRun: ${runId}\nProject root: ${projectRoot || "not supplied"}\n\nReview the current implementation diff only. Validate safety, correctness, API compatibility, OpenAPI/schema accuracy, test adequacy, operational risk, and deploy readiness. Do not implement changes. Return concrete findings with severity and file:line where possible. Call out whether corrections are required before ship.\n\n## Approved work summary / plan excerpt\n\n${excerpt(plan, 8000)}\n\n## Mechanical validation\n\n${excerpt(validationSummary, 6000)}\n\n## Git status\n\n\`\`\`text\n${excerpt(gitStatus, 4000)}\n\`\`\`\n\n## Diff stat\n\n\`\`\`text\n${excerpt(gitStat, 4000)}\n\`\`\`\n\n## Changed files\n\n\`\`\`text\n${excerpt(gitNames, 4000)}\n\`\`\`\n\n## Untracked files\n\n\`\`\`text\n${excerpt(gitUntracked, 4000)}\n\`\`\`\n\n## Untracked file contents\n\n${excerpt(untrackedContents, 24000)}\n\n## Full diff\n\n\`\`\`diff\n${excerpt(gitDiff, 90000)}\n\`\`\`\n`;
  const inputDir = join(dir, "council-code-review-input");
  await mkdir(inputDir, { recursive: true });
  const taskPath = join(inputDir, "task.md");
  await writeFile(taskPath, task);
  return { task, taskPath, gitStatus, gitStat, gitNames, gitUntracked };
}

async function runCouncilCodeReview(dir: string, status: any, params: any = {}) {
  const adapter = String(params.implementationAdapter || status?.implementationAdapter || implementationConfig.adapter);
  if (adapter !== "octopus") return { ok: true, skipped: true, reason: "council_requires_octopus_adapter", status };
  const project = cleanId(params.project || status?.project || "default");
  const runId = cleanId(params.runId || status?.runId || "run");
  const projectRoot = String(params.projectRoot || status?.projectRoot || "");
  if (!projectRoot) return { ok: false, skipped: true, reason: "projectRoot_missing" };
  if (status?.councilReviewSummary && await stat(String(status.councilReviewSummary)).catch(() => null)) return { ok: true, skipped: true, reason: "council_review_already_done", summaryPath: status.councilReviewSummary, status };
  const input = await buildCouncilCodeReviewTask(dir, project, runId, { ...status, projectRoot });
  const outputRoot = join(dir, "council-code-review");
  await mkdir(outputRoot, { recursive: true });
  const stdoutPath = join(dir, "council-code-review.stdout");
  const stderrPath = join(dir, "council-code-review.stderr");
  const scriptPath = join(implementationConfig.octopusRoot, "scripts", "orchestrate.sh");
  const councilSource = await readTextIfExists(join(implementationConfig.octopusRoot, "scripts", "lib", "council.sh"));
  const activeCouncilSupportsAgy = councilSource.includes("claude,codex,agy");
  const defaultCouncilProviders = activeCouncilSupportsAgy ? "claude,codex,agy,opencode,openrouter" : "claude,codex,opencode,openrouter";
  const councilProviders = String(params.councilProviders || params.councilAutoProviders || process.env.OCTOPUS_COUNCIL_AUTO_PROVIDERS || defaultCouncilProviders);
  const councilCodexModel = String(params.councilCodexModel || process.env.DEVELOPMENT_CYCLE_COUNCIL_CODEX_MODEL || "gpt-5.6");
  const args = ["--dir", projectRoot, "council", "--goal", "review", "--domain", "security", "--style", "red-team", "--depth", String(params.councilDepth || "standard"), "--members", String(params.councilMembers || 5), "--providers", councilProviders, "--implement", "never", "--worktree", "off", "--max-cost", String(params.councilMaxCost || "2.00"), "--output-dir", outputRoot, "--json", input.task];
  const startedAt = new Date().toISOString();
  let execResult: any;
  try {
    execResult = await execFileAsync(scriptPath, args, { cwd: projectRoot, env: { ...process.env, OCTOPUS_PROJECT_DIR: projectRoot, OCTOPUS_COUNCIL_AUTO_PROVIDERS: councilProviders, OCTOPUS_CODEX_MODEL: councilCodexModel }, timeout: Number(params.councilTimeoutMs || 900000), maxBuffer: 8 * 1024 * 1024 });
  } catch (err: any) {
    execResult = { failed: true, code: err?.code ?? null, signal: err?.signal ?? null, stdout: err?.stdout || "", stderr: err?.stderr || "", error: String(err?.message || err) };
  }
  await writeFile(stdoutPath, execResult.stdout || "");
  await writeFile(stderrPath, `${execResult.stderr || ""}${execResult.error ? `\n[error]\n${execResult.error}` : ""}`);
  const latest = await latestFileByMtime(await findFilesByName(outputRoot, "summary.json", 5));
  const summaryPath = latest?.path || "";
  const summary = summaryPath ? await readJsonIfExists(summaryPath) : null;
  const councilDir = summaryPath ? summaryPath.replace(/\/summary\.json$/, "") : outputRoot;
  const synthesisPath = summaryPath ? join(councilDir, "synthesis.md") : "";
  const synthesis = synthesisPath ? await readTextIfExists(synthesisPath) : "";
  const needsCorrections = councilNeedsCorrectionsText(synthesis || JSON.stringify(summary || {}));
  const findings = extractCouncilFindings(synthesis || JSON.stringify(summary || {}));
  const ok = Boolean(summaryPath && summary?.status === "completed" && !execResult.failed);
  const next = await cycleStatus(dir, { phase: ok ? (needsCorrections ? "council_review_needs_corrections" : "council_validated") : "council_review_failed", owner: "main", ok: ok && !needsCorrections, councilReviewStartedAt: startedAt, councilReviewCompletedAt: new Date().toISOString(), councilReviewSummary: summaryPath, councilReviewSynthesis: synthesisPath, councilReviewStdout: stdoutPath, councilReviewStderr: stderrPath, councilReviewInput: input.taskPath, councilReviewNeedsCorrections: needsCorrections, councilReviewFindings: findings, nextAction: needsCorrections ? "Auto-launch Implementation corrections from council feedback." : "Council review passed; write/read one-pager and close or deploy." });
  return { ok, project, runId, summaryPath, synthesisPath, stdoutPath, stderrPath, inputPath: input.taskPath, needsCorrections, findings, synthesis: excerpt(synthesis, 12000), status: next, execFailed: Boolean(execResult.failed) };
}

async function writeCouncilOnePager(dir: string, status: any, council: any, params: any = {}) {
  const project = cleanId(params.project || status?.project || "default");
  const runId = cleanId(params.runId || status?.runId || "run");
  const projectRoot = String(status?.projectRoot || params.projectRoot || "");
  const gitStat = projectRoot ? await execSummary("git", ["diff", "--stat"], projectRoot, 15000) : "projectRoot not supplied";
  const gitNames = projectRoot ? await execSummary("git", ["diff", "--name-only"], projectRoot, 15000) : "projectRoot not supplied";
  const validation = await readTextIfExists(String(status?.validationSummary || join(dir, "validation_summary.md")));
  const synthesis = council?.synthesis || (status?.councilReviewSynthesis ? await readTextIfExists(String(status.councilReviewSynthesis)) : "");
  const findings = council?.findings || status?.councilReviewFindings || extractCouncilFindings(synthesis);
  const decision = council?.needsCorrections ? "Corrections required before ship" : council?.ok ? "Council validated" : "Council review failed or inconclusive";
  const nextSteps = council?.needsCorrections ? "Implementation corrections were/will be launched automatically from the council feedback. Re-run mechanical validation and council review after corrections." : "Ready for human deploy/commit decision after checking the worktree and excluding local runtime artifacts.";
  const content = `# ${project} — code review one-pager\n\nRun: ${runId}\nGenerated: ${new Date().toISOString()}\nDecision: **${decision}**\n\n## What the work was\n\nImplement the approved development-cycle plan for ${project}. The council reviewed the resulting code diff, not the planning document.\n\n## What changed\n\n\`\`\`text\n${excerpt(gitStat, 3000)}\n\`\`\`\n\nChanged files:\n\n\`\`\`text\n${excerpt(gitNames, 2000)}\n\`\`\`\n\n## Mechanical validation\n\n${excerpt(validation, 2500)}\n\n## Council verdict\n\n${excerpt(synthesis, 4500)}\n\n## Key findings\n\n${findings.length ? findings.map((f: string) => `- ${f}`).join("\n") : "- No key findings extracted."}\n\n## Next steps\n\n${nextSteps}\n\n## Artifacts\n\n- Council summary: ${council?.summaryPath || status?.councilReviewSummary || "not available"}\n- Council synthesis: ${council?.synthesisPath || status?.councilReviewSynthesis || "not available"}\n- Mechanical validation: ${status?.externalValidation || "not available"}\n- Run directory: ${dir}\n`;
  const projectWikiPath = await resolveContainedWikiDir(project, String(params.projectWikiPath || status?.projectWikiPath || ""));
  if (!projectWikiPath) {
    // Fall back to cycle dir when wiki path escapes or is missing.
    const reportsDir = join(dir, "reports");
    await mkdir(reportsDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const out = join(reportsDir, `${stamp}-${runId}-code-review-one-pager.md`);
    const fallbackContent = `${content}(wiki path untrusted; wrote under cycle dir)\n`;
    await writeFile(out, fallbackContent);
    const next = await cycleStatus(dir, { councilOnePagerWikiPath: out, councilOnePagerGeneratedAt: new Date().toISOString() });
    return { path: out, content: fallbackContent, status: next };
  }
  const reportsDir = join(projectWikiPath, "reports");
  await mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const out = join(reportsDir, `${stamp}-${runId}-code-review-one-pager.md`);
  await writeFile(out, content);
  const next = await cycleStatus(dir, { councilOnePagerWikiPath: out, councilOnePagerGeneratedAt: new Date().toISOString() });
  return { path: out, content, status: next };
}

async function sendCycleMessage(params: any, title: string, text: string) {
  const enabled = params.notify === undefined
    ? developmentCycleConfig.notifications.enabled
    : Boolean(params.notify);
  if (!enabled) return { ok: true, skipped: true, reason: "notifications_disabled" };

  const channel = String(params.notificationChannel || developmentCycleConfig.notifications.channel || "").trim();
  const target = String(params.notificationTarget || developmentCycleConfig.notifications.target || "").trim();
  const account = String(params.notificationAccount || developmentCycleConfig.notifications.account || "").trim();
  const deliveryJson = String(params.notificationDeliveryJson || developmentCycleConfig.notifications.deliveryJson || "").trim();
  if (!channel || !target) {
    return { ok: true, skipped: true, reason: "notification_destination_missing", channel, target };
  }

  const args = ["message", "send", "--channel", channel, "--target", target, "--message", `${title}\n\n${excerpt(text, 2500)}`, "--json"];
  if (account) args.push("--account", account);
  if (deliveryJson) args.push("--delivery", deliveryJson);
  if (params.notificationDryRun === true) args.push("--dry-run");

  try {
    const res = await execFileAsync(developmentCycleConfig.openclawBin, args, { timeout: 20000, maxBuffer: 1024 * 1024 });
    return { ok: true, channel, target, account: account || null, stdout: excerpt(res.stdout || "", 2000), stderr: excerpt(res.stderr || "", 1000) };
  } catch (err: any) {
    return { ok: false, channel, target, account: account || null, error: String(err?.message || err), stdout: excerpt(err?.stdout || "", 1000), stderr: excerpt(err?.stderr || "", 1000) };
  }
}

async function launchCouncilCorrections(dir: string, status: any, council: any, params: any = {}) {
  const adapter = String(params.implementationAdapter || status?.implementationAdapter || implementationConfig.adapter);
  if (adapter !== "octopus") return { ok: true, skipped: true, reason: "council_corrections_require_octopus_adapter", status };
  const project = cleanId(params.project || status?.project || "default");
  const runId = cleanId(params.runId || status?.runId || "run");
  const projectRoot = String(params.projectRoot || status?.projectRoot || "");
  const projectWikiPath = resolveTrustedProjectWikiPath(project, params.projectWikiPath, status?.projectWikiPath);
  const count = Number(status?.councilCorrectionCount || 0);
  const max = Number(params.autoCouncilCorrectionsMax || 2);
  if (!projectRoot) return { ok: false, error: "projectRoot_required" };
  if (count >= max) {
    const next = await cycleStatus(dir, { phase: "council_review_waiting_human", owner: "main", ok: false, nextAction: "Council requested corrections but auto-correction limit was reached." });
    return { ok: false, limitReached: true, status: next };
  }
  const plan = await readTextIfExists(join(dir, "implementation_plan.md"));
  const synthesis = council?.synthesis || (status?.councilReviewSynthesis ? await readTextIfExists(String(status.councilReviewSynthesis)) : "");
  const feedback = `Council code review requires corrections before ship. Apply only these targeted fixes; do not restart the whole cycle and do not broaden scope.\n\nCOUNCIL_SUMMARY_JSON:\n${council?.summaryPath || status?.councilReviewSummary || "not available"}\n\nCOUNCIL_SYNTHESIS:\n${synthesis}\n`;
  const feedbackPath = join(dir, `council_corrections_feedback_${count + 1}.md`);
  await writeFile(feedbackPath, feedback);
  await writeFile(join(dir, "final_validation_response.md"), `revise\n\n${feedback}`);
  const prompt = `Apply only the direct correction feedback from council code review. Do not restart the whole cycle. Preserve already-correct work and stop before risky/protected changes needing human approval.\n\nPROJECT_ROOT_CODE_CHECKOUT:\n${projectRoot}\n\nCODEX_SANDBOX:\n${defaultCodexSandbox}\n\nAPPROVED_PLAN:\n${plan}\n\nCOUNCIL_CORRECTION_FEEDBACK:\n${feedback}`;
  const requestPath = join(dir, "council_corrections_request.md");
  await writeFile(requestPath, prompt);
  const stdoutPath = join(dir, "implementation_corrections_stdout.txt");
  const stderrPath = join(dir, "implementation_corrections_stderr.txt");
  const observerObservationId = await createImplementationObserverSession(dir, { project, runId, command: "council-corrections", projectRoot, projectWikiPath, stdoutPath, stderrPath, status: "running", summary: `development_cycle council corrections ${project}`, message: "Development-cycle queued Octopus council corrections." });
  if (developmentCycleConfig.observer.enabled && !observerObservationId) return { ok: false, error: "observer_root_session_creation_failed" };
  const launch = await createImplementationRunnerSession(dir, { project, runId: `${runId}-council-corrections-${count + 1}`, projectRoot, command: "tangle", prompt, kind: "corrections", implementationAdapter: "octopus", planPath: join(dir, "implementation_plan.md"), validationPath: feedbackPath, timeoutSeconds: Number(params.timeoutSeconds ?? params.timeout_ms ?? 0), observerObservationId, purpose: `development_cycle council corrections ${project}` });
  if (!launch.ok) {
    const next = await cycleStatus(dir, { phase: "corrections_failed", owner: "main", ok: false, error: launch.error || "direct_runner_launch_failed", projectRoot, codexSandbox: defaultCodexSandbox, councilCorrectionFeedback: feedbackPath, observerCorrectionsObservationId: observerObservationId, implementationCorrectionsRequest: requestPath });
    return { ok: false, error: launch.error, status: next };
  }
  await updateImplementationObserverSession(dir, observerObservationId, { project, runId, command: "council-corrections", projectRoot, projectWikiPath, stdoutPath: launch.stdoutPath, stderrPath: launch.stderrPath, status: "running", summary: `development_cycle council corrections ${project} running`, message: "Octopus council corrections runner launched; observer integration is optional." });
  const launchRecord = join(dir, "implementation_council_corrections_launch.json");
  await writeFile(launchRecord, JSON.stringify(launch, null, 2) + "\n");
  const next = await cycleStatus(dir, { phase: "corrections_launched", owner: "implementation", implementationAdapter: launch.adapter, ok: false, councilCorrectionCount: count + 1, councilCorrectionFeedback: feedbackPath, nextAction: "Use development_cycle status to watch council corrections. Validation/council will rerun after corrections exit.", projectRoot, projectWikiPath, codexSandbox: defaultCodexSandbox, implementationCorrectionsSessionId: launch.sessionId, directCorrectionsStatus: launch.statusPath, directCorrectionsStdout: launch.stdoutPath, directCorrectionsStderr: launch.stderrPath, observerCorrectionsObservationId: observerObservationId, implementationCorrectionsRequest: requestPath, implementationCorrectionsLaunch: launchRecord, correctionsStdout: launch.stdoutPath, correctionsStderr: launch.stderrPath, externalValidation: "", validationSummary: "", councilReviewSummary: "", councilReviewSynthesis: "", councilReviewNeedsCorrections: null });
  return { ok: true, launch, feedbackPath, status: next };
}

async function maybeRunCouncilEndgate(dir: string, status: any, params: any = {}) {
  const adapter = String(params.implementationAdapter || status?.implementationAdapter || implementationConfig.adapter);
  if (adapter !== "octopus" || params.autoRunCouncilReview === false) return null;
  const phase = String(status?.phase || "");
  if (phase !== "external_validation_passed") return null;
  if (status?.councilReviewSummary) return null;
  const council = await runCouncilCodeReview(dir, status, params);
  const onePager = await writeCouncilOnePager(dir, council.status || status, council, params);
  const title = `${cleanId(params.project || status?.project || "project")} council review: ${council.needsCorrections ? "corrections needed" : "validated"}`;
  const text = `One-pager: ${onePager.path}\nCouncil summary: ${council.summaryPath || "not available"}\nDecision: ${council.needsCorrections ? "corrections needed; launching automatically" : "validated"}\nFindings:\n${(council.findings || []).slice(0, 6).map((f: string) => `- ${f}`).join("\n") || "- none extracted"}`;
  const notice = await sendCycleNotice(params, String(params.runId || status?.runId || "run"), title, text).catch((e: any) => ({ ok: false, error: String(e?.message || e) }));
  const notification = await sendCycleMessage(params, title, text);
  let corrections: any = null;
  let effectiveStatus = onePager.status || council.status || status;
  if (council.needsCorrections && params.autoCouncilCorrections !== false) {
    corrections = await launchCouncilCorrections(dir, effectiveStatus, council, params);
    effectiveStatus = corrections.status || effectiveStatus;
  }
  const next = await cycleStatus(dir, { councilNotice: notice, councilNotification: notification, councilAutoCorrections: corrections ? { ok: corrections.ok, feedbackPath: corrections.feedbackPath, limitReached: corrections.limitReached || false } : null });
  return { council, onePager, notice, notification, corrections, status: corrections?.status || next };
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


function numericPid(value: any) {
  const pid = Number(value);
  return Number.isFinite(pid) && pid > 1 ? Math.trunc(pid) : 0;
}

function signalPid(target: number, signal: NodeJS.Signals) {
  try {
    process.kill(target, signal);
    return { ok: true, target, signal };
  } catch (err: any) {
    return { ok: false, target, signal, error: String(err?.code || err?.message || err) };
  }
}

async function stopDirectImplementationRunnerSession(statusPath: string, reason: string) {
  const session = await readJsonIfExists(statusPath);
  if (!session) return { ok: false, skipped: true, reason: "session_status_missing", statusPath };
  const runnerPid = numericPid(session.runnerPid || session.pid);
  const processGroupId = numericPid(session.processGroupId || session.runnerPid || session.pid);
  if (!processGroupId && !runnerPid) return { ok: false, skipped: true, reason: "runner_pid_missing", statusPath, session };

  const signals: any[] = [];
  if (processGroupId) signals.push(signalPid(-processGroupId, "SIGTERM"));
  if (runnerPid && runnerPid !== processGroupId) signals.push(signalPid(runnerPid, "SIGTERM"));
  await sleep(5000);
  if (processGroupId) signals.push(signalPid(-processGroupId, "SIGKILL"));
  if (runnerPid && runnerPid !== processGroupId) signals.push(signalPid(runnerPid, "SIGKILL"));

  const stoppedAt = new Date().toISOString();
  if (session.exitCodePath) await writeFile(String(session.exitCodePath), "143\n").catch(() => null);
  if (session.exitedAtPath) await writeFile(String(session.exitedAtPath), `${stoppedAt}\n`).catch(() => null);
  const next = {
    ...session,
    status: "stopped",
    launchState: "stopped",
    ok: false,
    exitCode: 143,
    stoppedAt,
    stoppedReason: reason,
    processGroupStopped: Boolean(processGroupId),
    processGroupId: processGroupId || null,
    runnerPid: runnerPid || session.runnerPid || null,
    stopSignals: signals,
    updatedAt: stoppedAt,
    message: "Implementation direct runner stopped by development_cycle using process-group termination.",
  };
  await saveJson(statusPath, next);
  return { ok: true, statusPath, runnerPid, processGroupId, stoppedAt, signals };
}

async function stopLaunchedImplementation(dir: string, status: any, reason: string) {
  const targets = [status?.directImplementationStatus, status?.directCorrectionsStatus].filter(Boolean).map(String);
  if (!targets.length) return { ok: false, stopped: [], reason: "no_direct_implementation_status_paths" };
  const stopped = [];
  for (const target of targets) stopped.push(await stopDirectImplementationRunnerSession(target, reason));
  const stoppedAt = new Date().toISOString();
  const next = await cycleStatus(dir, {
    phase: "stopped",
    owner: "main",
    status: "stopped",
    launchState: "stopped",
    ok: false,
    exitCode: 143,
    stoppedAt,
    stoppedReason: reason,
    processGroupStopResults: stopped,
    nextAction: "Inspect logs and dirty worktree before deciding whether to clean/relaunch.",
    error: reason,
  });
  return { ok: true, stopped, status: next };
}

async function latestRunId(project: string) {
  try {
    const names = await readdir(join(cycleRoot, "runs", cleanId(project)));
    return names.filter((x) => x.startsWith(`${cleanId(project)}-`)).sort().at(-1) || "";
  } catch { return ""; }
}

async function projectCycle(params: any) {
  const supported = [...ACTIONS];
  const action = params.action || "status";
  if (!supported.includes(action)) return { ok: false, error: "unknown_action", action, supported };

  const project = cleanId(params.project || "default");
  const createRun = action === "request_plan" || action === "record_plan";
  const runId = cleanId(params.runId || (createRun ? newRunId(project) : await latestRunId(project)));
  if (!runId) return { ok: true, project, runId: null, dir: null, status: null, files: [], nextAction: "request_plan or record_plan" };
  const dir = cycleDir(project, runId);
  const status = await loadJson(join(dir, "status.json"));

  if (action === "status") {
    const files = (await readdir(dir).catch(() => [])).sort();
    const runtimeObservation = await loadJson(join(dir, "runtime_observation.json"));
    const runtimeAlerts = await loadJson(join(dir, "runtime_alerts.json"));
    return {
      ok: true,
      readOnly: true,
      project,
      runId,
      dir,
      status,
      files,
      runtime: { observation: runtimeObservation, alerts: runtimeAlerts },
      nextAction: status?.nextAction || null,
    };
  }

  if (action === "reconcile") {
    const refreshedStatus = await refreshLaunchedImplementationStatus(dir, status);
    let effectiveStatus = refreshedStatus;
    let automaticValidation: any = null;
    if (params.autoRunFinalValidation === true && ["implementation_delivered", "corrections_completed"].includes(String(effectiveStatus?.phase || "")) && !effectiveStatus?.externalValidation) {
      automaticValidation = await runExternalFinalValidation(dir, { ...effectiveStatus, project, runId }, params, "implementation_delivered");
      effectiveStatus = automaticValidation.status || effectiveStatus;
    }
    let councilEndgate: any = null;
    if (params.autoRunCouncilReview === true) {
      councilEndgate = await maybeRunCouncilEndgate(dir, { ...effectiveStatus, project, runId }, params);
      effectiveStatus = councilEndgate?.status || effectiveStatus;
    }
    const stall = await maybeHandleStalledRun(dir, effectiveStatus, params);
    effectiveStatus = stall?.status || effectiveStatus;
    const files = (await readdir(dir).catch(() => [])).sort();
    const runtime = await cycleRuntimeSummary(dir, effectiveStatus);
    const runtimeEvent = await dcClassify(dir, { ...effectiveStatus, project, runId }, runtime);
    const failurePolicy = await dcPersistFailure(dir, effectiveStatus, runtimeEvent);
    effectiveStatus = failurePolicy.status || effectiveStatus;
    const mainUpdate = await dcNotifyMain(dir, project, runId, effectiveStatus, params, runtimeEvent);
    return { ok: true, readOnly: false, project, runId, dir, status: effectiveStatus, files, runtime, stall, automaticValidation, councilEndgate, failurePolicy: runtimeEvent, mainUpdate };
  }

  const transition = checkActionTransition(action, status?.phase);
  if (!transition.ok) {
    return { ok: false, project, runId, dir, ...transition, nextAction: "Inspect status and invoke only the action allowed for the current phase." };
  }

  if (action === "stop_implementation") {
    const reason = String(params.stopReason || params.reason || "Stopped by development_cycle stop_implementation.");
    const stopped = await stopLaunchedImplementation(dir, status, reason);
    const files = (await readdir(dir).catch(() => [])).sort();
    const runtime = await cycleRuntimeSummary(dir, stopped.status || status);
    return { ok: stopped.ok, project, runId, dir, stopped, files, runtime };
  }

  if (action === "run_final_validation") {
    await mkdir(dir, { recursive: true });
    return await runExternalFinalValidation(dir, { ...status, project, runId }, params, String(params.reason || "manual"));
  }

  await mkdir(dir, { recursive: true });

  if (action === "request_plan") {
    const direction = String(params.direction || params.objective || "Create or validate the implementation plan for this development cycle.");
    const projectRoot = String(params.projectRoot || status.projectRoot || "");
    const projectWikiPath = resolveTrustedProjectWikiPath(project, params.projectWikiPath, status.projectWikiPath);
    const existingPlanPath = String(params.planPath || "");
    const planningPack = await writePlanningPack(dir, { project, runId, projectRoot, projectWikiPath, direction, existingPlanPath });
    const text = `# Development plan request for external gate

Project: ${project}
Run: ${runId}
Wiki root: ${wikiRoot}
Project wiki path: ${projectWikiPath}
Project root / code checkout: ${projectRoot || "not supplied"}

## User direction

${direction}

## Existing plan path, if any

${existingPlanPath || "not supplied"}

## Planning pack files

- contextPack: ${planningPack.contextPack}
- operatorConstraints: ${planningPack.operatorConstraints}
- expectedPlanContract: ${planningPack.expectedPlanContract}

Read these files before writing the implementation plan. They contain project context, current git state, constraints, and the required plan contract.

## Your responsibility

You are responsible for the macro implementation plan. Do not implement. Do not ask Implementation to infer the project structure. The plan you return must include exact project paths so main can hand it to Implementation safely.

## Required project paths section

The final implementation plan must contain a section named "Project paths" with at least:

- projectWikiPath: ${projectWikiPath}
- projectRoot: the real code checkout directory; validate it exists before handoff; do not infer it from the project identifier
- planPath: where the approved plan will live, preferably under ${projectWikiPath}/plans/ or the active cycle run
- relevant code paths / affected files and directories
- expected output paths / artifacts
- protected or risky paths that require explicit human confirmation before edits

## Required external gate output

Create or validate the implementation plan only. Do not implement. The plan must be actionable for Implementation and safe for main to hand off. Include objective, project paths, required context/files, ordered implementation tasks, validation checks, stop conditions, expected artifacts, and explicit human-confirmation points for risky changes. A plan without projectRoot/projectWikiPath/relevant code paths is not ready for Implementation handoff.
`;
    const file = join(dir, "plan_request.md");
    await writeFile(file, text);
    const next = await cycleStatus(dir, { phase: "waiting_external_plan", owner: "external_gate_or_human", nextAction: "Send plan_request.md plus planning pack to an external gate or human reviewer, then call record_plan with planText or planPath.", project, runId, projectRoot, projectWikiPath, direction, planRequest: file, planningPack });
    const notice = await sendCycleNotice(params, runId, `Development plan needed: ${project}`, `Development plan request ready for an external gate or human reviewer validation: ${file}`);
    return { ok: true, project, runId, dir, phase: next.phase, planRequest: file, notice };
  }

  if (action === "record_plan") {
    let planText = params.planText || "";
    if (!String(planText).trim() && params.planPath) {
      const projectRootEarly = await trustedProjectRoot(String(params.projectRoot || status.projectRoot || ""));
      const projectWikiPathEarly = resolveTrustedProjectWikiPath(project, params.projectWikiPath, status.projectWikiPath);
      const loaded = await readAllowedTextFile(String(params.planPath), [dir, cycleRoot, projectsWikiRoot, wikiRoot, projectRootEarly, projectWikiPathEarly], "plan_path_outside_allowed_roots");
      if (!loaded.ok) return { ok: false, error: loaded.error, project, runId, dir, path: (loaded as any).path };
      planText = loaded.text;
    }
    if (!String(planText).trim()) return { ok: false, error: "planText_or_planPath_required", project, runId, dir };
    if (!params.force && looksLikePlanRequest(String(planText))) {
      return { ok: false, error: "plan_request_not_implementation_plan", project, runId, dir, nextAction: "Ask an external gate or human reviewer to write the actual implementation plan, then call record_plan with that plan. Use force only after explicit human confirmation." };
    }
    if (!params.force && !looksLikeImplementationPlan(String(planText))) {
      return { ok: false, error: "implementation_plan_not_validated", project, runId, dir, nextAction: "Provide a concrete implementation plan with a Project paths section including projectWikiPath, projectRoot, relevant code paths/affected files, validation checks, stop conditions, and expected artifacts; or set force=true after explicit human confirmation." };
    }
    const projectRoot = String(params.projectRoot || status.projectRoot || "");
    const projectWikiPath = resolveTrustedProjectWikiPath(project, params.projectWikiPath, status.projectWikiPath);
    const file = join(dir, "implementation_plan.md");
    await writeFile(file, String(planText));
    const canonicalPlan = await persistApprovedPlan(project, runId, projectWikiPath, String(planText));
    const canonicalPlanGit = canonicalPlan ? await autoCommitCanonicalPlan(project, runId, canonicalPlan) : { ok: false, skipped: true, reason: "no_canonical_plan" };
    const next = await cycleStatus(dir, { phase: "plan_ready_for_implementation", owner: "main", nextAction: "Call start_implementation to run the configured adapter on the approved plan.", project, runId, projectRoot, projectWikiPath, plan: file, canonicalPlan: canonicalPlan || null, canonicalPlanGit });
    return { ok: true, project, runId, dir, phase: next.phase, plan: file, canonicalPlan: canonicalPlan || null, canonicalPlanGit };
  }

  if (action === "start_implementation") {
    const projectRoot = String(params.projectRoot || status.projectRoot || "");
    const projectWikiPath = resolveTrustedProjectWikiPath(project, params.projectWikiPath, status.projectWikiPath);
    if (!projectRoot) return { ok: false, error: "projectRoot_required", project, runId, dir, wikiRoot, projectWikiPath, hint: "projectRoot must be the real code checkout; projectWikiPath is only docs/state." };
    const rootStat = await stat(projectRoot).catch(() => null);
    if (!rootStat?.isDirectory()) return { ok: false, error: "projectRoot_missing_or_not_directory", project, runId, dir, projectRoot, wikiRoot, projectWikiPath, hint: "Pass the configured project documentation directory separately from the real code checkout." };
    let plan = params.planText || "";
    if (!String(plan).trim() && params.planPath) {
      const loaded = await readAllowedTextFile(String(params.planPath), [dir, cycleRoot, projectsWikiRoot, wikiRoot, await trustedProjectRoot(projectRoot), projectWikiPath], "plan_path_outside_allowed_roots");
      if (!loaded.ok) return { ok: false, error: loaded.error, project, runId, dir, path: (loaded as any).path };
      plan = loaded.text;
    }
    if (!String(plan).trim()) plan = await readTextIfExists(join(dir, "implementation_plan.md"));
    if (!String(plan).trim()) return { ok: false, error: "missing_implementation_plan", project, runId, dir, expected: join(dir, "implementation_plan.md") };
    const adapter = String(params.implementationAdapter || status.implementationAdapter || implementationConfig.adapter);
    const command = String(params.implementationCommand || (adapter === "octopus" ? "tangle" : "implement"));
    if (adapter === "octopus" && command !== "tangle") return { ok: false, error: "unsupported_octopus_command", supported: ["tangle"] };
    const prompt = `Run the approved development plan. Stay within the agreed scope. Stop and report before risky, destructive, or protected changes that need human approval.\n\nPROJECT_DOCUMENTATION_PATH:\n${projectWikiPath}\n\nPROJECT_ROOT_CODE_CHECKOUT:\n${projectRoot}\n\nIMPLEMENTATION_ADAPTER:\n${adapter}\n\nAPPROVED_PLAN:\n${plan}`;
    const handoffRequest = join(dir, "implementation_request.md");
    const stdoutPath = join(dir, "implementation_delivery_stdout.txt");
    const stderrPath = join(dir, "implementation_delivery_stderr.txt");
    await writeFile(handoffRequest, prompt);
    const observerObservationId = await createImplementationObserverSession(dir, { project, runId, command, projectRoot, projectWikiPath, stdoutPath, stderrPath, status: "running", summary: `development_cycle ${command} ${project}`, message: "Development-cycle implementation run queued." });
    if (developmentCycleConfig.observer.enabled && !observerObservationId) {
      const next = await cycleStatus(dir, { phase: "implementation_failed", owner: "main", ok: false, error: "observer_root_session_creation_failed", projectRoot, projectWikiPath, implementationCommand: command, implementationHandoffRequest: handoffRequest });
      return { ok: false, project, runId, dir, phase: next.phase, error: next.error };
    }
    const launch = await createImplementationRunnerSession(dir, { project, runId, projectRoot, command, prompt, kind: "delivery", implementationAdapter: adapter, planPath: String(params.planPath || status.plan || join(dir, "implementation_plan.md")), timeoutSeconds: Number(params.timeoutSeconds ?? params.timeout_ms ?? 0), observerObservationId, purpose: `development_cycle ${command} ${project}` });
    if (!launch.ok) {
      const next = await cycleStatus(dir, { phase: "implementation_failed", owner: "main", ok: false, nextAction: "Fix direct runner launch blocker, then launch a new clean handoff.", error: launch.error || "direct_runner_launch_failed", projectRoot, projectWikiPath, implementationCommand: command, codexSandbox: defaultCodexSandbox, observerObservationId, implementationHandoffRequest: handoffRequest });
      return { ok: false, project, runId, dir, phase: next.phase, error: next.error, observerObservationId };
    }
    await updateImplementationObserverSession(dir, observerObservationId, { project, runId, command, projectRoot, projectWikiPath, stdoutPath: launch.stdoutPath, stderrPath: launch.stderrPath, status: "running", summary: `development_cycle ${command} ${project} running`, message: "Implementation runner launched; observer integration is optional." });
    const launchRecord = join(dir, "implementation_launch.json");
    await writeFile(launchRecord, JSON.stringify(launch, null, 2) + "\n");
    const next = await cycleStatus(dir, { phase: "implementation_launched", owner: "implementation", nextAction: "Use development_cycle status to watch the supervised implementation runner.", projectRoot, projectWikiPath, implementationAdapter: launch.adapter, implementationCommand: command, codexSandbox: defaultCodexSandbox, implementationSessionId: launch.sessionId, directImplementationStatus: launch.statusPath, directImplementationStdout: launch.stdoutPath, directImplementationStderr: launch.stderrPath, observerObservationId, implementationHandoffRequest: handoffRequest, implementationLaunch: launchRecord, implementationStdout: launch.stdoutPath, implementationStderr: launch.stderrPath });
    return { ok: true, project, runId, dir, phase: next.phase, implementationAdapter: launch.adapter, implementationSessionId: launch.sessionId, observerObservationId, launchState: launch.status?.launchState || null, directImplementationStatus: launch.statusPath };

  }

  if (action === "record_delivery") {
    let deliveryText = params.deliveryText || "";
    if (!String(deliveryText).trim() && params.deliveryPath) {
      const loaded = await readAllowedTextFile(String(params.deliveryPath), [dir, cycleRoot, projectsWikiRoot, wikiRoot, await trustedProjectRoot(status?.projectRoot), status?.projectWikiPath && pathWithin(projectsWikiRoot, String(status.projectWikiPath)) ? status.projectWikiPath : null, await trustedProjectRoot(params.projectRoot), params.projectWikiPath && pathWithin(projectsWikiRoot, String(params.projectWikiPath)) ? params.projectWikiPath : null], "delivery_path_outside_allowed_roots");
      if (!loaded.ok) return { ok: false, error: loaded.error, project, runId, dir, path: (loaded as any).path };
      deliveryText = loaded.text;
    }
    if (!String(deliveryText).trim()) return { ok: false, error: "deliveryText_or_deliveryPath_required", project, runId, dir };
    const file = join(dir, "implementation_delivery.md");
    await writeFile(file, String(deliveryText));
    const next = await cycleStatus(dir, { phase: "implementation_delivered", owner: "main", nextAction: "Call request_final_validation.", implementationDelivery: file });
    return { ok: true, project, runId, dir, phase: next.phase, implementationDelivery: file };
  }

  if (action === "request_final_validation") {
    const validationPack = await writeFinalValidationPack(dir, project, runId, status);
    const names = ["implementation_plan.md", "delivery_summary.md", "test_evidence.md", "risk_checklist.md", "observer_sessions.json", "artifact_manifest.json", "implementation_delivery_error.txt"];
    const parts: string[] = [];
    for (const name of names) {
      const text = await readTextIfExists(join(dir, name));
      if (text.trim()) parts.push(`## ${name}\n\n${excerpt(text, name.endsWith(".json") ? 8000 : 12000)}`);
    }
    const file = join(dir, "final_validation_request.md");
    await writeFile(file, `# Final validation request for external gate\n\nProject: ${project}\nRun: ${runId}\n\nReview the approved plan, delivery summary, test evidence, Observer sessions and risk checklist. Return exactly one decision as the first token: go | revise | stop.\n\nGO only if the plan was fulfilled, evidence is adequate, no protected/risky paths were changed without explicit authorization, worktree state is understood, and required docs/runbooks/state were updated. If revise, include direct delta-only correction instructions for Implementation. If stop, explain the blocker for the operator.\n\nValidation pack files:\n- deliverySummary: ${validationPack.deliverySummary}\n- artifactManifest: ${validationPack.artifactManifest}\n- observerSessions: ${validationPack.observerSessions}\n- testEvidence: ${validationPack.testEvidence}\n- riskChecklist: ${validationPack.riskChecklist}\n\n${parts.join("\n\n---\n\n")}\n`);
    const next = await cycleStatus(dir, { phase: "waiting_final_validation", owner: "external_gate_or_human", nextAction: "Send final_validation_request.md plus validation pack to an external gate or human reviewer, then call record_final_validation.", finalValidationRequest: file, validationPack });
    const notice = await sendCycleNotice(params, runId, `Final validation needed: ${project}`, `Final validation request ready for an external gate or human reviewer: ${file}`);
    return { ok: true, project, runId, dir, phase: next.phase, finalValidationRequest: file, validationPack, notice };
  }

  if (action === "record_final_validation") {
    let validationText = params.validationText || params.feedbackText || "";
    if (!String(validationText).trim() && (params.validationPath || params.feedbackPath)) {
      const pathValue = String(params.validationPath || params.feedbackPath);
      const loaded = await readAllowedTextFile(pathValue, [dir, cycleRoot, projectsWikiRoot, wikiRoot, await trustedProjectRoot(status?.projectRoot), status?.projectWikiPath && pathWithin(projectsWikiRoot, String(status.projectWikiPath)) ? status.projectWikiPath : null, await trustedProjectRoot(params.projectRoot), params.projectWikiPath && pathWithin(projectsWikiRoot, String(params.projectWikiPath)) ? params.projectWikiPath : null], "validation_path_outside_allowed_roots");
      if (!loaded.ok) return { ok: false, error: loaded.error, project, runId, dir, path: (loaded as any).path };
      validationText = loaded.text;
    }
    if (!String(validationText).trim()) return { ok: false, error: "validationText_or_validationPath_required", project, runId, dir };
    const parsedDecision = parseFinalDecision(validationText);
    if (!parsedDecision.ok) return { ok: false, project, runId, dir, ...parsedDecision };
    const file = join(dir, "final_validation_response.md");
    await writeFile(file, String(validationText));
    const phase = parsedDecision.decision === "go" ? "final_validated" : parsedDecision.decision === "stop" ? "stopped" : "needs_corrections";
    const nextAction = phase === "needs_corrections" ? "Call start_corrections with the final validation feedback." : phase === "final_validated" ? "Call close when reporting is complete." : "Stop and report to the operator.";
    const next = await cycleStatus(dir, { phase, owner: "main", nextAction, finalValidation: file });
    return { ok: true, project, runId, dir, phase: next.phase, finalValidation: file };
  }

  if (action === "start_corrections") {
    const projectRoot = String(params.projectRoot || status.projectRoot || "");
    if (!projectRoot) return { ok: false, error: "projectRoot_required", project, runId, dir };
    const plan = await readTextIfExists(join(dir, "implementation_plan.md"));
    let validation = params.feedbackText || params.validationText || "";
    if (!String(validation).trim() && params.feedbackPath) {
      const loaded = await readAllowedTextFile(String(params.feedbackPath), [dir, cycleRoot, projectsWikiRoot, wikiRoot, await trustedProjectRoot(projectRoot), status?.projectWikiPath && pathWithin(projectsWikiRoot, String(status.projectWikiPath)) ? status.projectWikiPath : null, params.projectWikiPath && pathWithin(projectsWikiRoot, String(params.projectWikiPath)) ? params.projectWikiPath : null], "feedback_path_outside_allowed_roots");
      if (!loaded.ok) return { ok: false, error: loaded.error, project, runId, dir, path: (loaded as any).path };
      validation = loaded.text;
    }
    if (!String(validation).trim()) validation = await readTextIfExists(join(dir, "final_validation_response.md"));
    if (!String(validation).trim()) return { ok: false, error: "missing_final_validation_feedback", project, runId, dir };
    const adapter = String(params.implementationAdapter || status.implementationAdapter || implementationConfig.adapter);
    const command = String(params.implementationCommand || (adapter === "octopus" ? "tangle" : "correct"));
    if (adapter === "octopus" && command !== "tangle") return { ok: false, error: "unsupported_octopus_command", supported: ["tangle"] };
    const prompt = `Apply only the direct correction feedback from final validation. Do not restart the whole cycle. Preserve already-correct work and stop before risky or protected changes needing human approval.\n\nPROJECT_ROOT_CODE_CHECKOUT:\n${projectRoot}\n\nIMPLEMENTATION_ADAPTER:\n${adapter}\n\nAPPROVED_PLAN:\n${plan}\n\nFINAL_VALIDATION_FEEDBACK:\n${validation}`;
    const requestPath = join(dir, "corrections_request.md");
    await writeFile(requestPath, prompt);
    const stdoutPath = join(dir, "implementation_corrections_stdout.txt");
    const stderrPath = join(dir, "implementation_corrections_stderr.txt");
    const observerObservationId = await createImplementationObserverSession(dir, { project, runId, command: "corrections", projectRoot, projectWikiPath: status.projectWikiPath || "", stdoutPath, stderrPath, status: "running", summary: `development_cycle corrections ${project}`, message: "Development-cycle corrections run queued." });
    if (developmentCycleConfig.observer.enabled && !observerObservationId) {
      const next = await cycleStatus(dir, { phase: "corrections_failed", owner: "main", ok: false, error: "observer_root_session_creation_failed", projectRoot, implementationCorrectionsRequest: requestPath });
      return { ok: false, project, runId, dir, phase: next.phase, error: next.error };
    }
    const launch = await createImplementationRunnerSession(dir, { project, runId: `${runId}-corrections`, projectRoot, command, prompt, kind: "corrections", implementationAdapter: adapter, planPath: String(status.plan || join(dir, "implementation_plan.md")), validationPath: String(status.finalValidation || join(dir, "final_validation_response.md")), timeoutSeconds: Number(params.timeoutSeconds ?? params.timeout_ms ?? 0), observerObservationId, purpose: `development_cycle corrections ${project}` });
    if (!launch.ok) {
      const next = await cycleStatus(dir, { phase: "corrections_failed", owner: "main", ok: false, error: launch.error || "direct_runner_launch_failed", projectRoot, codexSandbox: defaultCodexSandbox, observerCorrectionsObservationId: observerObservationId, implementationCorrectionsRequest: requestPath });
      return { ok: false, project, runId, dir, phase: next.phase, error: next.error, observerObservationId };
    }
    await updateImplementationObserverSession(dir, observerObservationId, { project, runId, command: "corrections", projectRoot, projectWikiPath: status.projectWikiPath || "", stdoutPath: launch.stdoutPath, stderrPath: launch.stderrPath, status: "running", summary: `development_cycle corrections ${project} running`, message: "Corrections runner launched; observer integration is optional." });
    const launchRecord = join(dir, "implementation_corrections_launch.json");
    await writeFile(launchRecord, JSON.stringify(launch, null, 2) + "\n");
    const next = await cycleStatus(dir, { phase: "corrections_launched", owner: "implementation", nextAction: "Use development_cycle status to watch the supervised corrections runner.", projectRoot, implementationAdapter: launch.adapter, implementationCorrectionsSessionId: launch.sessionId, directCorrectionsStatus: launch.statusPath, directCorrectionsStdout: launch.stdoutPath, directCorrectionsStderr: launch.stderrPath, observerCorrectionsObservationId: observerObservationId, implementationCorrectionsRequest: requestPath, implementationCorrectionsLaunch: launchRecord, correctionsStdout: launch.stdoutPath, correctionsStderr: launch.stderrPath });
    return { ok: true, project, runId, dir, phase: next.phase, implementationAdapter: launch.adapter, implementationCorrectionsSessionId: launch.sessionId, observerObservationId, launchState: launch.status?.launchState || null, directCorrectionsStatus: launch.statusPath };

  }

  if (action === "close") {
    const next = await cycleStatus(dir, { phase: "closed", owner: "main", nextAction: "none" });
    return { ok: true, project, runId, dir, phase: next.phase };
  }
}



export default defineToolPlugin({
  id: "development-cycle",
  name: "Development Cycle",
  description: "Adapter-agnostic supervised development cycles for OpenClaw with durable state, process supervision, validation gates, and correction loops.",
  tools: (tool) => [
    tool({
      name: "development_cycle",
      label: "Development Cycle",
      description: "Supervised development-cycle control plane. It records plans, launches a configured implementation adapter, persists evidence, coordinates validation and corrections, and closes the cycle. Project documentation and the source checkout are separate paths. Observers, channel notifications, and external gates are optional.",
      parameters: Type.Object({
        action: lit(...ACTIONS),
        project: Type.String(),
        runId: Type.Optional(Type.String()),
        projectRoot: Type.Optional(Type.String({ description: "Real code checkout directory for Implementation. Must exist; do not infer it from the project wiki id." })),
        projectWikiPath: Type.Optional(Type.String({ description: "Project documentation folder. Defaults under DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT and is separate from the source checkout." })),
        direction: Type.Optional(Type.String()),
        objective: Type.Optional(Type.String()),
        planText: Type.Optional(Type.String()),
        planPath: Type.Optional(Type.String()),
        feedbackText: Type.Optional(Type.String()),
        feedbackPath: Type.Optional(Type.String()),
        deliveryText: Type.Optional(Type.String()),
        deliveryPath: Type.Optional(Type.String()),
        validationText: Type.Optional(Type.String()),
        validationPath: Type.Optional(Type.String()),
        outputPath: Type.Optional(Type.String()),
        implementationAdapter: Type.Optional(lit("command", "octopus")),
        implementationCommand: Type.Optional(Type.String()),
        force: Type.Optional(Type.Boolean()),
        timeoutSeconds: Type.Optional(Type.Number()),
        timeout_ms: Type.Optional(Type.Number()),
        stopReason: Type.Optional(Type.String()),
        reason: Type.Optional(Type.String()),
        validationConfigPath: Type.Optional(Type.String()),
        autoStopStalled: Type.Optional(Type.Boolean()),
        autoRunFinalValidation: Type.Optional(Type.Boolean()),
        autoRunCouncilReview: Type.Optional(Type.Boolean()),
        autoCouncilCorrections: Type.Optional(Type.Boolean()),
        autoCouncilCorrectionsMax: Type.Optional(Type.Number()),
        councilDepth: Type.Optional(Type.String()),
        councilMembers: Type.Optional(Type.Number()),
        councilMaxCost: Type.Optional(Type.String()),
        councilAutoProviders: Type.Optional(Type.String()),
        councilProviders: Type.Optional(Type.String()),
        councilCodexModel: Type.Optional(Type.String()),
        councilTimeoutMs: Type.Optional(Type.Number()),
        notify: Type.Optional(Type.Boolean({ description: "Send a lifecycle notification through an OpenClaw-supported channel." })),
        notificationChannel: Type.Optional(Type.String({ description: "OpenClaw channel name, for example slack, telegram, whatsapp, signal, discord or matrix." })),
        notificationTarget: Type.Optional(Type.String({ description: "Channel-specific recipient or destination." })),
        notificationAccount: Type.Optional(Type.String({ description: "Optional OpenClaw channel account id." })),
        notificationDeliveryJson: Type.Optional(Type.String({ description: "Optional JSON string passed to openclaw message send --delivery." })),
        notificationDryRun: Type.Optional(Type.Boolean()),
        notifyExternalGate: Type.Optional(Type.Boolean()),
        notifyMain: Type.Optional(Type.Boolean()),
        emitMainUpdates: Type.Optional(Type.Boolean()),
        dryRunMainUpdate: Type.Optional(Type.Boolean()),
        mainUpdateTimeoutMs: Type.Optional(Type.Number()),
        mainUpdateExecTimeoutMs: Type.Optional(Type.Number()),
        stallQuietSeconds: Type.Optional(Type.Number()),
      }),
      execute: async (params) => await projectCycle(params),
    }),
  ],
});
