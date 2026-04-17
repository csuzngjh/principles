# Phase 0b: Adapter Abstraction - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-17
**Phase:** 00b-adapter-abstraction
**Areas discussed:** 适配器耦合模式, EvolutionHook 生命周期, PrincipleInjector 抽象边界, 遥测 Schema 范围

---

## 适配器耦合模式

| Option | Description | Selected |
|--------|-------------|----------|
| 泛型适配器（推荐） | PainSignalAdapter<RawEvent> 泛型接口，每个框架实现自己的类型参数 | ✓ |
| unknown 入参 + 类型守卫 | PainSignalAdapter 只接收 unknown，内部自行类型守卫 | |
| 中间协议层 | 框架适配器产出中间对象，再由核心翻译为 PainSignal | |

**User's choice:** 泛型适配器（推荐）
**Notes:** 编译时类型安全，每个框架有明确的类型参数。

| Option | Description | Selected |
|--------|-------------|----------|
| 纯翻译（推荐） | capture() 只负责翻译框架事件为 PainSignal 或 null | ✓ |
| 判断+翻译 | capture() 同时判断是否值得捕获 | |
| 分离过滤器 | 独立 SignalFilter 接口，适配器只翻译，过滤器判断 | |

**User's choice:** 纯翻译（推荐）
**Notes:** 是否触发信号由框架侧 hook 逻辑决定（如现有 GFI 阈值判断）。

---

## EvolutionHook 生命周期

| Option | Description | Selected |
|--------|-------------|----------|
| 仅 3 核心（推荐） | 只包含 onPainDetected, onPrincipleCreated, onPrinciplePromoted | ✓ |
| 5 个事件 | 加上 onCandidateRejected, onPrincipleDeprecated | |
| 3 核心 + 泛型扩展 | 3 核心 + onEvent(type: string, data: unknown) | |

**User's choice:** 仅 3 核心（推荐）
**Notes:** 扩展能力通过 future phase 添加。

| Option | Description | Selected |
|--------|-------------|----------|
| 接口回调（推荐） | EvolutionHook 是包含 3 个方法的接口，用户实现整个接口 | ✓ |
| EventEmitter 模式 | 注册单独的事件监听器 adapter.on('painDetected', handler) | |
| 混合模式 | 接口回调为默认 + toEmitter() 转换工具函数 | |

**User's choice:** 接口回调（推荐）
**Notes:** 类型安全，IDE 支持好。

---

## PrincipleInjector 抽象边界

| Option | Description | Selected |
|--------|-------------|----------|
| 包装现有实现（推荐） | 接口方法委托调用 selectPrinciplesForInjection 和 formatPrinciple | ✓ |
| 从零设计新接口 | 不考虑现有函数签名，重新设计 | |
| 新接口 + 复用底层实现 | 接口签名自行设计，底层可复用现有代码 | |

**User's choice:** 包装现有实现（推荐）
**Notes:** 零重写风险，现有测试全部保留。

| Option | Description | Selected |
|--------|-------------|----------|
| 通用 InjectionContext（推荐） | domain, sessionId, 可用字符预算等，不含框架特定字段 | ✓ |
| 框架特定上下文 | 直接接收 OpenClaw AgentContext 等 | |

**User's choice:** 通用 InjectionContext（推荐）
**Notes:** 框架适配器负责转换框架上下文为 InjectionContext。

---

## 遥测 Schema 范围

| Option | Description | Selected |
|--------|-------------|----------|
| 类型 + 文档 Schema（推荐） | TypeBox TelemetryEvent schema + 文档，不改现有代码 | ✓ |
| 新 TelemetryService 接口 | 统一所有遥测收集，替换或包装现有 EvolutionLogger | |
| 纯文档描述 | Markdown 描述格式，不生成代码 schema | |

**User's choice:** 类型 + 文档 Schema（推荐）
**Notes:** 现有 EvolutionLogger 输出应符合此 schema。

| Option | Description | Selected |
|--------|-------------|----------|
| 核心 3 事件（推荐） | pain_detected, principle_candidate_created, principle_promoted | ✓ |
| 核心 + 注入事件 | 加上 principle_injected, injection_skipped | |
| 全部可观测事件 | 包含 deprecated, storage_operation 等所有事件 | |

**User's choice:** 核心 3 事件（推荐）
**Notes:** 与 EvolutionHook 的 3 事件对齐。

---

## Claude's Discretion

- 各接口精确字段命名和类型细节
- PainSignalAdapter 错误处理策略
- EvolutionHook 可选方法实现方式
- InjectionContext 完整字段列表

## Deferred Ideas

None — discussion stayed within phase scope.
