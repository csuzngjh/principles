# Phase 01: SDK Core Implementation - Context

**Gathered:** 2026-04-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement the universal SDK as `@principles/core` npm package with: reference adapter implementations (Coding + Creative Writing), adapter conformance test suite, performance benchmarks (p99 targets), and Semver packaging. This phase takes Phase 0b's abstract interfaces and builds concrete, working implementations.

</domain>

<decisions>
## Implementation Decisions

### Second Domain Adapter
- **D-01:** Creative Writing 作为第二个参考适配器域。痛点来自文本质量评估、风格不一致、逻辑矛盾。原则以文风/结构/叙事规则为主。与 coding 域差异大（无工具调用，痛点来自 LLM 自身输出质量），适合作为 Phase 1.5 的极端案例基础。

### SDK Package Structure
- **D-02:** 创建新 `packages/principles-core` 包，将 Phase 0a/0b 定义的接口文件（pain-signal.ts, storage-adapter.ts, pain-signal-adapter.ts, evolution-hook.ts, principle-injector.ts, telemetry-event.ts）移动到此包。`openclaw-plugin` 变为 `@principles/core` 的消费者。清洁的 Semver 边界。
- **D-03:** Coding adapter 和 Writing adapter 实现放在 `packages/principles-core/src/adapters/` 下，各自一个子目录。

### Performance Benchmarking
- **D-04:** 使用 vitest bench 或 benchmark.js 在 CI 中运行性能基准。生成 JSON 报告 + markdown 摘要。使用合成数据（已知大小的信号/原则集）。可重复、无外部依赖。p99 目标：< 50ms (pain capture)，< 100ms (injection)。

### Adapter Conformance Testing
- **D-05:** 参照 `storage-conformance.test.ts` 的 `describeAdapterConformance` 工厂函数模式——导出 `describePainAdapterConformance` 和 `describeInjectorConformance` 函数，每个适配器实现调用它。统一格式，可扩展。

### Claude's Discretion
- 新包的 package.json 配置（exports, types, main 字段）
- Coding adapter 的具体 OpenClaw 事件类型映射
- Writing adapter 的痛点评分算法细节
- 基准测试的具体数据规模和迭代次数
- conformance suite 的完整测试用例列表

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 0a/0b 接口（Phase 01 直接依赖）
- `packages/openclaw-plugin/src/core/pain-signal.ts` — Universal PainSignal schema, validatePainSignal, deriveSeverity
- `packages/openclaw-plugin/src/core/storage-adapter.ts` — StorageAdapter interface
- `packages/openclaw-plugin/src/core/pain-signal-adapter.ts` — PainSignalAdapter<TRawEvent> interface
- `packages/openclaw-plugin/src/core/evolution-hook.ts` — EvolutionHook interface + noOpEvolutionHook
- `packages/openclaw-plugin/src/core/principle-injector.ts` — PrincipleInjector + InjectionContext + DefaultPrincipleInjector
- `packages/openclaw-plugin/src/core/telemetry-event.ts` — TelemetryEvent TypeBox schema

### 现有框架集成点（Coding adapter 需要）
- `packages/openclaw-plugin/src/hooks/pain.ts` — 当前 OpenClaw pain 捕获逻辑
- `packages/openclaw-plugin/src/hooks/prompt.ts` — 当前原则注入逻辑
- `packages/openclaw-plugin/src/core/principle-injection.ts` — selectPrinciplesForInjection, formatPrinciple

### 测试模式参考
- `packages/openclaw-plugin/tests/core/storage-conformance.test.ts` — conformance suite 工厂函数模式

### 项目级参考
- `.planning/REQUIREMENTS.md` — SDK-CORE-03, SDK-ADP-07, SDK-ADP-08, SDK-TEST-02, SDK-TEST-03, SDK-MGMT-01, SDK-MGMT-02
- `.planning/ROADMAP.md` — Phase 1 定义

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 0a/0b 的 6 个接口文件：直接移动到新包
- `DefaultPrincipleInjector`：已实现的委托 wrapper，直接可用
- `validatePainSignal()`：适配器输出验证复用
- `selectPrinciplesForInjection()` + `formatPrinciple()`：Injection 核心逻辑

### Established Patterns
- TypeBox schema + validate 函数模式
- 泛型适配器接口 + 具体实现模式
- conformance suite 工厂函数模式
- `--no-verify` commit 用于并行 worktree 执行

### Integration Points
- `packages/principles-core/` — 新 SDK 包（Phase 01 创建）
- `packages/openclaw-plugin/` — 变为 @principles/core 消费者
- Coding adapter 需要映射 OpenClaw hook 事件类型
- Writing adapter 是独立实现，无现有框架绑定

</code_context>

<specifics>
## Specific Ideas

- Creative Writing 域的痛点信号示例：text_coherence_violation, style_inconsistency, narrative_arc_break, tone_mismatch
- Writing adapter 的 capture() 可接收文本分析结果（如 LLM 输出质量评估）作为 rawEvent
- 性能基准应覆盖：单个信号翻译、批量原则选择（10/50/200 条）、格式化输出
- 新包的 exports 应支持 tree-shaking：interfaces 独立入口，adapters 独立入口

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 01-basic-visualization*
*Context gathered: 2026-04-17*
