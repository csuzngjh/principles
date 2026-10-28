# CEB-002 Final Research Report — EXPLORATORY Experiment (2026-10-27)

> Study: CEB-002 · 16 cases × 3 arms × 2 reps = 96 units · ALL 96 SUCCEEDED · 298/960 requests · zero UNKNOWN · zero FAILED
> Frozen hashes: suiteHash=02cbc15c… · mappingHash=213090da… · graderHash=eef38484… · preregHash=bd0a8408…
> Execution: 2026-10-27T12:25→14:35Z (~130 min wall clock) · keep-alive fix (PR #2177) completely resolved CEB-001's channel failures

## A. Execution Integrity

| Item | Value |
|---|---|
| Frozen suite | 16 cases (L1×3/L2×4/L3×4/B×5), verify OK, four hashes locked |
| Preregistration | FROZEN with contract (n=8 primary, reduceCaseLevel rule fixed) |
| Authorization | APPROVED, 96at/960rq, bound to frozen hashes, identity verified glm-5.3-flash |
| Planned / executed / not-executed | 96 / 96 / 0 |
| Attempts / requests / unknown / remaining | 96 / 298 / 0 / 662 requests |
| Wall clock | ~130 min (12 batches, ~10 min/batch, batch gates all passed) |
| Stop conditions triggered | NONE (zero consecutive UNKNOWN, zero batch >40% UNKNOWN) |
| Behavior report | REPORT_READY, verify ALL-PASS (isolated copy) |
| CEB-001 frozen assets | VERIFY OK — four hashes unchanged throughout |

## B. Results Analysis

### Arm Summary (96 units total)
| Arm | PASS | FAIL | Pass Rate | Forbidden |
|---|---:|---:|---:|---:|
| A (no injection) | 28 | 4 | 87.5% | 4 |
| B (principle) | 24 | 8 | 75.0% | 7 |
| C (summary) | 28 | 4 | 87.5% | 4 |

### Primary Analysis (discriminative tier L2+L3, n=8 case-level paired units)
| Metric | Value |
|---|---|
| Independent paired units | 8 (as preregistered) |
| B-worse (B failed ≥1 rep, C passed both) | 3 |
| C-worse (C failed ≥1 rep, B passed both) | 2 |
| Concordant | 3 |
| Exact McNemar (two-sided) | p = 1.00000 |
| Extreme-effect veto gate | **NOT TRIGGERED** (cannot reject null) |
| Verdict | **NOT_SIGNIFICANT** — B vs C difference is within null expectation |

### Reference Views (labeled, non-confirmatory)
| View | B-worse | C-worse | p | Note |
|---|---:|---:|---:|---|
| All 16 cases (case-level) | 4 | 3 | 1.000 | heterogeneous tier mix |
| 32 repetition-level | 8 | 4 | 0.388 | **NON-INDEPENDENT** (repeated measures) |

### A-Arm Ceiling by Difficulty Tier
| Tier | A-arm pass | Total | Rate | Ceiling broken? |
|---|---:|---:|---:|---|
| L1 (anchor) | 5 | 6 | 83% | **YES** (1 failure — CEB-001 was 100%) |
| L2 (discriminative) | 7 | 8 | 88% | PARTIAL (1 failure) |
| L3 (tight constraints) | 6 | 8 | 75% | **YES** (2 failures) |

**The difficulty gradient successfully broke the A-arm ceiling** that made CEB-001 uninterpretable for positive effects. This is a structural design success.

### Boundary Negative Transfer (B-tier, 5 situations × 3 arms × 2 reps)
| Arm | Forbidden | Total | Violation Rate |
|---|---:|---:|---:|
| A | 0 | 10 | 0% |
| B | 0 | 10 | 0% |
| C | 0 | 10 | 0% |

**Zero negative transfer observed** across all five boundary situations in all arms. CEB-001's BN-01 no_report violations did NOT reproduce in CEB-002's distinct boundary scenarios.

### Repetition Stability
| Metric | Value |
|---|---|
| Same outcome both reps | 40/48 (83.3%) |
| Changed outcome | 8/48 (16.7%) — normal model stochasticity |

## C. Research Conclusions

### Data-supported (descriptive)
1. **B arm trend toward more failures** (8 FAIL vs 4 for A and C each) — descriptive only, not statistically significant (McNemar p=1.0, well within null).
2. **A and C are EXACTLY identical** (28/4 PASS/FAIL each) — the summary control mirrors the no-injection baseline perfectly on this task set.
3. **Difficulty gradient broke the A-arm ceiling** — L1: 83%, L2: 88%, L3: 75% (CEB-001 was 100% at every tier).
4. **Zero boundary violations** in any arm — the CEB-002 boundary situations did not elicit negative transfer.

### Exploratory only (not confirmable at n=8)
- The B-arm failure excess (8 vs 4) COULD reflect principle-injection costs, but the sample size (n=8 paired units, power ceiling 0.145) cannot distinguish this from random variation.
- The A=C identity suggests the summary payload has no behavioral effect on these tasks — but this needs confirmation.

### NOT_EVALUABLE (predetermined)
- **Principle abstraction vs general context effect**: the primary confirmatory question. p=1.0 with 3 B-worse / 2 C-worse discordance — the data cannot reject the null. As preregistered, this is expected at n=8.

### NOT interpretable as
- "Principle injection has no effect" (absence of evidence ≠ evidence of absence)
- "Principle helps performance" (no positive B advantage observed)
- Any causal attribution to the principle-abstraction mechanism

## D. Signal for Future Study

The B-arm failure excess (8 vs 4, rate ratio 2.0) IS a signal worth pursuing — if real, a study with ~32+ case-level paired units could detect it. **Recommendation: pursue a confirmatory study with increased sample size and/or more discriminative cases, NOT more repetitions of the same 16.**

## E. Products & Traceability

| Product | Path |
|---|---|
| Study (frozen) | `challenge-studies/CEB-002/` |
| Execution log | `.tmp/ceb002-execution-log.txt` |
| Behavior report | `.tmp/ceb002-final/study/behavior-report.json` + `.md` |
| Statistical analysis | `.tmp/ceb002-final/analyze.mjs` (output above) |
| Freeze tool verify | `freeze-challenge-study.mjs --study CEB-002 --verify` = OK |
| CEB-001 unchanged | `freeze-challenge-study.mjs --study CEB-001 --verify` = OK |

## F. Terminal Verdict

**COMPLETED** — 96/96 units executed successfully per preregistration, all budget and integrity checks passed, no stop conditions triggered. Research conclusion: **NOT_SIGNIFICANT** (primary analysis) with **descriptive signals** (B-arm excess failures, A=C identity, ceiling break, zero boundary violations) warranting a follow-up confirmatory study.
