# Phase m9-04: Tests - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning

<domain>
## Phase Boundary

m9-04 交付两套测试，验证 PiAiRuntimeAdapter 集成到 runtime v2：

1. **Unit tests** — `pi-ai-runtime-adapter.test.ts`（已存在，727行，覆盖所有错误路径）
2. **E2E tests** — `runner/__tests__/m9-e2e.test.ts`（不存在，需新建）：
   - Adapter integration: PiAiRuntimeAdapter + DiagnosticianRunner 集成
   - Full chain E2E: pain → artifact → candidate → ledger probation entry

依赖：m9-01（PiAiRuntimeAdapter 实现）、m9-02（factory/policy）、m9-03（CLI commands）

</domain>

<decisions>
## Implementation Decisions

### E2E Test Strategy (TEST-06)
- **D-01:** 两种测试文件：
  - `runner/__tests__/m9-adapter-integration.test.ts` — adapter + runner 集成，不经过 candidate/ledger
  - `runner/__tests__/m9-e2e.test.ts` — 完整链路 pain → artifact → candidate → ledger probation entry

### Mock Strategy
- **D-02:** Module-level `vi.mock('@mariozechner/pi-ai')` — 真实 PiAiRuntimeAdapter 代码运行，只是 LLM 调用被 mock。E2E 测试 adapter 逻辑路径，与单元测试策略一致。
- **D-03:** 不使用 StubRuntimeAdapter — Stub 绕过真实 adapter，测不到实际代码路径。

### Full Chain E2E Pattern
- **D-04:** 复用 m8-02-e2e 的 `InMemoryLedgerAdapter` 模式 — 内存 ledger 用于验证 probation entry 写入正确性
- **D-05:** 复用 m8-02-e2e 的 StubRuntimeAdapter 模式（调整 kind 为 `'pi-ai'`）用于某些需要精确控制 runtime 行为的场景

### Test Structure
- **D-06:** 每个测试文件 ~150-200 行（m9-01-01-PLAN.md 要求）
- **D-07:** 使用 `os.tmpdir()` 创建临时 workspace，每个测试后清理
- **D-08:** E2E 测试的 mock setup 放在 `beforeEach`，cleanup 放在 `afterEach`

### What NOT to Test
- 不测试 m9-01 单元测试已覆盖的路径（retry logic、JSON extraction、error mapping）
- 不测试 candidate intake 业务逻辑（m7 已覆盖）
- 不测试 ledger 内部实现（通过 LedgerAdapter 接口验证）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### PiAiRuntimeAdapter (m9-01)
- `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` — adapter 实现
- `packages/principles-core/src/runtime-v2/adapter/__tests__/pi-ai-runtime-adapter.test.ts` — 已有单元测试（727行），E2E 不重复

### E2E Reference (m8-02)
- `packages/principles-core/src/runtime-v2/runner/__tests__/m8-02-e2e.test.ts` — InMemoryLedgerAdapter + StubRuntimeAdapter 模式，full chain pain→ledger
- `packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-e2e.test.ts` — OpenClawCliRuntimeAdapter + FakeCliProcessRunner 模式

### Runner & Committer
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — DiagnosticianRunner
- `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts` — SqliteDiagnosticianCommitter
- `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts` — PainSignalBridge（m8 single path）
- `packages/principles-core/src/runtime-v2/candidate-intake-service.ts` — CandidateIntakeService

### Store Components
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` — TaskStore, RunStore, CandidateStore
- `packages/principles-core/src/runtime-v2/store/sqlite-context-assembler.ts` — SqliteContextAssembler
- `packages/principles-core/src/runtime-v2/store/sqlite-history-query.ts` — SqliteHistoryQuery
- `packages/principles-core/src/runtime-v2/store/event-emitter.js` — StoreEventEmitter

### Runtime Protocol
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter 接口
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDRuntimeError

### Prior Phase Context
- `.planning/phases/m9-01-PiAiRuntimeAdapter-Core/m9-01-CONTEXT.md` — adapter 实现细节、D-01~D-03
- `.planning/phases/m9-02-Policy-Factory-Integration/m9-02-CONTEXT.md` — factory/policy 集成
- `.planning/phases/m9-03-CLI-Commands/m9-03-CONTEXT.md` — CLI 集成

### Requirements
- `.planning/REQUIREMENTS.md` — TEST-01~06 定义

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Patterns from m8-02-e2e
- `InMemoryLedgerAdapter` — 内存实现 LedgerAdapter 接口，验证 probation entry 写入
- `StubRuntimeAdapter` — 实现 PDRuntimeAdapter，可控制 `setOutput()` 和 `setRunStatus()`
- Temp workspace pattern: `const ws = path.join(os.tmpdir(), 'pd-e2e-m9-' + randomUUID()); ... fs.rmSync(ws, { recursive: true, force: true });`
- Full chain assertion: `candidateIds.length > 0` + `ledgerEntryIds.length > 0`

### Reusable Patterns from m6-06-e2e
- `makeDiagnosticianOutputWithCandidates()` fixture
- `FakeCliProcessRunner` 模式用于 CLI adapter E2E（m9 不需要）

### Integration Points to Test
- `DiagnosticianRunner` + `PiAiRuntimeAdapter` 真实集成（module mock）
- `PainSignalBridge.create()` + `bridge.record()` 完整链路（factory 选择 pi-ai）
- `SqliteDiagnosticianCommitter` artifact 写入
- `CandidateIntakeService.intake()` candidate 创建
- `InMemoryLedgerAdapter.writeProbationEntry()` ledger 写入

### Mock Pattern for pi-ai
```typescript
vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(),
  complete: vi.fn(),
}));

const mockComplete = complete as ReturnType<typeof vi.fn>;
mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));
```

</code_context>

<specifics>
## Specific Ideas

- E2E 测试用 `xiaomi-coding` provider 的 mock response，不依赖真实 API key
- Adapter integration 测试验证 `fetchOutput()` 返回正确的 DiagnosticianOutputV1 payload
- Full chain 测试验证 pain signal → task → run → artifact → candidate → ledger probation entry 完整
- 幂等性测试：同一 painId 两次 record，第二次不产生新 candidate/ledger entry

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---
*Phase: m9-04-Tests*
*Context gathered: 2026-04-29*
