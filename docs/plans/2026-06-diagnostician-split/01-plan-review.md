# Diagnostician Refactor Plan — Independent Code Review

> **Reviewer**: Code-level investigation agent (Trae IDE)
> **Date**: 2026-06-10
> **Scope**: `00-diagnostician-refactor-plan.md` + ADR-0014 Amendment + codebase validation
> **Method**: 4S Problem Analysis + full codebase trace of blocking chain, domain model, orchestration mechanism, and error handling

---

## Executive Summary

The plan is well-structured: problem definition is precise, phase ordering is correct (Q1 async first, then grounding, then split), flag-gated + 3-arm comparison risk control is sound. However, code-level investigation reveals **3 P0 issues** that must be resolved before implementation starts, and **3 P1 risks** that need attention during execution. The most critical finding is that the diagnostician chain cannot reuse the InternalizationOrchestrator's task-chaining mechanism without first extending PeerRunnerKind and the Job Graph — a prerequisite the plan does not mention.

---

## 1. Problem Confirmation: Sync Blocking Is Real

### 1.1 Blocking chain (5-layer await)

```
CLI handler (await)                                    ← pain-record.ts
  └─ PainToPrincipleService.recordPain() (await)       ← pain-to-principle-service.ts
       └─ PainSignalBridge.onPainDetected() (await)    ← pain-signal-bridge.ts:L213
            └─ DiagnosticianRunner.run() (await)       ← diagnostician-runner.ts:L129
                 └─ PiAiRuntimeAdapter.startRun()      ← pi-ai-runtime-adapter.ts:L431
                      └─ await completeSimple()        ← BLOCKS until LLM responds
```

**Confirmed**: Single call blocks 256-480s. Worst case (3 repair + 2 retry) = ~780s.

### 1.2 Root cause is architectural, not performance

The 5 root causes identified in the plan are validated against code:

| # | Root Cause | Level | Code Evidence |
|---|-----------|-------|---------------|
| R1 | No submit/complete event separation | Architecture | `onPainDetected()` is a "god method" that does runner.run() + admission + intake + seed in one await |
| R2 | Runner assumes synchronous wait | Component | `DiagnosticianRunner.run()` returns only after full pipeline |
| R3 | PD chose `completeSimple` over `streamSimple` | Usage choice | **pi-ai fully supports streaming** — see §2 below |
| R4 | No CLI background execution model | Process | `handlePainRecord()` directly `await service.recordPain()` |
| R5 | Sync assumption scales linearly with agent count | System dynamics | 3 agents serial = 540-1440s |

### 1.3 Correction to R3: pi-ai supports streaming

**The plan states**: "PiAiRuntimeAdapter chose `completeSimple` (block until done) where `streamSimple` (return immediately) was available."

**Code evidence confirms this is correct**, but the implication is deeper than the plan suggests:

- `streamSimple()` returns `AssistantMessageEventStream` immediately (AsyncIterable)
- `completeSimple()` internally calls `streamSimple()` then `.result()` to await completion
- Event protocol: `start → text_delta → thinking_delta → toolcall_* → done/error`
- This means the blocking is a **PD usage choice**, not a pi-ai limitation

**Impact on plan**: The plan's "medium-term" solution (PiAiRuntimeAdapter streaming) is more feasible than assumed — `streamSimple()` is already available and returns immediately. The adapter just needs to consume the stream asynchronously instead of awaiting `.result()`.

---

## 2. P0 Issues (Must Fix Before Implementation)

### P0-1: T-09 Not in THINKING_OS.md — Drift Test Will Fail Immediately

**Finding**: The plan's Core Principle Registry lists T-01..T-09 (9 entries). But `THINKING_OS.md` only defines T-01..T-08 (8 directives). `FIRST_PRINCIPLES_ANALYSIS.md` lists 9 including T-09 "Divide and Conquer".

**Code evidence**:
- `THINKING_OS.md`: defines `T-01` through `T-08` (8 `<directive>` elements)
- `FIRST_PRINCIPLES_ANALYSIS.md` L248-262: lists T-01..T-09 including "Divide and Conquer"

**Impact**: The plan §4.1 says the drift test asserts "every THINKING_OS.md T-id has a registry entry". With 9 registry entries but only 8 THINKING_OS.md directives, the test fails on day one.

**Recommendation**: Before P0 starts, add T-09 "Divide and Conquer" directive to `THINKING_OS.md`, OR change the drift test to validate against `FIRST_PRINCIPLES_ANALYSIS.md` as the canonical source.

---

### P0-2: Diagnostician Not in InternalizationOrchestrator's Job Graph

**Finding**: `PeerRunnerKind` only has 7 values (dreamer/philosopher/scribe/artificer/evaluator/trainer/rollout_reviewer). `diagnostician` is not included. The `ALLOWED_EDGES` in `internalization-job-graph.ts` has no diagnostician edges.

**Code evidence**:
- `peer-runner-contracts.ts:L39-46`: `PeerRunnerKind` = 7 internalization runners only
- `internalization-job-graph.ts:L28-35`: `ALLOWED_EDGES` = dreamer→philosopher→scribe→artificer→evaluator→rollout_reviewer→trainer
- `internalization-orchestrator.ts:L477`: `wakeOnce()` filters `isPeerRunnerKind(t.taskKind)` — diagnostician tasks are excluded
- `internalization-orchestrator.ts:L314`: `proposeNextTask()` returns null for non-PeerRunnerKind tasks

**Impact**: The plan §7.3 says "chaining/orchestration identical to the internalization pipeline" and "the seeding helper mirrors the existing successor-seeding used by Dreamer→Philosopher→Scribe". This is **not possible** without:
1. Adding `diag_rootcause`/`diag_distiller`/`diag_router` to `PeerRunnerKind`
2. Adding 3 edges to `ALLOWED_EDGES`: rootcause→distiller, distiller→router
3. Updating `createNextTaskProposal()` to handle diagnostician chain successors

**Recommendation**: Extend `PeerRunnerKind` with 3 new values and add edges to `ALLOWED_EDGES` in P3. This is the only way to reuse the orchestrator's mature chaining mechanism. The alternative (building a separate orchestration path in PainSignalBridge) would create two parallel orchestration systems, which is a maintenance liability.

---

### P0-3: No Trigger for Admission/Intake/SeedDreamer After Split

**Finding**: Currently `PainSignalBridge.onPainDetected()` synchronously executes:

```
runner.run(taskId) → admission → intake → seedDreamer
```

After split, `onPainDetected()` can only seed the first task (`diag_rootcause`). When Router (C) completes, **nothing triggers admission + intake + seedDreamer**.

**Code evidence**:
- `pain-signal-bridge.ts:L213-292`: The entire post-runner pipeline (admission → intake → seed) runs synchronously after `runner.run()`
- `internalization-orchestrator.ts`: Only handles internalization chain successors, not diagnostician-to-admission transition
- `intake-to-internalization-bridge.ts`: `seedIntakeTask()` creates dreamer tasks, but it's only called from `PainSignalBridge`

**Impact**: Without a post-diagnosis trigger, principle candidates created by the Router will never enter admission/intake, and the dreamer task will never be seeded. The entire pipeline breaks after split.

**Recommendation**: Add `onDiagnosisComplete(taskId)` method to `PainSignalBridge` (or a new `DiagnosisCompletionHandler`). The host layer (openclaw-plugin) calls this when it detects `diag_router` task succeeded. This method performs:
1. Load Router's `DiagnosticianOutputV1` from artifact
2. Run admission gate
3. Run intake
4. Seed dreamer task

This is the "Phase 2: Complete" pattern from the async analysis, scoped to the diagnostician chain only.

---

## 3. P1 Issues (Should Fix During Implementation)

### P1-1: `pd diagnose run` Command Does Not Exist

**Finding**: Plan §6.1 says "spawns a detached background `pd` subprocess (`pd diagnose run --task <taskId>`)". This command does not exist in the current CLI.

**Code evidence**: `packages/pd-cli/src/commands/` has `pain-record.ts`, `pain-retry.ts`, etc. but no `diagnose-run.ts`.

**Recommendation**: Either:
- (A) Create `pd diagnose run --task <taskId>` as a new command (cleanest, follows CLI/Operator gate)
- (B) Reuse `pd pain retry --pain-id <id>` with a `--background` flag (less new code)

Option A is recommended because it has a clear single responsibility and can be independently tested.

---

### P1-2: Validator/Committer Injection Strategy for New Runners

**Finding**: Current `DiagnosticianRunner` injects `DiagnosticianValidator` and `DiagnosticianCommitter` as constructor dependencies. `BasePeerRunner` subclasses (Dreamer/Philosopher) inline validation and commit in `validateOutput()`/`succeedTask()`.

**Code evidence**:
- `diagnostician-runner.ts:L46-53`: `DiagnosticianRunnerDeps` includes `validator` and `committer`
- `dreamer-runner.ts`: No injected validator/committer — logic is inline

**Recommendation**:
- **A (RootCause) and B (Distiller)**: Inline validation/commit — simple schemas, no need for injected dependencies
- **C (Router)**: Reuse `DiagnosticianCommitter` via injection — downstream contract is identical to today's diagnostician, so the committer should be shared

---

### P1-3: 3-Arm Comparison Corpus Too Small

**Finding**: Plan §8.1 mentions "two manual pain signals + synthetic baseline". 2 real samples are statistically meaningless.

**Recommendation**: Minimum 10 real pain signals covering all 4 `rootCauseCategory` values (People/Design/Assumption/Tooling). If real signals are scarce, use synthetic signals that are validated against real error patterns.

---

### P1-4: `--wait` + `--json` Output Format Undefined

**Finding**: Plan §6.1 defines async output format but doesn't specify `--wait` + `--json` output.

**Recommendation**: `--wait` + `--json` should output the same format as today's synchronous `pd pain record --json` (i.e., the full diagnosis result). This preserves backward compatibility for scripted usage.

---

## 4. P2 Suggestions (Optional Improvements)

### P2-1: Grounding on Single Agent — Choose Prompt-Only Path

**Finding**: Plan §5.4 says "add `groundedOnCorePrincipleIds` to a v1.1 optional output field OR measure via Arm 2 prompt". These are fundamentally different approaches:
- Path A: Modify `DiagnosticianOutputV1Schema` → changes downstream contract
- Path B: Prompt-only injection + telemetry observation → zero schema change

**Recommendation**: Choose Path B for P2. The schema change can happen naturally in P3 when `DiagPrincipleDraftV1` introduces `groundedOnCorePrincipleIds` as a first-class field. Modifying `DiagnosticianOutputV1` in P2 would violate the "downstream contract frozen" constraint.

---

### P2-2: Add Rollback Runbook

**Finding**: Plan says "flip flag off = revert" but doesn't specify concrete steps.

**Recommendation**: After P1 ships, add a brief rollback runbook:
1. Which flag: `diagnostician_async_cli`
2. Where: `.pd/feature-flags.yaml` (or DEFAULT_FEATURE_FLAGS in code)
3. Change: `enabled: true` → `enabled: false`
4. Restart required: yes/no
5. Verification: `pd pain record` should block synchronously again

---

### P2-3: PrincipleScope Missing `scenario`

**Finding**: `PrincipleScope` is `'general' | 'domain'` but DOMAIN_MODEL.md defines 3 levels (Core → Domain → Scenario). The plan's Distiller outputs `scope: 'general' | 'domain' | 'scenario'`.

**Code evidence**: `principle-enums.ts:L30`: `PrincipleScope = 'general' | 'domain'`

**Recommendation**: Extend to `'general' | 'domain' | 'scenario'` in P0 alongside the Core Principle Registry. This is an additive change — existing principles are all `general` or `domain`, so no data migration needed.

---

## 5. Domain Model Foundation Assessment

### 5.1 What exists

| Concept | Code Location | Completeness |
|---------|--------------|-------------|
| Principle interface | `principle-schema.ts:L29-54` | Full (20+ fields) + TypeBox schema |
| Rule interface | `principle-schema.ts:L84-102` | Full + TypeBox schema |
| Implementation interface | `principle-schema.ts:L125-141` | Full + TypeBox schema |
| PrincipleTreeStore | `principle-tree-store.ts:L7-13` | Three-layer tree (principles + rules + implementations + metrics) |
| PrincipleDependency | `principle-dependency.ts:L3-8` | dependsOn / conflictedWith / supersedes |
| PrincipleValueMetrics | `principle-value-metrics.ts:L3-14` | Value scoring |
| All enums | `principle-enums.ts` | Status/Priority/Scope/Evaluability/RuleType/ImplementationType |
| `coreAxiomId` field | `principle-schema.ts:L33` | Optional string — **no registry, no validation** |

### 5.2 What's missing

| Gap | Impact on Refactor | Severity |
|-----|-------------------|----------|
| No Core Principle Registry (T-01..T-09) | Plan's P0 directly addresses this | Low (plan covers it) |
| `coreAxiomId` is free-form string | Distiller output needs validated grounding | Low (plan covers it) |
| `PrincipleScope` missing `scenario` | Distiller output can't express scenario scope | Medium (easy fix) |
| No `principles` table in SQLite | Principles stored in JSON file only | Low (not needed for refactor) |
| T-01..T-09 not in any database | Core axioms are markdown-only | Low (plan's registry addresses this) |

### 5.3 Critical finding: `coreAxiomId` + routing-policy is dead code

`routing-policy.ts:L147-156` uses `coreAxiomId` to boost routing decisions:

```typescript
const axiomId = principle.principle.coreAxiomId;
if (axiomId === 'T-05' || axiomId === 'T-08') {
  codeBoost = AXIOM_GOVERNANCE_BOOST;
} else if (axiomId === 'T-01' || axiomId === 'T-03' || axiomId === 'T-04') {
  skillBoost = AXIOM_KNOWLEDGE_BOOST;
}
```

But `coreAxiomId` is **never written by any code path** — it's always `undefined`. This means the axiom boost logic is dead code. The refactor's Core Principle Registry + Distiller grounding would activate this path for the first time.

**Implication**: The refactor doesn't just improve diagnosis quality — it also **enables existing routing-policy logic that was designed but never activated**. This reduces risk because the downstream consumer (routing-policy) is already implemented and tested.

---

## 6. Error Handling & Retry in Split Chain

### 6.1 Current mechanism (validated against code)

| Mechanism | Code | Behavior |
|-----------|------|----------|
| Lease conflict | `lease-manager.ts` | `acquireLease()` throws `PDRuntimeError('lease_conflict')` — second process cannot lease same task |
| Retry on transient error | `base-peer-runner.ts` retryOrFail | Task → `retry_wait` with exponential backoff |
| Recovery sweep | `recovery-sweep.ts` | Detects expired leases → `retry_wait` (if attempts remain) or `failed` (if max exceeded) |
| Dependency gate | `internalization-orchestrator.ts:L202` | `validateInternalizationTaskReady()` — blocked if dependencies not succeeded |

### 6.2 Split chain failure scenarios

| Scenario | Expected Behavior | Gap |
|----------|------------------|-----|
| A succeeds, B fails | A's artifact preserved; B → retry_wait → RecoverySweep recovers | None — existing mechanism handles this |
| A succeeds, B fails permanently | A's artifact preserved; B → failed; C never created | Correct behavior — but `pd pain retry` semantics unclear (see P1-1) |
| A succeeds, B succeeds, C fails | A+B artifacts preserved; C → retry_wait | None — existing mechanism handles this |
| All succeed | Normal flow | Need P0-3 solution for post-diagnosis trigger |

### 6.3 Retry semantics for split chain

Current `pd pain retry --pain-id <id>` retries the diagnostician task. After split, one painId maps to 3 tasks. Retry should:
1. Find the latest non-succeeded task for this painId
2. Retry that specific task (not the whole chain)
3. If A succeeded but B failed, retry B only (A's artifact is reused)

**Recommendation**: Define this in P1 (CLI async phase) since it affects the CLI interface.

---

## 7. Prompt Builder Workload Assessment

### 7.1 Current state

`DiagnosticianPromptBuilder` (~250 lines) builds a single prompt covering all 4 phases:
1. Evidence presentation
2. 5-Whys root cause analysis
3. Classification (People/Design/Assumption/Tooling)
4. Distillation + taxonomy routing (5 recommendation kinds)

### 7.2 Split workload

| New Builder | Cognitive Job | Estimated Complexity |
|-------------|--------------|---------------------|
| RootCausePromptBuilder | Evidence → 5-Whys → classify | Medium (reuse ~60% of current prompt) |
| DistillerPromptBuilder | Root cause + axioms → abstracted principle | **High** (entirely new prompt design — must teach LLM to derive from axioms, not invent) |
| RouterPromptBuilder | Principle + root cause → 5 kinds | Medium (reuse taxonomy section from current prompt) |

### 7.3 Risk

The Distiller prompt is the highest-risk artifact. If the LLM doesn't understand "ground principle on core axiom", it will either:
- Fabricate axiom IDs (mitigated by registry validation)
- Produce rule-like output instead of abstract principles (the exact problem Q3 aims to fix)

**Recommendation**: Before P3 implementation, create a manual prompt prototype for the Distiller and test it against 5-10 real pain signals. This validates the prompt design before committing to runner infrastructure.

---

## 8. Summary: Required Changes to Plan

| Change | Phase Affected | Priority | Effort |
|--------|---------------|----------|--------|
| Add T-09 to THINKING_OS.md (or change drift test source) | P0 | P0 | Low |
| Extend `PeerRunnerKind` with 3 diagnostician kinds + `ALLOWED_EDGES` | P3 | P0 | Medium |
| Add `onDiagnosisComplete()` post-diagnosis trigger | P3 | P0 | Medium |
| Extend `PrincipleScope` with `scenario` | P0 | P2 | Low |
| Create `pd diagnose run` CLI command | P1 | P1 | Medium |
| Define split-chain retry semantics | P1 | P1 | Low |
| Choose prompt-only path for P2 grounding | P2 | P2 | Low |
| Pre-validate Distiller prompt design | P3 | P1 | Medium |
| Add rollback runbook | P1 | P2 | Low |

---

## 9. Open Questions for Plan Author

1. **Orchestration path**: Do you intend to extend `PeerRunnerKind` + `ALLOWED_EDGES` to include the 3 diagnostician runners (recommended), or build a separate orchestration path in PainSignalBridge?

2. **Post-diagnosis trigger**: Where should `onDiagnosisComplete()` live — in `PainSignalBridge` (keeps all pain→diagnosis logic together) or as a new `DiagnosisCompletionHandler` (cleaner separation)?

3. **Distiller prompt validation**: Are you planning to prototype the Distiller prompt before P3 implementation? If not, how will you validate that "ground on axiom" produces better output than the current monolith?

4. **T-09 canonical source**: Should `THINKING_OS.md` be updated to include T-09, or should the drift test validate against `FIRST_PRINCIPLES_ANALYSIS.md` instead?

5. **`pd diagnose run` vs `pd pain retry`**: Which approach do you prefer for the CLI async subprocess — new command or reuse existing?

---

> **End of review.** All findings are grounded in code-level investigation. No speculative claims without code evidence.
