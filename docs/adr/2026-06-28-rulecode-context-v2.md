# ADR: RuleContext v2 — Rule-Code Context Vision

- **Date:** 2026-06-28
- **Status:** Accepted
- **Decision Owner:** Maintainer (gong wesley)
- **Tracking Issue:** [PRI-479](https://linear.app/principlesdisciple/issue/PRI-479) (parent epic: PRI-478)
- **Spec:** [`docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md`](../superpowers/specs/2026-06-27-rulecode-context-vision-design.md)
- **Execution Plan:** [`docs/superpowers/plans/2026-06-28-rulecode-context-v2.md`](../superpowers/plans/2026-06-28-rulecode-context-v2.md)

## Context

The current rule system (v1) enforces approved rules via the `code_tool_hook` /
RuleHost pipeline. Rule matching is string/keyword-based and the rule host
receives limited context about *why* a rule exists or *what* code it targets.
This produces two recurring failure modes:

1. **Over-triggering** — rules fire on superficial keyword matches even when
   the underlying intent does not apply, producing noise and owner fatigue.
2. **Under-explaining** — when a rule fires, the agent receives the rule text
   but not the principle lineage, the originating pain signal, or the
   code-structural rationale, so corrections feel arbitrary.

The **RuleContext v2** vision (see spec) introduces a structured context
object that travels with each rule evaluation: principle lineage, semantic
code anchors, owner-intent linkage, and evidence provenance. This is a
multi-phase expansion of the `RuleHostInput` contract and the downstream
context builders.

## Decision

We approve the RuleContext v2 initiative as a **quiet, default-off** expansion
of the rule-code context pipeline, executed phase-by-phase behind the
`rulecode_context_v2` feature flag.

### 1. Feature Flag Registration (this ADR's immediate scope — Phase 0)

Register in `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts`:

```yaml
rulecode_context_v2:
  category: quiet      # NOT core — does not expand the MVP-Core default-on set
  enabled: false       # default off — v1 rule behavior is unchanged
  since: 2026-06-27    # spec approval date
```

**Why `quiet` and not `core`:** Per AGENTS.md > MVP-Core / MVP-Quiet / MVP-Gone
Triage, adding to MVP-Core requires explicit maintainer approval and forces a
default-on contract. RuleContext v2 is an additive, reversible expansion; it
must not alter production rule behavior until each phase is independently
reviewed and the owner explicitly opts in. `quiet` + `enabled: false` is the
strictest reversible posture.

### 2. Contract Boundary

- **Phase 0** (this ADR) registers the flag only. No production code path
  reads the flag yet. This is intentional: the flag is the foundation that
  later phases gate on.
- **Phase 1+** (future ADRs / issues) will extend `RuleHostInput` and add
  context builders, each gated behind `rulecode_context_v2`. Those phases
  MUST individually satisfy the MVP Three Questions and the emotional-value
  assessment before flipping any default.
- **v1 rule behavior is the control.** While `rulecode_context_v2` is off,
  rule evaluation MUST be byte-for-byte identical to today. This is the
  regression invariant every subsequent phase must preserve.

### 3. Rollback Path

- **Default off** is the rollback. Leaving the flag unconfigured = v1 behavior.
- Explicit disable: `config.features.rulecode_context_v2.enabled: false`.
- Per-phase rollback (once phases land): each phase ships its own revert path
  (PR revert or sub-flag), never relying on this flag alone once a phase
  has been promoted.

## Consequences

- **Positive:** Subsequent phases have a stable, testable gate. The flag is
  propagated automatically through `pd-config-defaults.ts` →
  `computeFeatureFlagsFromConfig`, so no config plumbing changes are needed
  per phase.
- **Neutral:** Adds one entry to the flag registry. The
  `Flag Registry Consistency` regression test
  (`pd-config-contract.test.ts`) now covers this flag end-to-end.
- **Negative / risk:** Registering a flag with no consumer could be mistaken
  for dead code. Mitigation: this ADR + the PRI-478 epic + the spec document
  the consumer pipeline. ERR-024 ("flag must be truly consumed by tests") is
  satisfied by `rulecode-context-v2-flag.test.ts`, which exercises existence,
  propagation, and override — not merely registration.

## Compliance

- **MVP Three Questions (Phase 0):** answered in PRI-479 description — pure
  flag registration has no product behavior, no emotional-value claim, and is
  a required foundation. ✅
- **antipattern-future-extensibility:** This ADR does NOT pre-approve any
  Phase 1+ code. Each phase re-enters the MVP gate. The flag exists to
  *enable disciplined gating*, not to pre-ship code.
- **antipattern-core-io:** Phase 0 touches only a pure-logic contract file in
  `principles-core`. No I/O is introduced.
- **Runtime Contract:** N/A — no untrusted data parsing in this change.

## References

- Spec: [`2026-06-27-rulecode-context-vision-design.md`](../superpowers/specs/2026-06-27-rulecode-context-vision-design.md)
- Plan: [`2026-06-28-rulecode-context-v2.md`](../superpowers/plans/2026-06-28-rulecode-context-v2.md)
- Parent epic: PRI-478
- ADR-0014 (MVP-First Strategy) — governs the quiet/core triage used here
