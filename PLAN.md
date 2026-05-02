# Plan: PRI-23 + PRI-24 Pruning Review Foundation

**Date:** 2026-05-02
**Status:** READY

## Context

M2 Principle Lifecycle Review 的第一批开发。目标：
- PRI-23: CLI explain command（读 PruningReadModel，不写任何状态）
- PRI-24: Core append-only review log（写 JSONL，不碰 ledger）

Non-goals: 不实现 review CLI、不修改 ledger 状态、不做自动 pruning。

---

## Scope A: PRI-23 `pd runtime pruning explain`

### Files to Modify

| File | Change |
|------|--------|
| `packages/pd-cli/tests/commands/runtime-pruning.test.ts` | 新增 explain 测试用例 |
| `packages/pd-cli/src/commands/runtime-pruning.ts` | 新增 `handlePruningExplain` |
| `packages/pd-cli/src/index.ts` | 注册 `explain` 子命令 |

### Command Shape

```
pd runtime pruning explain --principle-id <id> [--workspace <path>] [--json]
```

### Behavior

1. 实例化 `PruningReadModel`，调用 `getPrincipleSignals()`
2. 找到匹配 `principleId` 的 signal
3. **JSON mode**: `{ workspace, principleId, signal, generatedAt }` → `console.log(JSON.stringify(...))`
4. **Text mode**: 输出 principleId, status, riskLevel, ageDays, derivedPainCount, matchedCandidateCount, orphanCandidateCount, reasons, read-only note
5. **找不到**: JSON mode `process.exit(1)` + 结构化错误，text mode 打印错误 + `process.exit(1)`
6. **不写** ledger / state.db / review log

### TDD Tests (add to `runtime-pruning.test.ts`)

```typescript
it('explain --json outputs matching signal for p_watch', ...)
it('explain text output includes reason lines and read-only note', ...)
it('explain missing principle exits 1 with error', ...)
it('explain passes explicit workspace to PruningReadModel', ...)
it('explain does not call any write/append API', ...)
```

---

## Scope B: PRI-24 `pruning-review-log.ts`

### Files to Add

| File | Change |
|------|--------|
| `packages/principles-core/src/runtime-v2/pruning-review-log.ts` | NEW — core audit log |
| `packages/principles-core/src/runtime-v2/__tests__/pruning-review-log.test.ts` | NEW — TDD tests |
| `packages/principles-core/src/runtime-v2/index.ts` | 新增导出 |

### API

```typescript
export type PruningReviewDecision = 'keep' | 'defer' | 'archive-candidate';

export interface PruningReviewRecord {
  reviewId: string;        // UUID
  principleId: string;
  decision: PruningReviewDecision;
  note: string;
  reviewer: string;
  reviewedAt: string;      // ISO timestamp
  signalSnapshot: PrinciplePruningSignal;
}

export interface AppendPruningReviewInput {
  principleId: string;
  decision: PruningReviewDecision;
  note?: string;
  reviewer?: string;
  signalSnapshot: PrinciplePruningSignal;
}

export function appendPruningReview(
  workspaceDir: string,
  input: AppendPruningReviewInput,
): PruningReviewRecord;

export function listPruningReviews(
  workspaceDir: string,
  filter?: { principleId?: string },
): PruningReviewRecord[];
```

### Storage

- Path: `<workspace>/.state/pruning_reviews.jsonl`
- Format: 每行一个完整 JSON record
- `.state` 目录不存在则创建
- corrupt line 处理: **跳过并继续**（不抛错），测试验证此行为

### Validation

- invalid decision → `throw new Error('Invalid decision: ...')`
- `reviewer` 默认为 `'operator'`

### TDD Tests

```typescript
// 1. append creates .state/pruning_reviews.jsonl
// 2. append returns record with reviewId (UUID) and reviewedAt (ISO)
// 3. list returns appended records
// 4. list filters by principleId
// 5. invalid decision rejected with clear Error
// 6. append preserves previous records (append twice, list returns 2)
// 7. missing log returns []
// 8. does not modify ledger file
// 9. corrupt line skipped on list
```

---

## Verification

```bash
# PRI-24 tests
npx vitest run packages/principles-core/src/runtime-v2/__tests__/pruning-review-log.test.ts \
  --exclude "**/.worktrees/**"

# PRI-23 tests
npx vitest run packages/pd-cli/tests/commands/runtime-pruning.test.ts \
  --exclude "**/.worktrees/**"

# Architecture guard
npx vitest run packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts \
  --exclude "**/.worktrees/**"

# Build
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
```

---

## Branch

```bash
git checkout main && git pull origin main
git checkout -b codex/pri-23-24-pruning-review-foundation
```

## Commit

```
feat(runtime-v2): add pruning explain and review log foundation

- pd runtime pruning explain --principle-id --json/--text (read-only)
- core append-only pruning review log (JSONL)
- TDD: all new files have corresponding tests
- architecture regression guard updated
```

## Linear Update

- PRI-23: comment with test/validation results → mark **Done**
- PRI-24: comment with test/validation results → mark **Done**
- PRI-19: comment 说明已拆为 PRI-23..PRI-26，当前不单独执行
- 不要动 PRI-25（除非加 blocked/unblocked comment）