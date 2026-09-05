# ADR-0023: PD Installation Architecture Decisions — Runtime, Adapter, Console/Desktop, SDK, Workspace State, Version Identity, Integrity

> **Status**: **Accepted**
> **Date**: 2026-09-04
> **Decider**: **Owner**
> **Decision evidence**: Owner 逐项裁决于 2026-09-04 会话（`Decision 1` ~ `Decision 9` 的文本由 Owner 直接给出，本 ADR §2 与之逐条对应）。本 ADR 的 Accepted 状态直接来自该 Owner 指令，**非 Agent 自行标记**；合规满足 ADR 治理硬原则（涉及 Owner 决策的 ADR 必须引用真实 Owner decision evidence）。
> **Context**: PD 已从单一 OpenClaw plugin 演化为多组件平台（Runtime / Host Adapters / Console / Desktop Companion / SDK），需要重新定义安装与运行边界
> **Supersedes**: 无。取代会话内起草的未编号草稿 `docs/architecture/ADR-0021-PD-Installation-Architecture-Decisions.md`（该草稿因编号与已 Accepted 的 ADR-0021 冲突而作废，内容已并入本 ADR）。
> **Refines**: [ADR-0020](0020-codex-cli-host-adapter.md) §2（薄适配器与 host-runtime 抽象层）—— 本 ADR 在**安装/部署**层面细化 ADR-0020 的适配器边界，不改动其协议/编解码决策。
> **Related**: [ADR-0014](0014-mvp-first-strategy-and-product-pivot.md)（MVP-First）；[ADR-0021](0021-anonymous-product-telemetry.md)（编号所有者，本 ADR 不触碰）；[ADR-0022](0022-owner-identity-registration.md)（`~/.pd/owner.json` 机器级作用域先例）；[PD Installation Architecture v2.0](../architecture/PD_Installation_Architecture_v2.md)；[环境拓扑只读审计](../audit/PD_Current_Environment_Topology_Audit.md)；[ADR-0023 审查报告](../architecture/ADR-0023-review-summary.md)
> **Scope**: **架构决策文档。** 本 ADR 固化边界，**不执行**任何实施动作（见 §4 Non-Goals）。

---

## 1. Context

### 1.1 演化带来的边界问题

PD 最初是 OpenClaw 的一个插件——单一产物、单一安装位置。当前已演化为五个组件族：

| 组件 | 作用 | 现状位置 |
|---|---|---|
| **Runtime** | 执行引擎与共享能力 | `~/.pd/runtime/`（core / host-runtime / codex-adapter / pd-cli / console / plugin / install-layout / bin） |
| **Host Adapter** | 宿主协议适配（OpenClaw / Codex / 未来宿主） | `~/.openclaw/extensions/principles-disciple`、宿主发现目录 |
| **Console** | Owner 界面服务（HTTP + Web UI） | `~/.pd/runtime/console` |
| **Desktop Companion** | 桌面启动与监护外壳 | `D:\Program Files\PD Companion`（Electron） |
| **SDK** | 治理能力库 `@principles/core` | 随 release 分发 |

边界未定义导致的直接后果（均为已核实事实，见 [审查报告 §1](../architecture/ADR-0023-review-summary.md)）：

1. **安装目录曾被非安装器静默写入。** 2026-09-03 15:06，`runtime/console/dist/server.js`、`runtime/core/dist/index.js`、`runtime/plugin/dist/bundle.js` 及两个 `package.json` 被写成占位文本。系统仍可运行，仅因这些文件恰好没有加载路径命中——这是运气，不是设计。
2. **产品身份没有唯一权威。** `installer.ts` 从不写 `active.json`，导致 `pd version --json` 落到 legacy 兜底分支：`source: official-legacy-overlay`、`health: degraded`、版本取自宿主插件的 package.json。
3. **依赖解析策略名义存在、实际失效。** 安装器的 junction 全部带 `if (!existsSync)` 守卫，叠加 npm `file:` 依赖的复制语义，现场一条链接都未建成。
4. **状态根分裂且持续增长。** workspace 下有四个状态根：`.pd`、`.state`、`.principles`、`memory/`，其中后两个存放 **Owner 直接编辑的知识资产**（PRINCIPLES.md、THINKING_OS.md、MEMORY.md）。

### 1.2 为什么现在裁决

上述每条都可单独打补丁缓解，但共同根因是同一个：**没有人对"边界"做过一次明确裁决**。在边界未裁决前修复任何一条，都是在流沙上施工。

### 1.3 与 ADR-0020 的关系

ADR-0020 已 Accepted，确立了"宿主包是薄协议适配器、业务编排在 `@principles/host-runtime`"的方向。本 ADR **不重新讨论该方向**，而是在安装与部署层面回答：适配器以什么形态交付、谁能写安装目录、版本身份由谁定义。

---

## 2. Decision

### 2.1 Runtime Ownership — `~/.pd/runtime` 是 PD canonical runtime

`~/.pd/runtime` 是本机上 **PD 唯一的 canonical runtime 位置**。它是当前 release 的呈现，不是一堆各自复制的目录集合。

**允许写入**：

- installer
- updater
- repair tool

**禁止直接修改 runtime**：

- Agent
- Adapter
- Console
- 用户脚本

**原因**：已发生 runtime artifact 被外部写坏的事件（2026-09-03 15:06，见 §1.1-1）。写入权限未定义前，任何只修文件、不修权限的方案都会被重演。

**配套不变式**：

- **零数据**：runtime 目录不得出现任何 `.db` / workspace 数据 / 用户配置（该不变式当前成立）。
- **违规应为显性失败**（EPERM 或完整性校验失败），而非静默覆盖。

---

### 2.2 Adapter Boundary — Host plugin = Adapter

宿主包是**适配器**，不是运行时。

适用范围：

- OpenClaw adapter
- Codex adapter
- future adapters

**Adapter 不拥有独立 governance runtime。**

**原因**：PD 的核心价值是**一个 Owner 原则治理多个 Agent**。若每个宿主携带独立治理运行时，则 N 个宿主 = N 份编排逻辑 = N 种治理行为——同一条原则在不同 Agent 下表现不同，这会直接摧毁 PD 作为治理系统的可信度。

**交付形态**（见 §2.3）：适配器允许 bundle isolation，但**必须**记录 runtime compatibility 与 artifact digest，使其版本身份仍可验证。

**当前已支持宿主**：`INSTALL_HOSTS = ['codex', 'openclaw']`。Claude Code**不是**已支持宿主（ADR-0020 §1 仅表述为 "anticipated"），其 hook 语义需先取证才能纳入本边界。

---

### 2.3 Dependency Strategy — Runtime 共享 / Adapter 隔离

采用**分层**策略，而非全局单一策略：

| 层 | 策略 | 要求 |
|---|---|---|
| **Runtime** | 单 release 内部**共享依赖** | 一次 release 内，同一依赖只允许一份权威副本 |
| **Adapter** | 允许 **bundle isolation** | **必须记录**：runtime compatibility + artifact digest |

**原因**：内部一致性（Runtime 层，共享依赖保证行为一致）+ 外部环境隔离（Adapter 层，bundle 保证不依赖宿主进程的模块解析能力）。

**推论**：当前 `openclaw-plugin` 的形态（内联 `@principles/host-runtime` 且 `bundle-plugin.mjs:386` 显式从清单删除该依赖）**不再可接受**——内联可以，但必须在发布元数据中登记所内联组件的 release 与摘要。

---

### 2.4 Core Position — `@principles/core` 是 PD Governance SDK

`@principles/core` 定位为 **PD Governance SDK / internal SDK**。

- 它是治理能力的**唯一实现**，不承担宿主协议职责（宿主协议在 Adapter 层）。
- 其 package.json 已声明 7 个子路径导出（`./runtime-v2`、`./trajectory-store`、`./principle-tree-ledger`、`./prompt-builder`、`./evolution-store`、`./quality-scorecard`、`./host`），导出面即契约。
- **不要创建重复 façade**：不新建 `packages/sdk` 包。按 AGENTS.md P7（禁止投机性抽象），当前只有一种实现，加壳只增加认知负担而不增加能力。

---

### 2.5 Version Identity Model — 三轴，废除混合版本

**废除**：多个 package version 混合作为产品版本的做法。当前 `pd version` 的产品版本取自宿主插件的 package.json（legacy 兜底分支），这是被废除的状态。

**定义三个版本轴**：

| 轴 | 面向 | 用途 | 示例 |
|---|---|---|---|
| **Product Version** | Owner / 用户 | 用户看到的版本 | `PD 2.0.0` |
| **Runtime Build ID** | 运维 / 排障 | 精确定位安装产物 | release 级标识，指向具体的 release 内容 |
| **Schema Version** | 数据 | 数据兼容判定 | 独立于前两者 |

**权威来源**：Product Version 与 Runtime Build ID 由安装状态（active release 记录）定义，组件 package.json 的 version 是**发布过程的输入**，不得充当产品版本。

**Schema Version 的作用**：判定 workspace 状态结构兼容性。release 元数据应声明其支持的 schema 范围；不匹配时必须走**显式、可回滚、有日志**的迁移，禁止静默改写。

---

### 2.6 Workspace State Strategy — 逻辑统一，暂不物理迁移

采用**逻辑统一**。暂不进行物理迁移。

**原因**：当前 workspace 包含四个状态根：

- `.pd` —— 治理配置与治理状态（config.yaml、state.db、telemetry）
- `.state` —— 轨迹与运行时状态（trajectory.db、blobs、principles、sessions、exports）
- `.principles` —— 身份（PROFILE.json、PRINCIPLES.md、THINKING_OS.md、DECISION_POLICY.json）
- `memory/` —— Agent 记忆（MEMORY.md、evolution.jsonl、okr、pain、logs）

其中**部分是 Owner 知识资产**（PRINCIPLES.md、THINKING_OS.md、MEMORY.md 由 Owner 直接读写）。物理迁移会改变这些文件的路径，打断 Owner 心智模型与既有工作流；且新旧版本运行时互访会产生**静默数据分裂**。迁移风险高。

**"逻辑统一"的含义**：建立单一路径权威（把散落的路径常量收敛为唯一解析入口，当前 `PD_DIRS` 位于 `openclaw-plugin/src/core/paths.ts` 且未被 host-runtime / pd-cli 普遍消费），要求所有读写路径经其解析，并阻止未登记的状态目录继续滋生。**物理目录结构维持不变。**

#### 2.6.1 Workspace 解析优先级 — PD canonical 优先于 host runtime workspace（修正案 2026-09-05，PRI-686）

**决策**：当 PD canonical workspace 与 host runtime 的工作区解析结果不一致时，**PD canonical 优先**——hook 与命令两条解析链（`resolveHookWorkspaceDir` / `resolveCommandWorkspaceDir` / `resolvePluginCommandWorkspaceDir`）统一采用：PD 显式来源（`PD_WORKSPACE_DIR` → `OPENCLAW_WORKSPACE` → `~/.openclaw/principles-disciple.json`）优先，host 会话上下文（`ctx.workspaceDir`）作为回退；分歧必须打告警，不得静默（rc-9）。

**理由**：PD workspace 是治理状态的唯一边界——`.pd`/`.state`/`.principles`/`memory/` 四个状态根共同构成治理事实的完整性单位，跨两个 workspace 分裂即分裂为两套治理状态。host runtime 的 workspace 语义（如 OpenClaw 2026.8/9 多 agent 布局将未钉定的 `main` agent 解析到 `<defaults.workspace>/main` 子目录）描述的是**会话运行位置**，不是治理状态归属；让它覆盖 PD canonical 会让 hook 写入与命令读取落到两棵状态树（2026-09-05 live incident：所有 pain 候选被 `needs_evidence/empty_trajectory` 门控，且无错误指向真因）。回归防线：`tests/integration/workspace-hook-command-convergence.test.ts`（hook 写 + 命令读同一真实 trajectory DB 的往返断言）。

---

### 2.7 Desktop Companion Boundary — 独立 release 生命周期

Desktop Companion 拥有**独立 release 生命周期**。

**职责**：

- 启动
- 监护
- UI shell

**不拥有** PD governance runtime。Companion 解析 runtime 位置、校验、拉起 console、监护与重启；不得嵌入任何治理逻辑，不得自带 core / plugin 副本。

**推论**：

- Companion 的版本号**不得代表产品版本**（现状日志中 `console_started version:"2.0.0"` 取自 plugin 包，属误用，应修正）。
- Companion 不是运行 PD 的必要条件；CLI 与宿主链路必须在其缺席时完整可用。

---

### 2.8 CLI Ownership — `pd` 是官方入口，只允许一个 canonical PATH 来源

官方入口命令：**`pd`**。只允许**一个 canonical PATH 来源**。

**清理 legacy PATH 属于后续迁移任务**，不在本 ADR 范围内执行。

**现状待办（属后续实施，非本 ADR 动作）**：当前实际存在分叉——npm 全局 `pd.cmd`（2026-09-01）指向已不存在的 legacy 路径，`~/bin/pd` 是安装器所有权之外的手工包装器，另有 decoy `openclaw.cmd`。收敛目标是让全新 PATH 解析链只有一条且指向 canonical runtime bin。

---

### 2.9 Runtime Integrity Strategy — 分阶段，Phase 1 warn-only

**Phase 1 — warn-only**

目标：发现以下情况并报告：

- runtime 文件变化
- artifact digest 不一致

**但不阻止启动。**

**Phase 2 — enforce**

经过迁移稳定后，**考虑**强制执行。

**为什么必须分阶段**：本机当前存在已损坏但系统仍能运行的 runtime 文件（`runtime/core/dist/index.js`、`runtime/plugin/dist/bundle.js` 为占位文本）。若立即 enforce，会先把可运行的安装变成不可启动的故障。且 Phase 1 之前不存在基线摘要，enforce 无对象可比。

**Phase 1 → Phase 2 的前提**（属实施计划，非本 ADR 决策）：基线已建立、观察期内零误报、损坏 artifact 已通过重铺消除。

---

## 3. Consequences

### 3.1 正向

- **写入边界闭合**：runtime 损坏事件从"可被静默重演"变为"违规即显性失败"（§2.1）。
- **治理行为一致性获得结构保证**：Adapter 不拥有独立治理运行时，"一个 Owner 原则治理多个 Agent"的核心价值不再依赖各宿主自觉遵守（§2.2）。
- **产品身份可回答**：三轴模型 + active release 权威，使"我装的 PD 是什么版本"有单一答案（§2.5）。
- **迁移风险被主动规避**：workspace 状态采用逻辑统一，避免物理移动 Owner 知识资产（§2.6）。
- **严格化不会自我伤害**：完整性校验分阶段，先建基线再谈 enforce（§2.9）。

### 3.2 代价与约束

- **分层依赖策略（§2.3）比单一策略复杂**：Runtime 层共享、Adapter 层隔离，意味着两套机制都要维护，且 Adapter 的摘要登记纪律成为新的正确性负担。
- **Adapter 的 bundle isolation 需要登记机制**：登记若缺失，bundle isolation 会退化回"内联且不可验证"的现状。
- **逻辑统一（§2.6）不减少目录数量**：备份、清理、卸载仍需处理多个物理位置，只是可由清单驱动。
- **Companion 独立生命周期（§2.7）意味着 Owner 需认知两个版本号**：产品版本与桌面外壳版本。需在 UI 上可解释，而非靠用户猜。
- **三轴版本模型（§2.5）要求废止现有 legacy 兜底路径**：`pd version` 从 legacy-overlay 切到 canonical 后，字段来源与 `health`/`source` 取值会变化，依赖旧输出形态的脚本需同步。

### 3.3 对现有代码的影响（属实施，非本 ADR 动作）

以下均已识别，**不在本 ADR 中执行**：安装器需开始生产 active release 记录；`openclaw-plugin` 的清单需登记被内联 host-runtime 的 release 与 digest；`PD_DIRS` 需从宿主适配器包下沉为唯一路径权威；完整性校验需要一个对外呈现面（当前 `pd doctor` 命令不存在，详见审查报告）。

---

## 4. Non-Goals

**本 ADR 不执行以下任何一项。** 它们属于后续 implementation tasks，需各自独立的实施计划与验收：

- ❌ **runtime 修复** —— 不修复被占位文本覆盖的 `runtime/core/dist/index.js`、`runtime/plugin/dist/bundle.js` 及被清空的 package.json
- ❌ **core 副本收敛** —— 不删除或合并任何 `@principles/core` 重复副本
- ❌ **plugin bundle 调整** —— 不改动 `bundle-plugin.mjs` 的内联/清单策略或插件打包方式
- ❌ **workspace 搬迁** —— 不移动、合并或重命名任何 workspace 状态目录
- ❌ **version migration** —— 不统一、不改写、不迁移任何现有版本号

此外，**本 ADR 不改动**：任何生产代码、`installer.ts`、`install-layout`、任何包的构建配置、任何运行时数据。

---

## 5. 决策证据记录（Owner 确认，ADR 由 Proposed → Accepted）

| 项 | 内容 |
|---|---|
| **裁决人** | Owner |
| **裁决时间** | 2026-09-04 |
| **裁决形式** | Owner 在会话中逐项给出 Decision 1 ~ Decision 9 的决定文本与原因，本 ADR §2.1 ~ §2.9 与之逐条对应 |
| **状态变更** | Proposed → **Accepted** |
| **Agent 角色** | 架构分析助手：核验事实、摊开选项与代价、执行 Owner 裁决的文档化。**未替 Owner 决策。** |

与会话内起草的 Proposed 草稿的差异（Owner 裁决优先于先前建议）：

| # | 先前的建议 | Owner 裁决 | 说明 |
|---|---|---|---|
| 依赖策略 | 全局 Bundle + Digest | **分层**：Runtime 共享 / Adapter 隔离 + 登记 | Owner 选择了更贴合两层不同诉求的方案 |
| runtime 写入者 | 仅安装器 | **installer / updater / repair tool** | Owner 扩充了合法写入者集合 |
| 版本轴命名 | Product / Component / Schema | **Product / Runtime Build ID / Schema** | 第二轴从"组件版本"改为"Runtime Build ID"，定位为精确标识安装产物 |

> 上述差异处**以本 ADR（Owner 裁决）为准**。
