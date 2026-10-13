# Read-only run reader

The reader indexes durable Development Cycle state without OpenClaw or the plugin. It uses Node built-ins and pure core helpers, makes no network requests, and never writes, locks, renames, repairs, or creates temporary files under the state root.

Build once, then run with Node.js:

```sh
npm run build
node bin/read-runs.mjs <state-root>
node bin/read-runs.mjs <state-root> --project synthetic-example --format markdown
```

JSON is the default format; `--format json` selects it explicitly. `--project` matches the exact project directory name. The library entry point is `dist/reader/index.js`:

```js
import { readRunIndex } from "./dist/reader/index.js";

const index = await readRunIndex(stateRoot, { project: "synthetic-example" });
```

## Discovery and output schema

Runs live at `runs/<project>/<runId>/status.json`. Only directories with a regular `status.json` are listed. Malformed or unreadable status produces an entry with `status: "unreadable"` and unavailable fields; it does not prevent other runs from being listed.

The JSON envelope is:

```json
{
  "schemaVersion": 1,
  "projects": [
    { "project": "synthetic-example", "runs": [] }
  ]
}
```

Projects are alphabetical. Runs use recorded `createdAt`, falling back to `updatedAt`, ascending; unknown times come last, with run ID breaking ties. Directory names and filesystem times never supply missing timestamps.

An unreadable root or `runs` adds envelope `unavailable: { "projects": "unreadable" }`; a failed project listing adds project `unavailable: { "runs": "unreadable" }`. These distinguish a failed listing from an empty index.

Each run has the following fields. Unavailable scalar values are `null`, with a matching entry in its `unavailable` map.

| Field | Value and source |
| --- | --- |
| `project`, `runId` | Project and run directory names. |
| `path` | Run directory path relative to the state root, using `/` separators. |
| `status` | Reader result: `readable` or `unreadable`. |
| `phase` | Recorded `status.json.phase`. |
| `terminal` | `true` only when the run is `closed` or awaits only `close` (`lifecycle` is `closed` or `awaiting_close`). |
| `lifecycle` | `closed`, `awaiting_close` (delivery materialized), `awaiting_operator` (a decision, stop or failure is recorded and `finalize_delivery` or `resume_finalization` is the next action), or `active`. Derived from the state machine's allowed transitions. |
| `finalDecision` | `go`, `revise`, or `stop`, parsed from `final_validation_response.md` with the existing `parseFinalDecision` helper. |
| `implementationAdapter` | Recorded `status.json.implementationAdapter`. |
| `failureClass` | `status.json.failureClass` verbatim; never derived from phase or logs. Absence does not establish success. |
| `interventionCount` | Recorded `status.json.interventionAnswerCount`: answered interventions. Runs created before this field existed leave it unavailable. |
| `correctionRounds` | Recorded `status.json.correctionRoundCount`: launched `start_corrections` rounds. Automatic council rounds are in `councilCorrectionRounds`. Older runs leave it unavailable. |
| `councilCorrectionRounds` | Recorded `status.json.councilCorrectionCount`; automatic council corrections only. |
| `automaticRecoveryCount` | Cumulative `status.json.automaticPlannerRecoveryCount` only; unavailable if absent. |
| `automaticRecoveryEvents` | Retained automatic recovery JSONL event count; `0` when the recorded total is `0` and no log exists; unavailable when the recorded total proves history is missing. |
| `deliveryOutcome` | Delivery `classification`: `success`, `partial`, or `invalid`. Source is `repository_delivery.json`, falling back to `status.repositoryDelivery` only if the file is absent. |
| `prUrl` | Delivery `pullRequest.url`. |
| `deliveryOk`, `deliverySkipped`, `deliveryLocalOnly`, `deliveryMerged`, `prState` | Delivery `ok`, `skipped`, `localOnly`, `merged`, and `pullRequest.state`; missing flags remain unavailable. |
| `createdAt`, `updatedAt` | Recorded run `status.json` timestamps. `createdAt` is written with the first status of runs created since run tracking was added; older runs leave it unavailable. |
| `startedAt` | Recorded run `status.json.startedAt`: the first implementation launch of a run that has `createdAt`. |
| `endedAt` | Recorded `status.json.closedAt` when the phase is `closed`, or `stoppedAt` when it is `stopped`. Other phases have no run endpoint yet. |
| `durationMs` | Difference between `startedAt` and `endedAt` when both are recorded. `updatedAt` is never an endpoint. |
| `attemptCreatedAt`, `attemptEndedAt`, `attemptDurationMs` | Latest attempt's `createdAt`, `stoppedAt` or `exitedAt`, and their difference, from contained `status.directCorrectionsStatus` when recorded, else `status.directImplementationStatus` (`start_implementation` clears the corrections pointer). These measure an attempt, not the cycle. |
| `planPath` | Recorded `status.json.plan`, returned only as a contained path relative to the state root. Plan contents are never returned. |
| `acceptanceChecks`, `solutionValue`, `cost` | Unavailable: no persisted external acceptance result, usefulness assessment, or run-level model/token cost. |
| `unavailable` | Object mapping unavailable field names to `not_recorded`, `unreadable`, or `pruned`. |

Markdown columns match the [baseline's per-run record](reliability-baseline.md#per-run-record): `run id, adapter, plan path`; `terminal phase`; `final decision`; `acceptance checks`; `solution value`; `failure class`; `interventions and corrections`; `automatic recoveries`; `duration and cost`, plus project. The terminal phase cell shows the phase and its `lifecycle`; the automatic recoveries cell shows `automaticRecoveryEvents`, the count from `automatic_recovery_events.jsonl`. Cells show unavailable reasons instead of inventing zero counts.

Unknown phases make `terminal` and `lifecycle` unavailable with `unreadable`. A run in `awaiting_operator` has a recorded outcome for measurement but is not terminal: it can still be finalized or resumed.

## Confirmed persistence mappings

[`updateStatus`](../src/storage/filesystem.ts) merges patches and stamps `updatedAt`; `status.previous.json` holds one previous snapshot, never used to reconstruct history. [`record_final_validation`](../src/index.ts) writes the response and maps `go → final_validated`, `revise → final_revised`, `stop → stopped`. Finalization can change phase; council corrections can overwrite the response with `revise`. The fixed response file is authoritative, never the phase alone.

[`Runner attempts`](../src/cycle/runner-session.ts) use `implementation_session/attempts/<attemptId>/status.json` and optional `intervention.json`; corrections use `corrections_session/attempts/<attemptId>/`. Contained older direct-session paths also work. [`Implementation reconciliation`](../src/cycle/implementation-status.ts) copies the latest request to `implementation_intervention.json`; `answer_intervention` overwrites `implementation_intervention_response.json`. Neither preserves a cumulative answer count. [`Council corrections`](../src/cycle/council.ts) record only automatic rounds; surviving requests or attempt directories cannot supply missing totals.

[`Recovery recording`](../src/index.ts) appends `detectedAt`, `failureClass`, `recoveryCount`, and attempt evidence. [`Event rotation`](../src/storage/event-log.ts) moves logs to `event-archives/automatic_recovery_events.jsonl/<timestamp>-<id>.jsonl.gz`; interrupted compression can leave `.jsonl`. Both archive forms and the live log are counted. Finite retention removes compressed archives without a pruning manifest, so retained events cannot establish a missing lifetime total.

[`Repository delivery`](../src/cycle/repository-delivery.ts) writes the result and inline mirror. Classification alone does not establish publication or merge: `success` can be local-only. Only classification, recorded flags and PR metadata are returned; request paths, findings, stdout, and stderr are excluded.

## Unavailable values and containment

- `not_recorded`: no field or optional source is recorded. A missing count is not zero.
- `unreadable`: malformed or inaccessible source, invalid value/decision, missing recorded target, or unsafe path. Malformed delivery is not repaired from its mirror.
- `pruned`: cumulative recovery evidence proves retained history is incomplete. This does not identify deletion provenance; absent files alone cannot prove pruning.

Symlinks at root, project, run, artifact, and archive levels are rejected; realpath containment is checked. Only regular files within the state root are read, including status pointers. Output paths are relative. Source bytes and decompressed gzip are capped at 32 MiB per file; excess is `unreadable`. Errors expose reasons, not private absolute paths or contents. No prompts, plan bodies, logs, stdout, or stderr are output.

Removed run directories cannot be recovered. Preserve history by redirecting JSON output to a file **outside** the state root before cleanup. The CLI does not save an index or change run formats.
