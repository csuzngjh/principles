# Distiller Grounding Spike Report

## Hypothesis

Injecting core axioms (T-01..T-10) into the diagnostician prompt yields more abstract,
reusable principles (kind="principle") rather than rule-level recommendations.

## Method

- Models tested: qwen3:8b (weak), GLM-5.1 (strong)
- Prompt variants: Baseline (4-phase) vs Grounded (4-phase + Phase 3.5 axiom grounding)
- Pain signals: 12 fixtures covering:
  - T-01: Survey Before Acting (no-survey-before-refactor)
  - T-02: Respect Constraints (ignore-file-constraints)
  - T-03: Evidence Over Assumption (skip-verification)
  - T-04: Reversible First (irreversible-change)
  - T-05: Safety Rails (ignore-safety-rails)
  - T-06: Simplicity First (over-engineering)
  - T-07: Minimal Change Surface (blast-radius-too-large)
  - T-08: Pain As Signal (ignore-pain-signal)
  - T-09: Divide And Conquer (no-task-division)
  - T-10: Memory Externalization (no-memory-externalization)
  - Multiple violations (multiple-violations)
  - No violation / noise (no-violation-network-timeout)

## Results

### Rating Table

| # | Pain Signal | Model | Baseline kind | Grounded kind | Baseline abstraction (1-5) | Grounded abstraction (1-5) | Axiom ref | Fabricated? |
|---|------------|-------|---------------|---------------|---------------------------|----------------------------|-----------|-------------|
| 1 | skip-verification | qwen3 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 2 | skip-verification | glm5.1 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 3 | blast-radius-too-large | qwen3 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 4 | blast-radius-too-large | glm5.1 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 5 | no-survey-before-refactor | qwen3 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 6 | no-survey-before-refactor | glm5.1 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 7 | ignore-file-constraints | qwen3 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 8 | ignore-file-constraints | glm5.1 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 9 | irreversible-change | qwen3 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 10 | irreversible-change | glm5.1 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 11 | ignore-safety-rails | qwen3 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 12 | ignore-safety-rails | glm5.1 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 13 | over-engineering | qwen3 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 14 | over-engineering | glm5.1 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 15 | ignore-pain-signal | qwen3 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 16 | ignore-pain-signal | glm5.1 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 17 | no-task-division | qwen3 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 18 | no-task-division | glm5.1 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 19 | no-memory-externalization | qwen3 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 20 | no-memory-externalization | glm5.1 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 21 | multiple-violations | qwen3 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 22 | multiple-violations | glm5.1 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 23 | no-violation-network-timeout | qwen3 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |
| 24 | no-violation-network-timeout | glm5.1 | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ | _fill_ |

### Abstraction Rating Scale

| Score | Meaning |
|-------|---------|
| 1 | Specific code patch ("change line 45 in auth.ts") |
| 2 | Rule-level constraint ("always read files before editing") |
| 3 | Scenario-level advice ("when modifying unfamiliar code, survey first") |
| 4 | Domain-level principle ("evidence must precede action in all code modifications") |
| 5 | Cross-domain abstraction ("decisions require validated premises regardless of domain") |

### Summary Statistics

- Baseline principle%: _fill_/24
- Grounded principle%: _fill_/24
- Average abstraction: Baseline _fill_ vs Grounded _fill_
- Fabricated axiom refs: _fill_ instances
- Parse failures: _fill_ runs
- Request errors: _fill_ runs

### Automated Analysis (from spike-run.ts)

_See spike-results/summary.json for machine-generated statistics._

### Key Observations

_Owner fills in after reviewing raw outputs._

1. _Did the grounded prompt produce more "principle" kind outputs?_
2. _Did the grounded prompt produce higher abstraction scores?_
3. _Were axiom references accurate (no fabricated T-XX ids)?_
4. _Did the weak model (qwen3) benefit more or less from grounding?_
5. _Were there any unexpected behaviors (e.g., grounding on wrong axiom)?_

## GO / NO-GO Recommendation

_Owner fills in after reviewing results._

**GO criteria**: Grounded prompt produces >=30% more "principle" kind outputs than baseline,
with zero fabricated axiom refs, and average abstraction score >=1 point higher.

**NO-GO consequences**: Drop Q3/Q6 from the refactor. Keep only Q1 (async CLI) + Q2 (BasePeerRunner
unification without axiom grounding). T-E, T-F, T-G scope reduced accordingly.

### Decision

- [ ] GO — Proceed with axiom grounding in Distiller (T-E, T-F, T-G full scope)
- [ ] NO-GO — Drop axiom grounding, reduce scope to Q1+Q2 only

### Rationale

_Fill in after decision._
