# Phase m9-02: Policy + Factory Integration - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-29
**Phase:** m9-02-Policy-Factory-Integration
**Areas discussed:** Policy Field Structure, Validation Strategy, Cache Strategy, Default Runtime, Backward Compatibility

---

## Policy Field Structure

| Option | Description | Selected |
|--------|-------------|----------|
| 平铺字段 | runtimeKind, provider, model, apiKeyEnv, maxRetries 直接加到 FunnelPolicy interface，和 timeoutMs 同级 | ✓ |
| 嵌套 runtime 对象 | 新增 RuntimeConfig interface，FunnelPolicy 内嵌 runtime?: RuntimeConfig | |

**User's choice:** 平铺字段 (Recommended)
**Notes:** 简单直接，不需要额外的 interface 定义

---

## Validation Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Factory 层验证 | PainSignalRuntimeFactory 在创建 adapter 前检查字段，缺失则抛配置错误 | ✓ |
| Adapter 层透传 | Factory 只做选择，字段透传给 PiAiRuntimeAdapter，adapter 内部验证 | |

**User's choice:** Factory 层验证 (Recommended)
**Notes:** 错误在工厂层暴露，更早发现问题

---

## Cache Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| 按 runtime 隔离缓存 | key 改为 `${workspaceDir}:${runtimeKind}`，不同 runtime 独立缓存 | ✓ |
| workspace 级缓存 + invalidate | 保持现有 Map<workspaceDir, Bridge>，runtimeKind 变更时 invalidate | |

**User's choice:** 按 runtime 隔离缓存 (Recommended)
**Notes:** 避免 runtime 切换后拿到旧 adapter

---

## Default Runtime

| Option | Description | Selected |
|--------|-------------|----------|
| openclaw-cli | policy 中 runtimeKind 缺失时回退到 'openclaw-cli'，保持向后兼容 | |
| pi-ai | policy 中 runtimeKind 缺失时回退到 'pi-ai'，M9 目标是让 pi-ai 成为默认 | ✓ |
| 无默认 | policy 中 runtimeKind 缺失时抛配置错误，强制显式声明 | |

**User's choice:** pi-ai
**Notes:** 与 M9 目标一致 — pi-ai 成为默认 diagnostician runtime

---

## Backward Compatibility

| Option | Description | Selected |
|--------|-------------|----------|
| 报错，要求显式配置 | 默认 pi-ai，缺失字段直接报错。现有用户必须更新 workflows.yaml | ✓ |
| 默认 pi-ai + 合理默认值 | 默认 pi-ai，但对 provider/model/apiKeyEnv 提供合理默认值 | |

**User's choice:** 报错，要求显式配置 (Recommended)
**Notes:** M9 是新功能，现有用户应显式迁移。D-02 决定无默认 provider/model。

---

## Claude's Discretion

- YAML 字段命名用 camelCase（与 TypeScript 一致）
- `test-double` runtimeKind 仅在 type union 中声明，factory 暂不实现
- `resolveRunnerOptions` 扩展为 `resolveRuntimeConfig`

## Deferred Ideas

None — discussion stayed within phase scope
