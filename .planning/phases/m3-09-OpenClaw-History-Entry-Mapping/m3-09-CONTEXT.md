# m3-09: OpenClaw-History Entry Mapping

## Phase Goal

让 imported `openclaw-history` runs 真正进入 `DiagnosticianContextPayload.conversationWindow`。

## Root Cause

`SqliteContextAssembler.assemble()` 调用 `historyQuery.query(taskId)` **没有传时间范围**，默认 24 小时窗口（从现在往前推）。openclaw-history runs 发生在 `2026-04-19T13:23:44.489Z`，当前时间 `2026-04-23`，窗口已过，全部 runs 被过滤。

```typescript
// 当前代码 (sqlite-context-assembler.ts:47)
const historyResult = await this.historyQuery.query(taskId);
// → timeWindowStart = now - 24h = 2026-04-22T02:28:29
// → openclaw-history run started_at = 2026-04-19T13:23:44
// → 2026-04-19 < 2026-04-22 → 过滤掉
```

## Fix Strategy

在 `assemble()` 中从 `task.createdAt` 开始查询，不使用默认 24 小时窗口。

```typescript
const historyResult = await this.historyQuery.query(taskId, undefined, {
  timeWindowStart: task.createdAt,
});
```

## Changes

1. `packages/principles-core/src/runtime-v2/store/sqlite-context-assembler.ts` — pass `timeWindowStart: task.createdAt`
2. `packages/principles-core/src/runtime-v2/store/sqlite-context-assembler.test.ts` — add test for openclaw-history conversationWindow

## Verification

1. `npm run build` — must pass
2. `npm test -- --run sqlite-context-assembler.test.ts` — all green
3. Real workspace (D:\.openclaw\workspace):
   - `pd history query 11613697 --workspace D:\.openclaw\workspace --from 2026-04-01 --to 2026-04-30`
   - `pd context build 11613697 --workspace D:\.openclaw\workspace --json` — must have non-empty conversationWindow
