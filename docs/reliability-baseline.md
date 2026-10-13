# Reliability baseline

**Status:** proposed criterion; no baseline runs recorded yet.

The control plane is useful only if a linear cycle reliably reaches a recorded decision. This page defines how to measure that on a fixed task, so changes to the control plane or an adapter can be compared against the same reference.

## Baseline task requirements

- Public and synthetic: no private project, runtime state or operator-specific data.
- Offline and deterministic: no network services, paid APIs or real-world outcomes needed to judge the result.
- Behavioral acceptance checks written and committed **before** any run, and never edited by the run.
- Small enough to finish in one implementation attempt, with a few real design choices.
- Executed through the normal `development_cycle` flow (`record_plan`, `start_implementation`, `reconcile`, `run_final_validation`, `request_final_validation`, `record_final_validation`, then `finalize_delivery` when repository delivery is disabled, and `close`), never by launching the adapter directly.

## Per-run record

Record one entry per run:

| Field | Source |
| --- | --- |
| run id, adapter, plan path | run `status.json` |
| terminal phase | `status.json` (`closed`, `merged`, `stopped`, `implementation_failed`, `review_infrastructure_failed`, …) |
| final decision | `go`, `revise` or `stop` from `record_final_validation` |
| acceptance checks | pass or fail of the pre-written checks, run outside the cycle |
| failure class | none, implementation, runner/supervisor, review infrastructure, validation, delivery |
| interventions and corrections | count of `answer_intervention` and correction rounds |
| automatic recoveries | count from `automatic_recovery_events.jsonl` |
| duration and cost | wall-clock from launch to close; model/token cost when the adapter reports it |

## Proposed criterion

The linear cycle counts as stable for a given adapter when **three consecutive runs** of the same baseline task:

- reach `go` with the pre-written acceptance checks passing;
- have no runner/supervisor or review-infrastructure failure;
- need no manual state repair.

A run that ends in `revise` or `stop` for a reason in the task itself is a valid outcome, not a reliability failure, but it does not count toward the three. The numbers are a starting point to be adjusted once real runs exist.

## Where results go

Keep run records with the operator's private documentation unless they are sanitized. Publish only aggregated, sanitized results here.
