# Handoff — Optional Security Track in `development_cycle`, backed by Octopus

Status: design handoff only; not implemented  
Date: 2026-09-02  
Control-plane repository: `/data/workspace/plugins/development-cycle`  
Octopus reference checkout: `/data/workspace/contrib/claude-octopus`

## Goal

Add an **optional, independent security-audit track** to the same OpenClaw tool `development_cycle`.

It must be callable without plan, implementation, final validation, repository delivery or deploy. It must not automatically block deploy or launch remediation in v1.

```text
development_cycle
  |-- implementation lifecycle  (existing)
  |-- deploy track              (separate handoff)
  `-- security track            (new, optional)
```

The desired behavior is:

> Run a read-only security review of real project code/diff using Octopus as the review backend, persist evidence/report, then record an explicit security verdict.

## Critical current-state finding

Do **not** implement this by calling the current `octopus_security target=/repo`.

Current OpenClaw Octopus behavior is:

```text
octopus_security
  -> executeOrchestrate("squeeze", target)
```

Current `squeeze_test()` explicitly tells agents:

```text
Do NOT read, explore, or modify any files.
Do NOT run any shell commands.
```

It asks Blue Team to generate code from a prompt, then Red Team attacks that generated code. That is useful adversarial design, but it is **not a repository security audit**.

## Existing Octopus capability closest to V1

Octopus enhanced code review already reviews real code and supports a security focus:

```text
orchestrate.sh code-review '<profile-json>'
```

Relevant profile shape:

```json
{
  "target": "staged | working-tree | PR# | path",
  "focus": ["security"],
  "provenance": "unknown",
  "autonomy": "autonomous",
  "publish": "never",
  "debate": "auto",
  "history": "fresh"
}
```

That workflow documents OWASP/auth/data-exposure review, CVE lookup, multi-provider verification and proof-packet output.

### Recommended V1 backend

Use Octopus **code-review with security-only focus**, launched by a security adapter owned by `development-cycle` and supervised by the development-cycle runner.

Do not patch the detached/upstream Octopus checkout for V1.

If richer first-class security-review support is later required in Octopus, implement it on an explicit upstream PR branch. Never carry a local operational patch in the upstream checkout.

## Separate track storage

Security state must not change normal development `status.phase` and must not change deploy state.

Suggested root:

```text
<state-root>/tracks/security/<project>/<securityId>/
```

Optional metadata links:

```text
sourceRunId
sourceDeployId
```

Neither is required.

## V1 public actions

Add to the **same** `development_cycle` tool:

```text
security_prepare
security_run
security_status
security_record_verdict
```

Optional only if easy and bounded:

```text
security_stop
```

## `security_prepare`

Inputs:

```text
project
projectRoot
securityId?          # create if absent
target?              # working-tree/staged/PR/path per adapter semantics
sourceRef?
baseRef?
headRef?
sourceRunId?
sourceDeployId?
securityBrief?
securityBriefPath?
securityAdapter?
```

Responsibilities:

- validate/pin trusted Git checkout;
- resolve exact source commit and diff refs when relevant;
- preserve dirty/clean state evidence;
- create independent security track;
- generate a default security brief;
- select adapter;
- perform no audit yet and no source mutation.

Do not silently broaden a requested path/diff audit to the whole repository.

## `security_run`

Launch the configured security adapter through the existing supervised runner pattern.

For Octopus V1, enforce a profile equivalent to:

```text
focus=[security]
publish=never
non-interactive/headless-safe autonomy
```

Persist raw output and normalized report references.

Important distinctions:

- adapter exit `0` means review execution completed;
- it does **not** mean security `pass`;
- backend/model failure means track `failed`, never `pass`.

## `security_status`

Read-only. Return at least:

```text
securityId
status
target
source/base/head commit evidence
adapter/runtime state
reportPath
proof references
finding counts by severity, when available
suggestedVerdict
recordedVerdict
files
nextAction
```

## `security_record_verdict`

Record one explicit verdict after report review.

Allowed tokens:

```text
pass
pass_with_findings
fail
```

Suggested input:

```text
securityVerdictText="pass_with_findings\nNo release blockers; two medium hardening findings accepted."
```

Persist exact rationale. Do not trigger deploy, corrections or issue creation in V1.

## Security track states

Keep independent from the implementation state machine:

```text
prepared
running
completed
failed
stopped
verdict_recorded
```

Suggested report metadata:

```text
suggestedVerdict: pass | pass_with_findings | fail | null
recordedVerdict:  pass | pass_with_findings | fail | null
```

A completed report without an explicit recorded verdict remains `completed`, not `pass`.

## Durable artifacts

Suggested layout:

```text
tracks/security/<project>/<securityId>/
  security_status.json
  security_request.json
  security_context.md
  security_brief.md
  octopus_profile.json
  report/
    raw_output.log
    security_report.md
    findings.json          # optional normalized artifact
    proof.json             # references/index only
  attempts/<attemptId>/
    request.json
    status.json
    heartbeat.json
    logs/
    exit-code.txt
  security_verdict.md
  security_verdict.json
```

Never copy secrets or protected credential/state files wholesale into these artifacts.

## Default security brief

Generate a default brief even when the caller provides none.

Recommended core instruction:

```text
Review this real application as a production security auditor.
Do not modify the repository.
Prioritize exploitable vulnerabilities and broken trust boundaries.

For every finding provide:
- severity;
- CWE/CVE when relevant;
- affected file/function/endpoint;
- attack preconditions;
- concrete exploit path;
- impact;
- confidence;
- minimum remediation;
- whether it is a release blocker.

Separate explicitly:
- confirmed vulnerabilities;
- likely vulnerabilities requiring verification;
- defence-in-depth recommendations;
- controls verified as safe.

End with suggested verdict:
pass | pass_with_findings | fail
```

Project-specific `securityBrief` may append threat-model areas but must never contain credentials.

## Important Octopus brief limitation

The existing Octopus code-review profile has no first-class `briefPath` field.

Do not fake this by writing temporary review files into the target repo unless that mechanism is explicitly designed and proven safe.

For V1 choose and document one of:

1. use existing security-focused code-review and keep `security_brief.md` as development-cycle operator context/evidence; or
2. use a small **owned wrapper** around Octopus that can safely compose supported context without modifying the checkout.

If Octopus itself needs a richer prompt contract, defer that to an upstream PR branch.

## Adapter configuration

Keep separate from implementation adapter config:

```text
DEVELOPMENT_CYCLE_SECURITY_ENABLED=false
DEVELOPMENT_CYCLE_SECURITY_ADAPTER=octopus
DEVELOPMENT_CYCLE_SECURITY_TIMEOUT_SECONDS=<bounded value>
DEVELOPMENT_CYCLE_SECURITY_OCTOPUS_ROOT=/path/to/claude-octopus
DEVELOPMENT_CYCLE_SECURITY_OCTOPUS_SANDBOX=read-only
```

Optional generic command backend:

```text
DEVELOPMENT_CYCLE_SECURITY_ADAPTER=command
DEVELOPMENT_CYCLE_SECURITY_COMMAND=/absolute/path/to/security-runner
DEVELOPMENT_CYCLE_SECURITY_ARGS_JSON=[]
```

Do not overload `DEVELOPMENT_CYCLE_IMPLEMENTATION_ADAPTER`.

Suggested generic request:

```json
{
  "schemaVersion": 1,
  "track": "security",
  "project": "example",
  "securityId": "...",
  "projectRoot": "/repo",
  "target": "working-tree",
  "sourceCommit": "<exact sha>",
  "baseCommit": "",
  "headCommit": "",
  "securityBriefPath": "/state/.../security_brief.md",
  "resultsRoot": "/state/tracks/security/...",
  "timeoutSeconds": 1800,
  "command": "audit"
}
```

## Read-only and safety requirements

- Feature disabled by default.
- Do not modify audited checkout.
- Force Octopus `publish=never`.
- No automatic PR comments/issues.
- No active exploitation against production hosts.
- No secret printing/persistence.
- Do not ingest protected auth/state files wholesale.
- Normal CVE/code-review research is acceptable; uncontrolled network scanning is not.
- Run through supervisor, not foreground provider calls.
- Immutable attempt directories.
- Security findings never auto-trigger code changes in V1.

## V1 non-goals

Do not implement:

- automatic run after implementation;
- automatic run before deploy;
- automatic deploy blocking;
- remediation/correction loops;
- DAST/public-host scanning;
- secret rotation;
- PR publishing;
- second OpenClaw tool;
- semantic repurposing of `squeeze` without an explicit Octopus redesign.

## Shopping Assistant as first real fixture

Use as an integration fixture only; do not hard-code policy.

Useful brief areas:

- owner/member authorization;
- cross-household BOLA/IDOR;
- invite entropy/expiry/replay/email binding;
- member `scrypt` credential storage and brute-force exposure;
- session fixation/hijacking/revocation;
- CSRF;
- XSS from product/retailer/user metadata;
- retailer-profile isolation;
- retailer secret/token leakage;
- Cloudflare Access vs app-auth boundary;
- checkout redirects;
- container/nginx/API exposure;
- secret/build-artifact leakage;
- login/invite/join rate limiting.

The audit should try to **prove** privilege escalation/cross-household access, not merely confirm that authorization checks exist.

## Tests required

At minimum prove:

1. security actions never change normal cycle `status.phase`;
2. security can run without development `runId`;
3. feature disabled by default;
4. exact target/source evidence persisted;
5. security adapter is supervised with immutable attempts;
6. target checkout is not modified by the adapter path;
7. Octopus profile forces security focus and `publish=never`;
8. repository audit does not invoke current `squeeze`;
9. exit `0` never auto-records `pass`;
10. verdict parser accepts only the three tokens;
11. failed review cannot become implicit pass;
12. status is read-only;
13. existing public-leak and development-cycle tests remain green.

Run:

```bash
npm run check
```

## Documentation after implementation

Update `README.md`, `docs/architecture.md`, `docs/adapters.md`, `docs/configuration.md`, `CHANGELOG.md`, then Gallivanter wiki state pages only after the feature is live.

## Acceptance criteria

- Still one OpenClaw tool: `development_cycle`.
- Security is optional and independently invocable.
- Security state is durable and separate from implementation/deploy state.
- Real code/diff is reviewed read-only.
- Octopus is the backend, but current `squeeze` is not misused as repo audit.
- No PR/source mutation or automatic remediation.
- Raw report/evidence is durable.
- Explicit `pass | pass_with_findings | fail` is separate from backend success.
- No automatic deploy gate or complete flow is introduced.
