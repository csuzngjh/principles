# Roadmap

## Milestones

- ✅ **v1.0-alpha MVP** - Phases 1-3 (shipped 2026-03-26)
- ✅ **v1.4 OpenClaw v2026.4.3 Compatibility** - Phases 1, 2, 5 (shipped 2026-04-05)
- ✅ **v1.5 Nocturnal Helper 重构** - Phases 6-10 (shipped 2026-04-06)
- 🚧 **v1.9.0 Principle Internalization System** - Phases 11-15 (planned)

## Phases

<details>
<summary>✅ v1.0-alpha MVP (Phases 1-3) - SHIPPED 2026-03-26</summary>

- [x] Phase 1: SDK Integration (1/1 plan) - completed 2026-03-26
- [x] Phase 2: Memory Search (1/1 plan) - completed 2026-03-26
- [x] Phase 2.5: SDK Refinement (1/1 plan) - completed 2026-03-26
- [x] Phase 3A: Input Quarantine (1/1 plan) - completed 2026-03-26
- [x] Phase 3B: Gate Split (1/1 plan) - completed 2026-03-26
- [x] Phase 3C: Defaults & Errors (1/1 plan) - completed 2026-03-26

</details>

<details>
<summary>✅ v1.4 OpenClaw v2026.4.3 Compatibility - SHIPPED 2026-04-05</summary>

- [x] Phase 1: SDK Type Cleanup (2 plans) - completed 2026-04-05
- [x] Phase 2: Memory Search (FTS5) (1 plan) - completed 2026-04-05
- [x] Phase 5: Integration Testing (partial - TEST-04/05 pending)

**Known gaps:** TEST-04/05 runtime verification pending via Feishu

</details>

<details>
<summary>✅ v1.5 Nocturnal Helper 重构 (Phases 6-10) - SHIPPED 2026-04-06</summary>

- [x] Phase 6: Foundation and Single-Reflector Mode (1/1) - completed 2026-04-03
- [x] Phase 7: Trinity Integration with Event Recording (2/2) - completed 2026-04-04
- [x] Phase 8: Intermediate Persistence and Idempotency (2/2) - completed 2026-04-05
- [x] Phase 9: Fallback and Evolution Worker Integration (1/1) - completed 2026-04-06
- [x] Phase 10: Fix NOC-15 Stub Parameters (1/1) - completed 2026-04-06

**Key accomplishments:** NocturnalWorkflowManager with WorkflowManager interface, Trinity chain (Dreamer->Philosopher->Scribe), WorkflowStore stage_outputs for persistence/idempotency, stub-based fallback on Trinity failure

</details>

<details open>
<summary>🚧 v1.9.0 Principle Internalization System (Phases 11-15) - PLANNED</summary>

- [x] Phase 11: Principle Tree Ledger Entities (3 plans) - completed 2026-04-07
- [x] Phase 12: Runtime Rule Host and Code Implementation Storage (2 plans) - completed 2026-04-07
- [x] Phase 13: Replay Evaluation and Manual Promotion Loop (1 plan) - completed 2026-04-07
- [x] Phase 14: Nocturnal RuleImplementationArtifact Factory (2 plans) - completed 2026-04-08
- [ ] Phase 15: Coverage, Adherence, and Internalization Routing

**Milestone goal:** turn the current principle / nocturnal / gate architecture into a real Principle Internalization System with first-class Rule and Implementation entities, a constrained runtime Rule Host, replay-based code implementation promotion, and nocturnal code candidate generation.

**Milestone boundaries:** keep Progressive Gate in place, do not auto-deploy code implementations, and prefer the cheapest viable internalization path over defaulting every principle to code.

</details>

### Next Milestone (Current)

**v1.9.0 Principle Internalization System** is in progress. Next step: start Phase 15.

## Progress

| Phase | Milestone | Plans | Status | Completed |
|-------|-----------|-------|--------|-----------|
| 1 | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 2 | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 2.5 | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 3A | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 3B | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 3C | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 1 | v1.4 | 2/2 | Complete | 2026-04-05 |
| 2 | v1.4 | 1/1 | Complete | 2026-04-05 |
| 5 | v1.4 | 1/1 | Partial | 2026-04-05 |
| 6 | v1.5 | 1/1 | Complete | 2026-04-03 |
| 7 | v1.5 | 2/2 | Complete | 2026-04-04 |
| 8 | v1.5 | 2/2 | Complete | 2026-04-05 |
| 9 | v1.5 | 1/1 | Complete | 2026-04-06 |
| 10 | v1.5 | 1/1 | Complete | 2026-04-06 |
| 11 | v1.9.0 | 3/3 | Complete    | 2026-04-07 |
| 12 | v1.9.0 | 2/2 | Complete    | 2026-04-07 |
| 13 | v1.9.0 | 1/1 | Complete   | 2026-04-07 |
| 14 | v1.9.0 | 2/2 | Complete   | 2026-04-08 |
| 15 | v1.9.0 | 0/1 | Pending | - |

## Phase Details

### Phase 11: Principle Tree Ledger Entities

Goal: make `Rule` and `Implementation` first-class principle-tree records instead of schema-only concepts.

**Plans:** 3/3 plans complete

Plans:
- [x] 11-01-PLAN.md - Build the hybrid `_tree` ledger, CRUD/query surface, and backward-compatible training-state adapter
- [x] 11-02-PLAN.md - Wire the ledger into `WorkspaceContext` and remove raw unlocked pain-path writes
- [x] 11-03-PLAN.md - Close the CRUD gap with Rule/Implementation update-delete helpers and integrity-preserving tests

Requirements:
- TREE-01
- TREE-02
- TREE-03
- TREE-04

Success criteria:
1. Principle tree store can persist and query `Principle -> Rule -> Implementation` relationships
2. One Rule can reference multiple Implementations without semantic collapse
3. Rule and Implementation CRUD exists in code, not only in docs

### Phase 12: Runtime Rule Host and Code Implementation Storage

Goal: add the constrained runtime host for `Implementation(type=code)` and store code implementations as versioned assets.

**Plans:** 2/2 plans complete

Plans:
- [x] 12-01-PLAN.md - Build Rule Host types, helper whitelist, evaluator, and wire into gate.ts between GFI and Progressive Gate
- [x] 12-02-PLAN.md - Build versioned code implementation storage with manifest, entry file, and PD path extensions

Requirements:
- HOST-01
- HOST-02
- HOST-03
- HOST-04
- IMPL-01
- IMPL-02

Success criteria:
1. gate chain executes `Rule Host` between `GFI` and `Progressive Gate`
2. active code implementations run only through a fixed host contract and helper whitelist
3. implementation storage supports manifest, entry, replay samples, and evaluation artifacts

### Phase 13: Replay Evaluation and Manual Promotion Loop

Goal: require offline replay before any code implementation can become active.

**Plans:** 1/1 plan complete

Plans:
- [x] 13-01-PLAN.md - ReplayEngine, structured evaluation reports, manual promotion/disable/rollback commands, and natural language routing

Requirements:
- IMPL-03
- EVAL-01
- EVAL-02
- EVAL-03
- EVAL-04
- EVAL-05

Success criteria:
1. candidate code implementations can be replayed over negative, positive, and anchor samples
2. replay produces a structured evaluation report with pass/fail decision
3. operator can manually promote, disable, and roll back code implementations

### Phase 14: Nocturnal RuleImplementationArtifact Factory

Goal: extend nocturnal reflection so it can research and emit code implementation candidates without conflating them with training samples.

**Plans:** 2/2 plans complete

Plans:
- [x] 14-01-PLAN.md - Define Artificer contracts, deterministic principle->rule routing, and RuleHost-compatible code-candidate validation
- [x] 14-02-PLAN.md - Wire candidate persistence, parallel lineage registration, and nocturnal-service integration without changing behavioral artifact semantics

Requirements:
- NOC-01
- NOC-02
- NOC-03

Success criteria:
1. nocturnal can emit `RuleImplementationArtifact` candidates with principle and rule linkage
2. code implementation candidates reuse existing snapshot / validation skeletons without reusing the wrong artifact schema
3. behavioral training artifacts and code implementation artifacts coexist cleanly

### Phase 15: Coverage, Adherence, and Internalization Routing

Goal: turn implementation outcomes into real coverage and internalization decisions.

Requirements:
- COV-01
- COV-02
- COV-03
- COV-04
- ROUT-01
- ROUT-02

Success criteria:
1. Rule coverage and false-positive metrics reflect replay and live behavior rather than implementation presence alone
2. Principle adherence and deprecation eligibility are computed from lower-layer implementation outcomes
3. system can represent "cheapest viable implementation first" as an explicit routing policy
