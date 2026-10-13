import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { cleanId } from "../core/ids.js";
import { readProcessIdentity } from "../runtime/processes.js";
import { buildImplementationLaunchSpec, jsonShellQuote, renderShellCommand, renderShellEnvironment, shellQuote } from "../adapters/implementation.js";
import { execFileAsync } from "./exec.js";
import { readTextIfExists, readJsonIfExists } from "./files.js";
import type { createRunnerSupervisor } from "./runner-supervisor.js";
import type { createCycleStore } from "./cycle-store.js";
import type { createPinnedFs } from "./pinned-fs.js";
import type { DevelopmentCycleConfig } from "../config.js";

export interface RunnerSessionDeps {
  developmentCycleConfig: DevelopmentCycleConfig;
  implementationConfig: DevelopmentCycleConfig["implementation"];
  observerAgentHook: string;
  observerHookLog: string;
  runtimeHome: string;
  observerRepository: string;
  observerBranch: string;
  observerOwner: string;
  runnerSupervisorPath: string;
  runnerSupervisorSocket: string;
  runnerHeartbeatIntervalSeconds: number;
  runnerDefaultTimeoutSeconds: number;
  ensureRunnerSupervisor: ReturnType<typeof createRunnerSupervisor>["ensureRunnerSupervisor"];
  saveJson: ReturnType<typeof createCycleStore>["saveJson"];
  pinTrustedProjectRoot: ReturnType<typeof createPinnedFs>["pinTrustedProjectRoot"];
}

export function createRunnerSession(deps: RunnerSessionDeps) {
  const { developmentCycleConfig, implementationConfig, observerAgentHook, observerHookLog, runtimeHome, observerRepository, observerBranch, observerOwner, runnerSupervisorPath, runnerSupervisorSocket, runnerHeartbeatIntervalSeconds, runnerDefaultTimeoutSeconds, ensureRunnerSupervisor, saveJson, pinTrustedProjectRoot } = deps;

  async function createImplementationRunnerSession(dir: string, params: any) {
    const requestedProjectRoot = String(params.projectRoot || "");
    const pinnedProjectRoot = await pinTrustedProjectRoot(requestedProjectRoot);
    if (!pinnedProjectRoot) return { ok: false, error: "projectRoot_missing_or_not_trusted_git_checkout", projectRoot: requestedProjectRoot };
    const projectRoot = pinnedProjectRoot.realPath;
    const projectRootStat = await pinnedProjectRoot.handle.stat();
    const projectRootIdentity = `${projectRootStat.dev}:${projectRootStat.ino}`;
    await pinnedProjectRoot.handle.close().catch(() => null);
    const prompt = String(params.prompt || "");
    const command = String(params.command || "implement");
    const mode = String(params.kind || "delivery") === "corrections" ? "corrections" : "delivery";
    const timeoutSeconds = Number(params.timeoutSeconds ?? 0);
    const effectiveTimeoutSeconds = timeoutSeconds > 0
      ? timeoutSeconds
      : (runnerDefaultTimeoutSeconds > 0 ? runnerDefaultTimeoutSeconds : undefined);
    const observerRootSessionId = String(params.observerObservationId || "");
    if (developmentCycleConfig.observer.enabled && !observerRootSessionId) {
      return { ok: false, error: "observer_root_session_missing" };
    }

    const sessionId = cleanId(params.sessionId || `DC-${params.project || "project"}-${params.runId || Date.now()}-${Date.now()}`);
    const attemptId = cleanId(params.attemptId || `${mode}-${Date.now()}-${randomUUID()}`, "attempt");
    const sessionRootDir = join(dir, mode === "corrections" ? "corrections_session" : "implementation_session");
    const sessionDir = join(sessionRootDir, "attempts", attemptId);
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
    const interventionPath = join(sessionDir, "intervention.json");

    await mkdir(logsDir, { recursive: true });
    await writeFile(promptPath, prompt);
    const request = {
      schemaVersion: 1,
      project: String(params.project || ""),
      runId: String(params.runId || ""),
      mode,
      attemptId,
      sessionId,
      projectRoot,
      projectRootIdentity,
      promptPath,
      planPath: String(params.planPath || ""),
      validationPath: String(params.validationPath || ""),
      resultsRoot: dir,
      timeoutSeconds: effectiveTimeoutSeconds,
      command,
      interventionPath,
    };
    await saveJson(requestPath, request);

    let launchSpec: any;
    try {
      launchSpec = buildImplementationLaunchSpec(implementationConfig, {
        adapter: params.implementationAdapter,
        project: request.project,
        runId: request.runId,
        attemptId,
        mode,
        projectRoot,
        requestPath,
        promptPath,
        prompt,
        timeoutSeconds: effectiveTimeoutSeconds,
        command,
        interventionPath,
        writeScopeMode: String(params.writeScopeMode || process.env.DEVELOPMENT_CYCLE_OCTOPUS_WRITE_SCOPE_MODE || "adaptive").toLowerCase() === "strict" ? "strict" : "adaptive",
        readScopeMode: params.readScopeMode,
        projectWikiPath: String(params.projectWikiPath || ""),
        planPath: String(params.planPath || ""),
        runRoot: dir,
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
    const boundedLogPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "bounded-log.py");
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
(while :; do printf '{"at":"%s","pid":%s,"observerSessionId":%s}\n' "$(date -Is)" "$$" ${jsonShellQuote(observerRootSessionId)} > "$HEARTBEAT_FILE"; sleep ${runnerHeartbeatIntervalSeconds}; done) &
heartbeat_pid=$!
cd ${shellQuote(projectRoot)} || exit 72
actual_project_root_identity=$(stat -Lc '%d:%i' . 2>/dev/null || true)
if [ "$actual_project_root_identity" != ${shellQuote(projectRootIdentity)} ]; then
  printf '%s\n' "projectRoot identity changed before execution" >&2
  exit 72
fi
python3 ${shellQuote(boundedLogPath)} --stdout ${shellQuote(stdoutPath)} --stderr ${shellQuote(stderrPath)} -- /bin/sh -c ${shellQuote(commandLine)}
`;
    await writeFile(runnerPath, runnerScript, { mode: 0o755 } as any);

    await rm(exitCodePath, { force: true });
    await rm(interventionPath, { force: true });
    await rm(exitedAtPath, { force: true });
    const now = new Date().toISOString();
    const status: any = {
      id: sessionId,
      attemptId,
      runtime: "development-cycle-runner",
      adapter: launchSpec.adapter,
      command: `${launchSpec.displayName} ${command}`.trim(),
      owner: observerOwner,
      status: "starting",
      launchState: "launching",
      timeoutSeconds: effectiveTimeoutSeconds,
      timeoutPolicy: "bounded-with-heartbeat-stall-detection",
      observerRootSessionId,
      heartbeatPath: join(sessionDir, "heartbeat.json"),
      message: `Implementation launch starting through the ${launchSpec.displayName} adapter.`,
      createdAt: now,
      updatedAt: now,
      projectRoot,
      projectRootIdentity,
      executable: launchSpec.executable,
      runnerPath,
      requestPath,
      promptPath,
      exitCodePath,
      exitedAtPath,
      interventionPath,
      logs: { stdout: stdoutPath, stderr: stderrPath },
      stdoutPath,
      stderrPath,
    };
    await saveJson(payloadPath, {
      id: sessionId,
      attemptId,
      project: request.project,
      runId: request.runId,
      mode,
      adapter: launchSpec.adapter,
      projectRoot,
      projectRootIdentity,
      executable: launchSpec.executable,
      requestPath,
      promptPath,
      interventionPath,
      purpose: params.purpose || "development_cycle implementation",
    });
    await saveJson(statusPath, status);
    let supervisor: any = null;
    try {
      supervisor = await ensureRunnerSupervisor();
      const launched = await execFileAsync("python3", [runnerSupervisorPath, "--socket", runnerSupervisorSocket, "launch", runnerPath, sessionDir], {
        cwd: sessionDir,
        env: { ...process.env, HOME: runtimeHome, DEVELOPMENT_CYCLE_RECONCILE_PROJECT: request.project, DEVELOPMENT_CYCLE_RECONCILE_RUN_ID: request.runId },
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
      const launchInfo = JSON.parse(String(launched.stdout || "{}"));
      const runnerPid = Number(launchInfo?.pid || 0);
      if (!launchInfo?.ok || !Number.isInteger(runnerPid) || runnerPid <= 1) {
        throw new Error(`supervised_runner_pid_invalid:${String(launched.stdout || "").trim()}`);
      }
      const runningStatus = {
        ...status,
        status: "running",
        launchState: "running",
        runnerPid,
        runnerIdentity: await readProcessIdentity(runnerPid),
        processGroupId: Number(launchInfo?.pgid || runnerPid),
        runnerSupervisorPid: Number(launchInfo?.supervisorPid || supervisor?.pid || 0) || null,
        runnerSupervisorSocket,
        useProcessGroup: true,
        stopSignalPolicy: "process-group-term-kill",
        updatedAt: new Date().toISOString(),
        message: `Implementation launched through the ${launchSpec.displayName} adapter.`,
      };
      const persistedBeforeRunning = await readJsonIfExists(statusPath);
      const persistedAlreadyTerminal = persistedBeforeRunning
        && (persistedBeforeRunning.launchState === "exited"
          || ["completed", "failed", "interrupted", "stopped"].includes(String(persistedBeforeRunning.status || "").toLowerCase()));
      if (persistedAlreadyTerminal) {
        Object.assign(status, runningStatus, persistedBeforeRunning);
      } else {
        Object.assign(status, runningStatus);
        await saveJson(statusPath, status);
        const exitText = (await readTextIfExists(exitCodePath)).trim();
        if (exitText) {
          const exitCode = Number(exitText);
          const exitedAt = (await readTextIfExists(exitedAtPath)).trim() || new Date().toISOString();
          const persistedAfterRunning = await readJsonIfExists(statusPath) || status;
          const terminalStatus = {
            ...status,
            ...persistedAfterRunning,
            status: exitCode === 0 ? "completed" : "failed",
            launchState: "exited",
            exitCode,
            exitedAt,
            updatedAt: exitedAt,
            message: exitCode === 0
              ? "Implementation direct runner exited successfully."
              : `Implementation direct runner exited non-zero: ${exitCode}`,
          };
          await saveJson(statusPath, terminalStatus);
          Object.assign(status, terminalStatus);
        } else {
          const latestPersisted = await readJsonIfExists(statusPath);
          if (latestPersisted) Object.assign(status, latestPersisted);
        }
      }
    } catch (error: any) {
      const failedAt = new Date().toISOString();
      const failure = String(error?.message || error);
      const failedStatus = {
        ...status,
        status: "failed",
        launchState: "launch_failed",
        runnerPid: null,
        processGroupId: null,
        error: failure,
        failedAt,
        updatedAt: failedAt,
        message: "Implementation runner failed to launch.",
      };
      await saveJson(statusPath, failedStatus);
      return {
        ok: false,
        adapter: launchSpec.adapter,
        sessionId,
        attemptId,
        sessionDir,
        statusPath,
        payloadPath,
        requestPath,
        runnerPath,
        promptPath,
        exitCodePath,
        stdoutPath,
        stderrPath,
        status: failedStatus,
        error: failure,
      };
    }
    return {
      ok: true,
      adapter: launchSpec.adapter,
      sessionId,
      attemptId,
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

  return { createImplementationRunnerSession };
}
