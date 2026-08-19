import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const alive = (pid) => { try { process.kill(pid, 0); const status = readFileSync("/proc/" + pid + "/status", "utf8"); return !/^State:\s+Z/m.test(status); } catch { return false; } };
async function waitDead(pid) {
  for (let i = 0; i < 120; i++) {
    if (!alive(pid)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`pid ${pid} remained alive`);
}

test("failed supervisor startup is cleaned up and retry succeeds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dc-supervisor-startup-"));
  let healthySupervisorPid = 0;
  t.after(async () => {
    if (healthySupervisorPid > 1) {
      try { process.kill(-healthySupervisorPid, "SIGTERM"); } catch {}
      await waitDead(healthySupervisorPid);
    }
    await rm(root, { recursive: true, force: true });
  });
  const state = join(root, "state"), docs = join(root, "docs"), project = join(root, "project");
  const sock = join(root, "supervisor.sock"), marker = join(root, "healthy"), pidFile = join(root, "broken.pid");
  const fixture = join(root, "fixture.py");
  const real = new URL("../runner-supervisor.py", import.meta.url).pathname;
  await mkdir(project, { recursive: true });
  await writeFile(fixture, `#!/usr/bin/env python3
import os,socket,sys,time
marker=${JSON.stringify("/MARKER/")}
pidfile=${JSON.stringify("/PIDFILE/")}
real=${JSON.stringify("/REAL/")}
args=sys.argv[1:]; cmd=args[-1] if args else ""
if os.path.exists(marker): os.execv(sys.executable,[sys.executable,real,*args])
if cmd=="ping": raise SystemExit(1)
if cmd=="serve":
 p=args[args.index("--socket")+1]
 try: os.unlink(p)
 except FileNotFoundError: pass
 s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.bind(p)
 open(pidfile,"w").write(str(os.getpid()))
 while True: time.sleep(1)
raise SystemExit(1)
`.replace("/MARKER/", marker).replace("/PIDFILE/", pidFile).replace("/REAL/", real));
  await chmod(fixture, 0o755);

  Object.assign(process.env, {
    DEVELOPMENT_CYCLE_STATE_ROOT: state,
    DEVELOPMENT_CYCLE_PROJECT_DOCS_ROOT: docs,
    DEVELOPMENT_CYCLE_NOTIFICATIONS_ENABLED: "false",
    DEVELOPMENT_CYCLE_OBSERVER_ENABLED: "false",
    DEVELOPMENT_CYCLE_IMPLEMENTATION_COMMAND: "/bin/true",
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_PATH: fixture,
    DEVELOPMENT_CYCLE_RUNNER_SUPERVISOR_SOCKET: sock,
  });
  const { default: plugin } = await import(`../dist/index.js?startup=${Date.now()}`);
  let tool;
  plugin.register({ pluginConfig: {}, registerTool(v) { tool = v; } });

  const req = await tool.execute("request", { action: "request_plan", project: "fixture", projectRoot: project, projectWikiPath: join(docs, "fixture") });
  const runId = req.details.runId;
  const planText = "# Plan\n\n## Project paths\n\nprojectWikiPath: docs\nprojectRoot: project\nrelevant code paths: none\nvalidation checks: process proof\nstop conditions: startup failure\nexpected artifacts: process proof\n";
  await tool.execute("record", { action: "record_plan", project: "fixture", runId, projectRoot: project, projectWikiPath: join(docs, "fixture"), planText, force: true });

  await assert.rejects(() => tool.execute("fail", { action: "start_implementation", project: "fixture", runId, projectRoot: project }), /runner_supervisor_start_failed/);
  const brokenPid = Number((await readFile(pidFile, "utf8")).trim());
  await waitDead(brokenPid);
  const deadPing = spawnSync("python3", [real, "--socket", sock, "ping"], { encoding: "utf8", timeout: 1000 });
  assert.notEqual(deadPing.status, 0);

  await writeFile(marker, "healthy\n");
  const retry = await tool.execute("retry", { action: "start_implementation", project: "fixture", runId, projectRoot: project });
  assert.equal(retry.details.ok, true);
  const livePing = spawnSync("python3", [real, "--socket", sock, "ping"], { encoding: "utf8", timeout: 2000 });
  assert.equal(livePing.status, 0, livePing.stderr || livePing.stdout);
  const live = JSON.parse(livePing.stdout);
  assert.equal(live.ok, true);
  healthySupervisorPid = Number(live.pid);
});
