# Diagnostician Refactor — Detailed Design

> **Status**: Proposed (design)
> **Date**: 2026-06-10
> **Owner exception**: ADR-0014 Amendment (2026-06-10)
> **Scope**: `DiagnosticianRunner` + supporting context/output contracts + CLI pain-record path.
> **Authorizing docs**: `docs/adr/0014-mvp-first-strategy-and-product-pivot.md` §Amendment(2026-06-10), `docs/architecture/DOMAIN_MODEL.md`, `docs/articles/04-soft-to-hard-rules-en.md`.
>
> ⚠️ **READ FIRST**: `02-review-response-and-amendments.md` records verified corrections to this document (canonical core-principle set, orchestration ontology seam, integration checklist, flag matrix, P-spike, execution model). Where the two disagree, **02 wins** until folded in. Reviews: `01-plan-review.md`, `01-plan-review2.md`.

---

## 0. TL;DR

We refactor the monolithic diagnostician along three independent axes, each behind its own feature flag, each measurable and reversible:

1. **Q1 — CLI async**: `pd pain record` becomes submit-and-return (`< 5s`), background diagnosis, `--wait` keeps legacy sync. Solved at the CLI process boundary only; no `core` rearchitecture.
2. **Q2 — Architectural unification**: the diagnostician joins the other 7 peer runners by being rebuilt on `BasePeerRunner`.
3. **Q3 + Q6 — Quality**: the single overloaded LLM call is split into a 3-stage chain (Root-Cause → Distiller → Router), and the Distiller is **grounded** on a structured Core Principle Registry (T-01..T-10) so distilled principles grow from existing axioms instead of being invented in a vacuum.

The old single-agent path stays intact and flag-selected until a **3-arm comparison** proves the new path is equal-or-better. The downstream contract (`DiagnosticianOutputV1` + `PIArtifact` + candidates) is unchanged, so the whole refactor is a zero-migration toggle.

---

## 1. Problem statement (grounded in code, not speculation)

### Q1 — Synchronous CLI blocking (256–480s)
`pd pain record` awaits a 5-layer chain:

```
CLI handler (await)
  └─ PainToPrincipleService.recordPain() (await)
       └─ PainSignalBridge.onPainDetected() (await)
            └─ DiagnosticianRunner.run() (await)
                 └─ PiAiRuntimeAdapter.startRun() (await completeSimple)
```

There is no separation between *submit* and *complete*. The CLI cannot wait 4–8 minutes; operators interpret the hang as failure and Ctrl-C, aborting the diagnosis. `PiAiRuntimeAdapter` chose `completeSimple` (block until done) where `streamSimple` (return immediately) was available.

### Q2 — Architectural inconsistency
`DiagnosticianRunner` is the **only** runner that does not extend `BasePeerRunner`. It re-implements lease → buildContext → invoke → poll → fetch → validate → retry/fail (~300 lines) that all 7 other runners (Dreamer, Philosopher, Scribe, Artificer, Evaluator, RolloutReviewer, Trainer) inherit. This is a maintenance and correctness liability — every base-class fix (e.g. the final-poll-before-cancel improvement in `BasePeerRunner.pollUntilTerminal`) must be hand-ported.

### Q3 — Rule-like, insufficiently abstract output
A single LLM call runs all four phases (evidence → 5-Whys → classification → taxonomy+distillation across 5 kinds). With a small/local model this overload produces principles that read like rules (specific `triggerPattern`/`action`) rather than abstract, cross-scenario wisdom. Per `04-soft-to-hard-rules-en.md`, principles are *directional, reconcilable, judgment-dependent*; rules are *boundary-oriented, deterministic*. The monolith collapses that distinction.

### Q6 — Principles generated in a vacuum
`DiagnosticianContextPayload` has no field for the core axioms. The system has T-01..T-10 (think-os) in runtime code and templates, but did not previously expose them as structured, injectable data to the diagnostician. So distilled principles do not reference or grow from the principle hierarchy described in `DOMAIN_MODEL.md` (Core → Domain → Scenario).

---

## 2. Design constraints (hard rules for this work)

1. **Core vs plugin boundary** (AGENTS.md §Critical Rules 1): all new pure logic (registry, schemas, prompt builders, validators, runners) goes in `packages/principles-core`. The only plugin/CLI-layer change is the fire-and-forget process spawn for Q1.
2. **No `any`** — untrusted LLM output is `unknown` until validated (Runtime Contract Rules 1–4; ERR-001/005).
3. **Downstream contract frozen**: the final stage emits the existing `DiagnosticianOutputV1`; `DiagnosticianCommitter`, `CandidateIntakeService`, and the 5 recommendation kinds are untouched.
4. **Everything flag-gated, default-off** (PRI-239 contract). Disable = flip flag, never PR revert.
5. **No deferred-ADR resurrection**: no scheduler, event bus, BALM, LRAS, GAP. Q1 is CLI-process-local.
6. **Reversibility**: old single-agent runner remains the flag-off default until the comparison passes.

---

## 3. Target architecture — 3-stage diagnostician chain

The monolith's four phases map cleanly onto three peer runners that reuse the existing `dependencyTaskIds` + `PIArtifact` chaining (identical to Dreamer→Philosopher→Scribe):

```
PainSignal
   │  (host seeds first task)
   ▼
┌──────────────────────────────┐
│ A. DiagRootCauseRunner        │  taskKind: 'diag_rootcause'
│  Phases 1–3                   │  in : DiagnosticianContextPayload (+fullTrace, evidence)
│  evidence → 5-Whys → classify │  out: DiagRootCauseOutputV1  (PIArtifact)
└──────────────────────────────┘
   │  dependencyTaskIds=[A]
   ▼
┌──────────────────────────────┐
│ B. DiagDistillerRunner        │  taskKind: 'diag_distiller'
│  Phase 4a — distillation      │  in : A's artifact + Core Principle Registry (T-01..T-10)
│  GROUNDED on core axioms      │  out: DiagPrincipleDraftV1   (PIArtifact)
└──────────────────────────────┘
   │  dependencyTaskIds=[B]
   ▼
┌──────────────────────────────┐
│ C. DiagRouterRunner           │  taskKind: 'diag_router'
│  Phase 4b — taxonomy routing  │  in : B's artifact (+ A's root cause)
│  → 5 recommendation kinds     │  out: DiagnosticianOutputV1  (UNCHANGED contract)
└──────────────────────────────┘
   │
   ▼
DiagnosticianCommitter → PIArtifact + principle_candidates  (UNCHANGED)
```

### Responsibility split (why three, not two or four)

| Stage | Cognitive job | Why isolated |
|-------|---------------|--------------|
| **A. Root-Cause** | Forensic: what happened, why (5-Whys), which category. Pure analysis, no prescription. | Smallest, most evidence-bound task; a weak model can do this reliably. Output is reusable regardless of downstream form. |
| **B. Distiller** | Abstraction: lift the root cause to a principle that *grows from* a T-0x axiom. Produces ONE abstract principle draft, not 5 mixed kinds. | This is where Q3/Q6 live. Isolating distillation + giving it ONLY the axioms + root cause forces abstraction and prevents rule-like leakage. |
| **C. Router** | Taxonomy: given an abstract principle + root cause, decide the concrete carrier(s): principle / rule / implementation / prompt / defer. | Routing is a different skill from distillation. Keeping the existing `DiagnosticianOutputV1` here means downstream is untouched and the refactor is reversible. |

Four would over-fragment (latency, more chaining surface); two would re-merge distillation and routing — the exact overload causing Q3.

### What each stage does NOT do
- A never prescribes fixes (no recommendations).
- B never picks a channel/kind (no taxonomy).
- C never re-derives root cause or invents new principles (it routes what B produced).

This is the "divide and conquer" axiom (T-09) applied to the diagnostician itself.

---

## 4. Core Principle Registry (T-01..T-10) — Q6 foundation

> **CORRECTED 2026-06-10** (see `02-review-response-and-amendments.md` §2.1). Earlier drafts of this section used the FIRST_PRINCIPLES_ANALYSIS.md naming and a 9-entry count. That was wrong. The canonical core-principle set is the **think-os 10 built-in models** defined in `packages/openclaw-plugin/src/core/thinking-models.ts` (T-01..T-10) — the same set the owner referred to as "内置的 10 个原则" — which already populates `coreAxiomId` at bootstrap. The registry MUST mirror that runtime authority, not the FIRST_PRINCIPLES analysis doc.

### 4.1 Promotion from markdown to structured data

Today the canonical set lives in `thinking-models.ts` (ids + fallback names/statements) and in the updated per-workspace `THINKING_OS.md` templates. We promote them to a **frozen, read-only** pure-logic module in core, anchored to the `thinking-models.ts` ids/names. This is NOT a re-activation of general Thinking-OS prompt injection (that stays MVP-Quiet per ADR-0014 §2.5); it is a narrow data source consumed ONLY by the Distiller stage.

`packages/principles-core/src/runtime-v2/core-principles/core-principle-registry.ts`:

```ts
/** A think-os core axiom. Frozen, owner-curated, read-only. Ids/names mirror thinking-models.ts. */
export interface CorePrinciple {
  readonly id: `T-${string}`;   // 'T-01' .. 'T-10'
  readonly title: string;        // matches thinking-models.ts getFallbackName
  readonly statement: string;    // one-line directive used for grounding
  readonly scope: 'core_axiom';
}

// Titles/statements mirror thinking-models.ts getFallbackName/getFallbackDescription.
// Owner may refine the `statement` wording (pre-P0 sign-off); the id↔identity is pinned
// to the runtime set because routing-policy.ts keys behavior off these ids.
export const CORE_PRINCIPLES: readonly CorePrinciple[] = Object.freeze([
  { id: 'T-01', title: 'Survey Before Acting',     statement: 'Understand the structure first before making changes.',          scope: 'core_axiom' },
  { id: 'T-02', title: 'Respect Constraints',      statement: 'Trust files/constraints, not the context window.',               scope: 'core_axiom' },
  { id: 'T-03', title: 'Evidence Over Assumption', statement: 'Use logs, code, and outputs before inferring causes.',           scope: 'core_axiom' },
  { id: 'T-04', title: 'Reversible First',         statement: 'Prefer changes that are safe to roll back when risk is high.',    scope: 'core_axiom' },
  { id: 'T-05', title: 'Safety Rails',             statement: 'Call out guardrails, prohibitions, failure-prevention.',          scope: 'core_axiom' },
  { id: 'T-06', title: 'Simplicity First',         statement: 'Prefer the smallest understandable solution over over-engineering.', scope: 'core_axiom' },
  { id: 'T-07', title: 'Minimal Change Surface',   statement: 'Limit the blast radius and touch only what is necessary.',        scope: 'core_axiom' },
  { id: 'T-08', title: 'Pain As Signal',           statement: 'Treat failures and friction as clues to step back and rethink.',  scope: 'core_axiom' },
  { id: 'T-09', title: 'Divide And Conquer',       statement: 'Split the task into smaller phases before execution.',            scope: 'core_axiom' },
  { id: 'T-10', title: 'Memory Externalization',   statement: 'Write intermediate conclusions to files for persistence.',        scope: 'core_axiom' },
] as const);
```

> **Drift test target**: assert this registry matches `thinking-models.ts` `getFallbackName`/`getFallbackDescription` (NOT THINKING_OS.md, which is per-workspace, localized, and currently incomplete at 8 entries). A secondary non-blocking check warns when a workspace `THINKING_OS.md` omits an id; pre-P0 we extend THINKING_OS.md to add T-09/T-10. `FIRST_PRINCIPLES_ANALYSIS.md` is marked non-canonical.

> **Note**: the exact `statement` wording is owner-editable; the canonical source of truth for full text remains `THINKING_OS.md`. The registry holds the short, injectable form. A unit test asserts every `THINKING_OS.md` T-id has a registry entry (drift guard).

### 4.2 Grounding contract

The Distiller (B) receives `CORE_PRINCIPLES` in its prompt and MUST emit `groundedOnCorePrincipleIds: string[]` — the axiom(s) the distilled principle grows from. Rules:

- If the model cannot tie the principle to any axiom, it must either (a) pick the closest axiom and explain the linkage, or (b) emit `confidence < 0.3` and defer. It must NOT fabricate an axiom id outside T-01..T-10 (validated against the registry — fail loud, ERR-001/003).
- This makes the principle hierarchy (`DOMAIN_MODEL.md`: Core → Domain → Scenario) observable: a distilled principle is a Domain/Scenario principle hanging off a Core axiom.

---

## 5. Data contracts

All schemas are TypeBox, live in core, and validate untrusted LLM output as `unknown` first (ERR-001).

### 5.1 Stage A — `DiagRootCauseOutputV1`
`core-principles`-adjacent file `runtime-v2/diag/diag-rootcause-output.ts`:

```ts
DiagRootCauseOutputV1 = {
  valid: boolean;
  diagnosisId: string;
  taskId: string;                       // lineage (re-injected if stripped; ERR-008)
  summary: string;
  causalChain: Array<{ why: number; statement: string; evidenceRefs: string[] }>; // Why-1..Why-5
  rootCause: string;                    // MUST be prefixed People:/Design:/Assumption:/Tooling:
  rootCauseCategory: 'People'|'Design'|'Assumption'|'Tooling';
  evidence: Array<{ sourceRef: string; note: string }>;
  confidence: number;                   // 0..1
  ambiguityNotes?: string[];
};
```

### 5.2 Stage B — `DiagPrincipleDraftV1`
`runtime-v2/diag/diag-principle-output.ts`:

```ts
DiagPrincipleDraftV1 = {
  valid: boolean;
  taskId: string;
  sourceRootCauseArtifactId: string;    // lineage consistency check (ERR-004)
  abstractedPrinciple: string;          // ≤200 chars, abstract, cross-scenario
  rationale: string;                    // why this principle addresses the root cause
  groundedOnCorePrincipleIds: string[]; // subset of T-01..T-10 (validated vs registry)
  scope: 'general' | 'domain' | 'scenario';
  confidence: number;                   // 0..1
  ambiguityNotes?: string[];
};
```

### 5.3 Stage C — reuse `DiagnosticianOutputV1` (unchanged)
The Router emits exactly today's `DiagnosticianOutputV1` (`runtime-v2/diagnostician-output.ts`). It fills `violatedPrinciples` from A's root cause + B's grounding, and `recommendations[]` from its taxonomy decision. **No schema change downstream.**

### 5.4 Context payload extension (additive, backward-compatible)
Add an OPTIONAL field to `DiagnosticianContextPayloadSchema`:

```ts
corePrinciples: Type.Optional(Type.Array(CorePrincipleSchema)),
```

Optional ⇒ existing single-agent path and all current tests keep passing untouched. Only the grounded paths populate it.

---

## 6. Q1 — CLI async design (ships first, CLI-layer only)

### 6.1 Behavior
`pd pain record`:
- **Default (flag `diagnostician_async_cli` on)**: create pain signal + create the first diag task → print `{ painId, taskId, status: "submitted" }` (strict JSON in `--json` mode) → return in `< 5s`. Diagnosis is completed by the existing persisted-task/orchestrator path. A detached subprocess is **not** the primary design.
- **`--wait`**: legacy synchronous behavior (blocks until terminal). Mutually exclusive with the default async note in output.
- **flag off**: unchanged sync behavior (today's path).

### 6.2 Why persisted-task submit/complete separation (not detached subprocess)
ADR-0014 §9 forbids event-driven rearchitecture. The submit/complete split is achieved by reusing the task store and runner/orchestrator mechanics already present in PD:
- CLI persists the task, returns the ids, and does not own long-running diagnosis execution.
- `core` remains the source of task state. `pd task show <taskId>` reflects `pending → leased → succeeded | retry_wait | failed`.
- Crash safety comes from persistence before execution. `retry_wait` + the existing retry policy recover interrupted diagnosis work on the next worker pass.
- A detached subprocess is allowed only as an explicitly guarded fallback for a host with no runner/orchestrator wake path; it must use a taskId single-spawn guard and redirected logs.

### 6.3 CLI / Operator gate compliance (AGENTS.md)
- **JSON strict**: async output is exactly one JSON object on stdout (`painId`, `taskId`, `status`, `nextAction: "pd task show <taskId>"`).
- **Exit paths stop execution**: after spawning + printing, the handler returns; no later DB writes.
- **`--wait` registered + parser test**: add a Commander parser-level test (not just handler test).
- **Failure paths don't mutate**: if task creation fails, no background execution is scheduled and no successor is seeded.
- **Operator next action**: output always includes how to observe progress.

### 6.4 Telemetry
`diag_submitted` (CLI), then per-stage events from the runners (§7.4). Latency SLO: CLI return `< 5s`, diagnosis completion rate `> 95%` (matches the AI's prior analysis target).

---

## 7. Q2 — BasePeerRunner unification + the three runners

### 7.1 Approach: build the three NEW runners on BasePeerRunner; leave the monolith untouched
We do **not** spend effort migrating the existing monolith to `BasePeerRunner` (it would be throwaway once split). Instead:
- The three new runners (`DiagRootCauseRunner`, `DiagDistillerRunner`, `DiagRouterRunner`) each `extends BasePeerRunner<TContext, TOutput>` from day one, mirroring `PhilosopherRunner`/`ScribeRunner`.
- The existing `DiagnosticianRunner` stays exactly as-is as the flag-off fallback until the comparison passes, then is deleted (becomes MVP-Quiet code pending removal).

This satisfies Q2 (the diagnostician now lives on the unified base) without a risky intermediate rewrite, and keeps the old path bit-for-bit reversible.

### 7.2 Each runner implements the 5 abstract members
Per `BasePeerRunner`: `permanentErrorCategories`, `buildContext`, `invokeRuntime`, `validateOutput`, `succeedTask`, plus optional `postFetchTransform` (re-inject `taskId` lineage — ERR-008) and `emitSuccessTelemetry`. This is the exact shape `ScribeRunner`/`PhilosopherRunner` already use.

- **A.buildContext**: assembles `DiagnosticianContextPayload` from the pain signal (reuses existing `ContextAssembler`).
- **B.buildContext**: resolves A's `PIArtifact` via `artifactStore.listBySourceTaskId(depId)`; attaches `CORE_PRINCIPLES` when `diagnostician_core_grounding` is on; attaches the owner-selected principle output language from `principles.outputLanguage`.
- **C.buildContext**: resolves B's `PIArtifact` (and A's for root-cause echo).
- **C.succeedTask**: reuses the existing `DiagnosticianCommitter` to write the artifact + principle candidates (unchanged downstream).
- **A/B.succeedTask**: write their stage `PIArtifact` only (no candidate commit), exactly like Philosopher/Scribe.

### 7.3 Chaining / orchestration
> **CORRECTED (see 02 §2.3)**: the chain reuses the orchestrator *mechanics* but NOT the internalization *ontology*. We do **not** add diag stages to `PeerRunnerKind`/`ALLOWED_EDGES` (that would corrupt the documented "7 Peer Runners" invariant). Instead a sibling seam — `DiagnosticianStageKind` + `DIAGNOSTICIAN_EDGES` + a `RunnerKind` union — is wired through the generic orchestrator paths. See 02 §4 (Pre-P3 Integration Checklist INF-0..INF-9) for the file-by-file changes.

Conceptually identical to the internalization pipeline:
- On `diag_rootcause` success, the orchestrator seeds `diag_distiller` with `dependencyTaskIds=[rootcauseTaskId]`.
- On `diag_distiller` success, seed `diag_router` with `dependencyTaskIds=[distillerTaskId]`.
- Split tasks MUST be created with the `pi_metadata` envelope via `serializePITaskMetadata()` (02 §NEW-1/INF-8) or `hydrate*` returns null and the dependency gate blocks them forever.
- When `diagnostician_split_pipeline` is off, the legacy single `diagnosis_${painId}` task is seeded instead.
- After `diag_router` succeeds, `PainSignalBridge.onDiagnosisComplete()` runs admission → intake → seedDreamer (02 §INF-9 / P0-3). This was previously inline in `onPainDetected()` and MUST be extracted, or the downstream pipeline silently stalls.

### 7.4 Per-stage telemetry (Q3/Q6 observability)
- A: `diag_rootcause_task_leased|context_built|run_started|task_succeeded|run_failed`, payload includes `rootCauseCategory`, `causalChainDepth`.
- B: `diag_distiller_*`, payload includes `groundedOnCorePrincipleIds`, `scope`, `abstractionConfidence`.
- C: `diag_router_*`, payload includes the `recommendations[].kind` histogram.

These let us measure abstraction quality and core-principle linkage rate directly from telemetry.

### 7.4.1 Output language contract

The split path must preserve the existing owner language preference introduced by PRI-332/PRI-336. The Distiller and Router must receive `principles.outputLanguage` and produce owner-facing principle text in that language. A split implementation that improves abstraction but regresses Chinese/English selection is a product regression, not an acceptable trade-off. Tests must cover at least:

- `principles.outputLanguage: zh-CN` → principle/recommendation text is requested in Chinese.
- `principles.outputLanguage: en` → principle/recommendation text is requested in English.
- Missing config → existing default behavior is preserved and reported through the effective config path.

### 7.5 Latency note (split makes sync worse — that's why Q1 is the prerequisite)
3 serial LLM calls ⇒ worst-case 540–1440s synchronous. This is acceptable ONLY because Q1 (async submit) ships first; the operator never waits on it. The split MUST NOT be enabled before `diagnostician_async_cli` is proven.

---

## 8. 3-arm comparison harness (the acceptance gate)

Before deleting the monolith, we prove the new path is equal-or-better.

| Arm | `async_cli` | `core_grounding` | `split_pipeline` | What it isolates |
|-----|-------------|------------------|------------------|------------------|
| **1. Baseline** | on | off | off | Today's single agent (control). |
| **2. Grounded-single** | off or on | on | off | Pure effect of core grounding (Q6) on the existing single agent; grounding does not require async. |
| **3. Split** | on | on | on | Full target: split + grounding (Q3+Q6). |

### 8.1 Corpus
A fixed set of real dogfood pain signals (including the two manual ones already captured: `manual_1781081305247_*`, `manual_1781081347155_*`) plus synthetic baseline signals. Same inputs through all three arms.

### 8.2 Scored metrics
| Metric | How measured | Target (Arm 3 vs Arm 1) |
|--------|--------------|-------------------------|
| **Abstraction quality** | Heuristic + manual rubric: principle vs rule-like (presence of concrete paths/tools/commands in `abstractedPrinciple`). | Arm 3 ≥ Arm 1 (fewer rule-like leaks) |
| **Core-principle linkage** | `% recommendations whose principle carries ≥1 valid `groundedOnCorePrincipleIds`. | Arm 1 = 0% (no field); Arm 3 high |
| **Downstream candidate validity** | `% candidates that pass `CandidateIntakeService` without rejection. | Arm 3 ≥ Arm 1 |
| **Completion rate** | `% diagnoses reaching `succeeded`. | Arm 3 ≥ 95% |
| **Latency (informational)** | submit→complete wall clock. | Recorded, not gating (async hides it) |

### 8.3 Output
A report at `docs/plans/2026-06-diagnostician-split/05-comparison-report.md` with the scored table and a go/no-go recommendation. Go ⇒ flip flags default-on (still flag-gated) and schedule monolith deletion. No-go ⇒ flip `split_pipeline` off; system reverts with zero migration.

---

## 9. Phased delivery (incremental, each phase independently shippable & reversible)

Ordering is chosen so every phase is safe alone and the riskiest work (split) is last and fully gated.

| Phase | Deliverable | Flag | Risk | Reversible by |
|-------|-------------|------|------|---------------|
| **P0** | Core Principle Registry + drift test (additive, no behavior change). Optional `corePrinciples` field on context schema. | none (pure data) | minimal | n/a (dormant data) |
| **P1** | **Q1 CLI async**: `pd pain record` submit/return + `--wait` + parser tests. | `diagnostician_async_cli` | low (CLI-only) | flag off |
| **P2** | **Q6 grounding on single agent**: inject registry into existing prompt; measure linkage without changing `DiagnosticianOutputV1`; preserve `principles.outputLanguage`. | `diagnostician_core_grounding` | low | flag off |
| **P3** | **3 new runners on BasePeerRunner** (A/B/C) + schemas + prompt builders + validators + successor seeding. Old monolith untouched. | `diagnostician_split_pipeline` | medium | flag off (monolith runs) |
| **P4** | **Comparison harness + report**; go/no-go. | uses flags above | low | n/a |
| **P5** | On "go": defaults flipped; monolith marked MVP-Quiet then deleted; docs/DOMAIN_MODEL updated. | — | low | revert flag flip |

Each phase is one (or a few) PRI issue(s), respects the PR Pre-Review Gate, and answers nothing new for the MVP Three Questions beyond the ADR amendment.

---

## 10. Error Handbook gate (mandatory pre-implementation)

Relevant ERR classes this design must avoid (min. 3, per AGENTS.md):

- **ERR-001 / ERR-005** ("`as` bypasses validation"): every stage output is `unknown` until TypeBox-validated. Validators must runtime-check `groundedOnCorePrincipleIds` elements against the registry and `errorCategory` from injected validators (mirror `ScribeRunner.validateOutput`).
- **ERR-004 / ERR-008** ("lineage fields from same source / stale loop state"): B checks `sourceRootCauseArtifactId` matches `buildContext`'s resolved artifact; A/B/C re-inject `taskId` via `postFetchTransform` (mirror `injectRunnerLineageIfAbsent`). Each retry iteration recomputes context from the store, never reuses stale artifact ids.
- **ERR-014 / ERR-016 / ERR-017** ("preview/telemetry must be bounded + safe serialize"): all telemetry payloads use bounded values; any raw-output preview uses `safeStringifyPreview` (already used in the monolith's `fetchAndParseOutput`).
- **ERR-002** ("graceful degradation needs a reason"): if grounding registry is empty or a stage defers, emit a structured reason in telemetry + output `ambiguityNotes`; never silently fall back.

How recurrence is prevented is restated per-PR in the implementation brief.

---

## 11. Testing strategy

- **Unit**: registry drift test (THINKING_OS ↔ registry); each schema's accept/reject cases; each validator (valid, missing-required fail-loud, invalid axiom id rejected, lineage mismatch rejected).
- **V-slice** (mirror `scribe-runner-vslice.test.ts`): each runner's lease→...→succeed/fail with a fake adapter; dependency-not-succeeded path; no-dependency fail path.
- **Parser** (CLI): `--wait` / `--no-wait` registration; JSON-mode single-object output; failure path does not schedule background execution.
- **Architecture regression**: extend `architecture-regression.test.ts` to assert the three new runners extend `BasePeerRunner` and core stays I/O-free (no new plugin imports).
- **Real-LLM** (opt-in, mirror `*-runner-real-llm.test.ts`): smoke each stage against the configured model.
- **Merge gate**: `cd packages/principles-core && npm run build && npm run test`, `cd packages/openclaw-plugin && npm run build && npm run test`, `npm run lint`, `npm run verify:merge` once before handoff.

---

## 12. Risks & mitigations

| Risk | Prob | Impact | Mitigation |
|------|------|--------|------------|
| Split triples latency | high | medium | Q1 async ships first and is the hard prerequisite; latency is non-gating once submit/return works. |
| New chaining bugs (lost successor, double-seed) | med | medium | Reuse the proven Dreamer→Philosopher→Scribe seeding mechanism verbatim; v-slice tests for each hop; idempotent commit key. |
| Grounding makes output worse (model over-fits to axioms) | low | medium | Arm 2 isolates grounding; if it regresses, ship split without grounding or tune the prompt. |
| Monolith and split drift during the parallel period | med | low | Downstream contract is identical (`DiagnosticianOutputV1`); only the producer differs. Delete monolith promptly on "go". |
| Registry text diverges from THINKING_OS.md | low | low | Drift unit test fails the build. |
| Background diagnosis execution gets orphaned or invisible | low | med | Primary path is persisted-task/orchestrator execution; any subprocess fallback requires taskId single-spawn guard and redirected logs. |

---

## 13. Open questions for owner

> **Q1 RESOLVED (02 §2.1)**: the canonical set is the **10** think-os models in `thinking-models.ts` (T-01..T-10), not the FIRST_PRINCIPLES 9. Registry corrected in §4.1. Remaining owner action: sign off on the 10 `statement` wordings (pre-P0) — you may keep the more abstract FIRST_PRINCIPLES *wording* in `statement` as long as the *ids* stay pinned to the runtime set (routing-policy.ts keys off them).

1. **Registry wording sign-off**: confirm/edit the 10 `statement` lines (full text stays in THINKING_OS.md; we extend it to add T-09/T-10).
2. **Grounding scope**: is `diagnostician_core_grounding` diagnostician-only (recommended), or eventually available to Dreamer/Philosopher too? (Roadmap only; out of scope here.)
3. **Comparison rubric**: automated heuristic only, or owner manual review of the report? Recommend heuristic + your spot-check.
4. **Orchestration seam (02 §2.3 INF-0)**: approve the `RunnerKind` sibling-seam approach (keeps "7 Peer Runners" clean) vs the simpler `PeerRunnerKind` overload (needs a DOMAIN_MODEL.md note). Recommend the seam.

---

## 14. Summary

This design fixes all four diagnostician defects without violating MVP-First: Q1 via a persisted-task async submit, Q2 by rebuilding the diagnostician on the shared `BasePeerRunner`, and Q3+Q6 by splitting distillation from routing and grounding distillation on a structured T-01..T-10 registry. 

**Update (2026-06-12)**: The comparison report proved the split pipeline's superior quality. Per owner decision, the old monolith path has been completely deleted and the split pipeline is now the sole implementation (no fallback pathways or long-term compatibility switches remain) to keep the architecture clean and maintainable.
