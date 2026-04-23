# Phase m4-03: Validator - Context

**Gathered:** 2026-04-23
**Status:** Ready for planning

<domain>
## Phase Boundary

DiagnosticianValidator 实现 — 在 DiagnosticianRunner 推进状态之前验证 DiagnosticianOutputV1 的完整性和正确性。

Scope（REQUIREMENTS.md Section 2.3）：
- Schema 正确性（TypeBox 验证）
- 非空 summary / rootCause
- Task identity match（output.taskId === leased task.taskId）
- 有界 evidence 数组
- Recommendations 数组形状
- Confidence 范围 [0, 1]
- Best-effort evidence back-check（sourceRef 存在性）

边界：不修改 DiagnosticianRunner（m4-01 已完成），不包含 runner+validator 集成测试（m4-04 scope）。

</domain>

<decisions>
## Implementation Decisions

### 验证策略（分层模式）

- **D-01:** 分层验证策略。
  标准模式（默认）：fail-fast，遇见第一个错误立即返回，errors 数组仅包含该错误。
  Verbose 模式：收集所有验证错误，errors 数组包含完整错误列表。
  通过 `DiagnosticianValidator.validate()` 的第三个参数 `options?: { verbose?: boolean }` 控制模式。
  接口签名变更为 `validate(output, taskId, options?)`，向后兼容（options 可选，默认 undefined = 标准模式）。
  **Why:** fail-fast 适合快速路径，verbose 适合调试和详细诊断，两者在不同场景各有价值。
  **How to apply:** Validator 内部维护一个 errors[] 数组，fail-fast 模式下第一个错误就 resolve result；verbose 模式走完所有检查再 resolve。

### Evidence Back-check 深度（分层）

- **D-02:** 分层 evidence 检查。
  标准模式：best-effort 格式检查（验证 evidence.sourceRef 非空、格式合理，不验证引用有效性）。
  Verbose 模式：严格检查 sourceRef 存在性（验证 evidence.sourceRef 指向 context 中的真实记录）。
  **Why:** 标准模式快速检查格式即可；verbose 模式深入验证引用真实性，适合调试和诊断。
  **How to apply:** evidence back-check 在 validate() 内部实现两层逻辑，根据 verbose 标志选择检查深度。

### 错误信息格式（两者共存）

- **D-03:** 聚合摘要 + 逐字段详细描述共存。
  errors 数组同时包含聚合摘要（如 "2 fields invalid: summary, rootCause"）和逐字段详细描述
  （如 "summary: must be non-empty string"）。
  **Why:** 聚合摘要提供快速概览，逐字段描述便于精确定位问题。
  **How to apply:** validate() 返回时，errors[0] 是聚合摘要，后续 entries 是逐字段详情。

### 验证失败时的 Error Category

- **D-04:** 所有验证失败统一使用 errorCategory = `output_invalid`（PDErrorCategory）。
  **Why:** REQUIREMENTS.md Section 2.3 明确锁定。
  **How to apply:** DiagnosticianValidationResult.errorCategory 固定为 `output_invalid`，不做细分。

### Task Identity Match

- **D-05:** 验证 output.taskId === taskId（传入 validate 的 taskId 参数）。
  不做模糊匹配或前缀匹配，严格相等。
  **Why:** 确保输出与请求的任务精确对应，防止串台。
  **How to apply:** 在 validate() 的 identity check 步骤执行。

### Confidence Range

- **D-06:** confidence 必须 ∈ [0, 1]（闭区间）。
  TypeBox schema 已强制要求，但显式检查以提供具体错误信息。
  **How to apply:** 在 schema 验证后单独执行边界检查，返回具体字段名。

### ValidationResult 结构

- **D-07:** DiagnosticianValidationResult 保持当前接口不变（valid + errors + errorCategory）。
  不增加 severity 分级或其他字段。
  **Why:** Runner 只关心 valid=true/false，errors 是调试辅助，errorCategory 用于分类。
  **How to apply:** 现有接口足够，无需修改。

### Claude's Discretion

- DiagnosticianValidator 的目录组织（独立文件 vs 放在 runner/ 下）
- 是否导出工厂函数（如 `createStrictValidator()`）
- evidence sourceRef 检查的具体实现细节（如何查询 context 验证引用）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### M1 Frozen Interfaces
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — DiagnosticianOutputV1Schema, DiagnosticianViolationPrinciple, DiagnosticianEvidence, DiagnosticianRecommendation
- `packages/principles-core/src/runtime-v2/runner/diagnostician-validator.ts` — DiagnosticianValidator interface, DiagnosticianValidationResult, PassThroughValidator

### M4 Completed (m4-01, m4-02)
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — DiagnosticianRunner.validate() 调用位置（line 138）
- `.planning/phases/m4-01-RunnerCore/m4-01-CONTEXT.md` — D-01 到 D-07（Runner 决策）
- `.planning/phases/m4-02-RuntimeInvocation/m4-02-CONTEXT.md` — D-01 到 D-03（RuntimeInvocation 决策）

### Requirements
- `.planning/milestones/pd-runtime-v2-m4/REQUIREMENTS.md` — Section 2.3 (DiagnosticianValidator scope), Section 2.1 (Runner 调用 validate 的位置)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- DiagnosticianValidator 接口：已在 diagnostician-validator.ts 定义，m4-01 的 PassThroughValidator 是参考实现
- DiagnosticianOutputV1Schema：TypeBox schema，已在 diagnostician-output.ts 中定义
- Value.Check() from @sinclair/typebox/value：已在 start-run-input.test.ts 中使用，验证 TypeBox schema
- error-categories.ts：PDErrorCategory 输出验证失败时固定为 `output_invalid`

### Established Patterns
- TypeBox schema + Value.Check() 用于所有结构化验证（项目标准）
- Validator 接口 + PassThroughValidator 临时实现模式
- Verbose/debug 模式分层是项目中常见的扩展模式（如 logging、validation 等）

### Integration Points
- DiagnosticianRunner.validate() 调用 validator.validate(output, taskId)（diagnostician-runner.ts:138）
- Validator 需要访问 DiagnosticianContextPayload 以验证 evidence sourceRef（通过 taskId 查询 context）

</code_context>

<specifics>
## Specific Ideas

- DiagnosticianValidator 放在 `packages/principles-core/src/runtime-v2/runner/` 目录（与 runner 在同一目录）
- 文件命名：`diagnostician-validator.ts` → `default-validator.ts`（替换 PassThroughValidator）
- Verbose 模式通过 `validateOptions.verbose?: boolean` 参数控制

</specifics>

<deferred>
## Deferred Ideas

- Validator 的 semantic validation 扩展（如 recommendations 非空时的内容质量检查）— M5 scope
- Validator 与 store 的集成测试（m4-04 scope）
- Evidence sourceRef 的 context 回查（如果 context 数据不足，应 fallback 到 best-effort 而非 hard fail）

</deferred>

---

*Phase: m4-03-Validator*
*Context gathered: 2026-04-23*
