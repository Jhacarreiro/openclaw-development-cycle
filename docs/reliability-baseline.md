# Reliability baseline

**Status:** proposed criterion; no baseline runs recorded yet.

The control plane is useful only if a linear cycle reliably reaches a recorded decision. This page defines how to measure that on a fixed task, so changes to the control plane or an adapter can be compared against the same reference.

## Baseline task requirements

- A meaningful real task chosen by the user, with agreed scope, constraints and expected solution value. The task and repository may remain private.
- Comparable starting checkouts, inputs and budgets across runs; record external dependencies and runtime variability.
- Behavioral acceptance checks written and committed **before** any run, and never edited by the run.
- Executed through the normal `development_cycle` flow (`record_plan`, `start_implementation`, `reconcile`, `run_final_validation`, `request_final_validation`, `record_final_validation`, then `finalize_delivery` when repository delivery is disabled, and `close`), never by launching the adapter directly.

Synthetic fixtures remain useful for deterministic implementation tests, but they do not replace this real-task baseline. Keep private infrastructure, credentials and production state outside the public repository; sanitize any published evidence or examples.

## Per-run record

Record one entry per run:

| Field | Source |
| --- | --- |
| run id, adapter, plan path | run `status.json` |
| terminal phase | `status.json` (`closed`, `merged`, `stopped`, `implementation_failed`, `review_infrastructure_failed`, …) |
| final decision | `go`, `revise` or `stop` from `record_final_validation` |
| acceptance checks | pass or fail of the pre-written checks, run outside the cycle |
| solution value | observed usefulness for the user's actual problem, assessed against the agreed objective |
| failure class | none, implementation, runner/supervisor, review infrastructure, validation, delivery |
| interventions and corrections | count of `answer_intervention` and correction rounds |
| automatic recoveries | count from `automatic_recovery_events.jsonl` |
| duration and cost | wall-clock from launch to terminal outcome or close; model/token cost when the adapter reports it |

## Proposed criterion

The linear cycle counts as stable for a given adapter when **three consecutive runs** of the same baseline task:

- reach `go` with the pre-written acceptance checks passing;
- have no runner/supervisor or review-infrastructure failure;
- need no manual state repair.

A run that ends in `revise` or `stop` for a reason in the task itself is a valid outcome, not a reliability failure, but it does not count toward the three. The numbers are a starting point to be adjusted once real runs exist.

## Where results go

Keep run records with the operator's private documentation unless they are sanitized. Publish only aggregated, sanitized results here.
