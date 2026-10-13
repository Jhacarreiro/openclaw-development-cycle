import { gunzipSync } from "node:zlib";
import { parseFinalDecision, type FinalDecision } from "../core/decisions.js";
import { checkActionTransition } from "../core/state-machine.js";
import { isRecord, MAX_SOURCE_BYTES, ReadonlyState, type ReadResult, type UnavailableReason } from "./files.js";

export type { UnavailableReason } from "./files.js";

export interface RunRecord {
  project: string;
  runId: string;
  path: string;
  status: "readable" | "unreadable";
  phase: string | null;
  terminal: boolean | null;
  lifecycle: Lifecycle | null;
  finalDecision: FinalDecision | null;
  implementationAdapter: string | null;
  failureClass: string | null;
  interventionCount: number | null;
  correctionRounds: number | null;
  councilCorrectionRounds: number | null;
  automaticRecoveryCount: number | null;
  automaticRecoveryEvents: number | null;
  deliveryOutcome: string | null;
  deliveryOk: boolean | null;
  deliverySkipped: boolean | null;
  deliveryLocalOnly: boolean | null;
  deliveryMerged: boolean | null;
  prUrl: string | null;
  prState: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  attemptCreatedAt: string | null;
  attemptEndedAt: string | null;
  attemptDurationMs: number | null;
  planPath: string | null;
  acceptanceChecks: null;
  solutionValue: null;
  cost: null;
  unavailable: Partial<Record<RunField, UnavailableReason>>;
}
export type Lifecycle = "closed" | "awaiting_close" | "awaiting_operator" | "active";
type RunField = Exclude<keyof RunRecord, "project" | "runId" | "path" | "status" | "unavailable">;
export interface RunProject {
  project: string;
  runs: RunRecord[];
  unavailable?: { runs: UnavailableReason };
}
export interface RunIndex {
  schemaVersion: 1;
  projects: RunProject[];
  unavailable?: { projects: UnavailableReason };
}

const knownPhases = new Set([
  "closed", "merged", "closed_success", "closed_partial", "closed_invalid", "stopped",
  "implementation_failed", "review_infrastructure_failed", "corrections_failed", "repository_delivery_failed",
  "final_validated", "final_revised", "council_validated", "council_review_failed", "external_validation_failed", "external_validation_stopped",
  "waiting_external_plan", "plan_ready_for_implementation", "implementation_launched", "implementation_running",
  "implementation_delivered", "implementation_waiting_human", "corrections_launched", "corrections_running",
  "corrections_completed", "external_validation_passed", "external_validation_needs_revision",
  "waiting_final_validation", "needs_corrections", "council_review_needs_corrections", "council_review_waiting_human", "delivery_published",
]);

// Derived from the state machine so the reader cannot drift from the transitions it reports on.
function lifecycleOf(phase: string): Lifecycle {
  if (phase === "closed") return "closed";
  if (checkActionTransition("close", phase).ok) return "awaiting_close";
  if (checkActionTransition("finalize_delivery", phase).ok || checkActionTransition("resume_finalization", phase).ok) return "awaiting_operator";
  return "active";
}

const fields: RunField[] = [
  "phase", "terminal", "lifecycle", "finalDecision", "implementationAdapter", "failureClass", "interventionCount", "correctionRounds",
  "councilCorrectionRounds", "automaticRecoveryCount", "automaticRecoveryEvents", "deliveryOutcome",
  "deliveryOk", "deliverySkipped", "deliveryLocalOnly", "deliveryMerged", "prUrl", "prState",
  "createdAt", "updatedAt", "startedAt", "endedAt", "durationMs", "attemptCreatedAt", "attemptEndedAt", "attemptDurationMs",
  "planPath", "acceptanceChecks", "solutionValue", "cost",
];

function emptyRun(project: string, runId: string): RunRecord {
  return {
    project, runId, path: `runs/${project}/${runId}`, status: "readable",
    ...Object.fromEntries(fields.map(field => [field, null])),
    unavailable: Object.fromEntries(fields.map(field => [field, "not_recorded"])),
  } as RunRecord;
}

function setField<K extends RunField>(run: RunRecord, key: K, value: RunRecord[K] | null, reason: UnavailableReason = "not_recorded") {
  run[key] = value as RunRecord[K];
  if (value === null) run.unavailable[key] = reason;
  else delete run.unavailable[key];
}
function scalar(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}
function timestamp(value: unknown): value is string {
  if (!scalar(value)) return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-](\d\d):(\d\d))$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const y = Number(year);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(month) - 1] ?? 0;
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days &&
    Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60 &&
    Number(offsetHour ?? 0) < 24 && Number(offsetMinute ?? 0) < 60 && Number.isFinite(Date.parse(value));
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function recorded<K extends RunField>(run: RunRecord, key: K, value: unknown, valid: (v: unknown) => boolean) {
  setField(run, key, valid(value) ? value as RunRecord[K] : null, value == null ? "not_recorded" : "unreadable");
}
function duration(run: RunRecord, key: "durationMs" | "attemptDurationMs", start: string | null, end: string | null, reason: UnavailableReason = "not_recorded") {
  if (!start || !end) return setField(run, key, null, reason);
  const elapsed = Date.parse(end) - Date.parse(start);
  setField(run, key, elapsed >= 0 ? elapsed : null, "unreadable");
}

async function recoveryEvents(state: ReadonlyState, path: string, total: number | null): Promise<ReadResult<number>> {
  const live = await state.read(`${path}/automatic_recovery_events.jsonl`);
  if (live.reason === "unreadable") return { value: null, reason: "unreadable" };
  const directory = `${path}/event-archives/automatic_recovery_events.jsonl`;
  const archives = await state.list(directory);
  if (archives.reason === "unreadable") return { value: null, reason: "unreadable" };
  const names = (archives.value ?? []).filter(name => /^\d{4}-.*\.jsonl(?:\.gz)?$/.test(name));
  // A completed gzip and its original can coexist after a crash; count the rotation once.
  const selected = names.filter(name => !name.endsWith(".jsonl") || !names.includes(`${name}.gz`));
  let observed = 0;
  let available = Boolean(live.value) || selected.length > 0;
  for (const name of [null, ...selected]) {
    const source = name === null ? live : await state.read(`${directory}/${name}`);
    if (!source.value) {
      if (source.reason === "unreadable" || name !== null) return { value: null, reason: "unreadable" };
      continue;
    }
    available = true;
    try {
      const bytes = name?.endsWith(".gz") ? gunzipSync(source.value, { maxOutputLength: MAX_SOURCE_BYTES }) : source.value;
      for (const line of bytes.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const event: unknown = JSON.parse(line);
        if (!isRecord(event) || !count(event.recoveryCount) || !timestamp(event.detectedAt)) return { value: null, reason: "unreadable" };
        observed++;
      }
    } catch { return { value: null, reason: "unreadable" }; }
  }
  if (total !== null && total > observed) return { value: null, reason: "pruned" };
  // A recorded zero total with no event log is a known zero, not missing history.
  if (!available) return total === 0 ? { value: 0 } : { value: null, reason: "not_recorded" };
  return { value: observed };
}

async function readRun(state: ReadonlyState, project: string, runId: string): Promise<RunRecord> {
  const run = emptyRun(project, runId);
  const loaded = await state.json(`${run.path}/status.json`);
  if (!loaded.value) {
    run.status = "unreadable";
    for (const field of fields) run.unavailable[field] = "unreadable";
    return run;
  }
  const status = loaded.value;
  recorded(run, "phase", status.phase, scalar);
  if (run.phase && knownPhases.has(run.phase)) {
    const lifecycle = lifecycleOf(run.phase);
    setField(run, "lifecycle", lifecycle);
    setField(run, "terminal", lifecycle === "closed" || lifecycle === "awaiting_close");
  } else for (const field of ["lifecycle", "terminal"] as const) setField(run, field, null, run.phase ? "unreadable" : run.unavailable.phase);
  recorded(run, "implementationAdapter", status.implementationAdapter, scalar);
  recorded(run, "failureClass", status.failureClass, scalar);
  recorded(run, "councilCorrectionRounds", status.councilCorrectionCount, count);
  recorded(run, "automaticRecoveryCount", status.automaticPlannerRecoveryCount, count);
  for (const field of ["createdAt", "updatedAt", "startedAt"] as const) recorded(run, field, status[field], timestamp);
  recorded(run, "interventionCount", status.interventionAnswerCount, count);
  recorded(run, "correctionRounds", status.correctionRoundCount, count);
  if (run.phase === "closed") recorded(run, "endedAt", status.closedAt, timestamp);
  else if (run.phase === "stopped") recorded(run, "endedAt", status.stoppedAt, timestamp);
  duration(run, "durationMs", run.startedAt, run.endedAt,
    run.unavailable.startedAt === "unreadable" || run.unavailable.endedAt === "unreadable" ? "unreadable" : "not_recorded");

  const decision = await state.read(`${run.path}/final_validation_response.md`);
  if (decision.value) {
    const parsed = parseFinalDecision(decision.value.toString("utf8"));
    setField(run, "finalDecision", parsed.ok ? parsed.decision : null, "unreadable");
  } else setField(run, "finalDecision", null, status.finalValidation && decision.reason === "not_recorded" ? "unreadable" : decision.reason);

  const events = await recoveryEvents(state, run.path, run.automaticRecoveryCount);
  setField(run, "automaticRecoveryEvents", events.value, events.reason);

  const deliveryFile = await state.json(`${run.path}/repository_delivery.json`);
  const delivery: ReadResult<Record<string, unknown>> = deliveryFile.reason === "not_recorded" && status.repositoryDelivery != null
    ? isRecord(status.repositoryDelivery) ? { value: status.repositoryDelivery } : { value: null, reason: "unreadable" }
    : deliveryFile;
  if (delivery.value) {
    recorded(run, "deliveryOutcome", delivery.value.classification, value => typeof value === "string" && ["success", "partial", "invalid"].includes(value));
    for (const [field, source] of [["deliveryOk", "ok"], ["deliverySkipped", "skipped"], ["deliveryLocalOnly", "localOnly"], ["deliveryMerged", "merged"]] as const) {
      recorded(run, field, delivery.value[source], value => typeof value === "boolean");
    }
    const pullRequest = delivery.value.pullRequest;
    const invalidPr = pullRequest != null && !isRecord(pullRequest);
    recorded(run, "prState", isRecord(pullRequest) ? pullRequest.state : undefined, scalar);
    const url = isRecord(pullRequest) ? pullRequest.url : undefined;
    recorded(run, "prUrl", url, value => {
      if (typeof value !== "string" || /[\x00-\x20\x7f]/.test(value)) return false;
      try { const parsed = new URL(value); return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password; }
      catch { return false; }
    });
    if (invalidPr) for (const field of ["prUrl", "prState"] as const) setField(run, field, null, "unreadable");
  } else {
    for (const field of ["deliveryOutcome", "deliveryOk", "deliverySkipped", "deliveryLocalOnly", "deliveryMerged", "prUrl", "prState"] as const) setField(run, field, null, delivery.reason);
  }

  if (status.plan != null) {
    const plan = typeof status.plan === "string" ? state.pointer(status.plan) : null;
    const checked = plan ? await state.inspect(plan, "file") : null;
    setField(run, "planPath", checked?.value ? plan : null, "unreadable");
  }
  // start_implementation clears the corrections pointer, so a recorded one is the latest attempt.
  const attemptPointer = status.directCorrectionsStatus ?? status.directImplementationStatus;
  if (attemptPointer != null) {
    const path = typeof attemptPointer === "string" ? state.pointer(attemptPointer) : null;
    const attempt = path ? await state.json(path) : null;
    if (attempt?.value) {
      recorded(run, "attemptCreatedAt", attempt.value.createdAt, timestamp);
      recorded(run, "attemptEndedAt", attempt.value.stoppedAt ?? attempt.value.exitedAt, timestamp);
      duration(run, "attemptDurationMs", run.attemptCreatedAt, run.attemptEndedAt,
        run.unavailable.attemptCreatedAt === "unreadable" || run.unavailable.attemptEndedAt === "unreadable" ? "unreadable" : "not_recorded");
    } else for (const field of ["attemptCreatedAt", "attemptEndedAt", "attemptDurationMs"] as const) setField(run, field, null, "unreadable");
  }
  return run;
}

/** Index existing records; never imports or invokes the plugin or runtime coordinator. */
export async function readRunIndex(stateRoot: string, options: { project?: string } = {}): Promise<RunIndex> {
  const index: RunIndex = { schemaVersion: 1, projects: [] };
  const root = await ReadonlyState.create(stateRoot);
  if (!root.value) return { ...index, unavailable: { projects: "unreadable" } };
  const state = root.value;
  const projects = await state.list("runs");
  if (!projects.value) return { ...index, unavailable: { projects: projects.reason } };
  for (const project of projects.value) {
    if (project === ".git" || (options.project !== undefined && options.project !== project)) continue;
    if (!(await state.inspect(`runs/${project}`, "directory")).value) continue;
    const group: RunProject = { project, runs: [] };
    const runs = await state.list(`runs/${project}`);
    if (!runs.value) group.unavailable = { runs: "unreadable" };
    else for (const runId of runs.value) {
      if (runId === ".git" || !(await state.inspect(`runs/${project}/${runId}`, "directory")).value) continue;
      // A missing status excludes a directory; an existing unreadable regular file stays visible.
      const status = await state.inspect(`runs/${project}/${runId}/status.json`, "file");
      if (!status.value) continue;
      group.runs.push(await readRun(state, project, runId));
    }
    group.runs.sort((a, b) => {
      const first = a.createdAt ?? a.updatedAt;
      const second = b.createdAt ?? b.updatedAt;
      if (first && second) return Date.parse(first) - Date.parse(second) || compare(a.runId, b.runId);
      if (first) return -1;
      if (second) return 1;
      return compare(a.runId, b.runId);
    });
    index.projects.push(group);
  }
  return index;
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Columns are the baseline's per-run record fields, with project identity added. */
export function formatRunIndexMarkdown(index: RunIndex): string {
  const columns = ["project", "run id, adapter, plan path", "terminal phase", "final decision", "acceptance checks", "solution value", "failure class", "interventions and corrections", "automatic recoveries", "duration and cost"];
  const lines = [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`];
  const escape = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "&#124;").replace(/[\r\n]/g, " ");
  for (const project of index.projects) for (const run of project.runs) {
    const cell = (field: RunField) => run[field] === null ? `unavailable (${run.unavailable[field]})` : escape(run[field]);
    const values = [escape(run.project), `${escape(run.runId)}; ${cell("implementationAdapter")}; ${cell("planPath")}`,
      `${cell("phase")}; ${cell("lifecycle")}`, cell("finalDecision"), cell("acceptanceChecks"), cell("solutionValue"), cell("failureClass"),
      `interventions: ${cell("interventionCount")}; corrections: ${cell("correctionRounds")}; council: ${cell("councilCorrectionRounds")}`,
      cell("automaticRecoveryEvents"), `duration ms: ${cell("durationMs")}; cost: ${cell("cost")}`];
    lines.push(`| ${values.join(" | ")} |`);
  }
  if (index.unavailable) lines.push("", `Listing unavailable (${index.unavailable.projects}).`);
  for (const project of index.projects) if (project.unavailable) lines.push("", `${escape(project.project)} listing unavailable (${project.unavailable.runs}).`);
  return lines.join("\n") + "\n";
}
