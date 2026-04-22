# Phase 4: Verification + Doc Sync - Context

**Gathered:** 2026-04-21
**Status:** Ready for planning

<domain>
## Phase Boundary

验证 M1 全部 contracts 编译通过、输出 canonical vs legacy 冲突表、标记旧定义为 deprecated。不做任何新类型定义，只验证、记录、标记。

**In scope:**
- `npx tsc --noEmit` 验证（排除预存 io.ts 错误）
- 全量冲突表：记录所有 canonical vs legacy 重复定义
- `@deprecated` JSDoc 标记 DOC-01 列出的旧类型
- 类型与 canonical 文档一致性检查

**Out of scope:**
- 新增类型定义
- 修改旧 QueueStatus/TaskKind 定义（M2 迁移时处理）
- runtime adapter 实现
- 实际迁移旧代码到新类型

</domain>

<decisions>
## Implementation Decisions

### 冲突表输出
- **D-01:** 冲突表输出到 `docs/pd-runtime-v2/conflict-table.md`，作为持久文档供后续 M2-M9 milestone 引用
- **D-02:** 格式为 Markdown 表格，每行记录：类型名、canonical 位置、legacy 位置、重叠说明

### Deprecation 标记范围
- **D-03:** `@deprecated` 标记仅加到 DOC-01 明确列出的类型：TrinityRuntimeFailureCode、QueueStatus（evolution-worker 中）
- **D-04:** 冲突表全量记录所有发现的重复定义，包括 TaskKind（3处）、TaskResolution（4处），但不加 deprecation 标记（留给 M2 迁移）
- **D-05:** deprecation 标记使用 `@deprecated` JSDoc tag + 文字说明指向 canonical 替代位置

### 验证方式
- **D-06:** `npx tsc --noEmit -p packages/principles-core/tsconfig.json` 作为主要编译检查
- **D-07:** 类型一致性通过人工比对 canonical 文档（Protocol Spec v1, Diagnostician v2 Design）确认，不需要自动化 diff

### Claude's Discretion
- 冲突表的具体列和排版细节
- deprecation 文字的具体措辞
- 验证的具体执行步骤顺序

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Protocol Specification
- `docs/spec/2026-04-21-pd-runtime-protocol-spec-v1.md` — Protocol Spec v1: 定义 RuntimeKind, PDRuntimeAdapter, Run lifecycle, TaskStatus
- `docs/spec/2026-04-21-diagnostician-v2-detailed-design.md` — Diagnostician v2 Design: 定义 DiagnosticianOutputV1, ContextPayload

### Architecture
- `docs/design/2026-04-21-pd-runtime-agnostic-architecture-v2.md` — Runtime v2 总体架构文档

### Implementation (canonical locations)
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory canonical
- `packages/principles-core/src/runtime-v2/task-status.ts` — PDTaskStatus canonical
- `packages/principles-core/src/runtime-v2/agent-spec.ts` — AgentSpec canonical
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — RuntimeKind canonical

### Legacy (to be deprecated/marked)
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — TrinityRuntimeFailureCode legacy
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — QueueStatus legacy
- `packages/openclaw-plugin/src/service/queue-migration.ts` — TaskResolution legacy
- `packages/openclaw-plugin/src/service/evolution-queue-migration.ts` — TaskResolution legacy
- `packages/openclaw-plugin/src/core/evolution-types.ts` — TaskKind/TaskResolution legacy
- `packages/openclaw-plugin/src/core/trajectory-types.ts` — TaskKind legacy
- `packages/principles-core/src/evolution-store.ts` — TaskKind legacy

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/principles-core/src/runtime-v2/` — Phase 1+2 完整实现，所有 canonical contracts 在此
- `packages/principles-core/src/index.ts` — Phase 3 已完成全部 re-exports

### Established Patterns
- TypeBox schema pattern: 每个 contract 文件同时导出 schema（值）和 type
- `@deprecated` JSDoc 标记是 TypeScript 标准 deprecation 方式

### Integration Points
- 冲突表需记录 openclaw-plugin 包中的 legacy 类型（跨包引用）
- deprecation 标记需修改 openclaw-plugin 源文件

</code_context>

<specifics>
## Specific Ideas

- 冲突表应包含列：Type Name | Canonical Location | Legacy Location(s) | Overlap Notes | Status (deprecated/tracked)
- deprecation 标记文字应指向 canonical 位置，如 `@deprecated Use PDErrorCategory from '@principles/core/runtime-v2'`
- VER-02 要求确认 AgentSpec, PDErrorCategory, RuntimeKind, PDTaskStatus 只有一个 canonical 位置——需逐一 grep 验证

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 04-verification-doc-sync*
*Context gathered: 2026-04-21*
