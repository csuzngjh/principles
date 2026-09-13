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
- Parent epic: PRI-478
- ADR-0014 (MVP-First Strategy) — governs the quiet/core triage used here
- (Historical note: the original ADR also referenced an execution-plan
  document under `docs/superpowers/plans/` that was never committed; the
  dead link was removed in the PRI-780 amendment.)

## Amendment (2026-09-13): PRI-780 — Default-On Convergence of Runtime Governance Context

> **Status of amendment**: Accepted (SPEC v2 + Linear [PRI-780](https://linear.app/principlesdisciple/issue/PRI-780/runtime-governance-context-收敛rulecontextv2-成为唯一默认治理上下文), implementation directive issued 2026-09-13)
> **Authority**: Owner-approved SPEC v2 "Runtime Governance Context Convergence"; root evidence: [PRI-758](https://linear.app/principlesdisciple/issue/PRI-758) RuleCode behavior-loop validation (0 activations; complex principles degraded to action-only rules) + Implementation Readiness Reality Audit (2026-09-13, recorded in the PRI-780 ticket).
> **Supersedes within this ADR**: the "quiet, **default-off**" registration posture in §Decision and §Rollback Path below. The flag stays `quiet`-category but flips to `enabled: true`. All other historical passages are retained as decision history.

### A.1 What changed in reality since 2026-06-28

All phases the original ADR anticipated have landed and are verified by tests:
`RuleContextV2` schema + validators (`rule-context-v2.ts`), the production
assembler over the real trajectory source (`rule-context-assembler.ts` /
`buildProductionRuleContext`), RuleHost context injection on **both** runtime
governance routes (legacy `openclaw-plugin/src/hooks/gate.ts` and the shared
`host-runtime` production gate via the OpenClaw `ruleContextProvider` wiring),
v2 artifact gating at activation (`rule-host-writer.ts`) and evaluation
(`rule-host.ts` `suspended_by_flag`, shared gate `rule_context_v2_unavailable`
skip + warning). What never happened is the graduation: the flag remained
default-off, so production `RuleHostInput.context` stayed absent and the
Artificer kept a v1/v2 branch in which the production task-driven paths
(consumer cycle, run-once) were permanently pinned to v1.

### A.2 Decisions authorized by this amendment

1. **Default-on flip.** `rulecode_context_v2` becomes `enabled: true` in the
   flag registry SSoT (`feature-flag-contract.ts`). Category stays `quiet`:
   explicit `.pd/config.yaml` disable remains the migration-period kill
   switch. No new context flag is introduced.
2. **Both routes covered.** Convergence targets the two coexisting runtime
   governance routes (legacy OpenClaw hook path and shared host-runtime
   production gate). Both assemble context through the same
   `buildRuleContextIfEnabled`; `abstraction_layer_v1` keeps selecting the
   route. Route unification is a non-goal of PRI-780.
3. **Sequencing precondition.** The Codex capability declaration lands
   BEFORE the default flip: Codex declares structured-unsupported runtime
   context (v2 rules stay suspended with an explicit host-unsupported
   warning, see A.3), never a silent skip.
4. **BEP stays Owner-labelled.** `BehaviorExamplePack` remains
   Owner-labelled evidence. Trajectory execution outcomes are NOT Owner
   allow/block judgements and must not auto-generate a BEP. Missing BEP at
   v2 generation = explicit failure; silent downgrade to a low-capability
   (v1/action-only) rule is prohibited.
5. **Artificer V2-only generation contract.** The `contextMode=v1` prompt
   branch and the v1/v2 mode field are deleted; generation is v2-only
   (`requiresContextVersion: 2` or explicit failure). Persisted legacy v1
   artifacts keep evaluating unchanged — existing rules must not silently
   gain new semantic dependencies (evaluation-side v1 compatibility for
   already-approved artifacts remains).

### A.3 Codex structured-unsupported declaration (rev 2 — Codex review round 2 P1)

The Codex host has no runtime context provider, and it PASSES NONE: v2 rules
stay **suspended** on Codex. The shared production gate skips them with its
structured `rule_context_v2_unavailable` warning, and the Codex hook annotates
that warning with the explicit host reason
(`codex_runtime_context_unsupported: the Codex host provides no runtime
context provider; v2 rules stay suspended on this host`) before it reaches
Codex stderr — ticket option B: 明确 unsupported + 结构化 warning, never a
silent skip.

An earlier draft of this amendment declared a schema-valid
unavailable-posture `RuleContextV2` instead, keeping v2 rules loaded and
relying on the generation-time contract "unavailable → allow, matched:false".
Codex review round 2 correctly rejected that posture: the contract is
prompt-level discipline, not a runtime-enforced invariant — a persisted v2
rule may evaluate context-blind and DENY tool calls that were previously
suspended, silently changing governance behavior. Suspension is the safe,
spec-literal choice; a real Codex context provider (option A) remains the
follow-up that unlocks v2 enforcement on Codex.

### A.4 Consequences

- **Positive:** `RuleHostInput.context` is present by default; complex
  principles can compile into evidence-aware RuleCode; the generation,
  evaluation, and execution sides share one Runtime Governance Context.
- **Behavior change (intended):** automatic code-rule generation without
  Owner-labelled behavior examples now fails loud at the artificer stage
  (task retries, then `needs_human_review`). Code-rule generation becomes
  Owner-gated by design; text-principle flows are unaffected. Runbooks
  updated accordingly.
- **Risk / rollback:** explicit config disable
  (`features.rulecode_context_v2.enabled: false`) restores the pre-flip
  posture (context absent; v2 generation refused rather than silently v1 —
  see A.2.5).

### A.5 Revised acceptance criteria

See Linear PRI-780 (SPEC v2, AC1–AC7), including the reality-evidence
requirement: real `trajectory` → assembler → `RuleHostInput` → decision
chain, no synthetic-only verification.
