# Requirements: M9 PiAi Runtime Adapter

**Defined:** 2026-04-29
**Core Value:** PiAiRuntimeAdapter 成为 PD Runtime v2 默认 diagnostician runtime，绕过 OpenClaw CLI 直接调用 LLM，解决 m8-03 UAT 阻塞问题（main agent >300s）。

## v2.8 M9 Requirements

### Runtime Schema

- [ ] **RS-01**: RuntimeKindSchema 增加 `"pi-ai"` literal
- [ ] **RS-02**: 类型系统正确推导，`kind()` 返回 `'pi-ai'`

### PiAiRuntimeAdapter

- [ ] **AD-01**: 实现 PDRuntimeAdapter 接口所有方法：`kind()`, `getCapabilities()`, `healthCheck()`, `startRun()`, `pollRun()`, `cancelRun()`, `fetchOutput()`, `fetchArtifacts()`
- [ ] **AD-02**: `getModel(provider, modelId)` 使用 `@mariozechner/pi-ai` 获取模型实例
- [ ] **AD-03**: `complete(model, context, options?)` 调用 pi-ai complete，返回 AssistantMessage
- [ ] **AD-04**: DiagnosticianOutputV1 验证 — LLM 响应必须符合 DiagnosticianOutputV1Schema
- [ ] **AD-05**: `AbortSignal.timeout(timeoutMs)` 超时控制
- [ ] **AD-06**: 构造函数接受配置：`{ provider, model, apiKeyEnv, maxRetries, timeoutMs, workspace }`
- [ ] **AD-07**: apiKeyEnv 从环境变量读取 API key，不存在时 throw PDRuntimeError(runtime_unavailable)
- [ ] **AD-08**: maxRetries 失败重试（指数退避），超过后 throw PDRuntimeError(execution_failed)
- [ ] **AD-09**: startRun() 一次性执行：complete → validate → store output → return terminal RunHandle
- [ ] **AD-10**: pollRun() 对已 terminal 的 run 直接返回 current status
- [ ] **AD-11**: fetchOutput() 返回 stored StructuredRunOutput
- [ ] **AD-12**: fetchArtifacts() 返回空数组（pi-ai 无 artifact 概念，output 在 fetchOutput 中）
- [ ] **AD-13**: healthCheck() 验证 apiKeyEnv 存在 + pi-ai getModel 不抛异常
- [ ] **AD-14**: getCapabilities() 返回 `{ streaming: false, cancellation: true, artifactDelivery: false }`
- [ ] **AD-15**: Telemetry events: runtime_invocation_started, runtime_invocation_succeeded/failed

### workflows.yaml Policy

- [ ] **PL-01**: `pd-runtime-v2-diagnosis` funnel policy 增加字段：`runtimeKind`, `provider`, `model`, `apiKeyEnv`, `maxRetries`
- [ ] **PL-02**: policy 字段有合理默认值（runtimeKind: 'openclaw-cli', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', apiKeyEnv: 'OPENROUTER_API_KEY', maxRetries: 2）
- [ ] **PL-03**: WorkflowFunnelLoader 正确解析新 policy 字段

### PainSignalRuntimeFactory

- [ ] **FC-01**: 从 workflows.yaml policy 读取 runtimeKind
- [ ] **FC-02**: runtimeKind === 'pi-ai' 时创建 PiAiRuntimeAdapter
- [ ] **FC-03**: runtimeKind === 'openclaw-cli'（或未指定）时创建 OpenClawCliRuntimeAdapter（保持现有行为）
- [ ] **FC-04**: 不再硬编码 openclaw-cli，policy 驱动

### CLI

- [ ] **CLI-01**: `pd runtime probe --runtime pi-ai` — 验证 pi-ai runtime 可用
- [ ] **CLI-02**: `pd diagnose run --runtime pi-ai` — 使用 pi-ai 执行诊断
- [ ] **CLI-03**: `pd pain record` 默认走 workflows.yaml policy（读取 runtimeKind）
- [ ] **CLI-04**: CLI 正确传递 provider/model/apiKeyEnv 等配置到 PiAiRuntimeAdapter

### Tests

- [ ] **TEST-01**: mock complete success — 验证 DiagnosticianOutputV1 正确生成
- [ ] **TEST-02**: mock complete failure — 验证 PDRuntimeError(execution_failed) + maxRetries
- [ ] **TEST-03**: mock complete timeout — 验证 PDRuntimeError(timeout)
- [ ] **TEST-04**: mock complete invalid-json — 验证 PDRuntimeError(output_invalid)
- [ ] **TEST-05**: probe success/failure — 验证 healthCheck 行为
- [ ] **TEST-06**: E2E pain→artifact→candidate→ledger — 完整链路验证（mock pi-ai）

### Real UAT

- [ ] **UAT-01**: OPENROUTER_API_KEY 存在验证
- [ ] **UAT-02**: `pd runtime probe --runtime pi-ai` 返回 healthy
- [ ] **UAT-03**: `pd pain record --runtime pi-ai` 执行成功
- [ ] **UAT-04**: assert status === 'succeeded'
- [ ] **UAT-05**: assert artifactId 存在
- [ ] **UAT-06**: assert candidateIds.length > 0
- [ ] **UAT-07**: assert ledgerEntryIds.length > 0
- [ ] **UAT-08**: 幂等性验证 — 重复执行不产生重复 ledger entry

## Non-Goals

| Feature | Reason |
|---------|--------|
| 多 runtime 适配器套件 | M9 只新增 PiAiRuntimeAdapter |
| OpenClaw agent/tool 调用 | LOCKED-01: direct LLM completion only |
| 新 UI/dashboard | SDK scope 外 |
| pi-agent-core 依赖 | Hard boundary: 不引入 |
| 修改 OpenClawCliRuntimeAdapter | 保留为 alternative |
| 修改 candidate/ledger 主链路 | 除非测试证明有 bug |

## Hard Gates

| ID | Description |
|----|-------------|
| HG-1 | PiAiRuntimeAdapter 实现 PDRuntimeAdapter 完整接口 |
| HG-2 | workflows.yaml policy 是 runtime 配置的唯一来源（LOCKED-03） |
| HG-3 | M9 成功终点是 ledger probation entry 存在（LOCKED-02） |
| HG-4 | 不引入 pi-agent-core，不支持 tool calling（Hard boundary） |
| HG-5 | Real UAT 必须用真实 OPENROUTER_API_KEY 执行 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| RS-01~02 | m9-01 | Pending |
| AD-01~15 | m9-01 | Pending |
| PL-01~03 | m9-02 | Pending |
| FC-01~04 | m9-02 | Pending |
| CLI-01~04 | m9-03 | Pending |
| TEST-01~06 | m9-04 | Pending |
| UAT-01~08 | m9-05 | Pending |

---
*Requirements defined: 2026-04-29*
*Last updated: 2026-04-29 after M9 milestone start*
