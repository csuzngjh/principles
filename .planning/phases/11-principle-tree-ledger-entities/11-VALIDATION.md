---
phase: 11
slug: principle-tree-ledger-entities
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-07
---

# Phase 11 - Validation Strategy

> Per-phase validation contract for Principle Tree ledger work.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | none |
| **Quick run command** | `cd packages/openclaw-plugin && npx vitest run tests/core/principle-tree-ledger.test.ts -t "persists rule|persists implementation|multiple implementations"` |
| **Full suite command** | `cd packages/openclaw-plugin && npm test` |
| **Estimated runtime** | ~20 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd packages/openclaw-plugin && npx vitest run tests/core/principle-tree-ledger.test.ts -t "persists rule|persists implementation|multiple implementations"` or a similarly narrow task-local smoke command
- **After every plan wave:** Run `cd packages/openclaw-plugin && npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 11-01-01 | 01 | 1 | TREE-01 | T-11-01 | Locked ledger CRUD persists Rule records without corrupting existing top-level principle state | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/principle-tree-ledger.test.ts -t "persists rule"` | No - W0 | pending |
| 11-01-02 | 01 | 1 | TREE-02 | T-11-01 | Locked ledger CRUD persists Implementation records linked to Rule IDs | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/principle-tree-ledger.test.ts -t "persists implementation"` | No - W0 | pending |
| 11-01-03 | 01 | 1 | TREE-03 | T-11-02 | Workspace-scoped queries return `Principle -> Rule -> Implementation` relationships for active principles | unit/integration | `cd packages/openclaw-plugin && npx vitest run tests/core/principle-tree-ledger.test.ts tests/core/workspace-context.test.ts -t "active principle subtree"` | No - W0 | pending |
| 11-01-04 | 01 | 1 | TREE-04 | T-11-01 | Rule records preserve multiple linked Implementation IDs without semantic collapse | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/principle-tree-ledger.test.ts -t "multiple implementations"` | No - W0 | pending |
| 11-02-01 | 02 | 2 | TREE-01,TREE-03 | T-11-03 | Existing pain and principle-training writers route through the ledger owner module instead of raw unlocked JSON writes | smoke/integration | `cd packages/openclaw-plugin && npx vitest run tests/hooks/pain.test.ts -t "value metrics|principle training state"` | Partial | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `packages/openclaw-plugin/tests/core/principle-tree-ledger.test.ts` - new CRUD and migration coverage for TREE-01 through TREE-04
- [ ] `packages/openclaw-plugin/tests/core/principle-training-state.test.ts` - hybrid-file migration and backward-compatibility assertions
- [ ] `packages/openclaw-plugin/tests/core/workspace-context.test.ts` - getter caching and workspace access tests for ledger service
- [ ] `packages/openclaw-plugin/tests/hooks/pain.test.ts` - regression coverage proving pain hook no longer performs raw unlocked JSON writes

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Inspect migrated `.state/principle_training_state.json` shape for `_tree` namespace readability and top-level compatibility | TREE-01,TREE-02,TREE-03,TREE-04 | Automated tests can prove behavior but not the final operator-facing JSON readability expectation | Run a ledger mutation in a temp workspace, open the file, confirm legacy top-level principle records remain and `_tree` contains `principles`, `rules`, and `implementations` maps |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all missing references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
