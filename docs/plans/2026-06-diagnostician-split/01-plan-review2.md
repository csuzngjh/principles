# Diagnostician Refactor Plan — Deep Review (Qoder)

> **Reviewer**: Qoder (multi-agent codebase investigation)
> **Date**: 2026-06-10
> **Scope**: `00-diagnostician-refactor-plan.md` + `01-plan-review.md` + ADR-0014 Amendment + full codebase trace
> **Method**: 5 parallel investigation agents covering strategic docs, existing diagnostician code, BasePeerRunner/chain infrastructure, Thinking OS / First Principles taxonomy, error patterns & architectural constraints
> **Relationship to `01-plan-review.md`**: This review validates and extends the findings in `01-plan-review.md`. All 3 P0 issues from that review are confirmed with additional code evidence. This document adds 6 new blocking items, 4 contract gaps, and 6 document optimization recommendations.

---

## Executive Summary

The design is architecturally sound: BasePeerRunner unification, 3-stage split, flag-gated reversibility, and 3-arm comparison are the right choices. However, the plan has three systemic weaknesses that — if unaddressed — will cause implementation failures:

1. **The core value hypothesis (Distiller prompt grounding) is unvalidated.** The entire Q3+Q6 quality improvement rests on the assumption that an LLM can produce better abstracted principles when given core axioms. This has zero empirical evidence and can only be tested through a prompt spike, not through code review.

2. **The integration surface is wide and implicit.** Making the split chain functional requires simultaneous changes to 10+ existing files across 4 packages. The plan describes these changes in narrative form scattered across phases, with no single integration checklist. A developer who implements the 3 runners perfectly will still find the chain non-functional if any one of the 10 integration points is missed.

3. **P1 (CLI async) introduces a new execution model** (detached background subprocess) that PD has never used before. The plan treats this as "low risk, CLI-only" but it introduces novel process-management concerns (orphan processes, concurrent spawn, cross-platform behavior) that PD has no existing infrastructure to handle.

Additionally, the plan has significant readability gaps for junior developers: no reference code navigation, no inter-stage data flow diagrams, no skeleton code examples, and no explicit "done" criteria per phase.

---

## Part I: Confirmed Issues from `01-plan-review.md`

All three P0 issues from the prior review are validated against code. Below is the confirmation with additional evidence and deeper analysis.

### CONFIRMED P0-1: T-09 Not in THINKING_OS.md — Drift Test Fails Day One

**Status**: Confirmed. Problem is worse than reported.

**Code evidence**:
- `.principles/THINKING_OS.md`: 8 `<directive>` elements (T-01 through T-08)
- `tests/feature-testing/FIRST_PRINCIPLES_ANALYSIS.md` L248-262: 9 entries (T-01 through T-09)
- `packages/openclaw-plugin/src/core/thinking-models.ts`: 10 built-in patterns (T-01 through T-10, adding "Memory Externalization")
- English/Chinese template copies of THINKING_OS.md: all contain 8 directives

**New finding — naming taxonomy conflict**: The two documents don't just disagree on count; they use the **same T-xx numbering for entirely different concepts**:

| ID | THINKING_OS.md Name | FIRST_PRINCIPLES_ANALYSIS.md Name |
|----|-----|-----|
| T-02 | `PHYSICAL_MEMORY_PERSISTENCE` | "Constraints as Lighthouses" |
| T-03 | `PRINCIPLES_OVER_DIRECTIVES` | "Evidence Over Intuition" |
| T-04 | `ASK_BEFORE_DESTRUCTION` | "Reversibility Governs Speed" |
| T-05 | `PHYSICAL_DEFENSE_AND_ORCHESTRATION` | "Via Negativa" |
| T-06 | `OCCAMS_RAZOR_MVC` | "Occam's Razor" |
| T-07 | `PAIN_DRIVEN_EVOLUTION` | "Minimum Viable Change" |
| T-08 | `ZERO_ENTROPY_GROOMING` | "Pain as Signal" |

This is not a "missing entry" problem — it is **two competing taxonomies sharing the same ID namespace**. A junior developer implementing the drift test against THINKING_OS.md will find that almost every title mismatches.

**Additional concern — T-10 in thinking-models.ts**: The detection engine at `packages/openclaw-plugin/src/core/thinking-models.ts` defines 10 patterns including T-10 "Memory Externalization". The plan's registry covers T-01..T-09 only. If T-10 should be excluded, this needs to be stated explicitly; otherwise the drift test between registry and thinking-models will also fail.

**Impact on plan**: P0 cannot produce a valid drift test until the canonical source, canonical naming, and canonical count are resolved. This is a prerequisite for P0, not a task within P0.

**Recommendation**:
1. Declare `THINKING_OS.md` as the single authoritative source for the registry's drift test
2. Add T-09 "Divide and Conquer" directive to `THINKING_OS.md` before P0 starts
3. Align or explicitly deprecate `FIRST_PRINCIPLES_ANALYSIS.md`'s alternative naming
4. Decide whether T-10 "Memory Externalization" belongs in the registry (recommend: exclude, document why)
5. Add a pre-P0 task: "Resolve Core Principle Taxonomy" — owner must sign off on the canonical 9 entries, their titles, and their statements

---

### CONFIRMED P0-2: Diagnostician Not in Orchestrator's Job Graph

**Status**: Confirmed. Multiple integration points identified beyond what the prior review listed.

**Code evidence** (6 files affected):

1. **`peer-runner-contracts.ts` L39-46**: `PeerRunnerKind` has exactly 7 values:
   ```typescript
   export type PeerRunnerKind =
     | 'dreamer' | 'philosopher' | 'scribe'
     | 'artificer' | 'evaluator' | 'trainer' | 'rollout_reviewer';
   ```

2. **`peer-runner-contracts.ts` L132**: `PEER_RUNNER_KINDS` array — the runtime list used by `isPeerRunnerKind()` type guard.

3. **`internalization-job-graph.ts` L28-35**: `ALLOWED_EDGES` — 6 edges forming a strict linear chain:
   ```typescript
   export const ALLOWED_EDGES = [
     ['dreamer', 'philosopher'],
     ['philosopher', 'scribe'],
     ['scribe', 'artificer'],
     ['artificer', 'evaluator'],
     ['evaluator', 'rollout_reviewer'],
     ['rollout_reviewer', 'trainer'],
   ];
   ```

4. **`pitask-metadata.ts` L190**: `hydratePITaskRecord()` rejects non-PeerRunnerKind:
   ```typescript
   if (!isPeerRunnerKind(task.taskKind)) return null;
   ```
   The comment on L181 explicitly calls out `diagnostician` as a rejected example.

5. **`internalization-orchestrator.ts`**: `wakeOnce()` filters `isPeerRunnerKind(t.taskKind)` — diagnostician tasks are invisible to the orchestrator. `proposeNextTask()` and `commitNextTaskProposal()` only handle PeerRunnerKind tasks.

6. **`internalization-state-machine.ts`**: `createNextTaskProposal()` uses `getAllowedSuccessors()` from the job graph — diagnostician kinds have no defined successors.

7. **`runtime-internalization-run-once.ts` L578-632**: The CLI dispatcher is an `if/else if` chain with 7 branches. No diagnostician branch exists.

**Impact on plan**: The plan §7.3 states "chaining/orchestration identical to the internalization pipeline" and "the seeding helper mirrors the existing successor-seeding used by Dreamer→Philosopher→Scribe". This is **structurally impossible** without extending all 7 integration points. The plan does not mention any of them.

**Recommendation**: Add an explicit pre-P3 task "Extend PeerRunner Infrastructure for Diagnostician Chain" covering all 7 files. This task must be completed before any runner implementation begins. Include it as a checklist item (see Part IV, Appendix A).

---

### CONFIRMED P0-3: No Post-Diagnosis Trigger for Admission/Intake/SeedDreamer

**Status**: Confirmed.

**Code evidence**: `pain-signal-bridge.ts` L150-307 — `onPainDetected()` executes the following pipeline synchronously:

```
L213: runner.run(taskId)
L228: stateManager.getCandidatesByTaskId(taskId)
L232: evaluateCandidateAdmissions(candidates, diagnosticianOutput, ...)
L258: intakeService.intake(candidate.candidateId)
L272: seedIntakeTask(bridgeInput, ...)
```

After the split, `onPainDetected()` can only seed the first task (`diag_rootcause`). When the Router (Stage C) reaches `succeeded`, **no code path triggers admission → intake → seedDreamer**. The entire downstream pipeline (principle candidates entering the internalization chain) breaks.

**Impact on plan**: The plan does not mention this gap. A developer implementing the 3 runners would produce a chain that completes diagnosis but never feeds results into the admission gate, intake service, or dreamer seeding. The principle candidates would sit in the database with status `pending` forever.

**Recommendation**: Add a P3 sub-task: implement `onDiagnosisComplete(taskId, output)` that performs the same admission → intake → seed pipeline currently in `onPainDetected()` L228-306. This method must be triggered when `diag_router` enters `succeeded`. Specify:
- Who calls it (orchestrator? CLI polling? event listener?)
- Where it lives (PainSignalBridge extension? new DiagnosisCompletionHandler?)
- How it handles the async case (P1 means diagnosis completes in a background process)

---

## Part II: New Blocking Items

### NEW-1: diagnosticJson Format Incompatible with PI Metadata Envelope

**Severity**: P0 (chain non-functional without fix)
**Phase affected**: P3

**Problem**: The current `PainSignalBridge.buildDiagnosticJson()` at `pain-signal-bridge.ts` L100-114 produces bare JSON:

```json
{
  "sourcePainId": "...",
  "reasonSummary": "...",
  "evidence": [...]
}
```

But `hydratePITaskRecord()` at `pitask-metadata.ts` L104 calls `parsePITaskMetadata()` which expects the `pi_metadata` envelope format:

```json
{
  "pi_metadata": {
    "dependencyTaskIds": ["..."],
    "channel": "prompt",
    "timeoutMs": 300000,
    "inputArtifactRefs": [...],
    ...
  }
}
```

**Impact**: Without the `pi_metadata` envelope, `hydratePITaskRecord()` returns `null` for all diagnostician tasks. The orchestrator's dependency gate (`validateInternalizationTaskReady()`) cannot resolve `dependencyTaskIds`, so B and C tasks will be permanently blocked as "dependency not found".

**Recommendation**: The split path's task creation must use `serializePITaskMetadata()` to produce a properly enveloped `diagnosticJson` that includes both:
- PI metadata fields (`dependencyTaskIds`, `channel`, etc.) for chaining
- Stage A business fields (`sourcePainId`, `evidence`, `workspaceDir`) inside the envelope

Add this to the P3 integration checklist.

---

### NEW-2: Feature Flag Combinations Have Undefined Behavior

**Severity**: P1 (risk of confusing runtime behavior during development/testing)
**Phase affected**: P1, P2, P3

**Problem**: Three boolean flags produce 8 combinations. The plan defines only 3 (the comparison arms). The remaining 5 are undefined:

| `async_cli` | `grounding` | `split` | Plan Defines? | Problem |
|---|---|---|---|---|
| off | off | off | Yes (baseline) | — |
| on | off | off | Yes (Arm 1) | — |
| on | on | off | Yes (Arm 2) | — |
| on | on | on | Yes (Arm 3) | — |
| **off** | **on** | **off** | **No** | How does grounding inject into single-agent path when sync mode expects immediate output? |
| **off** | **off** | **on** | **No** | 3 serial LLM calls in sync mode = 540-1440s block. Operator will Ctrl-C. |
| **off** | **on** | **on** | **No** | Same sync block + grounding |
| **on** | **off** | **on** | **No** | Split without grounding — Distiller receives empty axiom list? What does `groundedOnCorePrincipleIds` contain? |

**Impact**: During development and testing, engineers will inevitably try combinations not covered by the plan. The `off/on/on` combination (sync split) would block the CLI for 10+ minutes with no feedback — a developer might assume the process hung and kill it.

**Recommendation**:
1. Add an explicit "Valid Flag Combinations" table to the design document (see Part IV, Appendix B)
2. Implement a **startup assertion** in the flag consumer: if `split_pipeline=on` and `async_cli=off`, fail loud with message: `"diagnostician_split_pipeline requires diagnostician_async_cli=on (3 serial LLM calls would block sync CLI for 540s+)"`
3. If `split_pipeline=on` and `core_grounding=off`, document that the Distiller receives an empty axiom list and `groundedOnCorePrincipleIds` will be `[]`

---

### NEW-3: Task ID Naming Convention Conflict

**Severity**: P1 (idempotency and debugging impact)
**Phase affected**: P1, P3

**Problem**: Current task ID generation at `pain-signal-bridge.ts` L68:

```typescript
export function createDiagnosticianTaskId(painId: string): string {
  return `diagnosis_${painId}`;
}
```

This produces a single task per painId. After split, one painId maps to 3 tasks. The plan does not specify how the 3 task IDs are generated.

Meanwhile, the orchestrator at `internalization-orchestrator.ts` L384 uses a different convention:
```typescript
taskId: `${proposal.taskKind}-${sourceTaskId}-${proposal.channel}`
```

These two conventions are inconsistent. Without a clear decision:
- `diagnosis_${painId}` (monolith) vs `diag_rootcause-${something}` (split) — different prefixes
- `pd pain retry --pain-id <id>` needs to know which task to retry — but now one painId maps to 3 tasks
- `pd task show <taskId>` in the CLI async output must return the correct first task ID

**Impact**: ID collisions break idempotency (re-running the same pain signal creates duplicate tasks). Debugging becomes confusing when `pd pain retry` cannot find the right task.

**Recommendation**: Define the split task ID convention explicitly:
- Stage A: `diag_rootcause-${painId}`
- Stage B: created by successor seeding using orchestrator convention: `diag_distiller-${stageA_taskId}-prompt`
- Stage C: `diag_router-${stageB_taskId}-prompt`
- Update `createDiagnosticianTaskId()` or create a new function for the split path
- Document `pd pain retry` semantics: retry the **latest non-succeeded task** for a given painId, not the entire chain

---

### NEW-4: ContextAssembler Stage Adaptation Not Specified

**Severity**: P1 (implementation ambiguity for junior developers)
**Phase affected**: P3

**Problem**: The plan §7.2 states:
- "A.buildContext: assembles DiagnosticianContextPayload from the pain signal (reuses existing ContextAssembler)"
- "B.buildContext: resolves A's PIArtifact via artifactStore.listBySourceTaskId(depId); attaches CORE_PRINCIPLES"
- "C.buildContext: resolves B's PIArtifact (and A's for root-cause echo)"

But `BasePeerRunner.buildContext()` takes only `(taskId: string) => Promise<TContext>`. The plan does not specify:
1. How Stage A accesses the pain signal data (via task's `diagnosticJson`? via `ContextAssembler` injection?)
2. How Stages B and C resolve their predecessor's artifact (the `dependencyTaskIds` → `artifactStore.listBySourceTaskId()` pattern used by Philosopher/Scribe)
3. What the `TContext` generic type parameter is for each runner (Philosopher uses `PhilosopherContext`, Scribe uses `ScribeContext`)

**Impact**: A junior developer implementing Stage B might not know to look at `philosopher-runner.ts` L128-167 for the dependency resolution pattern. They might try to inject `ContextAssembler` into all 3 runners, which would not work for B and C.

**Recommendation**: In §7.2, add pseudocode for each stage's `buildContext()`:
- Stage A: show how it reads `diagnosticJson` from the task record and transforms it into `DiagRootCauseContext`
- Stage B: reference `philosopher-runner.ts` L128-167 explicitly, show the `dependencyTaskIds` iteration pattern, define `DiagDistillerContext` type
- Stage C: reference `scribe-runner.ts` L132-171, show dual-dependency resolution (B's artifact + A's root cause echo), define `DiagRouterContext` type

---

### NEW-5: Successor Task Creation Responsibility Not Assigned

**Severity**: P0 (chain will not progress without this)
**Phase affected**: P3

**Problem**: After Stage A succeeds, who creates Stage B's task? After Stage B succeeds, who creates Stage C's task?

In the existing internalization chain, this is handled by `InternalizationOrchestrator.commitNextTaskProposal()` at `internalization-orchestrator.ts` L352-430. The plan says "the host seeds the next task" but does not specify who "the host" is:

- `PainSignalBridge`? It currently creates only the initial diagnostician task and then calls `runner.run()` synchronously.
- `InternalizationOrchestrator`? It currently only handles PeerRunnerKind tasks and uses `createNextTaskProposal()` which relies on `ALLOWED_EDGES`.
- The CLI command? It spawns a detached process and returns — it is not alive to observe stage completion.
- A new component? Not mentioned in the plan.

**Impact**: This is the most ambiguous point in the design. Two developers working on P3 might each assume the other is implementing successor seeding, resulting in a chain where Stage A completes and nothing happens next.

**Recommendation**: Assign this responsibility explicitly. Two viable options:

**Option A (Recommended)**: Extend `InternalizationOrchestrator` to handle the diagnostician chain. Benefits:
- Reuses mature `commitNextTaskProposal()` with dedup, idempotency, DAG validation
- Single orchestration codebase for both chains
- Recovery sweep already handles expired leases for PeerRunnerKind tasks

**Option B**: Create a `DiagnosticianChainOrchestrator` that mirrors the internalization orchestrator's successor logic. Costs:
- Duplicated dedup/idempotency logic
- Two orchestration systems to maintain
- Higher risk of divergence

Whichever option is chosen, document it in §7.3 and add it to the integration checklist.

---

### NEW-6: P2 Grounding Observability Method Not Defined

**Severity**: P1 (P2's acceptance criteria are unverifiable without this)
**Phase affected**: P2

**Problem**: In P2, core grounding is applied to the existing single-agent diagnostician. The Distiller prompt receives `CORE_PRINCIPLES` and is instructed to ground its output on core axioms. However, `DiagnosticianOutputV1` has no `groundedOnCorePrincipleIds` field. So:

- How does Arm 2 measure "core-principle linkage %"?
- How does the developer verify that grounding is working?
- Where does the grounding signal appear in the output?

The plan §5.4 says "add `groundedOnCorePrincipleIds` to a v1.1 optional output field OR measure via Arm 2 prompt" — these are fundamentally different approaches and neither is chosen.

**Impact**: Without a defined measurement method, P2 has no exit criteria. The developer cannot prove grounding works, and the 3-arm comparison cannot score Arm 2.

**Recommendation**: Choose one approach before P2 starts:

**Approach A (Prompt-only, recommended for P2)**:
1. Inject `CORE_PRINCIPLES` into the monolith's prompt
2. Instruct the LLM to include axiom references in `ambiguityNotes` (existing optional field)
3. Parse axiom IDs from `ambiguityNotes` as a telemetry metric
4. Zero schema change → downstream contract truly frozen

**Approach B (Schema extension)**:
1. Add `groundedOnCorePrincipleIds?: string[]` as an optional field to `DiagnosticianOutputV1Schema`
2. The monolith populates it when grounding is on; absent when off
3. Downstream consumers (Committer, CandidateIntake) ignore it (optional field)

Either approach works, but the plan must pick one and document it. Approach A is safer (no schema change) but less clean (parsing `ambiguityNotes` is fragile). Approach B is cleaner but technically modifies the downstream contract (even if backward-compatible).

---

## Part III: Risk Assessment

### Risk #1 (Highest): Distiller Prompt Design Is the Value Anchor — and It's Unvalidated

The entire refactoring's value proposition rests on one assumption:

> "When an LLM is given core axioms T-01..T-09 and a root cause, it can produce an abstracted principle that is measurably more abstract and cross-scenario than when it does root-cause + distillation + routing in a single call."

This assumption has **zero empirical evidence**. It cannot be validated through code review, unit tests, or architecture analysis. It can only be validated through a live prompt experiment.

If the assumption is wrong:
- P0 (Registry) = an unused data structure
- P2 (Grounding) = ineffective prompt injection
- P3 (3 runners) = 3x latency for the same quality output
- Arm 3 comparison = cannot demonstrate superiority over Arm 1

The plan acknowledges this risk in §12 ("Grounding makes output worse — model over-fits to axioms") but only proposes mitigation via Arm 2 isolation. This mitigation comes **after** all implementation work (P0-P3). If Arm 2 and Arm 3 both show no improvement, the entire effort is wasted.

**Recommendation**: Insert a **P-spike (Prompt Spike)** before or parallel to P0:
1. Select 5-10 real pain signals (including the 2 manual ones referenced in §8.1)
2. Construct a Distiller prompt prototype (root cause + CORE_PRINCIPLES → abstracted principle)
3. Test against both a weak model and a strong model
4. Human-evaluate: are the axiom references meaningful? Is the principle more abstract than the monolith's output?
5. Decision gate: if grounding shows no improvement, reconsider the split architecture

This costs 1-2 days of prompt engineering and potentially saves weeks of runner infrastructure work.

---

### Risk #2: Integration Width — 10 Files, Any Miss Breaks the Chain

The split chain requires coordinated changes across the following files:

| # | File | Change | What Breaks If Missed |
|---|------|--------|----------------------|
| 1 | `peer-runner-contracts.ts` | Add 3 kinds to `PeerRunnerKind` type | Type errors in all runner code |
| 2 | `peer-runner-contracts.ts` | Add 3 entries to `PEER_RUNNER_KINDS` array | `isPeerRunnerKind()` returns false → orchestrator ignores tasks |
| 3 | `internalization-job-graph.ts` | Add 2 edges to `ALLOWED_EDGES` | `validateEdge()` rejects transitions → orchestrator refuses to seed successors |
| 4 | `pitask-metadata.ts` | Ensure `hydratePITaskRecord()` passes new kinds | Returns null → dependency gate cannot resolve `dependencyTaskIds` |
| 5 | `internalization-state-machine.ts` | Handle diagnostician chain in `createNextTaskProposal()` | No successor proposed → chain stops after Stage A |
| 6 | `internalization-orchestrator.ts` | `wakeOnce()` discovers diagnostician tasks | Tasks stay `pending` forever |
| 7 | `runtime-internalization-run-once.ts` | Add 3 dispatch branches | Runners never instantiated |
| 8 | `pain-signal-bridge.ts` | Add `onDiagnosisComplete()` | Candidates never admitted/intaken/seeded |
| 9 | `pain-signal-bridge.ts` | Use `serializePITaskMetadata()` for split tasks | `hydratePITaskRecord()` returns null |
| 10 | `feature-flag-contract.ts` | Register 3 flags in `DEFAULT_FEATURE_FLAGS` | Flag checks fail → features disabled regardless of config |

The plan describes these changes in narrative form across §6, §7, and §9. A developer implementing Phase 3 would need to extract the integration points from 200+ lines of prose and ensure none are missed. This is error-prone.

**Recommendation**: Add an "Integration Checklist" appendix (see Part IV, Appendix A). Each item is a single file + single change + testable outcome. The developer checks off each item and runs a targeted test after each.

---

### Risk #3: P1 (CLI Async) Is Not "Low Risk" — It's a New Execution Model

The plan §12 Risk table rates Q1 async as "low (CLI-only)". This understates the risk.

**What's new**: PD's CLI has never used detached background subprocesses. The current model is purely synchronous: command → await → result → exit. `pd pain record` with async mode introduces:

1. **Orphan process management**: Parent CLI exits after spawning child. On Windows, detached process behavior differs from Unix. PD explicitly supports Windows + WSL (PRI-250). Windows `DETACHED_PROCESS` flag does not create a new process group — the child may be killed when the parent console closes.

2. **Concurrent spawn**: Two `pd pain record` calls in quick succession spawn two background processes. The existing idempotency guard (`createDiagnosticianTaskId` returns same ID for same painId) prevents duplicate tasks, but does it prevent duplicate subprocess spawns?

3. **Process lifecycle observability**: Once the child process is detached, how does the operator observe its progress? `pd task show <taskId>` works, but only if the child process actually started and leased the task. If the child crashed before leasing, the task stays `pending` with no indication that the subprocess failed.

4. **Log collection**: Detached subprocess stdout/stderr goes where? If it goes to the console, it interleaves with the next command the operator types. If it goes to a file, where is the file? If it goes to /dev/null, how do you debug a failed background diagnosis?

5. **Retry semantics**: `pd pain retry --pain-id <id>` currently retries the single diagnostician task. After split + async, retrying might need to: (a) find the latest failed task in the chain, (b) spawn a new background process for just that task, (c) resume the chain from that point. The plan mentions "retry that specific task (not the whole chain)" in the prior review §6.3 but doesn't specify the implementation.

**Recommendation**:
- Add a "P1 Execution Model" subsection that addresses: process lifecycle, Windows vs Unix behavior, log destination, concurrent spawn guard, retry semantics
- Consider using a simpler async model first: instead of detached subprocess, use `setImmediate()` / `process.nextTick()` + periodic `stateManager` polling from the same process, returning the task ID immediately. This avoids subprocess management entirely while still achieving the < 5s return time.
- If detached subprocess is chosen, implement a PID file at `.pd/diag-${taskId}.pid` for observability and orphan detection

---

### Risk #4: Parallel Maintenance Burden During Transition Period

Between P3 and P5, the monolith `DiagnosticianRunner` and the 3-runner split coexist. Any bug fix or improvement to the diagnostic logic must be evaluated for both paths. This is not mentioned in the plan.

**Concrete scenario**: A bug is found in the root cause analysis prompt (Phase 1-3 of the diagnostician prompt). The fix needs to be applied to:
- `diagnostician-prompt-builder.ts` (monolith, used when `split_pipeline=off`)
- `diag-rootcause-prompt-builder.ts` (split, used when `split_pipeline=on`)

These are different files with different prompt structures. The fix may not translate directly.

**Recommendation**: Document the dual-maintenance policy in §9:
- During the parallel period, prompt fixes go to both monolith and split builders
- After P5 (monolith deletion), only split builders are maintained
- The parallel period should be minimized — aim to reach P4/P5 as quickly as possible

---

### Risk #5: `coreAxiomId` in `routing-policy.ts` Is Dead Code About to Be Activated

**Finding from `01-plan-review.md` §5.3**, confirmed by code investigation:

`routing-policy.ts` L147-156 uses `coreAxiomId` to boost routing decisions:
```typescript
const axiomId = principle.principle.coreAxiomId;
if (axiomId === 'T-05' || axiomId === 'T-08') {
  codeBoost = AXIOM_GOVERNANCE_BOOST;
} else if (axiomId === 'T-01' || axiomId === 'T-03' || axiomId === 'T-04') {
  skillBoost = AXIOM_KNOWLEDGE_BOOST;
}
```

`coreAxiomId` is **never written by any code path** — it's always `undefined`. The grounding refactor activates this path for the first time.

**Risk**: The boost weights (`AXIOM_GOVERNANCE_BOOST`, `AXIOM_KNOWLEDGE_BOOST`) were designed speculatively and never tested with real data. When grounding activates them, they might produce incorrect routing decisions.

**Recommendation**: Before P2, review and validate the boost weights. Add a unit test that verifies routing behavior for each T-0x axiom ID. After P2, monitor routing distribution via telemetry.

---

## Part IV: Document Optimization Recommendations

### Optimization 1: Add a "Value Hypothesis Validation" Section

Insert §0.1 before the problem statement:

```markdown
## 0.1 Value Hypothesis

This design's core value claim is: "Splitting the diagnostician into 3 stages
and grounding the Distiller on core axioms T-01..T-09 produces measurably more
abstract principles than the current single-call approach."

This hypothesis MUST be validated before P3 implementation begins:
1. Construct a Distiller prompt prototype
2. Test with 5-10 real pain signals against weak and strong models
3. Human-evaluate abstraction quality vs monolith baseline
4. Go/No-Go: if grounding shows no improvement, reconsider the split architecture

If the hypothesis fails, the fallback is: keep the monolith, apply only Q1
(async CLI) and Q2 (BasePeerRunner unification) — both are valuable independent
of Q3/Q6.
```

---

### Optimization 2: Add Integration Checklist Appendix

```markdown
## Appendix A: Integration Checklist

### Pre-P3 (must ALL be green before runner implementation)

- [ ] PeerRunnerKind: add 'diag_rootcause' | 'diag_distiller' | 'diag_router'
      File: peer-runner-contracts.ts L39-46
      Test: type-level assertion that new kinds are valid PeerRunnerKind

- [ ] PEER_RUNNER_KINDS: add 3 entries to runtime array
      File: peer-runner-contracts.ts L132
      Test: isPeerRunnerKind('diag_rootcause') === true

- [ ] ALLOWED_EDGES: add ['diag_rootcause','diag_distiller'] and
      ['diag_distiller','diag_router']
      File: internalization-job-graph.ts L28-35
      Test: validateEdge('diag_rootcause','diag_distiller') === true

- [ ] hydratePITaskRecord: passes for new kinds
      File: pitask-metadata.ts L190
      Test: hydratePITaskRecord with taskKind='diag_rootcause' returns non-null

- [ ] createNextTaskProposal: handles diagnostician chain
      File: internalization-state-machine.ts
      Test: proposal for diag_distiller after diag_rootcause succeeded

- [ ] wakeOnce: discovers pending diagnostician tasks
      File: internalization-orchestrator.ts
      Test: wakeOnce returns diag_rootcause task

- [ ] CLI dispatcher: add 3 branches
      File: runtime-internalization-run-once.ts L578-632
      Test: command-level test for each new runner kind

- [ ] DEFAULT_FEATURE_FLAGS: register 3 flags
      File: feature-flag-contract.ts
      Test: architecture-regression.test.ts flag contract section

### P3 (must ALL be green before e2e test)

- [ ] DiagRootCauseRunner extends BasePeerRunner
      Test: architecture-regression.test.ts instanceof assertion

- [ ] DiagDistillerRunner extends BasePeerRunner
      Test: architecture-regression.test.ts instanceof assertion

- [ ] DiagRouterRunner extends BasePeerRunner
      Test: architecture-regression.test.ts instanceof assertion

- [ ] PainSignalBridge.onDiagnosisComplete() implemented
      File: pain-signal-bridge.ts
      Test: admission + intake + seed triggered after diag_router succeeded

- [ ] Split task creation uses pi_metadata envelope
      File: pain-signal-bridge.ts (split path)
      Test: hydratePITaskRecord succeeds on split diagnostician tasks

- [ ] architecture-regression.test.ts: REQUIRED_SOURCE_FILES updated
- [ ] architecture-regression.test.ts: REQUIRED_TEST_FILES updated
- [ ] architecture-regression.test.ts: REQUIRED_EXPORTS updated
```

---

### Optimization 3: Add Feature Flag Combination Matrix Appendix

```markdown
## Appendix B: Feature Flag Combination Matrix

| async_cli | grounding | split | Behavior | Valid? | Runtime Guard |
|-----------|-----------|-------|----------|--------|---------------|
| off       | off       | off   | Sync monolith (current default) | YES | — |
| on        | off       | off   | Async monolith (P1 target) | YES | — |
| on        | on        | off   | Async + grounded monolith (Arm 2) | YES | — |
| on        | on        | on    | Async + grounded split (Arm 3) | YES | — |
| on        | off       | on    | Async + split, no grounding | YES | Distiller gets empty axiom list |
| off       | on        | off   | Sync + grounding | **NO** | Fail loud at startup |
| off       | off       | on    | Sync split (540s+ block) | **NO** | Fail loud at startup |
| off       | on        | on    | Sync + grounded split | **NO** | Fail loud at startup |

Invalid combinations MUST fail with a structured error message naming both
flags and the reason (ERR-002 pattern).
```

---

### Optimization 4: Add Explicit "Done" Criteria Per Phase

Current plan §9 describes deliverables but not exit criteria. Add:

```markdown
### P0 Done When:
- Core Principle Registry exists at core-principle-registry.ts
- Registry exports CORE_PRINCIPLES with exactly 9 entries
- Drift test passes (registry ↔ THINKING_OS.md T-id consistency)
- PrincipleScope extended with 'scenario' (if adopted)
- architecture-regression.test.ts updated and passing
- npm run build && npm run test: all green in principles-core

### P1 Done When:
- pd pain record returns in < 5s with async_cli=on
- pd pain record --wait preserves sync behavior
- --json output is strict single JSON object
- Parser-level test covers --wait flag registration
- Invalid flag combinations fail loud with structured error
- Rollback runbook documented and exercised once
- pd diagnose run command exists and is independently testable

### P2 Done When:
- Grounding injection method chosen and documented
- Monolith prompt includes CORE_PRINCIPLES when grounding=on
- Grounding effect is measurable (define metric before starting)
- Arm 2 data collectible for comparison

### P3 Done When:
- 3 runners each pass V-slice tests (lease→...→succeed/fail)
- E2E test: one pain signal completes A→B→C full chain
- Admission + intake + seedDreamer triggered after Router completion
- All valid flag combinations pass integration tests
- Invalid flag combinations fail loud
- architecture-regression.test.ts: all new entries present and passing

### P4 Done When:
- Comparison report exists at docs/plans/2026-06-diagnostician-split/03-comparison-report.md
- All 3 arms executed against the same corpus (min 10 pain signals)
- Scored metrics table populated
- Go/No-Go recommendation documented with evidence
```

---

### Optimization 5: Add Implementation Reference Map for Junior Developers

```markdown
## Appendix C: Implementation Reference Map

### If you're implementing a new runner (DiagRootCause/Distiller/Router):
1. Read `philosopher-runner.ts` in full — it's the simplest BasePeerRunner subclass
2. Focus on:
   - `buildContext()` (L128-167): dependency resolution via dependencyTaskIds
   - `invokeRuntime()` (L169-193): prompt builder + runtimeAdapter.startRun()
   - `validateOutput()` (L195-220): delegating to injected validator
   - `succeedTask()` (L222-328): artifact write + lineage check
3. Then read `scribe-runner.ts` — it shows dual-dependency resolution
   (Scribe reads Philosopher's artifact, similar to how Router reads Distiller's)

### If you're implementing successor seeding:
1. Read `internalization-orchestrator.ts` L352-430 (commitNextTaskProposal)
2. Focus on:
   - Dedup logic (existing pending/retry_wait check)
   - serializePITaskMetadata() for diagnosticJson format
   - Task ID convention: ${taskKind}-${sourceTaskId}-${channel}

### If you're implementing the post-diagnosis trigger:
1. Read `pain-signal-bridge.ts` L228-306 — this is the code that must run
   after the Router completes (admission → intake → seedDreamer)
2. Extract this logic into a reusable method that can be called from
   either the monolith path (current onPainDetected) or the split path
   (new onDiagnosisComplete)

### If you're implementing the Core Principle Registry:
1. Read `.principles/THINKING_OS.md` — the authoritative source
2. Read `tests/feature-testing/FIRST_PRINCIPLES_ANALYSIS.md` L248-262 — the 9-entry list
3. Note: these two documents have naming conflicts that must be resolved BEFORE
   you implement the registry (see P0-1 in this review)
```

---

### Optimization 6: Add Inter-Stage Data Flow Table

The plan §5 defines each stage's output schema but not which fields flow where. Add:

```markdown
## Appendix D: Inter-Stage Data Flow

### Stage A → Stage B (via PIArtifact contentJson)

| Field from DiagRootCauseOutputV1 | Consumed by Stage B? | How |
|---|---|---|
| diagnosisId | Yes | Lineage: included in B's output for traceability |
| causalChain | Yes | Prompt input: Distiller reasons about root cause |
| rootCause | Yes | Prompt input: primary input for principle distillation |
| rootCauseCategory | Yes | Prompt input: shapes principle scope |
| evidence | No | Not needed (Distiller works from root cause, not raw evidence) |
| confidence | Informational | Passed through but not used for distillation decisions |

### Stage B → Stage C (via PIArtifact contentJson)

| Field from DiagPrincipleDraftV1 | Consumed by Stage C? | How |
|---|---|---|
| abstractedPrinciple | Yes | Primary input for routing decision |
| groundedOnCorePrincipleIds | Yes | Influences routing (coreAxiomId boost in routing-policy.ts) |
| scope | Yes | Determines recommendation kind distribution |
| rationale | Yes | Included in violatedPrinciples[].rationale |
| sourceRootCauseArtifactId | Yes | Lineage: C's output references back to A |

### Stage A → Stage C (root cause echo, via PIArtifact)

| Field from DiagRootCauseOutputV1 | Consumed by Stage C? | How |
|---|---|---|
| rootCause | Yes | Populates DiagnosticianOutputV1.rootCause |
| evidence | Yes | Populates DiagnosticianOutputV1.evidence |
| summary | Yes | Populates DiagnosticianOutputV1.summary |

### Stage C → DiagnosticianCommitter (unchanged contract)

| DiagnosticianOutputV1 field | Source |
|---|---|
| summary | A.summary (echoed through C) |
| rootCause | A.rootCause (echoed through C) |
| violatedPrinciples | A's root cause + B's grounding |
| evidence | A.evidence (echoed through C) |
| recommendations | C's routing decision (5 kinds) |
| confidence | C's routing confidence |
```

---

## Part V: Positive Findings Worth Highlighting

Not all findings are negative. Several aspects of the design are strong:

1. **BasePeerRunner reuse is the right call.** The class has been battle-tested by 5 production runners. Lease management, retry backoff, recovery sweep, lineage injection, and safe serialization are all inherited for free.

2. **The 3-stage split is well-motivated.** Each stage has a clear cognitive job (forensic / abstraction / taxonomy) and the "why not 2 or 4" reasoning in §3 is sound.

3. **The `routing-policy.ts` coreAxiomId boost logic is already implemented.** The grounding refactor activates existing (designed but dormant) routing intelligence. This means the downstream consumer is already coded and tested — the refactor unlocks value that was waiting for input data.

4. **Flag-gated reversibility is correctly designed.** Old monolith stays as flag-off default. Zero data migration. Flip a flag to revert. This is the gold standard for risky refactors.

5. **The 3-arm comparison harness is a strong acceptance gate.** Isolating grounding effect (Arm 2) from split effect (Arm 3) prevents confounding variables. The go/no-go decision based on evidence is sound engineering.

6. **ADR-0014 amendment is well-scoped.** Explicit scope guard (no BALM/LRAS/GAP resurrection), explicit feature flag registration, explicit reversibility guarantee. This is how MVP exceptions should be handled.

---

## Part VI: Summary Table

### All Issues

| # | Source | Severity | Phase | Description |
|---|--------|----------|-------|-------------|
| P0-1 | 01-review | P0 | P0 | T-09 not in THINKING_OS.md; naming taxonomy conflict across 3 sources |
| P0-2 | 01-review | P0 | P3 | PeerRunnerKind + ALLOWED_EDGES + 5 more files need extension |
| P0-3 | 01-review | P0 | P3 | No post-diagnosis trigger for admission/intake/seedDreamer |
| NEW-1 | This review | P0 | P3 | diagnosticJson bare format incompatible with pi_metadata envelope |
| NEW-5 | This review | P0 | P3 | Successor task creation responsibility not assigned to any component |
| NEW-2 | This review | P1 | P1-P3 | Feature flag combinations have undefined behavior (5 of 8 combos) |
| NEW-3 | This review | P1 | P1/P3 | Task ID naming convention conflict between monolith and split |
| NEW-4 | This review | P1 | P3 | ContextAssembler stage adaptation not specified for B/C |
| NEW-6 | This review | P1 | P2 | P2 grounding observability method not defined |
| RISK-1 | This review | Risk | Pre-P0 | Distiller prompt hypothesis unvalidated (value anchor) |
| RISK-2 | This review | Risk | P3 | Integration width: 10 files, any miss breaks chain |
| RISK-3 | This review | Risk | P1 | CLI async is new execution model, not "low risk" |
| RISK-4 | This review | Risk | P3-P5 | Parallel maintenance burden during transition |
| RISK-5 | This review | Risk | P2 | Dead code in routing-policy.ts about to be activated |

### All Recommendations

| # | Recommendation | Effort | When |
|---|---|--------|------|
| 1 | Resolve core principle taxonomy (count, naming, canonical source) | Low | Pre-P0 |
| 2 | Run a prompt spike to validate Distiller grounding hypothesis | Medium | Pre-P0 (parallel) |
| 3 | Add "Extend PeerRunner Infrastructure" as explicit pre-P3 task | Medium | Pre-P3 |
| 4 | Implement `onDiagnosisComplete()` in PainSignalBridge or new handler | Medium | P3 |
| 5 | Use `serializePITaskMetadata()` for split task creation | Low | P3 |
| 6 | Assign successor task creation to InternalizationOrchestrator | Low | P3 |
| 7 | Add runtime guard for invalid flag combinations | Low | P1 |
| 8 | Define split task ID convention and retry semantics | Low | P1 |
| 9 | Add pseudocode for each stage's buildContext() | Low | P3 |
| 10 | Choose P2 grounding observability method (prompt-only vs schema ext) | Low | Pre-P2 |
| 11 | Review routing-policy.ts boost weights before activation | Low | Pre-P2 |
| 12 | Add integration checklist appendix | Low | Document update |
| 13 | Add flag combination matrix appendix | Low | Document update |
| 14 | Add explicit "done" criteria per phase | Low | Document update |
| 15 | Add implementation reference map for junior developers | Low | Document update |
| 16 | Add inter-stage data flow table | Low | Document update |
| 17 | Document dual-maintenance policy during transition | Low | Document update |

---

> **End of review.** All findings are grounded in code-level investigation across 5 parallel agent sweeps of the repository. No speculative claims without code evidence. The design's architectural choices are sound; the gaps are in integration detail, risk calibration, and implementation guidance.
