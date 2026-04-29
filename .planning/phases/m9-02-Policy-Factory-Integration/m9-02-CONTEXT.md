# Phase m9-02: Policy + Factory Integration - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning

<domain>
## Phase Boundary

扩展 `workflows.yaml` policy 加入 runtime 配置字段，更新 `PainSignalRuntimeFactory` 根据 policy 选择正确的 runtime adapter。使 runtimeKind 可配置而非硬编码。

交付物：
1. `FunnelPolicy` interface 新增 runtime 配置字段（runtimeKind, provider, model, apiKeyEnv, maxRetries）
2. `WorkflowFunnelLoader` 正确解析新字段
3. `PainSignalRuntimeFactory` 根据 policy.runtimeKind 选择 adapter
4. `workflows.yaml` 包含 `pd-runtime-v2-diagnosis` funnel 的 runtime 配置

</domain>

<decisions>
## Implementation Decisions

### Policy Field Structure
- **D-01:** runtime 配置字段平铺到 `FunnelPolicy` interface，和 `timeoutMs` 同级。不使用嵌套 `runtime` 对象。字段：`runtimeKind`, `provider`, `model`, `apiKeyEnv`, `maxRetries`。

### Validation Strategy
- **D-02:** Factory 层验证 — `PainSignalRuntimeFactory` 在创建 adapter 前检查 `runtimeKind === 'pi-ai'` 所需字段（provider, model, apiKeyEnv）。缺失时抛出明确的配置错误。不在 adapter 层延迟验证。

### Cache Strategy
- **D-03:** bridgeCache key 从 `workspaceDir` 改为 `${workspaceDir}:${runtimeKind}`。不同 runtime 各自独立缓存，避免 runtime 切换后拿到旧 adapter 实例。

### Default Runtime
- **D-04:** policy 中 `runtimeKind` 缺失时默认 `'pi-ai'`。M9 目标是让 pi-ai 成为默认 diagnostician runtime。

### Backward Compatibility
- **D-05:** 默认 pi-ai + 无默认 provider/model（m9-01 D-02）= 现有只配了 timeoutMs 的 policy 会 break。选择报错要求显式配置，不提供 fallback 默认值。M9 是新功能，现有用户应显式迁移。

### Error Handling
- **D-06:** Factory 配置验证失败时抛出普通 `Error`（非 `PDRuntimeError`），因为这是配置错误而非运行时错误。错误消息明确列出缺失字段和修复方法。

### Claude's Discretion
- YAML 中 policy 字段的命名风格（camelCase 与 YAML 惯例的 kebab-case）— 代码侧用 camelCase，YAML 侧由 `js-yaml` load 后直接映射，保持一致。
- `test-double` runtimeKind 保留用于测试，factory 中暂时不实现，仅在 type union 中声明。
- 工厂函数 `resolveRunnerOptions` 扩展为 `resolveRuntimeConfig`，同时读取 runtime 配置和 timeoutMs。

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Runtime Protocol
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter 接口，RuntimeKindSchema（已含 'pi-ai' literal）

### Runtime Adapter
- `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` — m9-01 已实现的 PiAiRuntimeAdapter
- `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` — 现有 adapter，保持不变

### Policy Loader
- `packages/principles-core/src/workflow-funnel-loader.ts` — FunnelPolicy interface，WorkflowFunnelLoader 类

### Factory
- `packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts` — createPainSignalBridge，resolveRunnerOptions

### Prior Phase Context
- `.planning/phases/m9-01-PiAiRuntimeAdapter-Core/m9-01-CONTEXT.md` — D-02 (no defaults), LOCKED-03 (workflows.yaml SSOT)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `WorkflowFunnelLoader` (workflow-funnel-loader.ts): 已有 `getFunnel(workflowId)` 返回含 policy 的完整 funnel 定义
- `FunnelPolicy` interface: 已有 `timeoutMs`, `stageOrder`, `legacyDisabled`, `observability`，扩展新字段即可
- `PainSignalRuntimeFactory` (pain-signal-runtime-factory.ts): `resolveRunnerOptions()` 已从 policy 读取 timeoutMs，扩展为同时读取 runtime 配置
- `bridgeCache` Map: 已有 per-workspace 缓存机制，改 key 即可

### Established Patterns
- Factory 函数 `createPainSignalBridge` 是 async（因为 RuntimeStateManager.initialize()），新 adapter 创建不改变这个签名
- bridgeCache 是模块级 const Map，进程生命周期内存活
- `invalidatePainSignalBridge(workspaceDir)` 用于测试清理

### Integration Points
- `createPainSignalBridge` 中 line 97-99 硬编码 `new OpenClawCliRuntimeAdapter(...)` — 这是需要替换的核心位置
- `resolveRunnerOptions` line 48-64 — 需要扩展读取 runtime 配置
- `DiagnosticianRunner` 构造参数中 `runtimeKind: 'openclaw-cli'` (line 115) — 需要从 policy 动态传入

### Current Factory Flow (before m9-02)
```
createPainSignalBridge(opts)
  → resolveRunnerOptions(stateDir)  // 只读 timeoutMs
  → new OpenClawCliRuntimeAdapter(...)  // 硬编码
  → new DiagnosticianRunner(..., { runtimeKind: 'openclaw-cli' })  // 硬编码
```

### Target Factory Flow (after m9-02)
```
createPainSignalBridge(opts)
  → resolveRuntimeConfig(stateDir)  // 读 runtimeKind + provider + model + apiKeyEnv + maxRetries + timeoutMs
  → switch(runtimeKind):
      'pi-ai' → new PiAiRuntimeAdapter({ provider, model, apiKeyEnv, maxRetries, timeoutMs, workspace })
      'openclaw-cli' → new OpenClawCliRuntimeAdapter({ runtimeMode, workspace, timeoutMs })
  → new DiagnosticianRunner(..., { runtimeKind: resolvedKind })
```

</code_context>

<specifics>
## Specific Ideas

- `workflows.yaml` 中 `pd-runtime-v2-diagnosis` funnel 示例结构：
  ```yaml
  funnels:
    - workflowId: pd-runtime-v2-diagnosis
      stages: [...]
      policy:
        timeoutMs: 120000
        runtimeKind: pi-ai
        provider: openrouter
        model: anthropic/claude-sonnet-4
        apiKeyEnv: OPENROUTER_API_KEY
        maxRetries: 2
  ```
- Factory 配置错误消息应包含：缺失字段名 + 修复建议（"add to workflows.yaml policy"）

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: m9-02-Policy-Factory-Integration*
*Context gathered: 2026-04-29*
