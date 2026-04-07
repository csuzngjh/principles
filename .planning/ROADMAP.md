# Roadmap

## Milestones

- ✅ **v1.0-alpha MVP** — Phases 1-3 (shipped 2026-03-26)
- ✅ **v1.4 OpenClaw v2026.4.3 Compatibility** — Phases 1, 2, 5 (shipped 2026-04-05)
- ✅ **v1.5 Nocturnal Helper 重构** — Phases 6-10 (shipped 2026-04-06)
- 🚧 **v1.6 代码质量清理** — Phases 11-13 (in progress)

## Phases

<details>
<summary>✅ v1.0-alpha MVP (Phases 1-3) — SHIPPED 2026-03-26</summary>

- [x] Phase 1: SDK Integration (1/1 plan) — completed 2026-03-26
- [x] Phase 2: Memory Search (1/1 plan) — completed 2026-03-26
- [x] Phase 2.5: SDK Refinement (1/1 plan) — completed 2026-03-26
- [x] Phase 3A: Input Quarantine (1/1 plan) — completed 2026-03-26
- [x] Phase 3B: Gate Split (1/1 plan) — completed 2026-03-26
- [x] Phase 3C: Defaults & Errors (1/1 plan) — completed 2026-03-26

</details>

<details>
<summary>✅ v1.4 OpenClaw v2026.4.3 Compatibility — SHIPPED 2026-04-05</summary>

- [x] Phase 1: SDK Type Cleanup (2 plans) — completed 2026-04-05
- [x] Phase 2: Memory Search (FTS5) (1 plan) — completed 2026-04-05
- [x] Phase 5: Integration Testing (partial — TEST-04/05 pending)

**Known gaps:** TEST-04/05 runtime verification pending via Feishu

</details>

<details>
<summary>✅ v1.5 Nocturnal Helper 重构 (Phases 6-10) — SHIPPED 2026-04-06</summary>

- [x] Phase 6: Foundation and Single-Reflector Mode (1/1) — completed 2026-04-03
- [x] Phase 7: Trinity Integration with Event Recording (2/2) — completed 2026-04-04
- [x] Phase 8: Intermediate Persistence and Idempotency (2/2) — completed 2026-04-05
- [x] Phase 9: Fallback and Evolution Worker Integration (1/1) — completed 2026-04-06
- [x] Phase 10: Fix NOC-15 Stub Parameters (1/1) — completed 2026-04-06

**Key accomplishments:** NocturnalWorkflowManager with WorkflowManager interface, Trinity chain (Dreamer→Philosopher→Scribe), WorkflowStore stage_outputs for persistence/idempotency, stub-based fallback on Trinity failure

**Known gaps:** Phases 07/08 missing VERIFICATION.md; NOC requirements not in REQUIREMENTS.md

</details>

### 🚧 v1.6 代码质量清理 (Phases 11-13) — IN PROGRESS

**Goal:** 清理代码膨胀、修复危险命名冲突、解决遗留路径断裂问题

No new features — only cleanup and refactor. Must not break existing functionality.

#### Phase 11: Critical Safety Fixes

**Goal**: Eliminate dangerous naming conflict and broken pain processing path

**Depends on**: Nothing (first phase of v1.6)

**Requirements**: CLEAN-01, CLEAN-02

**Success Criteria** (what must be TRUE):
  1. `nocturnal-compliance.ts` uses renamed `normalizePathPosix` function instead of conflicting `normalizePath`
  2. `utils/io.ts` `normalizePath` remains unchanged and unaffected by refactor
  3. PAIN_CANDIDATES processing has single unified path (either integrated into evolution-reducer or removed)
  4. No broken `trackPainCandidate()` or `processPromotion()` calls remain in codebase

**Plans**: 2 plans

Plans:
- [x] 11-01-PLAN.md — CLEAN-01: Rename normalizePath to normalizePathPosix in nocturnal-compliance.ts
- [x] 11-02-PLAN.md — CLEAN-02: Delete entire PAIN_CANDIDATES system from evolution-worker.ts

#### Phase 12: Code Deduplication

**Goal**: Reduce code duplication across WorkflowManagers and unify duplicate type definitions

**Depends on**: Phase 11

**Requirements**: CLEAN-03, CLEAN-04

**Success Criteria** (what must be TRUE):
  1. WorkflowManager base class extracted containing shared lifecycle, state transitions, and store operations
  2. EmpathyObserverWorkflowManager and DeepReflectWorkflowManager extend the base class (NocturnalWorkflowManager unchanged — different architecture using TrinityRuntimeAdapter)
  3. `PrincipleStatus` type defined in single location (`core/evolution-types.ts`) with all references updated
  4. `PrincipleDetectorSpec` type defined in single location with all references updated

**Plans**: 2 plans

Plans:
- [x] 12-01-PLAN.md — CLEAN-03: Extract WorkflowManager base class (empathy-observer + deep-reflect)
- [x] 12-02-PLAN.md — CLEAN-04: Unify PrincipleStatus and PrincipleDetectorSpec types

#### Phase 13: Cleanup and Investigation

**Goal**: Complete remaining cleanup tasks and investigate dead code

**Depends on**: Phase 12

**Requirements**: CLEAN-05, CLEAN-06

**Success Criteria** (what must be TRUE):
  1. empathy-observer-workflow-manager reference status confirmed (either deprecated/removed if dead, or verified compatible if live)
  2. `.gitignore` contains `packages/*/dist/`, `packages/*/coverage/`, `packages/*/*.tgz` entries
  3. Build artifacts correctly excluded from git tracking
  4. Existing build and test processes unaffected by .gitignore changes

**Plans**: 2 plans

Plans:
- [ ] 13-01-PLAN.md — CLEAN-05: Verify EmpathyObserverWorkflowManager extends WorkflowManagerBase correctly
- [ ] 13-02-PLAN.md — CLEAN-06: Add coverage and tgz entries to .gitignore

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
| 11 | v1.6 | 2/2 | Complete | 2026-04-07 |
| 12 | v1.6 | 2/2 | Complete | 2026-04-07 |
| 13 | v1.6 | 2/2 | Not started | - |
