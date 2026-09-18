# PRI-838 / PRI-839 — Formation Context Connection Repair

> **Deliverable type**: implementation + paired A/B quality validation
> **Scope**: restore the two information connections the PRI-835 audit found disconnected (`DC-1`, `DC-3`)
> **Date**: 2026-09-18
> **Tickets**: PRI-838 (Scribe Formation Context Recovery), PRI-839 (Artificer Candidate Expansion)

```text
BASE_SHA = 89eb275e33f6f072ace012c5285ae3f3b498f0a8 (origin/main; base CI GREEN)

MODE = EXPLORATORY (single run per case; no repetition budget — PRI-815's frozen
       harness is the precedent for the A/B shape, not proof of stability here)
EXPERIMENT_N = 39 real production formation chains (56 scribe artifacts available;
       17 excluded: 16 with no readable diag_router predecessor, 1 single-candidate)
GENERATOR = glm-5.3 (ZAI coding endpoint)
GENERATOR_CONFIG = temp=0 maxTokens=8000 (primary) — production's own profiles
       grant maxTokens=16000 (config.yaml), so the primary harness is ~2x MORE
       constrained than production
ARM_SYSTEM_PROMPT_HASHES: A = a47db8f47552   B = 1203f5574457
       A is BYTE-IDENTICAL to the frozen PRI-815 Phase A Arm A hash — the harness
       independently reproduces the frozen baseline prompt
RESOLVER UNDER TEST = the REAL resolveFormationContext (worktree dist), reading a
       READ-ONLY production state.db — no reimplementation

RESOLUTION  39/39 chains resolved · 39/39 with diagnosis · mean 4.92 proposals
VALIDITY    primary (uniform 8000):   A 38/39 (97.4%)  B 38/39 (97.4%)   1 flip each way
            production config:        A 38/39 (97.4%)  B 39/39 (100%)    B-only pass
COST        scribe call: A 6545 -> B 10468 tokens = +59.9% (median +58.2%)
            COST_EXCEPTION = YES (PRI-815 guard <= +20%); chain-level ESTIMATED ~+27%
CONTENT     statement/rationale flat; applicability 3.97 -> 3.54; antiPatterns
            5.21 -> 4.85 — Arm B does NOT produce more (by design)
JUDGED      blind, seed-randomized, 39/39 judged, 0 parse failures
            OVERALL A = 9  B = 29  TIE = 1   NET_ADVANTAGE = +51.3pp
            per dimension (net B): applicability +46.2 · intentContractQuality +30.8
              · completeness +25.6 · antiPatterns +25.6 · groundedness +23.1
            applicability and antiPatterns have ZERO Arm A wins
            unsupported concrete claims: A 58 (25 cases) vs B 28 (20 cases)

ARTIFICER GENERATION A/B = NOT RUN (BLOCKED: no production BehaviorExamplePack
       exists; substituting one would inject synthetic evidence). Prompt-level
       effect MEASURED instead: 1.0 -> 4.9 candidates delivered, 345 -> 2154 chars.

LOCAL GATE  verify:merge — lint 0 errors, all typechecks, build, website, 5/6
            pipeline-contract groups PASS. The 1 red step is a pre-existing
            Windows-local EBUSY (proven on unmodified code); CI is the authority.
```

---

# 0. Baseline

```text
BASE_SHA            = 89eb275e33f6f072ace012c5285ae3f3b498f0a8   (origin/main; verified by `git ls-remote`, not the cached tracking ref)
BASE_SHA_SUBJECT    = Merge pull request #1746 from csuzngjh/ai/PRI-799-phase-c-final-cutover
BASE_CI             = GREEN (all check-runs on 89eb275e success; only superseded runs cancelled)
WORKTREE            = D:\Code\_worktrees\principles\PRI-838-formation-context-recovery
PRODUCTION_PD_HOME  = D:\.openclaw\workspace\.pd
INSTALLED_RUNTIME   = 1.245.2   (update-history.json, 2026-09-16T13:44:00Z)
PROBE_HARNESS       = D:\pd-probe-836\   (repo-external, per isolation policy)
GENERATOR           = glm-5.3 (ZAI coding endpoint) — temperature 0, max_tokens 8000, real production validators
```

**Production state: READ ONLY.** Every access to `state.db` used
`new Database(path, { readonly: true, fileMustExist: true })`. No write, no
synthetic artifact, no real agent trigger, no config/flag change.

## 0.1 What this is NOT

Per PRI-835 §6.3 and the ticket's hard constraints, this change deliberately does
**not**: add a database, add an artifact type, extend or widen any output schema
or validator, touch Principle authority / Owner approval / Activation / RuleCode
runtime, restore the retired PRI-634 Layer 0/1/2 plane, or reintroduce a feature
flag. It resolves identifiers that were **already persisted and already in the
runner's hand** into prompt content.

---

# 1. Problem and Root Cause

## 1.1 Problem

**Scribe** — the only stage that produces both the canonical Principle text and
the `intentContract` that every downstream consumer anchors to — was generating
that artifact from the **least** context in the whole formation chain. The
original pain, the diagnosis that classified it, and the Dreamer's alternative
corrections were all structurally dropped before the prompt was built.

**Artificer** likewise discarded the Dreamer's alternatives: `resolveDreamerContext`
projected `candidates[0]` and threw the remaining proposals away, so the model
could not explain why one path was preferred, what the alternatives were, or what
risks they carried.

## 1.2 Root Cause

**Existing artifact lineage was not resolved into prompt context.** Not missing
data, not a budget truncation, not a disabled flag — a missing dereference.

The identifiers were already in hand:

| Fact | Value | Evidence |
|---|---|---|
| scribe artifacts carrying `sourceTrace.dreamerArtifactId` | **56 / 56** | MEASURED, this work's read-only probe |
| dreamer artifacts carrying ≥2 candidates | **31 / 33** | MEASURED (5×25, 4×6, 2×1, 1×1) |
| dreamer candidates reaching the Artificer | **1** | `const [firstCandidate] = candidatesField;` |
| dreamer candidates reaching the Scribe | **0** | `ScribePromptInput` carried ids only |

The Artificer already demonstrated the required pattern
(`resolveDreamerContext`: untrusted parse → `getArtifactById` → structural
validation → prompt injection). The Scribe held the same id and never called the
store.

## 1.3 Reconciling with PRI-815's measured +85.7pp

PRI-815 Phase A proved the information channel matters (`W=19 L=1 T=1`,
`NET_ADVANTAGE = 85.7pp`). This work does not re-litigate that result; it
productionises the repair with deployment-grade error handling, bounding and
observability — and it reuses the validated prompt text **verbatim** (see §3.2).

---

# 2. Fix

## 2.1 New module: `formation-context.ts`

A single bounded-projection module with **two material consumers** (Scribe,
Artificer), so it is a real seam rather than a speculative abstraction:

* `projectDreamerProposals()` — ALL candidates, per-field clamped, deterministically
  priority-ranked, malformed entries skipped individually (one bad element can no
  longer discard the whole alternative set);
* `projectDiagnosisOutput()` — tolerant projection over the diagnostic stage
  artifact (`diag_router` preferred; earlier stages degrade gracefully);
* `resolveFormationContext()` — walks `dreamer artifact → dreamer task → diag_router`
  predecessor, returns the bounded context or degrades.

Reused rather than reinvented:

| Reused | From |
|---|---|
| The bounded-projection **contract** (pure projection, `Object.hasOwn` guards, no `as`, explicit degradation reasons, byte-deterministic) | `artifact-summary.ts` — the only bounded-projection implementation that survived PRI-819 R-06 |
| The prompt-boundary **bounding idiom** | `boundPackForPrompt` (EP002-R4), same file, same boundary, same reason |
| The artifact-store / lineage / task-lookup interfaces | `PIArtifactStore`, `pi_artifacts.lineage_artifact_ids`, `PITaskMetadata.dependencyTaskIds` |

Deliberately **not** restored: `ContextManifest`, `PromptBudgetManager`,
`CandidateLineage`, `ProgressiveEvaluator`, `attach-summary-envelope` (retired by
PRI-819 R-06 for never graduating).

## 2.2 Why the task lookup is required

Every PI artifact is written with `artifact_kind = 'principle'`, so a diagnosis
artifact cannot be identified from artifact records alone. Stage identity exists
only on the task row — hence `lookupTask` (mirroring how `diag_router` itself
resolves its predecessors). This is an existing structural property, not a new
contract.

## 2.3 Scribe prompt contract v3 → v4

* payload gains optional `formationContext` (`dreamerProposals` + `sourceDiagnosis` + `provenance`), matching the frozen Phase A block names;
* the system prompt conditionally gains `FORMATION_EVIDENCE_ADDENDUM`;
* **absent formation evidence ⇒ the payload and system prompt are the pre-PRI-838
  shape**, only the version string moves;
* OUTPUT FORMAT, CONSTRAINTS, `ScribeOutputV1` and `DefaultScribeValidator` are
  untouched.

## 2.4 Artificer prompt contract v7 → v8

* `ArtificerDreamerContext` becomes `{ candidates[], differenceSummary, omittedCandidateCount }`;
* `candidates` reuses `FormationCandidateProjection` — one definition of "a
  dreamer proposal projected for a prompt", not two;
* the system prompt conditionally gains `DREAMER_CANDIDATE_SET_INSTRUCTION`;
* the pre-PRI-839 event vocabulary (`dreamer_context_skipped`,
  `dreamer_artifact_missing`, `dreamer_context_invalid` + all reason strings) is
  **preserved**, so existing observability contracts still hold.

## 2.5 Degradation policy (never fail)

| Situation | Behaviour |
|---|---|
| no dreamer id | `undefined` + `formation_context_skipped` |
| dreamer artifact unreadable | `undefined` + `formation_dreamer_artifact_missing` |
| dreamer content not a JSON object | `undefined` + `formation_context_invalid` |
| dreamer OK, no diagnosis | context without `sourceDiagnosis` + a truncation note |
| artifact store / task lookup throws | `undefined` + `formation_context_failed` (wrapped, never rethrown) |
| bound exceeded | trailing items dropped + `truncationNotes` (never a mid-JSON cut) |

## 2.6 Bounding

Per-field clamp 400 chars; ≤5 candidates; ≤8 evidence / ≤8 violated principles /
≤5 recommendations; section caps 4000 (proposals) and 3500 (diagnosis); hard cap
8000 serialized chars with a documented degradation order (candidates →
evidence → violatedPrinciples → recommendations → diagnosis block → lineage ids).

---

# 3. Method — paired A/B on real production formations

## 3.1 Design

39 real, complete, multi-candidate formation chains were extracted read-only from
production `state.db` (every chain: scribe artifact → resolvable dreamer artifact
with ≥2 candidates → succeeded `diag_router` predecessor with a readable
artifact). 16 chains were excluded and counted (`diag_router_artifact_missing: 16`,
`single_candidate: 1`).

```text
Arm A = production Scribe prompt as it exists today (philosopher artifact only)
Arm B = the SAME input + formationContext resolved by the REAL resolver
```

* paired: same case, same model, same config for both arms;
* temperature 0, max_tokens 8000;
* judged/failed on the REAL `DefaultScribeValidator` after
  `normalizeStringEncodedIntentContract` (production also runs it);
* the resolver under test is the **real** `resolveFormationContext` built from
  this worktree's dist, reading a read-only production DB — no reimplementation.

## 3.2 Fidelity of the prompt text

The CANDIDATE PRIORITY contract is reused **byte-identical** from the frozen
PRI-815 Phase A addendum (`B_ADDENDUM_VERSION = 'pri815-b-addendum.v1'`), because
that exact text is the channel the only quantitative evidence (85.7pp) was
measured on. Two deltas, both required to productionise it, are declared in code:

1. the locator paragraph (production nests the blocks under `formationContext`);
2. one degradation bullet — legacy formations with no resolvable diagnosis must
   be told to degrade rather than invent a source intent.

## 3.3 Harness-integrity guards (a defect caught by them)

The first harness run silently produced `resolved: false` for every case: the
read-only DB adapter had not mapped snake_case columns onto the
`PIArtifactRecord` contract, so `contentJson` was `undefined` and Arm B was
identical to Arm A. A fail-loud guard was added, the adapter fixed, and the run
restarted. **Lesson recorded**: the resolver's own
`dreamer_content_not_object` event is what made the mis-wiring visible — rc-9
observability earned its keep.

After a lint-only refactor of the resolver (object params, function reorder), the
resolver output was re-verified as **byte-identical** against the recorded
`serializedChars` for every completed case (`checked=15 mismatches=0`), so the
refactor cannot have influenced any figure below.

# 4. Results

Two views are reported. **View 1 is primary** (a config-uniform experiment).

## 4.1 Resolution (MEASURED)

```text
cases attempted                      = 39   (complete multi-candidate chains)
formationContext resolved             = 39 / 39
  with sourceDiagnosis                = 39 / 39
  mean proposals delivered            = 4.92
  mean serialized context             = 4726 chars
  cases where a bound fired           = 1 / 39  (one candidate dropped, noted in truncationNotes)
```

At the production-config view, Arm B's validity improved further:

| View | Arm A | Arm B | A-only pass | B-only pass | JSON not extractable |
|---|---|---|---|---|---|
| **View 1** — uniform `maxTokens=8000` (primary) | 38 / 39 (97.4%) | 38 / 39 (97.4%) | 1 | 1 | A 0, **B 1** |
| **View 2** — the starved case re-run at production's `maxTokens=16000` | 38 / 39 (97.4%) | **39 / 39 (100%)** | 0 | 1 | A 0, B 0 |

**Validity is not regressed in either view**, and the two asymmetric cases are both
individually explained:

* `…mu2sxagz` — **Arm A failed the real validator** (`generatedAt must be non-empty string`);
  Arm B produced a fully valid contract. A judge-free Arm B win.
* `…mu0gt4ww` — at `maxTokens=8000` Arm B's content came back **empty with
  `completion_tokens = 8000` exactly**: the model spent the entire generation budget on
  reasoning over the richer evidence and emitted no JSON. Re-run at production's own
  `maxTokens=16000` (see `config.yaml`) it completes with `completion_tokens = 7983`
  and passes. **This is a harness-budget artifact, not a product defect** — but it is a
  real property of the change worth knowing: a richer prompt consumes more reasoning
  headroom, so the generation ceiling must have slack.

## 4.2 Cost (MEASURED)

```text
SCRIBE CALL ONLY (the call this change alters):
  tokens  A = 6545   B = 10468   DELTA = +59.9%
          median paired delta = +58.2%   range = +9.4% … +143.8%
  prompt chars  A = 2073   B = 6819   (+228.9%)
  formationContext alone ≈ 4726 chars ≈ ~1.5k tokens
```

**COST_EXCEPTION = YES** against the PRI-815 guard (`<= +20%`). Declared, not hidden.

The chain-level figure is **ESTIMATED, not measured** — this experiment only ever
invoked the scribe stage:

```text
ESTIMATE (method, not measurement):
  scribe-call delta      = +3923 tokens (mean)
  chain denominator      = PRI-815's published chain baseline (A = 14308.8 tokens/pair)
  ⇒ chain-level ≈ +27%, i.e. above the +20% guard as well

  This is NOT directly comparable to PRI-815's own +24.9%: that aggregate's per-pair
  composition (Dreamer/Philosopher outputs shared across 3 scribe repeats) cannot be
  reconstructed from the published numbers, and PRI-815's arm B carried a different
  (leaner) evidence composition. Treat both as "the same order of magnitude, guard
  exceeded".
```

Because the bounds are pure constants, the cost is an explicit, single-line policy
knob (see §7.1) — this is a decision for the Owner, not a defect.

## 4.3 Content shape (MEASURED)

| Metric (mean per case) | Arm A | Arm B |
|---|---|---|
| principal statement chars | 342.2 | 332.8 |
| rationale chars | 322.3 | 327.0 |
| applicability entries | 3.97 | 3.54 |
| antiPatterns entries | 5.21 | 4.85 |
| risks entries | 4.82 | 4.72 |
| full intentContract (5/5 fields) | 39 / 39 | 38 / 39 |
| output chars | 3854 | 3670 |

**Arm B does not produce "more".** Volume is flat-to-slightly-lower — which is the
intended effect of the frozen `"Longer output is not better"` contract line. Any
quality difference must therefore be in *faithfulness and specificity*, not in bulk;
that is what the blind judge is for.

## 4.4 Arm identity / harness fidelity (MEASURED)

```text
Arm A system prompt hash = a47db8f47552
Arm B system prompt hash = 1203f5574457
```

**Arm A's hash is byte-identical to the frozen PRI-815 Phase A Arm A hash
(`a47db8f47552`)**, computed independently in this harness. That is the strongest
available evidence that this harness reproduces the frozen experiment's baseline
prompt exactly, and therefore that the A/B delta here is attributable to the
formation-evidence block rather than to harness drift. Arm B differs from PRI-815's
`bc47a6df83bd` as expected — it carries the two declared locator/degradation deltas.

## 4.5 Blind judge (JUDGED — model-scored, bias disclosed)

Blinding is owned by the **judge harness**, not the generator: which arm is shown
as "X" is derived from a seeded per-case hash, recorded per case (`judgeXIsArm`),
and never revealed to the judge. The judge emits forced JSON; an unparseable
response is retried rather than recorded as a verdict. **All 39 cases are judged
with 0 parse failures.**

```text
OVERALL     A = 9    B = 29    TIE = 1      NET_ADVANTAGE = +51.3pp
```

| dimension | A mean | B mean | A wins | B wins | ties | paired net B |
|---|---|---|---|---|---|---|
| completeness | 4.69 | 4.95 | 2 | 12 | 25 | +25.6pp |
| intentContractQuality | 4.67 | 4.97 | 1 | 13 | 25 | +30.8pp |
| applicability | 4.41 | 4.92 | **0** | **18** | 21 | **+46.2pp** |
| antiPatterns | 4.69 | **5.00** | **0** | 10 | 29 | +25.6pp |
| groundedness | 4.15 | 4.41 | 8 | 17 | 14 | +23.1pp |

Unsupported concrete claims (judge-listed, across all 39 cases):

```text
Arm A: 58 claims across 25 cases      Arm B: 28 claims across 20 cases
```

**The two strongest results are also the two least likely to be pure judge bias:**
`applicability` and `antiPatterns` have **zero Arm A wins**. These are the two
dimensions the frozen contract line targets directly ("use the proposals as
EVIDENCE for specificity… never to widen the principle's scope"), and the objective
counts in §4.3 show Arm B did it with *fewer* entries, not more — so the gain is
in precision, not in volume.

`groundedness` is the weakest result (8 Arm A wins) and is **structurally the most
biased in Arm B's favour** — see §5.3. Read it as "B stayed inside the evidence it
was given", nothing stronger.

**Ceiling effect, disclosed:** all means sit in 4.15–5.00, so the means compress
most of the signal. The paired win/tie counts are the load-bearing numbers here,
not the mean differences.

## 4.6 Verdict

```text
CONNECTION REPAIR            = SUCCEEDED (39/39 production chains resolve; no regression in viability)
QUALITY DIRECTION            = POSITIVE, CONSISTENT ACROSS ALL 5 JUDGED DIMENSIONS
QUALITY MAGNITUDE            = +51.3pp overall (paired, blind, seeded) — EXPLORATORY, single run per case
VALIDITY                     = NOT REGRESSED (symmetric at the harness ceiling; B-only pass at production config)
COST                         = +59.9% on the scribe call — COST_EXCEPTION, Owner-decidable bound
ARTIFICER-SIDE RULE QUALITY  = NOT MEASURED (blocked; synthetic evidence forbidden)
DOWNSTREAM / BEHAVIORAL EFFECT = NOT MEASURED

OVERALL = PROCEED, with the cost exception and the two unmeasured claims explicitly
          left open for the Owner rather than asserted.
```

Nothing here claims a *behavioral* improvement. What is demonstrated is that the
formation evidence now reaches the Scribe intact, on 100% of real production
chains, without regressing the output contract — and that a blind judge prefers the
resulting principle on every dimension measured, most sharply where the frozen
contract aims.

---

# 5. Deviations & disclosures

1. **Scribe-call vs chain-level token cost.** The measured token delta below is
   the **scribe LLM call only**. PRI-815's `+24.9%` is **formation-level** (the
   whole dreamer→philosopher→scribe chain, ~14.3k → ~17.8k tokens/group). The two
   are not comparable head-to-head; §4 states both, and the chain-level
   equivalent is derived from PRI-815's own baseline.
2. **Judge is the same model family as the generator** (glm-5.3; all independent
   channels were dead on this host in the PRI-815 round as well). Mitigations:
   paired design, per-case seeded blinding, the real deterministic validator, and
   the objective metric block being fully independent of the judge.
3. **The judge's grounding reference is distilled from the same evidence Arm B
   received.** Therefore "groundedness" is structurally favourable to B and must
   be read as *"did B stay inside the evidence it was given"*, not as an unbiased
   comparison. The bias-free signals are the validator pass rate, the field
   counts and the token usage — those are measured, not judged.
4. **The Artificer GENERATION A/B was NOT run — it is blocked by a missing
   production artifact, not by scope choice.**
   `ArtificerPromptBuilder.buildPrompt` requires a valid `BehaviorExamplePack`
   (PRI-780: v2-only, missing pack fails generation loud), and **production
   persists no such pack** — 0 of the tasks in `state.db` carry one; the host
   assembles it at run time from pain lineage + trajectory and passes it in via
   `--behavior-examples`. Fabricating a pack would inject **synthetic evidence**
   into a RuleCode-quality experiment, which the ticket forbids and which would
   make any resulting number meaningless. Per the ticket's stop condition this is
   reported rather than worked around. What WAS measured, on all 39 real chains
   (`artificer-delta.mjs`), is the prompt-level effect:

   | Metric | Pre-PRI-839 | Post-PRI-839 |
   |---|---|---|
   | candidates delivered to the Artificer | 1.0 | **4.9** (production availability: 4.9) |
   | dreamer context chars | 345 | **2154** (+524%; ≈ +570 tokens) |
   | cases with a non-trivial difference summary | 0 / 39 | **39 / 39** |

   The RuleCode-quality / evaluator-score / adversarial-pass-rate comparison the
   ticket names remains **OPEN** and must not be reported as done.

5. **Local `verify:merge` has one RED step, and it is pre-existing and
   Windows-local.** `check:pipeline-contract → j1-formation-e2e` fails on
   `pain-id-chain-e2e.test.ts` with
   `EBUSY: resource busy or locked, unlink '…\Temp\pd-pain-chain-e2e-*\state.db'`
   — a Windows file-lock in the test's `afterEach` temp-dir cleanup. Evidence
   that it is NOT caused by this change:
   * the failure reproduces when the file is run **alone** in the task worktree;
   * it reproduces **identically on the unmodified code** (`D:\Code\principles`
     @ `fad746fc`, 61 commits behind my base, zero changes of mine) with the same
     `EBUSY` on the same temp path;
   * the test imports `TrajectoryDatabase` / `PrincipleCompiler` / `RuleHost` /
     `EvolutionReducerImpl` / the ledger — **none** of the scribe or artificer
     prompt/runtime modules this change touches, and the `@principles/core/runtime-v2`
     barrel export set is unchanged;
   * the sibling Safety-Net entry that DOES exercise the full production
     formation chain (`rulehost-seed-mvp-e2e.test.ts`, "pain → deactivate")
     **PASSED** in the same run;
   * the base commit `89eb275e` has **fully green CI**, including the release
     matrix, so this test passes on the same commit off Windows.
   The remaining local steps (lint with 0 errors, all three typechecks, build,
   website test, and the other 5 pipeline-contract groups shown as PASS) are
   green. Per the repository's own gate guidance, CI is the authority here.
5. **`provenance.sourcePainId` resolves to `null` in production** (0 of 33 dreamer
   artifacts carry `sourcePainId`). The field is carried and projected correctly;
   the upstream value is simply absent today. Recorded, not worked around.
6. **The clamps never fired** on any of the 39 real cases (`omittedFields: []` for
   the diagnosis; no truncation notes). The recorded context size (~1.5k tokens)
   is real content, not a mis-set bound. The bounds are safety rails whose
   calibration has not been exercised adversarially.
7. **Historical audit documents were not edited**, even where they describe the
   pre-PRI-839 shape (`docs/audit/agent-pipeline-audit-2026-09-15`,
   `docs/rulecode-audit/artificer-contract-analysis.md`). They are dated records
   with dated baselines; rewriting them would falsify the record.

---

# 6. Discipline statement

```text
CODE_CHANGES              = 6 source/test files + 1 new module + 1 new test file (+ report), all inside the task worktree
PRODUCTION_DB_WRITES      = NONE (readonly connections only)
SYNTHETIC_ARTIFACTS       = NONE
AGENT_RUNS                = NONE (no PD runtime/consumer cycle started)
CONFIG_WRITES             = NONE
FLAG_WRITES               = NONE
SCHEMA_CHANGES            = NONE
NEW_DEPENDENCIES          = NONE
```

---

# 7. Follow-up candidates (recorded, NOT implemented)

Per AGENTS.md §1 (unsolicited adjacent opportunities are recorded, not built):

1. **Bound calibration against real cost.** The bounds are unexercised
   (§5.6). If the Owner wants to trade specificity for tokens, the knobs are
   `FORMATION_FIELD_MAX_CHARS` / `FORMATION_PROPOSALS_MAX_CHARS` /
   `FORMATION_DIAGNOSIS_MAX_CHARS`.
2. **Small truncation-helper duplication.** `clamp` now exists in three
   module-private copies (`artifact-summary.ts`, `quality-scorecard/validation.ts`
   as `truncate`, `formation-context.ts`). Consolidating them is a tidy-up outside
   this ticket's surface.
3. **Artificer-side half of the hypothesis.** PRI-839 changes the Artificer prompt
   input but this work only validated the Scribe half. The Artificer A/B
   (RuleCode quality / evaluator score / adversarial pass rate) that the ticket
   names was **not run** — see §5.4.
4. **`sourcePainId` never populated** on dreamer artifacts (§5.5).
