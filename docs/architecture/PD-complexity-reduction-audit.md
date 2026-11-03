# PD 复杂度削减审计 — Phase 0（全仓只读扫描）

> 日期：2026-09-10
> 基线：`origin/main` `57f0dfebb`（本地工作树 `b789b4463`，二者差异仅限刚合并的 PRI-702/723/724 更新域；涉及该域的结论已按 origin/main 复核）
> 方法：只读扫描——标记统计（legacy/deprecated/fallback/compat）、体量热点、消费者追踪（importer 实证）、双实现 diff、flag 治理核对。**所有候选均经消费者验证，未采纳纯标记计数。**
> 本报告为审计产物，不改代码、不建 PR。
> 判断标准（任务给定）：**优先"删除后减少 AI 理解成本最大"的地方；目标降熵，不追求行数。**

---

## 1. 候选列表

| # | 模块 | 职责 | 当前实现数量 | 复杂度来源 | 风险等级 | 建议动作 |
|---|------|------|------------|-----------|---------|---------|
| C1 | runtime-v2 公共桶幽灵能力：`RuntimeSelector` / `workspace-guidance-migration` / `story-a-demo` | 三者均从 `runtime-v2/index.ts`（370 条导出）+ 根 `index.ts` 公开 | RuntimeSelector：1（纯接口，零实现零测试零消费者）；migration：1；story-a-demo：1（仅 pd-cli demo 命令） | ① `runtime-v2/runtime-selector.ts:11-12` 自述 "M1 ONLY: defines the interface. Implementation belongs to later milestones"——零实现的幽灵可插拔运行时抽象（`antipattern-future-extensibility` 实例）；② migration 模块是**一次性 AGENTS.md/THINKING_OS.md 正则改写器**，却挂在公共桶且被 plugin 启动热路径调用（`openclaw-plugin/src/index.ts:52`），永不退役；③ 演示脚手架混入产品语义 | 低（前两者零生产消费者；migration 是活行为，退役需确认） | **收敛（推荐下一工单）**：删 RuntimeSelector；退役/门控 guidance migration；story-a-demo 随 demo 命令决策去留或移出产品桶 |
| C2 | plugin legacy evolution worker 链 | 被 `features.evolution_worker.enabled` flag 门控的**历史并行执行管线**（Dreamer/Philosopher/Scribe 时代遗产，V2 内化管线的旧前辈） | 1（隔离态）+ 引用纠缠 | `openclaw-plugin/src/index.ts` 启动门 `shouldStartEvolutionWorker` + `evolution-worker.ts`(777) + `evolution-engine.ts`(613) + `evolution-reducer.ts`(882) + `evolution-logger.ts`(357) + `evolution-dedup.ts`(74) + `queue-io.ts`(120) + `queue-migration.ts`(153) ≈ **2,976 LOC**。纠缠点：活跃 hooks 仍用 engine 的 `getTier()`（`hooks/gate.ts:449`）与 `recordEvolutionSuccess/Failure`（`hooks/after-tool-call-helpers.ts:24`）。**该 flag 不在 core feature-flag 契约注册表内（旁路 flag）**；已有 `evolution-worker-quarantine/slimming` 测试证明收缩已开始 | 中（需要 1 个 Owner 决策：evolution 能力是否保留） | **分步退役**：先给 EP-tier/success 信号找新 owner（或确认随 worker 一起废弃），再删 worker 链 + 旁路 flag |
| C3 | trajectory 域三轨 | 会话/回合/工具调用/pain 事件的持久化与读取 | **3 套实现 + 2 个库** | ① `openclaw-plugin/src/core/trajectory.ts`(2054) 独占 trajectory.db 12 表 schema（唯一 writer，hooks 5 处写入）；② `principles-core/src/trajectory-store.ts` 是 SDK 提取版，**文件头自述 "Types (copied from trajectory-types.ts — do NOT import from openclaw-plugin)"——复制型第二事实（P4 违例）**，写同一库的 `sample_reviews`；③ `runtime-v2/store/trajectory/` locators 读的是 state.db（runs/tasks），与 ①② 同名不同库。消费者横跨 4 包（host-runtime 4 文件、pd-console models 3、pd-cli 4、core） | 高（数据迁移 + 跨包契约） | **立 SPEC 先行**：这是与 update 系统同量级的下一场收敛战役，不适合直接开工 |
| C4 | `workflow-funnel-loader` 双实现 | 读 `.state/workflows.yaml`（WORKFLOW_FUNNELS 定义表） | **2**：`openclaw-plugin/src/core/workflow-funnel-loader.ts`(195，自带 fs/yaml，非 re-export) vs `principles-core/src/workflow-funnel-loader.ts`(274) | 同一 YAML 读取器两套代码；core 版消费者仅 **1 个**（`pd-cli/src/commands/flow.ts`），plugin 用自己的副本；workflows.yaml 本身是 `.pd/config.yaml`（ADR-0016 单文件权威）之外的**第二个 YAML 状态面** | 低-中 | 合一到 core 单实现；中期评估整个 funnel 域是否已被 config.yaml 时代取代（plugin 版 D-01~D-04 注释与 CLI 侧 "replaces workflows.yaml reading" 语义已冲突） |
| C5 | pd-cli 命令面 | operator CLI | 68 个命令文件：16 `runtime-*`、8 `runtime-internalization-*`(2,972 LOC)、5 `codex-*`、~6 demo/lab | 面积大，但每个都是受 §10 CLI 契约保护的 operator 接口；demo/lab 命令（demo-story-a、mvp-smoke、runtime-synthetic-baseline、runtime-pain-flood-simulation、proven-channel-baseline）与生产命令混排 | 高（删=破坏外部脚本契约） | **不动注册**；仅在 `--help` 分组/文档中把 lab 类命令隔离命名 |
| C6 | 演化 lab 资产 | benchmark/仿真：`golden-trace*`(969)、`synthetic-baseline`、`proven-channel-baseline`、`pain-flood-simulation`、`mainline-snapshot` + pd-cli services 对应 runner | 各 1 | PRI-653/703 实验资产位于生产 src 与公共桶，语义上像产品能力 | 低 | 保留（Owner 实验在用）；若要减熵，集中到显式 lab 命名空间（低优先） |
| C7 | 配置域 | 用户配置/flag | 权威 1 套 | **已收敛良好，不构成候选**：ADR-0016 单文件 `config.yaml`（792 处引用）；旧 `feature-flag-loader.ts`/`workflows.yaml` CLI 读取已删（`pd-cli/src/services/pd-config-loader.ts:9`）；`.pd/feature-flags.yaml` 已 cutover（PRI-305）；plugin 侧 `core/pd-config-loader.ts`(97) 是 host-runtime 共享 loader 的薄 facade。残余尾巴：`principles-disciple.json`（installer 域，ADR-0023 管）+ `evolution_worker` 旁路 flag（归 C2） | — | 无需行动（尾巴并入 C2） |
| C8 | update 域 | 安装/更新/历史 | — | PRI-659/664/702/724 刚收敛，PRI-729 进行中；`create-principles-disciple/src/update/release-manager-authority.ts` 仍留 ADR-0024 D-1 "TEMPORARY migration debt" 注记 | — | 观察期，**不要碰**（与 PRI-729 撞车） |

---

## 2. Top 5 收敛机会（按收益/风险比排序）

### T1. runtime-v2 公共桶收敛（C1）——收益/风险比最高
- **收益**：`runtime-v2/index.ts` 是全部 AI 任务与开发者的第一入口。370 条导出中混着三类"幽灵能力"：宣称存在可插拔运行时（RuntimeSelector，67 行纯接口、零实现、零测试、零消费者）、宣称存在常驻迁移系统（workspace-guidance-migration，241 行硬编码正则文档改写器，且在 plugin 启动热路径上每次跑）、宣称存在产品级演示管道（story-a-demo）。这些名字直接制造 AI 误判（例如把 RuntimeSelector 当成真实的多运行时机制来"接线"）。删除后第一入口显著降噪。
- **风险**：低。零消费者纯删除有 `barrel-io-cleanup.test` + `architecture-regression.test`（4,333 行护栏）保护网；migration 是唯一活行为，退役前需 Owner 一句话确认（AGENTS.md 清理规则早已是历史纪元产物——规则内容是删除 "PLAN.md (status: READY)" 这类远古引用）。
- **形态**：与 PRI-636 Wave 1（D0 死代码删除，+24/−2031）同型的 Wave 2，先例与手法齐备。

### T2. legacy evolution worker 退役（C2）——与 update 系统最同构的历史并行机制
- **收益**：删除一条完整的、被 flag 门控的历史并行执行管线（≈2,976 LOC + 旁路 flag + 永不迁移的 queue-migration）。这是全仓最接近"update 系统式收敛"的目标：新旧两代执行管线并存，旧代靠 flag 隔离但整链仍在编译面、测试面、AI 理解面里持续收税。
- **风险**：中。engine 与活跃 hooks 纠缠（gate 的 EP-tier、after-tool-call 的 success/failure 记录），必须先决定这两个信号的归宿；`evolution_worker` 默认行为需在决策中一并裁定。
- **前置**：1 个 Owner 决策（evolution 能力还要吗？EP tier 信号新 owner 是谁？）。决策后即可立单执行。

### T3. workflow-funnel-loader 合一（C4）
- **收益**：消灭同业务双实现 + 暴露"workflows.yaml 是否还有存在必要"这个被掩盖的问题（CLI 侧已宣告被 config.yaml 取代，plugin 侧注释仍称其为 SSOT——两侧叙事已经打架）。约 −470 LOC + 一个 YAML 状态面。
- **风险**：低-中。消费者极少（core 版 1 个命令、plugin 版内部数处），行为可用现有测试覆盖。

### T4. trajectory 三轨收敛 SPEC（C3）
- **收益**：全仓最大的一块双库双写熵（trajectory.db vs state.db + 复制类型），收敛后 pain/会话/内化的数据叙事归一。类比：update 系统之于一堆并行更新器。
- **风险**：高（数据迁移、4 包消费者、生产 hooks 写入路径）。**必须 SPEC 先行**，本审计不建议直接开工；但建议现在立 SPEC 占位，避免 lab 资产继续围绕旧库长出新依赖。

### T5. lab 资产命名空间隔离（C6）
- **收益**：中低。golden-trace/synthetic-baseline/proven-channel-baseline/pain-flood-simulation 各有 1 实现且 lab 消费者在用，问题是位置而非数量——它们混在产品 src 里让 AI 高估其产品地位。
- **风险**：低。纯移动 + 导出面调整，但收益也有限，排最后。

---

## 3. 推荐下一任务

**推荐创建 Linear 工单：`runtime-v2 公共面收敛——删除幽灵能力与退役永续迁移`（即 T1 / C1）**

内容边界（一个工单一件事，遵守 P3）：
1. 删除 `runtime-v2/runtime-selector.ts`（67 行，纯接口零实现，公共桶导出一并移除）；
2. 退役 `workspace-guidance-migration`：从 plugin 启动热路径摘除 + 从公共桶移除（需 Owner 确认 AGENTS.md 文档清理使命已完成；若 Owner 要求保守，可降级为"运行一次后自禁用"）；
3. 将 `story-a-demo` 与 `golden-trace` 家族的桶导出收窄（实现保留、语义隔离到 lab 子路径导出）。

**为什么现在做：**
- 更新域刚被 PRI-702/724/729 连续收敛，演化域完全无人占用；唯一开放 PR #1594（EE-v2）在 error 域——**零撞车**。
- 它是 PRI-636 Wave 1 的直接延续，手法（census → 删 → 护栏重跑）与保护网（architecture-regression 4,333 行、barrel-io-cleanup 测试）都是现成的，交付确定性最高。
- 公共桶熵减对所有后续 AI 任务产生复利：每一个误读 RuntimeSelector 或把 migration 当常驻系统的会话都在重复缴税。

**预计删除的复杂度：**
- 生产代码约 −600 行（selector 67 + migration 241 + story-a-demo 桶面 291 的导出收窄 + 测试相应清理）；
- 公共桶 370 条导出减约 15~25 条（含类型导出）；
- **主要收益不在行数**：消除 3 类"名字暗示存在、实际不存在/不该存在"的机制，这正是 AI 理解成本的最大来源。

**风险：**
- migration 摘除改变 plugin 启动行为（老 workspace 里若仍有 "PLAN.md (status: READY)" 类远古文本将不再被自动改写）——影响面是文档内容，不是运行时数据；Owner 确认后即可关闭。
- story-a-demo 若 Owner 仍要 demo 命令，则只做导出收窄不删实现——零行为变化。
- 删除类改动按 §18 默认保守：全部走 git 历史可回滚，无数据迁移。

**第二梯队（本审计同时建议登记，但不在本工单内）：**
- T2 evolution worker：挂起等 1 个 Owner 决策（evolution 能力去留 + EP tier 信号归宿），决策后立独立工单；
- T4 trajectory：立 SPEC 工单占位（不实现）。

---

## 4. 不建议动的模块

| 模块 | 为什么不能动 |
|------|------------|
| `runtime-v2/internalization/`（evaluator-runner 3,300 / rollout-reviewer-runner 1,727 / artificer-runner 1,110 / base-peer-runner 1,462） | 活跃生产心脏，PRI-625/653/703 主战场；大体积来自真实分支复杂度而非历史冗余 |
| `runtime-v2/activation/` + writers | 核心产品能力（可逆激活）；已知存在未修的注入缺口类问题，任何重构都会放大风险 |
| `host-runtime/src/governance-signal-admission.ts`(1,165) / `governance-observation-store.ts`(1,137) | 活跃 pain 准入链（`production-pain-evidence.ts` 直接消费），与 core 的 governance-experience/projection 是不同层职责，**不是重复实现**（已核实消费者） |
| `create-principles-disciple/src/installer.ts`(3,364) + `src/update/` + `pd-console` update 域 | ADR-0023/0024 + PRI-659/664/702/724 刚收敛、PRI-729 进行中——观察期内重切一刀等于推翻刚落地的权威收敛 |
| `pd-console/src/ui/utils/validators.ts`(3,124) | 大但活：UI 响应校验契约的集中地；收敛它是 PR 宽化，不是减熵 |
| plugin `session-tracker` / `event-log` / `focus-history` / `rule-host` | 均为活跃 hooks 多 importer（已逐一核实），体积来自真实职责；它们与 C2 的纠缠点只在 engine，不在这些文件 |
| `pd-cli` 68 命令注册面 + 8 个 `runtime-internalization-*` | §10 CLI 契约；删除/合并破坏 operator 脚本，收益远低于风险 |
| `io-seam-registry.json` 机制 + `architecture-regression.test.ts`(4,333) | 保护性资产本身；§20 明确 guards 保护的是不变量，不应为减熵而减护栏 |
| 平铺 core store 中已被 PRI-459 收敛的 `principle-tree-ledger` | plugin 侧已是 re-export 适配（75 行），双轨已消除，无残留问题 |

---

## 附：证据索引

- 幽灵接口：`packages/principles-core/src/runtime-v2/runtime-selector.ts:11-12`（"M1 ONLY… Implementation belongs to later milestones"）；消费者扫描仅命中 `runtime-v2/index.ts` 与根 `index.ts` 两处 re-export；`-g "*.test.ts"` 零命中。
- 复制类型：`packages/principles-core/src/trajectory-store.ts:13-15`（"copied from trajectory-types.ts — do NOT import from openclaw-plugin"）；plugin schema 12 表见 `openclaw-plugin/src/core/trajectory.ts`；v2 locators 读 `runs/tasks`（state.db）见 `runtime-v2/store/trajectory/sqlite-trajectory-locator.ts`。
- 演化 worker 门：`openclaw-plugin/src/index.ts`（`shouldStartEvolutionWorker` + "legacy evolution worker" 注释 + `features.evolution_worker.enabled`）；旁路 flag 实证：`evolution_worker` 在 `runtime-v2/config/pd-config-defaults.ts` 与 `feature-flags/feature-flag-contract.ts` 中零命中。
- engine 纠缠：`openclaw-plugin/src/hooks/gate.ts:449`（`getEvolutionEngine` → `getTier()`）、`hooks/after-tool-call-helpers.ts:24`（recordEvolutionSuccess/Failure）。
- 双 funnel loader：`openclaw-plugin/src/core/workflow-funnel-loader.ts`（195 行，直接 import fs/yaml，零 `@principles/core` 引用）vs `principles-core/src/workflow-funnel-loader.ts`（274 行）；core 版唯一外部消费者 `pd-cli/src/commands/flow.ts`。
- 永续迁移：`openclaw-plugin/src/core/workspace-guidance-migrator.ts:139`（调 core `migrateWorkspaceGuidance`）；规则内容见 `runtime-v2/workspace-guidance-migration.ts:23-40`（删除 "PLAN.md (status: READY)" 等远古引用）。
- 配置收敛现状：`pd-cli/src/services/pd-config-loader.ts:9`（"replaces the old feature-flag-loader.ts and workflows.yaml"）、`runtime-features.ts:3`（"Cutover from .pd/feature-flags.yaml to .pd/config.yaml"）、`openclaw-plugin/src/core/pd-config-loader.ts:2`（"compatibility facade for the shared production PD config loader"）。
- update 域遗留注记：`create-principles-disciple/src/update/release-manager-authority.ts`（"TEMPORARY migration debt per ADR-0024 D-1"）——归 PRI-729 处理，本审计不动。
