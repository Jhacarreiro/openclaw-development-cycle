# Execution budgets, checkpoints and continuation

Status: design proposal. Execution-limit classification is implemented by the
operational-failure contract in this branch. Proactive budget monitoring,
cooperative yielding and the checkpoint controller below are not implemented
by that classification. Partial preservation and same-PR follow-ups are tracked
separately in PR #102; latest-run selection is tracked in PR #103. All require
their own review, tests and installation before operational claims.

## Intended behavior

A turn ceiling or continuation ceiling ends an operation, not the value of the
work already produced. Preserve that work, state what remains, and give a later
authorized execution fresh conversation capacity while retaining the code,
task identities and acceptance context. A partial checkpoint is not a successful
delivery and never bypasses independent review or authorizes merging.

Do not make larger turn ceilings the default remedy. First reduce the unit of
work, checkpoint completed milestones and distinguish coding from verification.
A verifier exhausting its allowance should leave a verification task; it should
not restart already completed implementation or turn candidates into confirmed
bugs. Use an unverified-candidate inventory and one unfinished-verification issue.

## Ownership

| Layer | Responsibility |
| --- | --- |
| CLI/provider adapter, including Octopus | Expose native failure identity and, where supported, budget unit, configured maximum, consumed amount, remaining amount and a cooperative checkpoint capability |
| Development Cycle | Track task/criterion progress, enforce the approved total policy, serialize checkpoint publication, maintain the draft PR/issues and prepare a stage-specific continuation |
| Repository workflow | Validate the exact checkpoint, enforce ordinary review and merge gates, and retain source/data recovery evidence |

CLI event bytes are liveness evidence, not a turn count. Turn, continuation,
context-token, time and financial allowances are separate units. Unknown counters
remain unknown. A provider exit number is scoped to its provider/version, not a
global error taxonomy. A financial incident needs attributable account evidence.

## Proposed soft boundary

Where trustworthy counters and a cooperative checkpoint operation exist, begin
finishing the current unit at a configurable soft threshold. An initial trial
could reserve the last 20% of a known allowance for finishing, validation and
handoff; this is a proposed calibration value, not a configured runtime default.
Bound the reserve by usable remaining turns/time as well as percentages.

The parent stops admitting new tasks to that worker, requests a checkpoint using
the provider's supported interface and keeps observing existing work. A prompt
asking the model to remember to stop is insufficient enforcement. If the CLI
cannot expose a counter or accept a checkpoint request, do not claim automatic
near-limit handling: use smaller tasks and host-owned milestone checkpoints.

Never rely on a last-minute handoff as the only recovery path. A hard limit,
crash, cancellation or unavailable response can arrive before the soft boundary.
Retain durable checkpoints at verified milestones, even during a healthy run.

## Checkpoint protocol

1. Retain ownership of the current worktree; drain or pause every writer to that
   checkout and verify process identity before capturing or committing it. Other
   workers may continue only in independent checkouts/scopes. Do not commit while
   an orphaned or delayed provider is still editing the snapshot.
2. Inspect the actual filesystem and Git ancestry. Record task and acceptance
   IDs, source revision, current revision, tracked/untracked inventory and hashes,
   checks run and not run, data/config versions, review completeness and external
   operations whose outcome is unknown. Worker prose is supporting evidence,
   not proof of completion or publication.
3. Preserve a coherent snapshot locally first. Before pushing, re-read the open
   PR and remote branch. Use the same draft PR, fast-forward-only, with normal
   sensitive-path controls. Failing or unfinished checks remain explicit; they
   do not justify discarding otherwise preservable source. Never auto-merge a
   partial checkpoint.
4. Create or update issues for residual acceptance criteria. Reuse existing task
   identities and issue mappings rather than creating one PR per session or one
   duplicate issue per retry. Unknown product correctness remains unfinished
   validation. A failure after push/issue submission requires remote readback
   before repeating the mutation.
5. Persist a checkpoint receipt only after verifying repository/PR identity,
   commit and issue results. Keep capture, publication and acceptance distinct.
   A planned API call or timeout is not a confirmed remote checkpoint.

Early yielding should be a deliberate partial result, distinguishable from both
an operational failure and full completion. Its eventual state-machine action
must be designed and tested explicitly; no status-file edits, invented actions
or fabricated final-validation records should simulate that transition.

## Continuation policy

Re-read the PR head, local state and still-open issues. Hold on unexpected edits,
closed/merged PRs or unverifiable external effects. Form a small plan from the
remaining criteria and failed stage, with the original scope as acceptance
context. Reuse the same branch/PR; give the new execution an explicit lineage
and fresh, bounded allowance. For an eligible review-only recovery, resume that
stage against the preserved exact revision instead of rerunning coding.

Automatic continuation, when explicitly enabled by policy, must have a maximum
generation count and aggregate turn/time/cost limits across the entire lineage.
A fresh session does not reset those totals. Check substantive progress: task
acceptance, useful code, or new validation evidence, not new timestamps, log
bytes or commits alone. Repeated limits without substantive progress stop the
chain for task resizing or an operator decision. Manual stops and unresolved
authentication, financial, policy and verification blockers remain held.

Raising a limit can be an explicit bounded exception when a task is making
progress and needs room to finish. It should not hide repeated restarts or
replace decomposition, checkpoints and a total lineage budget. Model changes
are independent decisions.

## Required implementation validation

- Inject soft-limit and hard-limit events from a synthetic adapter, with known
  and unknown counters. Prove event bytes cannot trigger percentage thresholds.
- Interrupt before handoff and during publication. Recover the actual source;
  lost acknowledgements must not duplicate commits, PRs or issues.
- Keep a delayed writer alive and prove capture/publication waits for quiescence;
  check process identity and reject changed checkout/remote heads.
- Continue a checkpoint with completed and incomplete criteria. Preserve code
  and issue identities; do not repeat completed work or reset aggregate budgets.
- Exhaust a verifier while coding succeeds. Preserve candidates as unverified,
  keep the PR draft and permit only an eligible stage-specific recovery.
- Repeatedly exhaust without progress. Stop at the approved aggregate/generation
  bound; never raise limits, change models, merge or restart indefinitely.

Measure work lost after forced interruption, repeated completed tasks,
successful same-PR recovery and fraction of checkpoints with verified source,
checks and residual issues. A higher number of retries alone is not improvement.
