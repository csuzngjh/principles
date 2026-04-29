# Phase m9-03: CLI Commands - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning

<domain>
## Phase Boundary

扩展 pd-cli 三个命令支持 pi-ai runtime：
1. `pd runtime probe --runtime pi-ai` — 验证 pi-ai runtime 可用性
2. `pd diagnose run --runtime pi-ai` — 使用 PiAiRuntimeAdapter 执行诊断
3. `pd pain record` — 通过 factory/policy 自动选择 runtime（不暴露 --runtime flag）

依赖：m9-01（PiAiRuntimeAdapter）、m9-02（Policy + Factory）

</domain>

<decisions>
## Implementation Decisions

### Config Source (CLI-04)
- **D-01:** CLI flags + policy fallback。`pd runtime probe` 和 `pd diagnose run` 接受 `--provider`、`--model`、`--apiKeyEnv`、`--maxRetries`、`--timeoutMs` flags。有 flag 用 flag，没有则从 workflows.yaml policy 读取。
- **D-02:** `--runtime pi-ai` 是必填 flag。不从 policy 推断 runtimeKind（probe/diagnose 是显式操作）。

### Probe Scope (CLI-01)
- **D-03:** probe 执行三步验证：(1) apiKeyEnv 环境变量存在，(2) getModel(provider, model) 不抛异常，(3) 发一个最小 prompt complete 请求验证完整链路。
- **D-04:** probe 超时 60s。pi-ai 走真实 LLM 调用，需要比 openclaw-cli probe 更长时间。
- **D-05:** probe 输出包含 test complete 结果（LLM 响应摘要），让用户确认 LLM 可达且返回合理内容。

### Diagnose Flags (CLI-02)
- **D-06:** `pd diagnose run --runtime pi-ai` 的 provider/model/apiKeyEnv/maxRetries/timeoutMs flags 与 probe 保持一致。有 flag 用 flag，没有则从 policy 读取。
- **D-07:** pi-ai 分支加入 diagnose.ts 的 runtime 选择逻辑，与 openclaw-cli 和 test-double 并列。

### Pain Record (CLI-03)
- **D-08:** `pd pain record` 不接受 `--runtime` flag。完全走 factory/policy，符合 LOCKED-03（workflows.yaml 是 SSOT）。现有代码已调用 `createPainSignalBridge`，m9-02 后 factory 自动从 policy 读取 runtimeKind，pain-record.ts 无需修改。

### Error Handling
- **D-09:** probe 的 apiKeyEnv 缺失 → 明确错误消息（"环境变量 XXX 未设置"），exit 1。
- **D-10:** probe 的 test complete 失败 → 输出错误类别（timeout/execution_failed/output_invalid）+ 原始错误消息，exit 1。
- **D-11:** diagnose 的 pi-ai 配置验证失败（缺少 provider/model/apiKeyEnv）→ 错误消息包含缺失字段 + 修复建议（"pass via --flag or add to workflows.yaml policy"）。

### Claude's Discretion
- probe 的 test complete 使用的 minimal prompt 内容（如 "ping" 或 "test"）
- probe 输出中 test complete 结果的展示格式
- pi-ai 分支的 telemetry event 与 openclaw-cli 保持一致的模式

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Runtime Protocol
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter 接口，RuntimeKindSchema（已含 'pi-ai'）

### PiAiRuntimeAdapter (m9-01)
- `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` — PiAiRuntimeAdapter 实现，healthCheck() 方法

### Factory (m9-02)
- `packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts` — createPainSignalBridge，resolveRuntimeConfig，从 policy 读取 runtime 配置

### Existing CLI Commands
- `packages/pd-cli/src/commands/runtime.ts` — 现有 probe handler，只有 openclaw-cli
- `packages/pd-cli/src/commands/diagnose.ts` — 现有 diagnose handler，openclaw-cli + test-double 分支
- `packages/pd-cli/src/commands/pain-record.ts` — 现有 pain record handler，调用 createPainSignalBridge

### Prior Phase Context
- `.planning/phases/m9-01-PiAiRuntimeAdapter-Core/m9-01-CONTEXT.md` — D-02 (no defaults), D-13 (healthCheck)
- `.planning/phases/m9-02-Policy-Factory-Integration/m9-02-CONTEXT.md` — D-01 (flat policy fields), D-02 (factory validation), D-04 (default runtimeKind)

### Requirements
- `.planning/REQUIREMENTS.md` — CLI-01~04 定义

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `probeRuntime()` (runtime-v2/index.ts): 已有的 probe 入口函数，接受 `{ runtimeKind, runtimeMode, agentId }`。需要扩展支持 pi-ai 的 config 参数。
- `handleRuntimeProbe` (runtime.ts): 已有 openclaw-cli probe handler，格式化输出、JSON 模式、错误处理模式可复用。
- `handleDiagnoseRun` (diagnose.ts): 已有 runtime 选择 if/else chain，加入 pi-ai 分支即可。
- `createPainSignalBridge` (pain-signal-runtime-factory.ts): m9-02 后已从 policy 读取 runtimeKind，pain-record.ts 无需修改。

### Established Patterns
- CLI flags 用 camelCase（`--openclawLocal`、`--apiKeyEnv`）
- JSON 输出用 `--json` flag，human-readable 是默认
- 错误处理：try/catch + PDRuntimeError 分类 + exit 1
- Telemetry：`storeEmitter.emitTelemetry()` 在 adapter 选择后调用

### Integration Points
- `runtime.ts` line 37: 硬编码 `opts.runtime !== 'openclaw-cli'` 检查 — 需要扩展
- `diagnose.ts` line 101: `runtimeKind = opts.runtime ?? 'test-double'` — 需要加 pi-ai 分支
- `pain-record.ts`: 无需修改（factory 已处理）

### Current probeRuntime Function
需要检查 `probeRuntime()` 是否支持传入 pi-ai 配置参数。如果不支持，需要扩展其签名或在 CLI 层直接调用 PiAiRuntimeAdapter.healthCheck()。

</code_context>

<specifics>
## Specific Ideas

- probe 的 test complete 应使用最小 prompt，验证 LLM 可达即可，不需要有意义的诊断内容
- probe 输出示例：
  ```
  Runtime: pi-ai
  Provider: openrouter
  Model:    anthropic/claude-sonnet-4
  Status:   succeeded

  Health:
    apiKeyEnv:     OPENROUTER_API_KEY (set)
    modelResolve:  ok
    testComplete:  ok (response: "Hello!")

  Capabilities:
    streaming          no
    cancellation       yes
    artifactDelivery   no
  ```
- diagnose 的 pi-ai 分支应与 openclaw-cli 分支结构一致：创建 adapter → telemetry → 构建 runner → 执行

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---
*Phase: m9-03-CLI-Commands*
*Context gathered: 2026-04-29*
