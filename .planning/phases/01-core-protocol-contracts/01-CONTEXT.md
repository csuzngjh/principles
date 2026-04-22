# Phase 1: Core Protocol + Agent + Error Contracts - Context

**Gathered:** 2026-04-21
**Status:** Ready for planning

<domain>
## Phase Boundary

定义 runtime-v2 最核心的 protocol、agent 和 error 类型。所有 types 放在 `packages/principles-core/src/runtime-v2/`。17 个 requirements。

</domain>

<decisions>
## Implementation Decisions

### Schema 方式
- **D-01:** 使用 TypeBox schema + Static type 推导（与现有 PainSignalSchema 模式一致）。运行时验证 + 编译时类型安全。

### Error 类层次
- **D-02:** PDRuntimeError 与旧 PdError 统一包装。旧 PdError 改为继承或包装 PDRuntimeError，统一错误体系。注意：修改 openclaw-plugin/config/errors.ts 属于此 phase scope（仅 error 类层次相关）。

### Claude's Discretion
- 所有 contract 的具体字段名和结构 — 已由 canonical 文档严格定义，Claude 按文档实现即可。

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture
- `docs/design/2026-04-21-pd-runtime-agnostic-architecture-v2.md` — 总体架构，§7-9 定义 AgentSpec/RuntimeAdapter
- `docs/spec/2026-04-21-pd-runtime-protocol-spec-v1.md` — Protocol SPEC，§5-12 定义核心协议
- `docs/spec/2026-04-21-diagnostician-v2-detailed-design.md` — Diagnostician v2，§7 定义 TaskRecord，§20 定义错误类别
- `docs/pd-runtime-v2/agent-execution-modes-appendix.md` — 执行模式附录
- `docs/pd-runtime-v2/gsd-execution-governance.md` — GSD 治理规则
- `docs/pd-runtime-v2/runtime-v2-milestone-roadmap.md` — 里程碑路线图

### Codebase (conflict scan results)
- `packages/principles-core/src/pain-signal.ts` — 现有 TypeBox 使用模式（参考）
- `packages/openclaw-plugin/src/config/errors.ts` — 旧 PdError 类层次（需统一包装）
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts:448-469` — TrinityRuntimeFailureCode（deprecated by PDErrorCategory）
- `packages/openclaw-plugin/src/core/evolution-types.ts:472-473` — 旧 QueueStatus + TaskResolution（deprecated by PDTaskStatus）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@sinclair/typebox` 已是 principles-core 依赖，直接使用
- PainSignalSchema 模式（TypeBox + Static + validate）可复用

### Integration Points
- `packages/principles-core/src/index.ts` — 主入口 re-export
- `packages/principles-core/package.json` — exports 字段需新增 `./runtime-v2`

</code_context>

<specifics>
## Specific Ideas

- 预写入代码已在 worktree 中：`packages/principles-core/src/runtime-v2/`（7个文件 + index.ts）
- 当前为纯 TypeScript types，需补写 TypeBox schemas
- PDErrorCategory 已覆盖 16 个错误值（三份文档的并集）

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---
*Phase: 01-core-protocol-contracts*
*Context gathered: 2026-04-21*
