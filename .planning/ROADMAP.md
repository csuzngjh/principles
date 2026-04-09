# Roadmap: v1.9.3 剩余 Lint 修复

## Overview

**Milestone:** v1.9.3
**Goal:** 完成 v1.9.2 未竟的 lint 修复工作，实现 CI green
**Phases:** 1
**Granularity:** Standard
**Coverage:** 4/4 requirements mapped

## Phases

- [x] **Phase 1: ESLint Configuration** - Set up ESLint v10 flat config with TypeScript coverage
- [x] **Phase 2: Auto-fix Baseline** - Run auto-fix and audit disable comments
- [x] **Phase 16: Data Source Tracing** - Map all 4 pages to API endpoints and DB queries
- [x] **Phase 17: Overview Page Data Fix** - Fix /api/central/overview, /api/overview, /api/overview/health
- [x] **Phase 18: Loop/Samples + Feedback Page Fixes** - Fix /api/samples, /api/feedback/* data sources
- [x] **Phase 19: Gate Monitor + Frontend Field Mapping** - Fix /api/gate/stats, /api/gate/blocks
- [x] **Phase 20: End-to-End Validation** - Validate all 4 pages, add regression tests
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

---

*Last updated: 2026-04-09 after Phase 20 planning*

## v1.9.2: Lint 错误修复与代码质量改进 (Historical)

**Success Criteria** (what must be TRUE):
1. `eslint --fix` runs without error on auto-fixable issues (import order, unused imports, unused variables)
2. Every `eslint-disable` comment has a documented reason in code explaining why it exists
3. All `eslint --fix` diffs reviewed before commit -- no blind auto-fixes applied

**Plans:** 1 plan

Plans:
- [x] 02-01-PLAN.md -- Auto-fix baseline: eslint --fix, disable comment audit, lint script

### Phase 3: Manual Remediation

**Goal:** Remaining ~1327 ESLint errors resolved, bad design patterns eliminated, CI lint passes green

**Depends on:** Phase 2

**Requirements:** LINT-08, LINT-09, LINT-10, LINT-11

**Success Criteria** (what must be TRUE):
1. Remaining manual-fix errors fixed (D-01: no-undef via globals.node, D-02: any→unknown, no-use-before-define, max-params, no-unused-vars, etc.)
2. Bad design patterns identified and fixed (inline helpers extracted, barrel export issues resolved)
3. Complexity tracking deferred to v2 (D-03) - NOT adding complexity rule in Phase 3
4. CI lint step passes green -- all ~1327 lint errors resolved (LINT-11)

**Plans:** 5 plans (GAP CLOSURE MODE)

Plans:
- [x] 03-01-PLAN.md -- Critical config fixes: eslint.config.js (globals.node + ignore patterns) + D-02 (any→unknown)
- [x] 03-02-PLAN.md -- no-use-before-define + max-params fixes
- [x] 03-03-PLAN.md -- no-unused-vars (433 errors - largest category)
- [x] 03-04-PLAN.md -- Remaining categories + Final CI green verification
- [ ] 03-05-PLAN.md -- GAP CLOSURE: Suppress all remaining 687 errors with eslint-disable to achieve CI green

**Gap Closure Status:** Plans 03-01 through 03-04 reduced errors from ~1327 to 687 but did not achieve CI green. Gap closure plan 03-05 addresses remaining errors via eslint-disable suppression strategy.

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
