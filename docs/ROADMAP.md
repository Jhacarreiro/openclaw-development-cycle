# Decision Multiverse — research roadmap

**Status:** proposal; no feature implemented or results established. **Home:** experimental documentation in the Development Cycle project, not a claim about the existing product.

## Vision

Solutions, not software output, are the unit of value. AI agents execute; humans contribute context, imagination, taste, choices and accountability. A development run is one observed trajectory through a space of possible solutions. We want to expose its consequential decisions, understand alternatives, and eventually revisit a fork and compare real outcomes.

**No predetermined branches.** Neither the number of alternatives nor their labels/categories are fixed. They must arise from the actual decision, available context, feasibility and meaningful trade-offs. Zero alternatives is legitimate. Alternative branches are suggestions until executed and independently validated.

## Phase 0 — linear baseline (prerequisite)

Every later comparison is against linear execution, so the linear cycle must first finish reliably on its own. Proposed criterion, to be confirmed before Phase 2:

- a fixed, public, synthetic task with behavioral acceptance checks written before any run;
- repeated runs through the normal `development_cycle` flow reach a recorded `go`, `revise` or `stop` without an infrastructure-classified failure;
- each run's evidence is complete: approved plan, delivery, mechanical validation and final decision;
- duration, cost and interventions are recorded per run, so they can serve as the comparison baseline.

These runs are also the first evaluation data for Phase 1. Runs from unrelated projects are not used as evidence.

## Phase 1 — decision provenance and post-run map (implementation target)

1. Inspect existing event, plan, run, adapter and validation artifacts. Document provenance and gaps before changing code. Artifacts that already carry observed decisions include `intervention.json` with its recorded answer, `final_validation_response.md`, normalized plan versions and council synthesis output.
2. Define a portable, additive decision record that any implementation adapter may emit optionally, so the map does not depend on one runner (Octopus can be the first producer): stable ID, run/phase, time, source artifact pointer, what was decided, observable evidence, chosen option, locally relevant unchosen alternatives, concise trade-offs, uncertainty, and classification (`observed` / `agent-stated` / `post-hoc-inferred`). Never fabricate an agent's past reasoning.
3. Extract consequential decisions from an existing finished run **read-only**, using observed evidence. Avoid logging every token or arbitrary implementation step. Include explicit 'unknown' when alternatives or rationale cannot be reconstructed.
4. Produce a small portable JSON schema and readable visual map (Mermaid or static HTML). Progressive disclosure: one-line summaries first; show source, evidence, pros/cons and uncertainty on selection. Distinguish chosen/executed/validated, unexecuted hypotheses, and unknowns.
5. Support a configurable relevance filter based on impact, reversibility, cost and uncertainty, without hard-coded option types or branch counts. Preserve the original record and provenance.
6. Demonstrate with one sanitized, realistic example run. Do not read production state into the public repository or embed deployment-specific values.

**Out of scope for Phase 1:** live branching, automatic replay, unconstrained parallel execution, predicted outcomes stated as facts, hidden chain-of-thought extraction, production-runtime changes, new agent runs.

## Acceptance checks

- Human usefulness is judged against a stated criterion, for example the map changed a decision or located a failure cause faster than reading the run artifacts.

- An actual completed run can be summarized without changing its execution or artifacts.
- Each displayed claim is linked to evidence or marked as inference/unknown.
- A decision may have any natural number of meaningful alternatives, including zero; no three-option template.
- The map can distinguish **observed outcome** from **hypothesized consequence** at a glance.
- Missing telemetry never becomes invented rationale.
- Generated public examples are portable and pass the repository's public-sanitization audit.
- No tautological checks, change-detector tests or regression tests without a genuine behavior gap.

## Future experimental phases (not implemented)

**Phase 2 — contextual alternatives:** construct short, non-prescriptive counterfactual descriptions, uncertainty and potential consequences, with source-grounded assumptions.

**Phase 3 — isolated replay:** capture or reconstruct an *adequate* pre-decision checkpoint, branch in isolated worktrees/environments, hold evaluation criteria fixed, prevent future-information leakage, and compare actual outputs.

**Phase 4 — adaptive search:** decide which forks deserve finite compute; compare to linear execution and to spending the same budget on one longer run. Study feasibility and diminishing returns before broad parallel search.

## Research gates

Evaluate decision-detection precision, provenance completeness, human usefulness, replay fidelity, solution quality, latency and cost. Use behavioral criteria grounded in real requirements. Report failures and null findings. Never treat a generated alternative as a measured outcome.
