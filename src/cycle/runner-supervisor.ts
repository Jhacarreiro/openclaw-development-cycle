import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { execFileAsync } from "./exec.js";

export interface RunnerSupervisorDeps {
  runnerSupervisorPath: string;
  runnerSupervisorSocket: string;
}

export function createRunnerSupervisor(deps: RunnerSupervisorDeps) {
  const { runnerSupervisorPath, runnerSupervisorSocket } = deps;

  async function ensureRunnerSupervisor() {
    const ping = async () => {
      const res = await execFileAsync("python3", [runnerSupervisorPath, "--socket", runnerSupervisorSocket, "ping"], { timeout: 2000, maxBuffer: 64 * 1024 });
      const parsed = JSON.parse(String(res.stdout || "{}"));
      if (!parsed?.ok || !parsed?.subreaper) throw new Error("runner_supervisor_ping_invalid");
      return parsed;
    };
    try { return await ping(); } catch {}
    await rm(runnerSupervisorSocket, { force: true }).catch(() => undefined);
    const supervisor = spawn("python3", [runnerSupervisorPath, "--socket", runnerSupervisorSocket, "serve"], {
      detached: true,
      stdio: "ignore",
    });
    const supervisorPid = Number(supervisor.pid);
    try {
      await new Promise((resolve, reject) => {
        supervisor.once("spawn", resolve);
        supervisor.once("error", reject);
      });
    } catch {
      try { await rm(runnerSupervisorSocket, { force: true }); } catch {}
      throw new Error("runner_supervisor_start_failed");
    }
    supervisor.unref();
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      try { return await ping(); } catch {}
    }
    // Startup failed — terminate the detached supervisor session and do not leave descendants reparented to init.
    if (Number.isInteger(supervisorPid) && supervisorPid > 1) {
      const terminateGroup = async (signal: NodeJS.Signals) => {
        try { process.kill(-supervisorPid, signal); } catch {}
        for (let i = 0; i < 20; i++) {
          try { process.kill(-supervisorPid, 0); } catch { return true; }
          await sleep(50);
        }
        return false;
      };
      if (!(await terminateGroup("SIGTERM"))) await terminateGroup("SIGKILL");
    }
    try { await rm(runnerSupervisorSocket, { force: true }); } catch {}
    throw new Error("runner_supervisor_start_failed");
  }

  return { ensureRunnerSupervisor };
}
