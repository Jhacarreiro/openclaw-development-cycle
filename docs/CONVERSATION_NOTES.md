# Conversation synthesis — Decision Multiverse

**Date:** 13 October 2026. Distilled from a product/research conversation. Not experimental evidence.

## Foundational positions

- We build **solutions**, not software as an end in itself.
- The long-term vision is AI performing most execution, with human creativity, taste, strategic and technical judgment and accountability guiding a large agent workforce — a top chef leading a huge kitchen.
- Human involvement described here includes framing problems, proposing and rejecting approaches, setting architecture and deciding what serves a real need; AI coding agents implement code.
- Outcome matters in three distinct layers: did the agent execute the request; is the engineering robust; did it solve the real problem?
- Product delivery, production readiness and acquisition remain priorities; research should augment rather than derail them.

## Conceptual decisions

- Prefer a navigable **decision graph** to an ordinary chronological log.
- Alternatives are **derived from implications of each decision**, never predefined as architecture A/B/C or a fixed three-way list.
- Each choice can later become an experimental fork. Infinite-token, multidimensional parallel exploration is a speculative limit, not an implementation premise.
- UI should be short and visual by default, reveal deeper arguments/evidence on demand.
- The first version should examine completed runs without changing execution; branching and replay come later.
- An agent's actual rationale, a posterior interpretation and speculation about outcomes must remain visually distinguishable.

## Open questions

- Which events currently expose decisions and their justification?
- How do we identify only consequential forks?
- What is the smallest useful decision record?
- Can an unchosen option be represented honestly when it was never discussed?
- Which state must be checkpointed to fairly replay a fork?
- How can we prevent future information contaminating counterfactual branches?
- Which comparisons measure genuine user outcomes instead of code or grader artifacts?
- How should exploration budgets be allocated as the tree grows?
- Does branch search beat linear execution with equivalent total budget?
- When does human judgment provide measurable benefit?

## Provisional conclusions

- The vision is compelling but unproven; the research value comes from falsifiable evaluation.
- A provenance-aware post-run visualization is tractable and useful independently of ambitious replay.
- Neither more branches nor more tokens guarantee better solutions.
- Documentation belongs here while tightly coupled to the Development Cycle control plane; split into a research repository only if methods/data/tooling become independent.
- Do not publicly expose operator-specific runtime details or private deployment state.
