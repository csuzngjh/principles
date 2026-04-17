# Phase 0b: Adapter Abstraction - Context

**Gathered:** 2026-04-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Abstract framework-specific logic from the core evolution pipeline into framework-agnostic adapter interfaces, and define a telemetry event schema for in-process observability. This phase builds on Phase 0a's PainSignal schema and StorageAdapter interface to create the adapter layer that decouples the SDK from any specific AI agent framework (OpenClaw, Claude Code, etc.).

</domain>

<decisions>
## Implementation Decisions

### PainSignalAdapter 设计
- **D-01:** PainSignalAdapter 使用泛型 `PainSignalAdapter<RawEvent>` 模式，每个框架实现自己的类型参数（如 `OpenClawPainSignalAdapter implements PainSignalAdapter<PluginHookAfterToolCallEvent>`）。编译时类型安全。
- **D-02:** PainSignalAdapter 职责为纯翻译——`capture(rawEvent)` 只负责将框架事件翻译为 `PainSignal | null`，返回 null 表示该事件不产生信号。是否触发捕获的判断（如 GFI 阈值）由框架侧 hook 逻辑决定，不在适配器内。

### EvolutionHook 接口
- **D-03:** EvolutionHook 接口仅包含 roadmap 定义的 3 个核心事件方法：`onPainDetected`、`onPrincipleCreated`、`onPrinciplePromoted`。额外事件（onCandidateRejected, onPrincipleDeprecated 等）留待后续 phase 扩展。
- **D-04:** EvolutionHook 使用接口回调模式——用户实现包含 3 个方法的接口。不使用 EventEmitter 模式。可选方法（不需要的 hook 可提供空实现）。

### PrincipleInjector 接口
- **D-05:** PrincipleInjector 接口包装现有实现——`getRelevantPrinciples()` 委托给 `selectPrinciplesForInjection`，`formatForInjection()` 委托给 `formatPrinciple`。零重写风险，现有测试全部保留。
- **D-06:** PrincipleInjector 接收通用 `InjectionContext`（包含 domain, sessionId, 可用字符预算等字段），不包含框架特定字段。框架适配器负责将框架上下文转换为 InjectionContext。

### 遥测 Schema
- **D-07:** 遥测 schema 以 TypeBox `TelemetryEvent` 类型定义 + 文档描述的形式输出。现有 EvolutionLogger 的输出应符合此 schema。不创建新 TelemetryService 接口，不改现有代码。
- **D-08:** 遥测 schema 覆盖核心 3 事件：`pain_detected`、`principle_candidate_created`、`principle_promoted`。与 EvolutionHook 的 3 事件对齐。注入、存储等事件不在本 phase scope 内。

### Claude's Discretion
- 各接口的精确字段命名和类型细节
- PainSignalAdapter 的错误处理策略（翻译失败时返回 null vs 抛异常）
- EvolutionHook 可选方法的具体实现方式（提供 base class with no-op vs individual method optional）
- InjectionContext 的完整字段列表（核心字段由 planner 决定）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 0a 产出（Phase 0b 直接依赖）
- `packages/openclaw-plugin/src/core/pain-signal.ts` — Universal PainSignal schema, validatePainSignal, deriveSeverity
- `packages/openclaw-plugin/src/core/storage-adapter.ts` — StorageAdapter interface contract (loadLedger, saveLedger, mutateLedger)
- `packages/openclaw-plugin/src/core/principle-injection.ts` — selectPrinciplesForInjection, formatPrinciple, InjectablePrinciple
- `packages/openclaw-plugin/src/core/observability.ts` — Observability baselines (Phase 0a 产出，Phase 0b 可参考其模式)

### 现有框架集成点（需要抽象的逻辑）
- `packages/openclaw-plugin/src/hooks/pain.ts` — 当前 OpenClaw after_tool_call hook，包含 pain 捕获的完整逻辑
- `packages/openclaw-plugin/src/hooks/prompt.ts` — 当前 OpenClaw before_prompt_build hook，包含原则注入逻辑
- `packages/openclaw-plugin/src/core/evolution-reducer.ts` — 内部事件分发（onPainDetected, onPrinciplePromoted 等方法）
- `packages/openclaw-plugin/src/core/evolution-logger.ts` — 当前遥测日志实现

### 项目级参考
- `.planning/REQUIREMENTS.md` — SDK-ADP-01..06, SDK-OBS-05
- `.planning/ROADMAP.md` — Phase 0b 定义
- `.planning/phases/00a-interface-core/00a-VERIFICATION.md` — Phase 0a 验证报告

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `PainSignalSchema` (TypeBox): Phase 0a 定义的通用 schema，PainSignalAdapter 的输出目标
- `validatePainSignal()`: 翻译后的信号可复用此验证
- `StorageAdapter` interface: Phase 0a 定义，Phase 0b 的 SDK-ADP-06 已被 Phase 0a 覆盖
- `selectPrinciplesForInjection()`: PrincipleInjector.getRelevantPrinciples() 的委托目标
- `formatPrinciple()`: PrincipleInjector.formatForInjection() 的委托目标
- `InjectablePrinciple` type: PrincipleInjector 的输入类型

### Established Patterns
- TypeBox schema 验证: 项目使用 @sinclair/typebox 做运行时类型验证（PainSignalSchema、observability）
- 泛型适配器模式: `StorageAdapter` 接口 + `FileStorageAdapter` 实现是类似的适配器模式
- 接口 + 委托: `principle-injection.ts` 的 `InjectablePrinciple` 是最小接口提取模式
- 文件命名: `*-adapter.ts`, `*-types.ts`, `*.test.ts`

### Integration Points
- `hooks/pain.ts:handleAfterToolCall()` — PainSignalAdapter 的主要调用者（OpenClaw 实现）
- `hooks/prompt.ts` — PrincipleInjector 的主要调用者（OpenClaw 实现）
- `evolution-reducer.ts` — EvolutionHook 的消费者（遍历 hooks 并调用）
- `evolution-logger.ts` — TelemetryEvent schema 的输出目标

</code_context>

<specifics>
## Specific Ideas

- PainSignalAdapter 的泛型模式参考 StorageAdapter 的设计——一个接口 + 多个框架实现
- EvolutionHook 的 3 事件与 evolution-reducer 已有的内部方法一一对应，可直接提取
- PrincipleInjector 应作为最薄的抽象层——接口签名 + 委托调用，不做额外逻辑

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 00b-adapter-abstraction*
*Context gathered: 2026-04-17*
