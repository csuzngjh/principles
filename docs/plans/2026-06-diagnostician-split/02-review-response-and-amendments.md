# Diagnostician Refactor — Review Response & Plan Amendments

> **Status**: Accepted amendments to `00-diagnostician-refactor-plan.md`
> **Date**: 2026-06-10
> **Inputs**: `01-plan-review.md` (Trae), `01-plan-review2.md` (Qoder)
> **Method**: independent code re-verification of every load-bearing P0 claim before adoption.

This document records which review findings we adopt, where the reviews were themselves inaccurate (verified against code), and the concrete amendments to the plan. Where this doc and `00-…-plan.md` disagree, **this doc wins** until `00` is folded in.

---

## 1. Verdict

Both reviews are high quality and code-grounded. I re-verified the load-bearing claims against the source rather than trusting the prose:

- **P0-2 (orchestration ontology)** — CONFIRMED. `PeerRunnerKind` is exactly 7 values, gated by `isPeerRunnerKind`; `PITaskRecord.taskKind` must be a `PeerRunnerKind` and requires a `channel`; `ALLOWED_EDGES` is a 6-edge linear chain; `hydratePITaskRecord` returns `null` for non-peer kinds. The split cannot reuse the chaining mechanism without infrastructure changes. **Adopt.**
- **P0-1 (core-principle taxonomy)** — CONFIRMED and worse than reported (see §2.1; it is a *three*-way collision, and our own `00` plan used the wrong naming).
- **P0-3 / NEW-1 / NEW-5 (post-diagnosis trigger, pi_metadata envelope, successor ownership)** — CONFIRMED against `pain-signal-bridge.ts` and `pitask-metadata.ts`. **Adopt.**

**We adopt the overwhelming majority of both reviews.** Two specific claims are factually wrong and are corrected below; one recommendation (extend `PeerRunnerKind`) we accept only with an ontology guard.

---

## 2. Corrections — where the reviews (and our own plan) were wrong

### 2.1 The canonical core-principle set is `thinking-models.ts` (T-01..T-10), not FIRST_PRINCIPLES, and not (only) THINKING_OS.md

Both reviews framed P0-1 as a **two-way** conflict (THINKING_OS.md 8 vs FIRST_PRINCIPLES 9) and recommended "declare THINKING_OS.md authoritative + add T-09". Code verification shows it is a **three-way** collision, and the real runtime authority is a third file neither review named as canonical:

| ID | `thinking-models.ts` fallback name (RUNTIME) | `THINKING_OS.md` name (per-workspace content) | `FIRST_PRINCIPLES_ANALYSIS.md` (analysis doc) |
|----|----|----|----|
| T-01 | Survey Before Acting | MAP_BEFORE_TERRITORY | Map Before Territory |
| T-02 | Respect Constraints | PHYSICAL_MEMORY_PERSISTENCE | Constraints as Lighthouses |
| T-03 | Evidence Over Assumption | PRINCIPLES_OVER_DIRECTIVES | Evidence Over Intuition |
| T-04 | Reversible First | ASK_BEFORE_DESTRUCTION | Reversibility Governs Speed |
| T-05 | Safety Rails | PHYSICAL_DEFENSE_AND_ORCHESTRATION | Via Negativa |
| T-06 | Simplicity First | OCCAMS_RAZOR_MVC | Occam's Razor |
| T-07 | Minimal Change Surface | PAIN_DRIVEN_EVOLUTION | Minimum Viable Change |
| T-08 | Pain As Signal | ZERO_ENTROPY_GROOMING | Pain as Signal |
| T-09 | Divide And Conquer | *(absent)* | Divide and Conquer |
| T-10 | Memory Externalization | *(absent)* | *(absent)* |

Key facts from code:
- `thinking-models.ts` defines **10** built-in patterns (T-01..T-10) with `getFallbackName/Description`, and is the source that populates `coreAxiomId` at bootstrap (`init.ts:214 coreAxiomId: model.id`, `bootstrap-rules.ts:99`).
- `thinking-models.ts` *claims* "THINKING_OS.md is the single source of truth", but THINKING_OS.md only defines 8 directives — so the code's own authority claim is already internally inconsistent (T-09/T-10 have no THINKING_OS.md entry; they only exist as code fallbacks).
- The owner explicitly described the core principles as **"内置的 10 个原则，原来叫 think os"** — that is exactly the `thinking-models.ts` T-01..T-10 set, **not** the FIRST_PRINCIPLES 9.

**Consequence for our plan**: `00-…-plan.md` §4.1 listed the registry using the FIRST_PRINCIPLES names ("Constraints as Lighthouses", "Via Negativa", etc.). **That is wrong.** The registry must mirror `thinking-models.ts` (T-01..T-10).

**Resolution (supersedes review P0-1 recommendation and `00` §4.1):**
1. The Core Principle Registry is anchored to **`thinking-models.ts` ids + fallback names** as the runtime authority (10 entries, T-01..T-10).
2. The drift test asserts the registry matches `thinking-models.ts` `getFallbackName`/`getFallbackDescription` (NOT THINKING_OS.md, which is per-workspace, localized, and incomplete).
3. THINKING_OS.md is extended to add T-09 and T-10 directives so the per-workspace content stops being a subset; a secondary (non-blocking) consistency check warns if a workspace THINKING_OS.md omits an id.
4. `FIRST_PRINCIPLES_ANALYSIS.md` is explicitly marked **non-canonical** (a historical analysis doc) with a header note pointing to `thinking-models.ts`, to stop future drift. We do **not** rename its T-ids (it is a doc, not code).
5. Owner sign-off task (pre-P0): confirm the 10 canonical names/statements. The owner may prefer the more abstract FIRST_PRINCIPLES *wording* for the registry `statement` field while keeping `thinking-models.ts` *ids* — that is allowed, but the **id↔semantic identity** must be pinned to the runtime set, because `routing-policy.ts` already keys behavior off these ids (see §2.2).

### 2.2 `coreAxiomId` is NOT dead code — both reviews are wrong here

`01-plan-review.md` §5.3 and `01-plan-review2.md` RISK-5 both assert: *"`coreAxiomId` is never written by any code path — it's always `undefined` … the axiom boost logic is dead code."*

**This is false.** Code verification:
- `packages/openclaw-plugin/src/core/init.ts:214` → `coreAxiomId: model.id`
- `packages/openclaw-plugin/src/core/bootstrap-rules.ts:99` → `coreAxiomId: id`
- `packages/openclaw-plugin/src/core/evolution-reducer.ts` reads/writes `coreAxiomId` from event data (multiple sites).

So `coreAxiomId` **is** populated for bootstrap-seeded principles (the thinking-models themselves), which means `routing-policy.ts`'s axiom boost (T-05/T-08→codeBoost, T-01/T-03/T-04→skillBoost) is **live today** for those principles — not dormant.

**Corrected implication (better than the reviews):** Grounding does not "activate dead code"; it *extends an already-live routing input* to diagnosis-derived principles. This is lower risk than the reviews implied (the boost path is already exercised by bootstrap principles and covered by `routing-policy.test.ts:307 coreAxiomId: 'T-05'`). The valid residual action from RISK-5 stands but is downgraded P2→P3-informational: re-check the boost weights once diagnosis-derived principles start carrying `coreAxiomId`, via telemetry on routing distribution. No pre-P2 blocking work.

### 2.3 Orchestration ontology — accept "extend `PeerRunnerKind`" only with a guard

Both reviews recommend Option A: add `diag_rootcause/diag_distiller/diag_router` to `PeerRunnerKind` + `ALLOWED_EDGES`. I verified this won't break a count assertion (architecture-regression has no `toHaveLength(7)` on peer kinds). **But** `DOMAIN_MODEL.md` ontologically separates *Diagnosis* (pain→recommendation, pre-intake) from the *Internalization Pipeline (7 Peer Runners, post-intake)*. Folding diagnosis stages into `PeerRunnerKind` makes "10 peer runners" where 3 are not internalization runners — an ontology smell that will mislead future readers and the domain model.

**Decision (refines reviews):** Reuse the orchestrator *mechanics* without corrupting the *internalization ontology*:
- Introduce a broader execution-kind seam rather than overloading `PeerRunnerKind`. Concretely: add `DIAGNOSTICIAN_STAGE_KINDS = ['diag_rootcause','diag_distiller','diag_router']` and a separate `DIAGNOSTICIAN_EDGES` graph in a new `diag/diagnostician-job-graph.ts`, plus a `RunnerKind = PeerRunnerKind | DiagnosticianStageKind` union used by the generic orchestrator paths (`hydratePITaskRecord`, `wakeOnce`, successor proposal).
- This keeps `PeerRunnerKind`/`ALLOWED_EDGES`/`DOMAIN_MODEL.md` "7 peer runners" invariant intact, while the orchestrator's *generic* lease/dedup/recovery logic is shared.
- If, during P3 spike, this seam proves materially more expensive than overloading `PeerRunnerKind`, we may fall back to Option A **with** a `DOMAIN_MODEL.md` update that explicitly documents diagnosis stages as a distinct sub-family. Either way the ontology is kept honest. This is an explicit pre-P3 design spike output (see §4 checklist item INF-0).

Everything else in the reviews' P0-2 integration list (the file-by-file changes) is adopted as-is, retargeted onto this seam.

---

## 3. Adoption table

| Finding | Source | Decision | Notes |
|---|---|---|---|
| P0-1 taxonomy | both | **Adopt, corrected** | Anchor to `thinking-models.ts` (10), not FIRST_PRINCIPLES; see §2.1 |
| P0-2 orchestration integration | both | **Adopt with guard** | Separate `RunnerKind` seam, not `PeerRunnerKind` overload; see §2.3 |
| P0-3 post-diagnosis trigger | both | **Adopt** | `onDiagnosisComplete()` — see §4 |
| NEW-1 pi_metadata envelope | review2 | **Adopt** | Split tasks use `serializePITaskMetadata()` |
| NEW-5 successor ownership | review2 | **Adopt** | Orchestrator owns successor seeding (via the new seam) |
| NEW-2 flag combination matrix + guards | review2 | **Adopt** | Startup fail-loud on invalid combos; §5 |
| NEW-3 task-id convention + retry semantics | review2 | **Adopt** | §6 |
| NEW-4 buildContext pseudocode per stage | review2 | **Adopt** | Add to `00` §7.2 |
| NEW-6 P2 grounding observability | review2 | **Adopt (Approach A)** | Prompt-only + telemetry; zero schema change |
| RISK-1 Distiller prompt unvalidated | review2 | **Adopt** | Add **P-spike** before P3; §7 |
| RISK-3 CLI async is a new execution model | review2 | **Adopt** | Prefer in-process deferral over detached subprocess; §8 |
| RISK-4 dual-maintenance during transition | review2 | **Adopt** | Policy in §9 |
| P1-1 `pd diagnose run` missing | review1 | **Adopt (revised)** | Likely unneeded if §8 in-process model chosen |
| P1-2 validator/committer injection | review1 | **Adopt** | A/B inline; C reuses `DiagnosticianCommitter` |
| P1-3 corpus too small | review1 | **Adopt** | ≥10 signals, all 4 categories |
| P1-4 `--wait`+`--json` format | review1 | **Adopt** | Same as today's sync `--json` |
| P2-1 prompt-only P2 path | review1 | **Adopt** | = NEW-6 Approach A |
| P2-2 rollback runbook | review1 | **Adopt** | §10 |
| P2-3 `PrincipleScope` add `scenario` | review1 | **Adopt** | Additive enum change in P0 |
| RISK-5 dead code | both | **Reject as stated; downgrade** | `coreAxiomId` is written; see §2.2 |
| Docs: integration checklist / flag matrix / done-criteria / reference map / data-flow | review2 | **Adopt** | Folded into §4–§6 and `00` appendices |

---

## 4. Pre-P3 Integration Checklist (authoritative)

Retargeted onto the §2.3 `RunnerKind` seam. ALL must be green before any runner logic is written.

- [ ] **INF-0 (spike)**: decide `RunnerKind` seam vs `PeerRunnerKind` overload; record in this doc + `DOMAIN_MODEL.md`.
- [ ] **INF-1**: `DiagnosticianStageKind` + `DIAGNOSTICIAN_STAGE_KINDS` defined; `RunnerKind` union exported. Test: `isDiagnosticianStageKind('diag_rootcause') === true` and `isPeerRunnerKind('diag_rootcause') === false`.
- [ ] **INF-2**: `DIAGNOSTICIAN_EDGES = [['diag_rootcause','diag_distiller'],['diag_distiller','diag_router']]` + `validateDiagEdge`. Test: edge accept/reject + `isAcyclic`.
- [ ] **INF-3**: `hydratePITaskRecord` (or a generalized `hydrateRunnerTaskRecord`) returns non-null for diag stage kinds. Test: hydrate with `taskKind='diag_rootcause'` non-null.
- [ ] **INF-4**: successor proposal handles diag chain (generic path or `createDiagNextTaskProposal`). Test: proposal for `diag_distiller` after `diag_rootcause` succeeded.
- [ ] **INF-5**: `wakeOnce` discovers pending diag tasks. Test: returns `diag_rootcause` task.
- [ ] **INF-6**: CLI/runtime dispatcher instantiates the 3 runners. Test: command-level test per kind.
- [ ] **INF-7**: 3 flags registered in `DEFAULT_FEATURE_FLAGS` + loader. Test: architecture-regression flag-contract section.
- [ ] **INF-8**: split task creation uses `serializePITaskMetadata()` envelope (NEW-1). Test: `hydratePITaskRecord` succeeds on a split task's `diagnosticJson`.
- [ ] **INF-9**: `PainSignalBridge.onDiagnosisComplete(taskId, output)` extracted from current `onPainDetected()` L228-306 (admission→intake→seedDreamer), callable from the async/split path (P0-3, NEW-5).

P3 runner work (each: V-slice + architecture-regression `extends BasePeerRunner` assertion + REQUIRED_SOURCE/TEST/EXPORTS update) only begins once INF-0..INF-9 pass.

---

## 5. Feature-flag combination matrix (authoritative; supersedes `00` §contradiction)

| `async_cli` | `grounding` | `split` | Behavior | Valid | Runtime guard |
|---|---|---|---|---|---|
| off | off | off | Sync monolith (current default) | ✅ | — |
| on | off | off | Async monolith (P1 target / Arm 1) | ✅ | — |
| on | on | off | Async grounded monolith (Arm 2) | ✅ | — |
| off | on | off | Sync grounded monolith (debug / A-B isolation) | ✅ | Grounding must not require async; useful for low-risk prompt validation |
| on | on | on | Async grounded split (Arm 3) | ✅ | — |
| on | off | on | Async split, no grounding | ✅ | Distiller gets empty axiom list; `groundedOnCorePrincipleIds=[]` |
| off | off | on | Sync split (540s+ block) | ❌ | fail loud at startup |
| off | on | on | Sync grounded split | ❌ | fail loud at startup |

Guard rule (ERR-002 structured error): `if split && !async_cli → throw "diagnostician_split_pipeline requires diagnostician_async_cli=on (3 serial LLM calls would block the sync CLI 540s+)"`. Implement as a startup assertion in the flag consumer.

Grounding rule: `diagnostician_core_grounding` is a prompt/context enhancement and may run on the sync monolith. It must not be coupled to `diagnostician_async_cli`. This keeps the lowest-risk quality improvement independently testable and independently rollbackable.

---

## 6. Task-id convention & retry semantics (NEW-3)

- Stage A id: `diag_rootcause-${painId}` (replaces `diagnosis_${painId}` on the split path; monolith path keeps `diagnosis_${painId}`).
- Stage B id (seeded): `diag_distiller-${stageA_taskId}-prompt`.
- Stage C id (seeded): `diag_router-${stageB_taskId}-prompt`.
- `pd pain retry --pain-id <id>` retries the **latest non-succeeded** task for that painId (not the whole chain). A succeeded predecessor's `PIArtifact` is reused; only the failed stage re-runs. Document this in the CLI help and a parser test.
- Idempotency: deterministic ids + existing pending/retry_wait dedup prevent duplicate tasks; the async spawn guard (§8) prevents duplicate execution.

---

## 7. P-spike: validate the Distiller grounding hypothesis BEFORE P3 (RISK-1)

The whole Q3+Q6 value rests on "axiom-grounded distillation yields more abstract principles." This is unprovable by code review. Insert a 1–2 day prompt spike, parallel to P0:

1. Take ≥10 real/synthetic pain signals across all 4 root-cause categories (include the 2 manual dogfood signals).
2. Hand-craft the Distiller prompt (root cause + `CORE_PRINCIPLES` → one abstract principle + `groundedOnCorePrincipleIds`).
3. Run against the weak (qwen) AND strong (GLM-5.1) models already configured.
4. Human-rate abstraction vs the monolith baseline; check axiom references are meaningful, not fabricated.
5. **Gate**: if grounding shows no improvement on either model, drop Q3/Q6 and ship only Q1+Q2 (both valuable independently). Record the decision here.

This is the single highest-leverage de-risking action; it can kill or confirm the split before any runner infrastructure is built.

### 7.1 Post-spike interpretation rule (added 2026-06-11)

PRI-366 / PR #898 produced useful evidence, but the current report is a **conditional GO**, not a final production GO:

- Spike-1 showed grounding alone did not materially improve abstraction, but did improve traceability/noise handling.
- Spike-2 showed a large abstraction lift on real dogfood pains for `qwen3.6-27b`, but only one model was run and several comparisons mix Chinese monolith output with English split output.
- Therefore T-E may proceed as a low-risk prompt/context improvement, and T-F may proceed as infrastructure. T-G may begin only after #898 is merged with the limitations explicitly recorded.
- T-H remains the real production decision gate. It must run the same corpus through baseline / grounded-single / split with language controlled and model coverage sufficient to avoid confusing "better English wording" with "better abstraction".

---

## 8. P1 execution model — prefer in-process deferral over detached subprocess (RISK-3)

The detached-subprocess design in `00` §6.2 introduces process-lifecycle, Windows-vs-Unix, orphan, log-destination, and concurrent-spawn concerns PD has no infrastructure for. **Revised recommendation:**

- **Primary**: in-process async deferral. `pd pain record` persists the task, schedules the runner via `setImmediate`/microtask, prints `{painId, taskId, status:"submitted", nextAction:"pd task show <taskId>"}` and returns `< 5s` while the runner continues in the same Node process until natural exit, with state persisted at each step. No subprocess, no `pd diagnose run` command needed (P1-1 becomes optional).
  - Caveat: if the CLI process exits immediately after printing (typical CLI), the in-process runner is cut off. So the concrete mechanism is: **persist task as `pending` and return; rely on the existing orchestrator/`wakeOnce` + recovery-sweep to lease and execute it.** This is the cleanest "submit/complete separation" and matches PD's existing polling model — no new execution model at all.
- **Only if** a host without a running orchestrator loop needs it: a guarded detached subprocess with a `.pd/diag-${taskId}.pid` file, single-spawn guard keyed on taskId, and stdout/stderr redirected to `.pd/logs/diag-${taskId}.log`. Treat as a fallback, documented separately.

Pick the orchestrator-driven path first; it removes RISK-3 almost entirely. Confirm during P1 that an orchestrator wake loop is available in the dogfood/host context; if not, implement the guarded subprocess fallback.

---

## 9. Dual-maintenance policy during P3→P5 transition (RISK-4)

While monolith and split coexist:
- Diagnostic-logic fixes (root-cause prompt, taxonomy) land in **both** the monolith builder and the corresponding split builder until P5.
- Minimize the window: drive to P4 comparison and P5 deletion quickly.
- A regression test asserts both paths emit schema-valid `DiagnosticianOutputV1` so they cannot silently diverge on contract.

---

## 10. Rollback runbook (P2-2)

For each flag (`diagnostician_async_cli` / `diagnostician_core_grounding` / `diagnostician_split_pipeline`):
1. Edit `{workspace}/.pd/feature-flags.yaml` → set `enabled: false`.
2. Restart the OpenClaw gateway / host so the loader re-reads flags.
3. Verify: `async_cli` off → `pd pain record` blocks synchronously again; `split` off → `pd task list` shows a single `diagnosis_*` task per pain; `grounding` off → output carries no axiom references.
4. No data migration; in-flight split tasks already persisted complete or recover via sweep.

---

## 11. Owner-facing output language contract

All diagnostician paths must preserve the product-level principle language preference:

- Single-agent grounding (T-E) must continue to read `principles.outputLanguage` and ask the model to produce owner-facing recommendations in that language.
- Split Distiller and Router (T-G) must receive the same language preference. The abstracted principle and final `DiagnosticianOutputV1.recommendations[]` text must follow it.
- Tests must verify at least zh-CN and en prompt construction. A split output that is abstract but in the wrong user language is a product regression.

---

## 12. Net effect on risk

After these amendments the residual high risks are: (1) the grounding/split quality hypothesis — now supported by a conditional spike but still gated by T-H before production cutover; (2) integration width — now a 10-item checklist with per-item tests instead of scattered prose; (3) execution model — now the existing polling/orchestrator model instead of a novel subprocess; (4) owner-facing language fidelity — now an explicit contract for T-E/T-G. The taxonomy landmine (P0-1) is resolved against the correct runtime authority, and the `coreAxiomId` "dead code" scare is dismissed with evidence. The design is materially safer and the downstream contract remains frozen and reversible.
