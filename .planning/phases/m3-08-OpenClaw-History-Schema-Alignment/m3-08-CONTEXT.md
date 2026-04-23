# m3-08: OpenClaw-History Schema Alignment

## Phase Goal

让 imported `openclaw-history` runs 被 runtime-v2 validator / context assembler 正确消费。

## Root Cause

`session-history-import.ts` 写入 `runtime_kind = 'openclaw-history'`，但 `RuntimeKindSchema` (`runtime-protocol.ts:15-22`) 只接受:
- `openclaw`, `claude-cli`, `codex-cli`, `gemini-cli`, `local-worker`, `test-double`

当 `SqliteRunStore.rowToRecord()` 读回 `openclaw-history` run 时，`Value.Check(RunRecordSchema, record)` 失败，抛出:
```
[storage_unavailable] Run run_11613697_history_1 has invalid schema — DB may be corrupted
```

## Fix Strategy

**修复消费侧（schema 层）：** 在 `RuntimeKindSchema` 中增加 `Type.Literal('openclaw-history')`。

**语义保留：** `openclaw-history` 标识来自 OpenClaw `trajectory.db` 的 compatibility import 数据，区别于实时运行时产生的 `openclaw` runs。

## Changes

1. `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — add `openclaw-history` to RuntimeKindSchema
2. `packages/principles-core/src/runtime-v2/store/sqlite-context-assembler.test.ts` — add test for openclaw-history runs

## Verification

1. `npm run build` — must pass
2. `npm test -- --run sqlite-context-assembler.test.ts` — all green
3. Real workspace (D:\.openclaw\workspace):
   - `pd legacy import openclaw --workspace D:\.openclaw\workspace`
   - `pd history query 11613697 --workspace D:\.openclaw\workspace --from 2026-04-01 --to 2026-04-30`
   - `pd context build 11613697 --workspace D:\.openclaw\workspace --json` — must succeed
