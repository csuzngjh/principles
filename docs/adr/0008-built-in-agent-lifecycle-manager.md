# ADR-0008: Built-in Agent Lifecycle Manager (BALM)

> **状态**: Accepted (实施延后至 Phase 2 — 见 v2.0 修订)
> **日期**: 2026-05-16
> **相关**: COMPONENTS.md, INTERNALIZATION_PIPELINE.md

> **2026-05-24 v2.0 修订**: 本 ADR 的 `Accepted` 状态保持不变，但**实施被显式延后**到 Phase 2，准入门槛由 [docs/plans/2026-05-roadmap/02-roadmap.md §7](../plans/2026-05-roadmap/02-roadmap.md) 强制：必须先完成 Phase 1C/1D（特别是 Attribution Pipeline 在生产 workspace 累计 ≥ 50 个 verdict 且校准通过 false positive < 5%）。在该门槛达成前，禁止启动本 ADR 涉及的实施工作；如有 Linear 工单引用本 ADR 要求即时实施，先与维护者确认门槛状态。本修订理由见 [ADR-0013](./0013-attribution-pipeline-and-decision-observability.md) 与 [06-ahe-informed-architecture-review.md](../plans/2026-05-roadmap/06-ahe-informed-architecture-review.md) §2.2。


## 1. 背景与痛点 (Context)

在目前的架构中，内部的 7 大 Peer Runners（Dreamer, Philosopher, Scribe, Artificer 等）通过硬编码的方式在代码中实例化。这导致了几个问题：
1. **身份与配置分散**：Agent 的提示词、支持的工具列表、优先使用的模型运行时（如 Claude Code 或 Gemini CLI）散落在各个文件中，难以集中管理和更新。
2. **多后端适配困难**：系统逐渐需要支持更多的底层驱动（OpenClaw, Claude Code, Codex, Gemini 等），如果在 Runner 里硬编码适配器调用，将导致核心领域层与外围基础设施严重耦合。
3. **缺乏版本控制**：内部代理的变更是极其危险的，目前没有机制对内置代理进行版本化管理和灰度测试。

## 2. 决策详情 (Decisions)

我们决定引入 **Built-in Agent Lifecycle Manager (BALM)** 子系统，统一接管所有内置代理的生命周期。

### 2.1 声明式代理清单 (Agent Manifests)
所有的内置代理不再通过代码硬性构建，而是必须通过声明式的 YAML 清单进行定义。例如 `diagnostician.agent.yaml`。
该 Manifest 包含：
- 代理的唯一身份 (Identity / ID)
- 版本号 (Version)
- 系统提示词模板 (System Prompt Template)
- 所需工具权限列表 (Required Tool Permissions)
- 偏好的运行时环境 (Preferred Runtimes)

### 2.2 集中式注册表与解析器
- 建立 `BuiltInAgentRegistry` 统一加载和缓存所有的 Agent Manifest。
- 建立 `AgentRuntimeResolver`。当系统需要唤醒某个 Agent 时，它会根据 Manifest 中的能力要求（Caps）和工作区当前的配置，自动为其匹配并分配最合适的 `PDRuntimeAdapter`（如 `ClaudeCodeRuntimeAdapter` 或 `OpenCodeRuntimeAdapter`）。

### 2.3 严格的不变量约束 (Invariants)
- `BALM-1`：所有内置代理必须有对应的 Manifest 文件，绝对禁止匿名或即兴实例化的 Peer Runner。
- `BALM-2`：Peer Runner 不得直接 `import` 任何 `Adapter` 的底层实现类。所有底层驱动的获取必须通过 BALM 依赖注入进行解析。
- `BALM-3`：Agent 的基础 Prompt 必须从 Manifest 加载，严禁在 TypeScript 源码中硬编码。

## 3. 架构收益 (Consequences)

### 积极影响 (Pros)
- **极度解耦**：Peer Runners 现在变成了纯粹的业务状态流转器，彻底摆脱了与大模型厂商 API 或特定 CLI 工具的耦合。
- **可插拔运行时**：能够非常轻松地接入新的底层驱动（例如接入未来新出的 Hermes 终端）。
- **统一治理**：架构师可以直接通过审查 YAML 文件来把控所有内部 AI 代理的权限和性格，这使得系统审计变得直观可见。

### 潜在风险 (Cons / Mitigations)
- *风险*：YAML 文件的加载可能成为新的故障点，尤其是语法错误。
- *缓解*：在启动时或打包阶段（Build Phase）使用专门的 TypeBox Schema 强制校验所有的 Manifest 文件，拒绝启动格式错误的配置。