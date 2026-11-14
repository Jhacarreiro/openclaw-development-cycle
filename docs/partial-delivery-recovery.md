# Partial delivery and continuation

A failed process does not establish that no implementation exists. Before
publishing a terminal Octopus attempt, the cycle inventories its exact attempt
manifest, linked repository, checked-out branch, captured source commit, current
commit and dirty/untracked work. A source checkout that advanced independently
does not turn a pristine attempt into progress. Missing, unrelated, mismatched
or pristine output is held with diagnostic evidence in `outputRecovery`.

When repository delivery is enabled, stopped, failed and review-infrastructure
attempts with verified progress can publish a **partial draft PR**. This verifies
artifact identity, not product correctness. The sensitive-path check covers both
dirty files and commits since the captured baseline. Active providers still
writing outside the observed tree block publication, including explicit
`finalize_delivery`. No clean, reset, forced push or automatic merge is part of
partial preservation. A previously queued auto-merge is disabled.

The draft links the remaining work through issues:

- Verified remaining review findings each become an issue, without a twelve-item
  cap. Long findings receive distinct stable titles.
- When concrete verified residue is unavailable, issues require comparing the
  branch against every approved acceptance criterion, completing missing scope,
  recording mechanical validation, and completing independent review as needed.
- An incomplete verifier result is unfinished validation. Its candidates are not
  published as confirmed product defects.
- The publisher records issue identities after each successful creation. A later
  operation can fail without the next publication duplicating those issues.

## What retry means

`start_followup` reads the PR and its issues again. Only still-open issues become
tasks, with their complete acceptance criteria. It checks that the preserved
checkout is clean and exactly matches the open PR head. It keeps the existing
implementation, uses the original approved plan as acceptance context, and
pushes new commits to the **same PR branch, fast-forward only**. It does not
assume that the interrupted run implemented the whole original plan.

Eligible failed implementations and review non-convergence can use the existing
automatic follow-up policy. `DEVELOPMENT_CYCLE_FOLLOWUP_AUTO_START=false` disables
it; `DEVELOPMENT_CYCLE_FOLLOWUP_MAX_GENERATIONS` bounds it (default two). Exhausting
the limit leaves the PR and issues visible for an operator decision.

| Condition | Continuation |
| --- | --- |
| Preserved progress and actionable unfinished work | Continue open issues on the same PR when policy allows |
| Manual stop | Preserve the draft; an explicit continuation is required |
| Authentication, quota, runtime or other policy blocker | Preserve progress; resolve the blocker before authorizing another attempt |
| Incomplete independent verification | Preserve the draft and validation issue; fix review infrastructure before continuation |
| PR head moved or checkout changed | Hold instead of overwriting someone else's work |

The dedicated `resume_finalization` path remains available for an eligible review
infrastructure failure after its partial PR is published. It revalidates the
same attempt, requires fresh mechanical validation and independent final review,
and retains the recovery audit. It does not relaunch implementation.

A continuation reaches successful delivery only through the normal fresh
validation and review gates. The runner then marks the draft ready; configured
successful-delivery merge policy applies. A partial PR never qualifies for
automatic merge merely because preserving it succeeded.
