# Phase 2: Context + Diagnostician Contracts - Context

**Gathered:** 2026-04-21
**Status:** Ready for planning

<domain>
## Phase Boundary

定义上下文 payload 和诊断输出的 canonical TypeBox schema + TypeScript types。7 个 requirements (CTX-01~05, DIAG-01~02)。所有 types 放在 `packages/principles-core/src/runtime-v2/`。

</domain>

<decisions>
## Implementation Decisions

### Schema 深度
- **D-01:** 全部独立 TypeBox schema — 每个 interface/type 都有对应的 TypeBox schema（包括 HistoryQueryEntry, TrajectoryCandidate, TrajectoryLocateQuery, DiagnosisTarget, DiagnosticianViolatedPrinciple, DiagnosticianEvidence, RecommendationKind, DiagnosticianRecommendation）。与 Phase 1 模式完全一致。

### 类型引用
- **D-02:** `DiagnosticianInvocationInput.context` 直接引用 `DiagnosticianContextPayload` 类型，不使用 `unknown`。同一目录无循环依赖。

### DiagnosisTarget 设计
- **D-03:** 共享一个 `DiagnosisTarget` interface 作为宽松并集。包含 reasonSummary?, source?, severity?, painId?, sessionIdHint? 五个可选字段。ContextPayload 和 DiagnosticianContextPayload 共用此 interface。必填约束留给 TypeBox schema validation 层。

### Claude's Discretion
- 所有 contract 的具体字段名和结构 — 已由 canonical 文档严格定义，Claude 按文档实现即可。
- TypeBox schema 的具体约束（minLength, maximum 等）— Claude 按 canonical 文档语义补充。

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### History Retrieval Spec
- `docs/pd-runtime-v2/history-retrieval-and-context-assembly-spec.md` — §7.4 TrajectoryLocateResult, §8.3 HistoryQueryEntry + HistoryQueryResult, §9.4 ContextPayload, §14 error semantics
- `docs/pd-runtime-v2/history-retrieval-and-context-assembly-spec.md` §10-12 — retrieval workflow, agent usage, safety requirements

### Diagnostician v2 Design
- `docs/spec/2026-04-21-diagnostician-v2-detailed-design.md` — §9.4 DiagnosticianContextPayload, §10.3 DiagnosticianInvocationInput, §11.2 DiagnosticianOutputV1
- `docs/spec/2026-04-21-diagnostician-v2-detailed-design.md` §11.3 — invalid output conditions

### Protocol Spec
- `docs/spec/2026-04-21-pd-runtime-protocol-spec-v1.md` — §15-17 TrajectoryLocateResult variant, §18 diagnostician output

### Architecture
- `docs/design/2026-04-21-pd-runtime-agnostic-architecture-v2.md` — 总体架构

### Phase 1 (completed)
- `.planning/phases/01-core-protocol-contracts/01-CONTEXT.md` — Phase 1 decisions (TypeBox pattern established)

</canonical_refs>

<code_context>
## Existing Code Insights

### Pre-written Files
- `packages/principles-core/src/runtime-v2/context-payload.ts` — 133 lines, 8 interfaces: HistoryQueryEntry, TrajectoryLocateQuery, TrajectoryCandidate, TrajectoryLocateResult, HistoryQueryResult, DiagnosisTarget, ContextPayload, DiagnosticianContextPayload
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — 79 lines, 6 types: DiagnosticianViolatedPrinciple, DiagnosticianEvidence, RecommendationKind, DiagnosticianRecommendation, DiagnosticianOutputV1, DiagnosticianInvocationInput

### Reusable Assets (from Phase 1)
- `@sinclair/typebox` 已是 principles-core 依赖
- Phase 1 建立的 TypeBox 模式: schema + Static 推导 + validate guard
- `index.ts` 已 re-export 所有 context/diagnostician types

### Integration Points
- `packages/principles-core/src/runtime-v2/index.ts` — 已包含 context-payload 和 diagnostician-output 的 re-exports，需新增 schema exports
- `packages/principles-core/src/index.ts` — 主入口需同步（Phase 3 scope）

### Required Changes
- context-payload.ts: 添加 TypeBox schemas（当前只有 interface）
- diagnostician-output.ts: 添加 TypeBox schemas + 修改 context 字段类型为 DiagnosticianContextPayload
- index.ts: 新增 schema exports

</code_context>

<specifics>
## Specific Ideas

- 预写入代码已基本对齐 canonical 文档，主要是补充 TypeBox schemas
- DiagnosisTarget 共享 interface 已在代码中实现，保持不变
- DiagnosticianInvocationInput.context 需从 unknown 改为 DiagnosticianContextPayload

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---
*Phase: 02-context-diagnostician-contracts*
*Context gathered: 2026-04-21*
