# Roadmap: v1.9.3 剩余 Lint 修复

## Overview

**Milestone:** v1.9.3
**Goal:** 完成 v1.9.2 未竟的 lint 修复工作，实现 CI green
**Phases:** 1
**Granularity:** Standard
**Coverage:** 4/4 requirements mapped

## Phases

- [ ] **Phase 03: Manual Remediation (Continuation)** - Execute eslint-disable suppression for remaining errors, mechanical fixes, CI verification

## Phase Details

### Phase 03: Manual Remediation (Continuation)

**Goal:** Execute eslint-disable suppression strategy for remaining ~700 errors, fix prefer-destructuring mechanically, achieve CI green

**Depends on:** Phase 02 (Auto-fix Baseline - complete in v1.9.2)

**Requirements:** LINT-11, LINT-12, LINT-13, LINT-14

**Success Criteria** (what must be TRUE):
1. prefer-destructuring errors fixed mechanically (~50 errors)
2. All other lint errors suppressed with eslint-disable comments containing `-- Reason:`
3. CI lint step passes with 0 errors
4. SUPPRESSION-LEDGER.md updated documenting all suppressions

**Plans:** 1 plan (continuation of v1.9.2 03-05-PLAN.md)

Plans:
- [ ] 03-05-PLAN.md -- GAP CLOSURE: Execute eslint-disable suppression for CI green

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 03. Manual Remediation | 0/1 | Pending | No |

## Coverage Map

| Requirement | Phase | Status |
|-------------|-------|--------|
| LINT-11 | 03 | Pending |
| LINT-12 | 03 | Pending |
| LINT-13 | 03 | Pending |
| LINT-14 | 03 | Pending |

**Total:** 4/4 requirements mapped

## Gap Closure from v1.9.2

**Remaining from v1.9.2:**
- ~50: prefer-destructuring (mechanically fixable)
- ~637: require eslint-disable suppression (max-params, no-use-before-define, no-explicit-any, etc.)
- ~13: no-unused-vars (partial fix in 03-03)

**Plan 03-05 Approach (from v1.9.2):**
1. Mechanically fix prefer-destructuring
2. Suppress all other categories with eslint-disable -- Reason:
3. Final CI verification must show 0 errors

**Deferred to future phases:**
- LINT-09: Inline helpers extraction (需要架构级重构)
- LINT-10: Complexity rules (项目约定，延期到 v2)
