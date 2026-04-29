# Discussion Log: m9-01 PiAiRuntimeAdapter Core

**Date:** 2026-04-29

## Area 1: Execution Model

**Question:** startRun() 的执行模式？

**Options:**
1. One-shot（推荐）— startRun() 内部等待 LLM 完成，返回时 run 已 terminal
2. Async fire-and-forget — startRun() 立即返回，LLM 在后台执行

**User Selection:** One-shot（推荐）

**Notes:** 与 OpenClawCliRuntimeAdapter 模式一致。pollRun() 直接返回最终状态。

## Area 2: Provider Strategy

**Question:** 默认 provider 策略？

**Options:**
1. openrouter（推荐）— 使用 OpenRouter 作为默认 provider
2. anthropic — 直接使用 Anthropic API
3. 不设默认值 — provider 和 model 必须在 workflows.yaml 中显式配置

**User Selection:** 不设默认值

**Notes:** provider/model/apiKeyEnv 必须在 workflows.yaml 中显式配置，否则报错。

## Area 3: Validation Strictness

**Question:** DiagnosticianOutputV1 验证的严格程度？

**Options:**
1. Schema 验证（推荐）— 用 TypeBox 严格验证
2. 宽松验证 — 只检查三个必需字段

**User Selection:** Schema 验证（推荐）

**Notes:** 用 TypeBox 严格验证 DiagnosticianOutputV1Schema，任何字段缺失或类型错误都 output_invalid。
