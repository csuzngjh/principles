---
phase: m7-05-E2E-Intake
plan: 01
status: complete
completed: 2026-04-27
---

## Summary: E2E — candidate → ledger entry

### What Was Built

完整的候选人体检 E2E 测试套件，验证从 pending candidate 到 ledger entry 的完整链路：

1. **candidateShow API 增强** (`diagnose.ts`):
   - `CandidateShowResult` 新增 `ledgerEntryId: string | null` 字段
   - `candidateShow()` 支持可选 `ledgerAdapter` 参数进行 ledger 查询

2. **handleCandidateShow CLI 增强** (`candidate.ts`):
   - 创建 `PrincipleTreeLedgerAdapter` 实例
   - 显示 "Ledger Entry: <id>" 在人类可读输出中
   - JSON 输出包含 `ledgerEntryId`

3. **E2E 测试套件** (`candidate-intake-e2e.test.ts`):
   - Test 1: Happy path — intake → consumed + ledgerEntryId (UUID 格式验证)
   - Test 2: Ledger 文件包含正确 sourceRef (`candidate://<id>`)
   - Test 3: 幂等性 — 重复 intake 返回相同 ledgerEntryId，无重复记录
   - Test 4: `pd candidate list --task-id` 显示 consumed 状态
   - Test 5: `pd candidate show` 显示 ledgerEntryId
   - Test 6: DB 状态验证 — candidate.status = 'consumed'

### Key Files Created/Modified

| File | Change |
|------|--------|
| `packages/principles-core/src/runtime-v2/cli/diagnose.ts` | ✅ `ledgerEntryId` 字段添加到 `CandidateShowResult` |
| `packages/pd-cli/src/commands/candidate.ts` | ✅ `handleCandidateShow` 显示 ledger entry link |
| `packages/pd-cli/tests/e2e/candidate-intake-e2e.test.ts` | ✅ 6 个 E2E 测试 |
| `packages/pd-cli/src/principle-tree-ledger-adapter.ts` | ✅ 本地 ledger adapter (避免运行时依赖 openclaw-plugin) |

### Verification Results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit -p packages/pd-cli/tsconfig.json` | ✅ 通过 |
| `npx tsc --noEmit -p packages/principles-core/tsconfig.json` | ✅ 通过 |
| `vitest run packages/pd-cli/tests/e2e/` | ✅ 6/6 tests passed |
| `vitest run packages/principles-core/tests/candidate-intake*.test.ts` | ✅ 45/45 tests passed |

### Decisions Made

1. **本地 Ledger Adapter**: pd-cli 使用本地 `PrincipleTreeLedgerAdapter` 实现，而非运行时依赖 `@principles/openclaw-plugin`，避免 SDK 类型/构建问题阻塞 CLI
2. **修复测试数据**: E2E 测试修复了 schema 中缺少 `idempotency_key` 导致 `INSERT OR IGNORE` 静默丢记录的问题
3. **Build 入口修正**: pd-cli build 入口修正为 `dist/index.js`

### Requirements Coverage

| Requirement | Status |
|-------------|--------|
| E2E-INTAKE-01: Happy path E2E | ✅ Verified |
| E2E-INTAKE-02: pd candidate list shows correct status | ✅ Verified |
| E2E-INTAKE-03: Idempotency | ✅ Verified |
| E2E-INTAKE-04: Traceability (ledger entry link) | ✅ Verified |

---
Generated: 2026-04-27