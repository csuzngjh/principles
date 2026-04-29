# Phase m9-01: PiAiRuntimeAdapter Core - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning

<domain>
## Phase Boundary

实现 PiAiRuntimeAdapter — 使用 @mariozechner/pi-ai 直接调用 LLM 的 PDRuntimeAdapter。绕过 OpenClaw CLI，解决 m8-03 UAT 阻塞问题（main agent >300s）。

交付物：
1. `@mariozechner/pi-ai` 依赖添加到 principles-core
2. `RuntimeKindSchema` 增加 `"pi-ai"` literal
3. `PiAiRuntimeAdapter` 类实现完整 `PDRuntimeAdapter` 接口
4. 从 `adapter/index.ts` 和 `runtime-v2/index.ts` 正确导出

</domain>

<decisions>
## Implementation Decisions

### Execution Model
- **D-01:** One-shot 模式 — `startRun()` 内部等待 LLM 完成，返回时 run 已 terminal (succeeded/failed/timed_out)。`pollRun()` 直接返回最终状态。与 OpenClawCliRuntimeAdapter 模式一致。

### Provider Strategy
- **D-02:** 不设默认 provider/model — 必须在 workflows.yaml 中显式配置。如果 policy 中缺少 provider 或 model，`PainSignalRuntimeFactory` 抛出配置错误。apiKeyEnv 同样必须显式配置。

### Validation Strictness
- **D-03:** 使用 TypeBox 严格验证 `DiagnosticianOutputV1Schema`。任何字段缺失、类型错误、或 schema 不匹配都返回 `output_invalid`。不做宽松验证。

### Claude's Discretion
- 超时控制使用 `AbortSignal.timeout(timeoutMs)`
- 重试策略：指数退避，可配置 maxRetries（默认 2）
- healthCheck 验证：apiKeyEnv 存在 + getModel 不抛异常
- 错误映射：AbortError → timeout, JSON parse 失败 → output_invalid, 重试耗尽 → execution_failed

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Runtime Protocol
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter 接口定义，RuntimeKindSchema, StartRunInput, RunHandle, RunStatus, StructuredRunOutput 类型

### Error Categories
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDRuntimeError 类别定义 (runtime_unavailable, timeout, execution_failed, output_invalid 等)

### Diagnostician Output
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — DiagnosticianOutputV1Schema TypeBox schema，所有 adapter 必须产出此格式

### Reference Implementation
- `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` — 现有 adapter 实现，one-shot 模式参考

### pi-ai API
- `@mariozechner/pi-ai` v0.70.6 — `getModel(provider, modelId)`, `complete(model, context, options?)`, `Context`, `AssistantMessage`, `KnownProvider` 类型
- Provider 类型: `'openrouter' | 'anthropic' | 'openai' | 'deepseek' | ...` (KnownProvider union)
- `ProviderStreamOptions.signal` 用于 AbortSignal 超时控制
- `ProviderStreamOptions.apiKey` 传入 API key
- `UserMessage` 需要 `timestamp` 字段

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `PDRuntimeError` (error-categories.ts): 错误类别体系，直接复用
- `DiagnosticianOutputV1Schema` (diagnostician-output.ts): TypeBox schema，用于验证 LLM 输出
- `DiagnosticianPromptBuilder` (diagnostician-prompt-builder.ts): 构建 prompt，m9-01 不需要修改但需了解其输出格式

### Established Patterns
- OpenClawCliRuntimeAdapter 的 one-shot 模式：startRun() 执行完所有工作，store output in memory，pollRun/fetchOutput 读取 stored state
- RunHandle 结构：`{ runId, runtimeKind, startedAt }`
- RunStatus 结构：`{ runId, status, startedAt?, endedAt?, reason? }`
- StructuredRunOutput 结构：`{ runId, payload }`

### Integration Points
- `adapter/index.ts` — 新 adapter 的导出入口
- `runtime-v2/index.ts` — runtime-v2 barrel exports
- `runtime-protocol.ts` — RuntimeKindSchema 需要增加 `'pi-ai'` literal

### Type Mismatch (Implementation Note)
- pi-ai 的 `getModel(provider, modelId)` 要求 `provider` 是 `KnownProvider` 类型，但 config 中是 `string`
- 解决方案：运行时 cast `as KnownProvider`，或使用 `getModel(provider as any, modelId)`
- pi-ai 的 `UserMessage` 需要 `timestamp` 字段，构建 context 时需添加

</code_context>

<specifics>
## Specific Ideas

- pi-ai API 已确认可用 (v0.70.6 on npm)
- `complete()` 是非 streaming 的 Promise<AssistantMessage>，适合 one-shot 模式
- `ProviderStreamOptions` 支持 `signal`, `apiKey`, `timeoutMs`, `maxRetries`

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: m9-01-PiAiRuntimeAdapter-Core*
*Context gathered: 2026-04-29*
