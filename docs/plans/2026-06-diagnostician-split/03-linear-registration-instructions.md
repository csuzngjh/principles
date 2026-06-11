# Instruction — Register the Diagnostician Refactor into Linear

> **Audience**: an AI assistant with Linear write access.
> **Your job**: read the source docs below and create a Linear Epic + child issues that track this refactor. **Do not write product code.** Create only Linear issues, their relationships, labels, and descriptions.
> **Author of source design**: see the docs; treat them as authoritative. If a doc and this instruction conflict, ask the human owner.

---

## 0. Source documents (read ALL before creating anything)

1. `docs/adr/0014-mvp-first-strategy-and-product-pivot.md` → §Amendment (2026-06-10) "Owner Exception — Diagnostician Multi-Agent Split & Core-Principle Grounding". This authorizes the work and registers 3 feature flags.
2. `docs/plans/2026-06-diagnostician-split/00-diagnostician-refactor-plan.md` → the detailed design (architecture, contracts, phases P0–P5).
3. `docs/plans/2026-06-diagnostician-split/02-review-response-and-amendments.md` → **authoritative corrections**; where 00 and 02 disagree, 02 wins. Contains the integration checklist (§4), flag matrix (§5), task-id/retry semantics (§6), P-spike (§7), execution model (§8).
4. `docs/plans/2026-06-diagnostician-split/01-plan-review.md` and `01-plan-review2.md` → the reviews that produced the corrections (context only).

---

## 1. Global rules every issue MUST encode

Apply these to every issue description (not just the epic):

1. **TDD is mandatory.** Each issue body must contain a "TDD plan" section: list the failing tests to write FIRST, then the implementation, then the green/refactor step. Acceptance criteria must be expressed as tests where possible.
2. **Backfill requirement.** Each issue body must end with a "Developer must backfill" block stating: the developer is required to (a) post their implementation plan as a comment when moving to In Progress, and (b) post the result summary (tests run, files changed, PR link, deviations) as a comment when moving to In Review. State this explicitly per AGENTS.md Linear Workflow.
3. **Acceptance criteria** must be a checkbox list, each item objectively verifiable (a command output, a test name, a flag behavior). No vague items.
4. **Error Handbook gate.** Each implementation issue must list the relevant EP pattern cards / ERR ids it must avoid (from `docs/ERROR_PATTERN_INDEX.md`) and how. Minimum: EP-01 (trust boundary), EP-03 (fail loud), EP-07 (lineage source), plus EP-04 for CLI issues, EP-09 for test issues.
5. **PR Pre-Review Gate.** Each issue says: before handoff run `cd packages/principles-core && npm run build && npm run test`, `cd packages/openclaw-plugin && npm run build && npm run test`, `npm run lint`, and `npm run verify:merge` if present; fetch and resolve PR comments (≥2 retries on API failure).
6. **Feature-flag discipline.** Every new behavior is flag-gated, default-off, registered in `{workspace}/.pd/config.yaml` / the effective PD config feature registry path with `category`, `enabled`, `since`. The 3 flags are: `diagnostician_async_cli`, `diagnostician_core_grounding`, `diagnostician_split_pipeline` (all `category: quiet`, `enabled: false`). `diagnostician_split_pipeline` requires `diagnostician_async_cli`; `diagnostician_core_grounding` does **not** require async.
7. **Core/plugin boundary.** Pure logic → `packages/principles-core`; I/O → `packages/openclaw-plugin` / `packages/pd-cli`. Drift/consistency tests that compare core data against plugin data live in the plugin package (plugin depends on core, never reverse).
8. **No AI merge.** Issues must state the human owner merges PRs manually.
9. **Conventional commits** and branch-per-issue.

---

## 2. External dependency to record on the Epic

- **PRI-239 (feature-flag registry production loader + test)** MUST be merged before any flag-gated issue (T-D / T-E / T-F / T-G) can be marked started. Create a "blocked by PRI-239" relation on those issues. If PRI-239 is already merged, note that in the epic and skip the block.

---

## 3. Epic to create

**Title**: `Diagnostician pipeline refactor: async CLI + BasePeerRunner unification + axiom-grounded 3-stage split`

**Description must include**:
- One-paragraph problem statement covering Q1 (sync blocking 256–480s), Q2 (only runner not on BasePeerRunner), Q3 (rule-like output), Q6 (principles generated without core-axiom grounding).
- Link to all four source docs.
- The phase map P0→P5 and the rule that the old monolith stays the flag-off default until the 3-arm comparison passes (reversibility).
- The 3 feature flags and the flag-combination matrix (copy from `02` §5), including the fail-loud guard for invalid combos.
- Labels: `lesson-learned` NOT applied here; apply `diagnostician`, `refactor`, `mvp-exception` (create labels if missing).

---

## 4. Child issues (create in this order; set dependencies as specified)

> For each issue: assign to the PD/Principles team using the existing PRI numbering, link to the Epic as parent, add the labels noted, and write the body using the Global Rules (§1). Below is the REQUIRED content per issue. Expand each into full TDD plan + acceptance criteria from the source docs.

### T-A — Resolve core-principle taxonomy & owner sign-off  *(doc/prep)*
- **Why**: three-way naming collision (thinking-models.ts vs THINKING_OS.md vs FIRST_PRINCIPLES_ANALYSIS.md); see `02` §2.1.
- **Scope**: confirm the canonical 10 (T-01..T-10) anchored to `thinking-models.ts`; add T-09 + T-10 `<directive>` blocks to `.principles/THINKING_OS.md` and its EN/ZH template copies; add a non-canonical header note to `tests/feature-testing/FIRST_PRINCIPLES_ANALYSIS.md`; obtain owner sign-off on the 10 `statement` wordings.
- **Acceptance**: THINKING_OS.md (+templates) contain T-01..T-10; FIRST_PRINCIPLES doc carries the non-canonical note; owner sign-off recorded as a comment.
- **Deps**: none. **Branch**: `docs/diag-taxonomy-signoff`. **PR**: 1 (docs only).

### T-B — P-spike: validate Distiller grounding hypothesis  *(spike, decision gate)*
- **Why**: the entire Q3/Q6 value rests on "axiom-grounded distillation is more abstract"; unprovable by code review (`02` §7, RISK-1).
- **Scope**: hand-craft a Distiller prompt prototype; run ≥10 pain signals (incl. the 2 manual dogfood ones) across qwen (weak) and, where configured, one stronger model; human-rate abstraction vs monolith baseline; verify axiom refs are real, not fabricated. Throwaway script allowed; deliver a report at `docs/plans/2026-06-diagnostician-split/04-distiller-spike-report.md`.
- **Acceptance**: report exists with the rating table and an explicit **GO / CONDITIONAL GO / NO-GO** recommendation. A conditional GO must list missing evidence (for example single-model coverage or language confound) and must not be treated as production cutover approval. NO-GO ⇒ drop Q3/Q6, keep only Q1+Q2.
- **Deps**: blocked by T-A. **Branch**: `spike/distiller-grounding`. **PR**: 1 (report only).

### T-C — Core Principle Registry + drift test  *(P0)*
- **Scope**: create `packages/principles-core/src/runtime-v2/core-principles/core-principle-registry.ts` exporting `CORE_PRINCIPLES` (10, frozen), `CorePrincipleSchema`, `CORE_PRINCIPLE_IDS`, `isCorePrincipleId()`, `getCorePrinciple()`; export from the runtime-v2 barrel. Add a drift test in `packages/openclaw-plugin` asserting registry ids+titles equal `listThinkingModels()` (no workspace → fallback names), and count === 10.
- **TDD**: write the drift test + registry unit tests (id guard rejects fabricated ids; frozen) FIRST.
- **Acceptance**: registry exports the 10; drift test green; `isCorePrincipleId('T-99')===false`; architecture-regression updated if it enumerates exports; `npm run build && npm run test` green in both packages.
- **EP**: EP-01 (id guard validates `unknown`), EP-06/EP-09 (drift test asserts real runtime source, not strings).
- **Deps**: blocked by T-A. **Branch**: `feat/core-principle-registry`. **PR**: 1.
- **Note**: `PrincipleScope` `'scenario'` extension is DEFERRED to T-G (only needed when Distiller emits it). Do NOT add it here.

### T-D — Q1: async pain-record CLI  *(P1)*
- **Scope**: `pd pain record` submits + returns `<5s` with `{painId, taskId, status:"submitted", nextAction:"pd task show <taskId>"}` (strict single JSON object in `--json`); `--wait` preserves today's sync behavior and same `--json` result shape; gated by flag `diagnostician_async_cli`. Prefer the orchestrator/polling-driven submit model over a detached subprocess (`02` §8); only implement the guarded subprocess fallback if no orchestrator wake loop exists in the host context. Define `pd pain retry` semantics: retry the latest non-succeeded task for a painId (`02` §6). Add the rollback runbook (`02` §10).
- **TDD**: Commander parser-level tests FIRST (`--wait`/`--no-wait` registration, `--json` single-object, failure path does NOT spawn/mutate); then handler.
- **Acceptance**: parser tests green; `--json` emits exactly one object; failed task-creation spawns nothing and mutates nothing; flag off ⇒ legacy sync; invalid flag combo (`split && !async_cli`) fails loud with structured message.
- **EP**: EP-04 (CLI contract), EP-03 (fail loud), EP-02 (real command wiring test).
- **Deps**: blocked by PRI-239 (flags). Independent of T-B/T-C otherwise. **Branch**: `feat/diagnostician-async-cli`. **PR**: 1.

### T-E — Q6: core grounding on the existing single agent (Arm 2)  *(P2)*
- **Scope**: inject `CORE_PRINCIPLES` into the existing `DiagnosticianPromptBuilder` when `diagnostician_core_grounding` is on; capture axiom references via the existing `ambiguityNotes` field (Approach A, prompt-only, zero schema change to `DiagnosticianOutputV1`); add telemetry to measure core-principle linkage %. First sub-task: lock the observability method and prove it measurable. Preserve `principles.outputLanguage` in every owner-facing recommendation prompt.
- **TDD**: test that grounding-on injects the axioms and that the linkage metric is parseable; grounding-off leaves prompt/output unchanged; zh-CN/en output-language prompt construction remains correct.
- **Acceptance**: flag on ⇒ axioms present in prompt + linkage metric emitted; flag off ⇒ byte-identical to today; downstream contract unchanged (committer/intake untouched); Arm 2 data collectible; grounding works in sync and async monolith modes; owner-facing principle language follows `principles.outputLanguage`.
- **EP**: EP-01, EP-03; re-check `routing-policy.ts` axiom-boost distribution via telemetry (note: `coreAxiomId` is already live for bootstrap principles — see `02` §2.2, NOT dead code).
- **Deps**: blocked by T-C (registry) and T-B GO/CONDITIONAL GO. It is **not** blocked by T-D because grounding is a prompt/context enhancement and may run on the sync monolith. **Branch**: `feat/diagnostician-core-grounding`. **PR**: 1.

### T-F — Pre-P3 orchestration infrastructure (RunnerKind seam)  *(P3 prerequisite)*
- **Scope**: implement INF-0..INF-8 from `02` §4: decide & document the `RunnerKind` sibling seam vs `PeerRunnerKind` overload (INF-0 spike, recommend the seam, update `DOMAIN_MODEL.md`); add `DiagnosticianStageKind` + `DIAGNOSTICIAN_EDGES` + `RunnerKind` union; make `hydrate*`, successor proposal, `wakeOnce`, CLI dispatcher, and `DEFAULT_FEATURE_FLAGS` handle diag stages; ensure split task creation uses `serializePITaskMetadata()` envelope (NEW-1).
- **TDD**: one test per INF item (see `02` §4 checklist — each item names its test) FIRST.
- **Acceptance**: every INF-1..INF-8 checkbox test green; `isDiagnosticianStageKind('diag_rootcause')===true` and `isPeerRunnerKind('diag_rootcause')===false`; "7 peer runners" invariant in DOMAIN_MODEL.md preserved; `hydratePITaskRecord` succeeds on a split task's `diagnosticJson`.
- **EP**: EP-01, EP-07 (lineage envelope), EP-09.
- **Deps**: blocked by T-C and T-B GO. **Branch**: `feat/diagnostician-runnerkind-seam`. **PR**: 1.

### T-G — Q2+Q3: 3 split runners on BasePeerRunner + post-diagnosis trigger  *(P3 main)*
- **Scope**: implement `DiagRootCauseRunner` / `DiagDistillerRunner` / `DiagRouterRunner` each `extends BasePeerRunner` (mirror `philosopher-runner.ts` / `scribe-runner.ts`); add output schemas `DiagRootCauseOutputV1`, `DiagPrincipleDraftV1` (reuse `DiagnosticianOutputV1` for Router); 3 prompt builders; validators (A/B inline, C reuses `DiagnosticianCommitter`); `groundedOnCorePrincipleIds` validated against the registry (fail loud on fabricated ids); implement `PainSignalBridge.onDiagnosisComplete()` (admission→intake→seedDreamer, extracted from current `onPainDetected` L228-306) triggered when `diag_router` succeeds (INF-9 / P0-3); extend `PrincipleScope` with `'scenario'` here (additive) since the Distiller now emits it; preserve `principles.outputLanguage` through Distiller and Router; gate the whole chain on `diagnostician_split_pipeline`. **First sub-task: finalize the per-stage `buildContext()` signatures and `onDiagnosisComplete()` signature into `00` §7.2 before coding.**
- **TDD**: V-slice tests per runner (lease→…→succeed/fail, dependency-not-succeeded, no-dependency) FIRST; e2e test that one pain signal completes A→B→C and triggers admission/intake/seedDreamer; architecture-regression `extends BasePeerRunner` assertions + REQUIRED_SOURCE/TEST/EXPORTS updates.
- **Acceptance**: 3 V-slices green; e2e chain green incl. post-diagnosis trigger; fabricated axiom id rejected; lineage consistency checks (`sourceRootCauseArtifactId`) enforced; zh-CN/en output-language prompt construction covered; flag off ⇒ monolith runs unchanged; valid flag combos pass, invalid fail loud.
- **EP**: EP-01, EP-03, EP-05 (per-iteration retry freshness), EP-07 (lineage), EP-02 (real chain wiring).
- **Deps**: blocked by T-F, T-E, T-B GO. **Branch**: `feat/diagnostician-split-runners`. **PR**: 1 (may be split into 2 PRs if size demands: PR-1 schemas+builders+validators, PR-2 runners+chaining+onDiagnosisComplete — note this option in the issue).

### T-H — P4: 3-arm comparison harness + report  *(validation)*
- **Scope**: run baseline (Arm 1) / grounded-single (Arm 2) / split (Arm 3) over the same corpus (≥10 real pain signals across all 4 root-cause categories, `02` §P1-3); score abstraction quality, core-principle linkage, downstream candidate validity, completion rate, latency (informational); write `docs/plans/2026-06-diagnostician-split/05-comparison-report.md` with a GO/NO-GO.
- **Acceptance**: report with the scored table for all 3 arms and a go/no-go recommendation backed by the metrics.
- **Deps**: blocked by T-D, T-E, T-G. **Branch**: `chore/diagnostician-3arm-comparison`. **PR**: 1 (report + harness).

### T-I — P5: flip defaults, retire monolith, docs  *(cutover)*
- **Scope**: on GO, flip the 3 flags' documented defaults; mark the monolith `DiagnosticianRunner` MVP-Quiet then delete it; update `DOMAIN_MODEL.md` and `00`/`02` status to "implemented"; remove dual-maintenance note.
- **Acceptance**: monolith deleted; all tests green with split as default; docs updated; rollback still possible by flag flip until deletion.
- **Deps**: blocked by T-H GO. **Branch**: `refactor/retire-diagnostician-monolith`. **PR**: 1.

---

## 5. Dependency graph (encode as Linear "blocks/blocked-by")

```
PRI-239 ─────────────┐ (external, flags)
                     ▼
T-A ──► T-B(GO/conditional GO gate) ─┬──────► T-E ─┐
  │                   │                      │
  └──► T-C ──────────►┼──► T-F ──► T-G ──────┼──► T-H ──► T-I
                      │            ▲          │
              T-D ─────────────────────────────┘
   (T-D also blocked by PRI-239; T-F/T-G blocked by PRI-239 via their flags)
```

- T-A blocks T-B and T-C.
- T-B (GO or explicit conditional GO) gates T-E, T-F, T-G. Conditional GO allows implementation to continue but must be carried into T-H as unresolved validation risk. If NO-GO, cancel T-E/T-F/T-G/T-H/T-I and keep only T-D + a reduced Q2-only unification issue — note this branch in the epic.
- T-C blocks T-E and T-F.
- T-F blocks T-G. T-D + T-E + T-G block T-H. T-H blocks T-I.
- T-D, T-E, T-F, T-G depend on the production feature-flag/config loader. `diagnostician_split_pipeline` additionally depends on `diagnostician_async_cli`; `diagnostician_core_grounding` does not.

---

## 6. Branch & PR plan (summary)

- **9 issues → 9 branches → 9 PRs** baseline, with T-G optionally split into 2 PRs (so up to 10 PRs).
- Doc/spike-only PRs: T-A, T-B, T-H (report), T-I (mostly deletion+docs).
- Code PRs: T-C, T-D, T-E, T-F, T-G.
- Each PR targets `main`, branch-per-issue, human owner merges manually (no AI merge).
- Parallelizable once T-A done: T-C and T-D can run in parallel; T-B runs parallel to T-C/T-D.

---

## 7. What to put in EVERY issue body (template)

```
## Context
<2-3 lines + links to 00/02/ADR>

## Scope (in / out)
<from the per-issue scope above; explicitly list out-of-scope>

## TDD plan
1. Failing tests to write first: <names>
2. Implementation
3. Green + refactor

## Acceptance criteria
- [ ] <objective, testable items>

## Error Handbook gate
- Relevant EP cards / ERR ids: <list>
- How this issue avoids each: <one line each>

## Dependencies
- Blocked by: <issues / PRI-239>
- Blocks: <issues>

## Branch / PR
- Branch: <name>  · PRs: <n>  · Target: main · Merge: human owner only

## Developer must backfill (mandatory)
- On In Progress: post implementation plan as a comment.
- On In Review: post result summary (tests run, files changed, PR link, deviations, EP checklist).
- Update issue status per AGENTS.md Linear Workflow.
```

---

## 8. Final checks for the registering AI

- Do NOT create product code or branches; create Linear issues + relations + labels only.
- Verify each issue has: TDD plan, checkbox acceptance criteria, EP gate, explicit deps, branch/PR plan, backfill block.
- Echo back to the human: the created Epic id, the 9 issue ids, and the dependency edges, so the human can verify completeness before work starts.
