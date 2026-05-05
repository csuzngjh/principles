# Plan: Active Implementation

**Status:** No active implementation plan

下一阶段：Hard Internalization Core Migration

---

## 参考：已完成的工作

### PRI-25: `pd runtime pruning review` CLI (merged)

```
pd runtime pruning review \
  --principle-id <id> \
  --decision keep|defer|archive-candidate \
  --note "..." \
  [--workspace <path>] \
  [--json]
```

行为：
1. Instantiate `PruningReadModel`, call `getPrincipleSignals()`
2. Find matching signal for `principleId`
3. **Missing principle**: exit 1, no log written
4. **Invalid decision**: exit 1, no log written
5. **archive-candidate + no note**: exit 1, no log written
6. Call `appendPruningReview(workspaceDir, { principleId, decision, note, reviewer, signalSnapshot })`
7. **JSON mode**: `{ reviewId, principleId, decision, reviewer, reviewedAt }`
8. **Text mode**: print all fields + audit-only note

验证命令：
```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npx vitest run packages/pd-cli/tests/commands/runtime-pruning.test.ts --exclude "**/.worktrees/**"
npx vitest run packages/principles-core/src/runtime-v2/__tests__/pruning-review-log.test.ts --exclude "**/.worktrees/**"
npx vitest run packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts --exclude "**/.worktrees/**"
```

已合并：PR #447

---

## Linear Update

- PRI-25 → Done (after merge, comment with PR + tests)
- PRI-26: comment → PRI-25 done, can start docs