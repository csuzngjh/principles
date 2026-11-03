# PRI-751 AI Developer Complexity Audit

> 日期：2026-09-12
> 基线：`origin/main` `4dce7d942f00039113b698de2a5b27025b9a3fa6`（2026-09-12，PR #1616 合并态；已导出为独立只读副本审计，未受主 checkout 暂存改动污染）
> 性质：**只读审计**。不改代码、不建 PR、不动 Linear 状态机（仅按任务书要求登记工单）。
> 方法：Reality Audit First——不信文件名、不信注释、不信历史 SPEC；全部结论经 importer / consumer / runtime wiring 实证（`rg` 消费者扫描 + 入口点接线追踪 + 关键论断二次抽查）。5 路并行扫描：Ghost Capability / Duplicate Authority / Data Model / Dead Config / Danger Zones + Concept Map。
> 范围：`packages/`（10 包）、`scripts/`、`docs/architecture/`、根 `AGENTS.md`/`MEMORY.md`、package.json exports、feature flags、runtime entry。不含 node_modules / dist / 测试生成物。
> 前序：本文是 `PD-complexity-reduction-audit.md`（Phase 0，2026-09-10，基线 57f0dfebb）之后的**收敛后复审**。Phase 0 的 T1（runtime-v2 公共面）/T2（evolution worker 退役）此后已由 PRI-730/737 部分落地，本文验证落地后残留，并回答任务书 Q1–Q6。
> 证据局限：导出名计数为正则近似（±5%）；行号以基线副本为准，与 origin/main 逐字节一致。

---

## Executive Summary

**当前 AI 最大理解成本不在"新架构学不会"，而在"删除之后的残余"与"未收敛的双写"。** Evolution worker 已被 PRI-737 删除，但它的 flag、14 个类型、双桶导出、SQLite 表、feature-test 场景、甚至仓库根 `MEMORY.md` 的"正确设计"章节仍然留在仓库里教 AI 一个不存在的服务；trajectory 域三轨并存且存在 `.state/.trajectory.db`（点前缀）死读——`pd evolution tasks list` 永远读到空库；`runtime-v2/index.ts` 以 2161 行暴露约 1792 个导出名，是全仓第一入口也是最大噪声源；另有 5 份导航文档在陈述与代码相反的事实。对 AI 而言，"名字存在 ⇒ 能力存在"这个默认推断在本仓当前失败率很高。

---

## 1. Complexity Scorecard

| 维度 | 评分 (/10) | 依据 |
|---|---|---|
| 单一权威（install/update 域） | **7.5** | ReleaseManager + MutationController 已收敛为单入口（`pd-console/src/server/update/mutation-controller.ts`，`routes/update.ts:2300-2311` 按 readiness 分流）；legacy inline updater 2386 行仍共居 `routes/update.ts` 一文件，属设计内 fail-loud 兜底（观察期，勿动） |
| 数据模型一致性 | **3.5** | trajectory 三轨并存（`openclaw-plugin/src/core/trajectory.ts:160-330` 16 表 DDL vs `principles-core/src/runtime-v2/pain-signal-observability.ts:100-168` 复制 DDL vs runtime-v2 locator 读 state.db）；点前缀死读（`principles-core/src/trajectory-store.ts:46`、`evolution-store.ts:56`）；pain 单次检测三写（`openclaw-plugin/src/hooks/gate-block-helper.ts:200-202`） |
| 公共 API 面清晰度 | **4** | `runtime-v2/index.ts` 2161 行 / ~1792 个导出名（Phase 0 基线时 ~1800，**持平未再增长**）；其中混有零消费者家族（trace-refiner、golden-trace replay、queue brand types、evolution types 双桶）；`principles-core/src/index.ts` 另有 ~197 名 |
| Feature flag / Config 卫生 | **6** | 47 个 flag 全部注册于 contract（`feature-flag-contract.ts`），抽样未发现旁路 flag；但存在死 flag（`empathy_observer`）、僵尸 kill-switch（`painEvidenceAdmission*`，回滚路径已删）、死 schema 字段（`contextInjection.evolutionContext`）与死脚本目标（`ai-sprint`） |
| 导航文档可信度 | **3** | `CONFIGURATION_ARCHITECTURE.md`（多层 config 方案不存在于代码）、`DATA_ARCHITECTURE.md`（authority 文件路径不存在、表清单与真实 DDL 不符）、`pd-task-manager.md`（状态过时）、`USER_GUIDE.md:208`（把死 flag 当活子系统）、根 `MEMORY.md:30-57`（教 AI 验证已删除的 EvolutionWorker） |
| 演化域清理完成度 | **8** | worker/engine/reducer/queue-migration 代码已删净（PRI-737/731），残余收税点集中于类型桶、flag、表、测试场景与文档（见 §2/§5） |

---

## 2. Ghost Capability

**好消息先说：任务书示例 `RuntimeSelector` 已不存在**——`rg "RuntimeSelector"` 在代码零命中，仅存于 `docs/architecture/PRI-730-runtime-v2-surface-convergence-audit.md` 的审计记述（`pd-console` 的 `DefaultRuntimeSelector` 是无关 UI 局部函数，子串误报）。PRI-730 已把它清干净。以下是目前仍然存在的幽灵：

| Symbol | Location (file:line) | 类型 | Why misleading | 消费者证据 | Conf |
|---|---|---|---|---|---|
| `evolution_worker` flag 条目 | `principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts:240`（lifecycle `feature-flag-lifecycle.ts:104`） | 零实现 | flag 契约+lifecycle 元数据仍在，但读取方/启动门已随 PRI-737 删除；`openclaw-plugin/src/index.ts:329-330` 注释自证"retires under a separate change" | `rg evolution_worker`（非测试非文档）→ 仅 contract/lifecycle/UI 标签/文档；`rg "readFlag.*evolution_worker"` → 0 | H |
| `service:evolution-worker`、`startup:evolution-worker` 插件面 | `feature-flags/plugin-surface-registry.ts:92,142` | 零实现 | surface registry 宣称存在两个已不存在的插件服务面 | `rg "EvolutionWorkerService\|registerEvolutionTaskSession" packages/` → 0 代码命中 | H |
| Evolution Points/Tier 子系统（14 个导出符号） | `runtime-v2/evolution/evolution-types.ts:37-380`；双桶导出 `runtime-v2/index.ts:1585-1662` + `openclaw-plugin/src/core/evolution-types.ts:23-61` | 零消费者/零实现 | `TIER_DEFINITIONS`/`getTierDefinition`/`EvolutionScorecard`/`EvolutionStorage`/`DEFAULT_EVOLUTION_CONFIG` 等构成一个"打分系统"的完整类型面，引擎已删；`EvolutionStorage` 无任何 `implements`。生产代码唯一接触点是 `hooks/gate.ts:449-452` 返回硬编码 `EvolutionTier.Seed` 的 stub | 逐符号 `rg`（剔定义/桶/测试）→ 0；`rg "implements EvolutionStorage"` → 0 | H |
| `scripts/pipeline-health.ts` 的 `evolution_queue` 阶段 | `scripts/pipeline-health.ts:61,332,640,769,820,966,1010,1239,1287` | 零运行入口 | 脚本本身无任何调用方；且健康报告盯着 `.state/evolution_queue.json`——worker 删除后零 producer 的死工件（PRI-736 审计已判"structurally dead"） | `rg -l "pipeline-health" -g '!*.md'` → 仅自身；queue 文件仅测试 fixture 写 | H |
| `evolution_queue.json` 快照收集 | `scripts/collect-control-plane-snapshot.sh:114`、`.ps1:71` | 零消费者 | 证据收集器拷贝一个不再被产生的工件（`copy_if_exists` 守卫故无害但误导证据包） | 同上零 producer | M |
| `QueueItemId`/`WorkflowId`/`Brand` 队列品牌类型 | `runtime-v2/types/queue-types.ts`；导出 `runtime-v2/index.ts:1720` + `types/index.ts:75` | 零消费者 | 已删 queue-io 域的品牌类型；唯一 importer 是死壳 `openclaw-plugin/src/types/queue.ts`（自身零 importer） | `rg "\bQueueItemId\b\|\bWorkflowId\b"` → 定义+2 桶+死壳 | H |
| `refineFullTrace`/`REFINED_EVENT_KINDS`/`TraceRefinerAgent` | `runtime-v2/trace-refiner.ts:22-176`、`trace-refiner-agent.ts`；经公共桶导出 | 零消费者 | 文件头宣称"consumed by Diagnostician and downstream L2 components"——**与事实相反**，无任何 import | 逐符号 rg（剔测试/桶/自身）→ 0 | M |
| GoldenTrace replay 家族：`replayGoldenTrace`/`replayValidateCode`/`SandboxEvaluateLoader`/`diffParams` | `runtime-v2/golden-trace-replay-adapter.ts`、`golden-trace-replay-validator.ts:285`；导出 `runtime-v2/index.ts:1569-1585` | 零消费者 | PRI-115 的 replay-validator/adapter 以产品 API 姿态导出，唯一 importer 是桶自身。（golden-trace 其余部分是活的：fixture→compiler.ts:303、`buildGoldenTraceFromArtificer`→pd-cli rulecode.ts:339） | `rg -l "golden-trace-replay-adapter\|replayGoldenTraceCases"`（剔测试/桶）→ 0 | M |
| `STALE_PLAN_MD_PATTERNS` | `runtime-v2/workspace-guidance-migration.ts:138`；桶导出 `index.ts:439` | 仅测试消费 | 模式表被桶导出，生产只用 `migrateWorkspaceGuidance` | `rg` → 定义+桶 2 命中 | M |
| `evolution-worker` feature-test 场景 | `tests/feature-testing/framework/test-scenarios/evolution-worker.json`、`pain-evolution-chain.json:20-369` | 文档型幽灵 | 场景指示测试 agent 去验证一个**不可能存在的** "EvolutionWorker service/process"——AI 驱动的特性测试会被主动带偏 | `rg "EvolutionWorker" tests/feature-testing/` → ~20 处引导文本；代码 0 | H |
| 根 `MEMORY.md:30-57` EvolutionWorker 章节 | 仓库根 `MEMORY.md` | 文档型幽灵 | 以"正确设计 (PR #290 已实现)"名义教 AI 验证已删除的服务，含对已删 dist 的 grep 验证命令 | `rg "EvolutionWorker" MEMORY.md` → 8 命中；代码 0 | M |

> 注意区别：`evolution_tasks`/`evolution_events` 表与 `pd evolution tasks list|show` 命令**不是** worker 残余的活能力——表仍在被创建（`trajectory.ts:299`）但写入方 `recordEvolutionTask` 零调用（见 §4/§5）。Dreamer/Philosopher/Scribe 是内化管线生产 runner（`host-runtime/src/internalization-consumer-cycle.ts:330,544-556`），**不是** worker 残余，勿混删。

---

## 3. Duplicate Authority

| Concept | 多个所有者 (file:line) | 真实所有者（接线证据） | Risk | Conf |
|---|---|---|---|---|
| Update 变更权威 | `pd-console/src/server/routes/update.ts`（legacy inline updater，2386 行）vs `create-principles-disciple/src/update/release-manager.ts:279` | 单入口 `pd-console/src/server/update/mutation-controller.ts`（按 `X-PD-Mutation-Authority` 分流）；`check`+`apply-full` 走 ReleaseManager（routes/update.ts:2300-2311，flag `release_manager_write_authority` 已毕业 default-on）；`apply`+`rollback` 结构性未就绪（`plugin_diff_not_supported`/`rollback_not_available`）→ 按设计回落 legacy | AI 在错误一侧"修 update 行为"→ 改动永不执行；分流理由是 fail-loud 的，但需要先读懂 mutation-controller 才不会误判 | H |
| Update history | console `routes/update-history.ts` vs cpd `src/update/update-history.ts` | console 是唯一读写方（server/index.ts 接线）；cpd 副本**零生产 import** | AI"补完"孤儿模块→ 长出第二历史流 | H |
| Config 读取 | core 语义权威 `principles-core/src/runtime-v2/config/*`；IO 壳三份拷贝：`pd-cli/src/services/pd-config-loader.ts:110`、`host-runtime/src/pd-config.ts:75`、`pd-console/src/server/config/pd-config-store.ts:248`（plugin facade 委托 host-runtime） | 语义（validate/defaults/flags）单归 core；但 read→parse→validate→fallback 骨架被复制 3 份（各自内联 js-yaml），pd-cli 版还多一段 legacy-file 检测（pd-config-loader.ts:78-86） | 一个壳修了 path-security/fallback bug，另两个面静默分歧；未发现 parity 测试 | H |
| Pain 准入（`pain_events` 写入方） | A: `host-runtime/src/governance-signal-admission.ts:475,669,871`（codex 路径）；B: `host-runtime/src/production-pain-evidence.ts:299,396`（裸 SQL，flag `abstraction_layer_v1` 门控，默认 OFF，`openclaw-plugin/src/index.ts:140-159`）；C: plugin `hooks/pain.ts:228`→`PainToPrincipleService.recordPain`；D: pd-cli `pain-record.ts:368` | 编排权威 = `PainToPrincipleService.recordPain`（plugin/CLI/codex-admission 都汇入）；B 是 flag 门控的**第二 SQL 写入方** | 两套准入栈（cooldown/dedupe/evidence shaping）并存；给 pain 事件加字段必须同时改两处 SQL 写入方，否则 flag 翻转时丢数据 | H |
| Diagnostician 工件存储 | `runtime-v2/internalization/diag-router-runner.ts:298,317,346` 同一任务双写：legacy `artifacts`+`commits`+`principle_candidates` **和** `artifactStore.upsertArtifact`→`pi_artifacts` | 今天是**真实双写**（与 `docs/specs/diagnostician-artifact-store-convergence.md` 一致；"canonical=pi_artifacts"是待 Owner 审的提案，未实施）；其余 8 个 stage 只写 pi_artifacts | AI 把任一表当"唯一存储"：读 legacy 会漏 8 个 stage；删 legacy 写入会静默断掉仍消费它的 intake/读模型 | H |
| 内化 task 状态 | runtime-v2 `tasks` 表（`store/task/sqlite-task-store.ts:107`，唯一管线写方）vs plugin `PDTaskService`（`.state/pd_tasks.json`+cron jobs，`pd-task-service.ts:6-27`，**名字撞车、职责不同**）vs plugin `trajectory.ts:299,909` 的 `evolution_tasks`（v1 遗留事件日志） | 内化管线 = sqlite-task-store；PDTaskService = cron 调度；evolution_* = 仍活跃写入但无生产入队的遗留账本 | "task store" 一搜三店；AI 给 pd_tasks.json 加状态机 expecting 管线语义 | H |
| 版本 stamp | 写：installer（`installer.ts:317-332,3151,261`）+ `src/update/release-metadata-publisher.ts`；读：`pd-cli/src/services/version-report.ts`（thin reader）、`pd-console/src/server/utils/installed-layout.ts:134` | 单写链 = installer（ReleaseManager apply-full 驱动）；console 读已部署 payload 是**有意**的第二口径（更新前置比对用） | AI"统一"两个读口会破坏更新前置条件 | M |
| Workspace 解析 | `pd-cli/src/resolve-workspace.ts:76` vs `openclaw-plugin/src/utils/workspace-resolver.ts:51,110,195,303,391,432` vs console（注入制，server/index.ts:260） | 每宿主一个权威（宿主上下文本质不同：hook ctx vs CLI flag vs 启动注入），plugin 的 6 个 resolver 是同一文件内分层变体 | 跨面"简化合并"会不兼容；中风险 | M |

**已验证单一权威（无需行动）**：update 入口（MutationController 唯一路由）、CLI 无竞争更新器、feature flag contract（抽样所有读取路径均回归 registry，无旁路 flag）、config 语义层、plugin config facade 委托、pd-console 单一组合根（`server/index.ts:260,265,612`）。PRI-659/PRI-729/PRI-661 文档与代码相符（唯一细化：PRI-729 结论"4 类全走 legacy"只对缺 release-metadata/journal readiness 的安装成立，ready 安装已路由 ReleaseManager）。

---

## 4. Data Model Confusion

**一句话结论：`trajectory` 这个词横跨两个数据库三种角色，且其中一条轨因文件名差一个点号而永远读空。**

| Concept | Storage | Writer | Consumer | Authority | 风险 |
|---|---|---|---|---|---|
| Task/Run（运行时任务） | `<ws>/.pd/state.db` `tasks`/`runs`（`store/sqlite-connection.ts:224,259`） | `SqliteTaskStore`/`SqliteRunStore`（经 `RuntimeStateManager:101` 接线） | history-query、operator-health、pd-console 治理模型 | **state.db** | L |
| Trajectory（运行引用） | 名为 trajectory 实为读 state.db（`store/trajectory/sqlite-trajectory-locator.ts:30`） | —（只读 locator） | source-trace-locator、context payload | state.db | M（名字误导） |
| Trajectory（原始证据） | `<ws>/.state/trajectory.db` 16 表（DDL 单源 `openclaw-plugin/src/core/trajectory.ts:160-330`） | `TrajectoryDatabase`（trajectory.ts:573-915）；**第二写方** `principles-core/src/runtime-v2/pain-signal-observability.ts:376-395` 自带复制 DDL（:100-168）写同一文件；host-runtime 另写 `governance_*` 表（`governance-observation-store.ts:338`、`governance-signal-admission.ts:348`） | plugin 各 context assembler、pd-cli pain-list/build-trajectory-evidence/quality-scorecard、pd-console EvidenceChain | trajectory.ts DDL 为权威 | **H**（双 DDL 双写方，漂移只差一次编辑；`schema-orphan-detection` 守卫只扫 state.db，trajectory.db 无护栏） |
| Trajectory types/stores（core 复制轨） | `principles-core/src/trajectory-store.ts:46`、`evolution-store.ts:56` 打开 `<ws>/.state/.trajectory.db`（**点前缀文件名**） | trajectory-store.ts:139,149（review 写） | `pd-cli evolution-tasks-list/show`、correction-sample SDK → **永远读到不存在的文件** | 无（断轨） | **H** |
| Session | trajectory.db `sessions` + `.state/sessions/` 目录（`paths.ts:37`） | hooks + SDK | pain-record ingestion、证据构建 | trajectory.db | M（"session"两个含义） |
| Pain | trajectory.db `pain_events`（trajectory.ts:221） | 单次检测**三写**：trajectory.db + `memory/evolution.jsonl` + `events_*.jsonl`（`gate-block-helper.ts:200-202`；JSONL 自我定位 debug 级） | pd-cli pain 系列、pd-console EvidenceChain | trajectory.db | M |
| Pain diagnosis | state.db `pain_diagnoses`（sqlite-connection.ts:678），flag 门控默认 OFF | `sqlite-pain-diagnosis-store` | dogfood metrics 脚本 | state.db | M（静默空表） |
| Decision/Approval/Receipt/Candidate/Intent | state.db 各表（`sqlite-connection.ts:350,395,463,502-568,594,626`） | 各 sqlite store（approval CAS、console_token 决策链） | pd-console 各 ConsoleModel | **state.db** | L |
| Principle/Rule/Impl 生命周期 | **JSON 账本** `<ws>/.state/principle_training_state.json`（`principle-tree-ledger.ts:62`，`mutateLedger` 单写契约:157）——**不在 state.db** | CandidateIntake/ChannelWriter/ActivationDispatcher/plugin 命令 | prompt 写入方、读模型、milestone-readers | 账本 | L |
| Evolution queue | trajectory.db `evolution_tasks`/`evolution_events`（trajectory.ts:299,320） | `recordEvolutionTask` 等（trajectory.ts:798,844,906）**零生产调用方**（worker 已删） | quality-scorecard `data-extractor.ts:54`（读历史行，活）；pd-cli evolution-tasks cmds（点前缀死轨） | **孤儿**：DDL+写 API 保留，无生产入队 | **H** |
| Event/遥测（四层） | (a) `events_<date>.jsonl`（`event-log.ts:42,69,784`）；(b) trajectory.db 事件性表；(c) state.db receipts；(d) website Cloudflare D1 `product_telemetry_daily`（`website/migrations/0001:8`，host-runtime exporter POST） | hooks/ledger/exporter 各管一层 | console/pd-cli/website 各读对应层 | 按用途分治（receipts=state.db、debug=jsonl、聚合=D1） | M（pain 三写造成 a+b 重叠） |
| Governance（codex） | trajectory.db `governance_*` 表（**不在 state.db**，`governance-signal-admission.ts:307,326`） | host-runtime admission/observation store | pd-cli codex-* 命令 | trajectory.db | M（落点反直觉） |
| Workflow | **无存储**。`.state/workflows.yaml` 已不被读（`scripts/verify-config-cutover.mjs:21,51`）；`initWorkflowSchema` 仅存于陈旧注释（`installer.ts:1693`、`scripts/bundle-plugin.mjs:463`） | — | — | n/a | M（注释说谎） |
| Config | `.pd/config.yaml` 单文件（ADR-0016）；`.pd/feature-flags.yaml` 已死 | slash commands、console WorkspaceService | 所有 feature 门 | config.yaml | L |
| Workspace JSON 杂项 | `.state/WORKBOARD.json`、`AGENT_SCORECARD.json`、`pain_candidates.json` 等（`paths.ts:36-77`） | plugin init/hooks | plugin hooks、config-doctor | 逐文件 | M（`WORKBOARD.json` 未发现生产读写方，疑似孤儿） |

**"我需要 X → 摸哪个库"速查（按现实，非按文档）**：任务/审批/决策/回执/候选/intent → `.pd/state.db`（只经 `@principles/core` store 类）；"会话里实际发生了什么"（turns/tool calls/pains/gate blocks/governance）→ `.state/trajectory.db`（schema 只认 `trajectory.ts` 的 `applyTrajectorySchema`）；Principle/Rule 状态 → `.state/principle_training_state.json` 账本；flag/宿主策略 → `.pd/config.yaml`；跨 workspace 聚合 → website D1（本地只许派生，参照 milestone-readers 模式）。

**双重真相 / 孤儿 / 死读清单**：
1. trajectory.db **DDL 双写**（trajectory.ts:160 vs pain-signal-observability.ts:100-168，同步靠人肉注释 trajectory.ts:151-153,351）；
2. **点前缀死读**（`.trajectory.db` vs `trajectory.db`）——`pd evolution tasks list/show` 与 correction-sample SDK 恒空（ADR-0023-review F13、PRI-736 §7 已记录，基线 4dce7d94 **仍未修**）；
3. **孤儿队列**（evolution_tasks/events：DDL+写 API 在、零入队）；
4. pain **三写**（1 检测 3 落点）；
5. **复制类型**（`trajectory-store.ts:12`/`evolution-store.ts:22-43` "do NOT import from openclaw-plugin"——P4 复制型第二事实）；
6. `DATA_ARCHITECTURE.md` 六处失真（authority 路径不存在、表清单错、`audit-log.jsonl`/AuditLogger 代码零命中、`pain_signals` 表不存在等）；
7. `WORKBOARD.json` 疑似孤儿；
8. `MemoryTaskStore`/`MemoryRunStore` 导出完整但生产恒用 SQLite（测试用，非第二真相）。

---

## 5. Dead Configuration

Flag 总量：contract 注册 **47 个**（`DEFAULT_FEATURE_FLAGS`，`{ id: '` 计数）+ 2 个 snake_case alias；lifecycle census 28 KEEP_QUIET / 0 RETIRE；全量消费路径扫描（isFeatureEnabled/flags.X/loadFeatureFlagFrom*）**未发现旁路 flag**——所有读取均回归 registry（Phase 0 的 C7"配置域已收敛"结论在基线 4dce7d94 仍成立，残余如下）。

| Candidate | Location (file:line) | 证据（搜索→命中） | Conf | 分类 |
|---|---|---|---|---|
| flag `empathy_observer` | `feature-flag-contract.ts:241` | 非测试 rg → 仅 UI 标签/展示；检测已移 `SignalCollectorHost`（prompt.ts "empathy 检测门控已移除"）；无任何 `load*/isFeatureEnabled(...)` 读取 | H | **A 删除 READY**（仅 flag；agent/Console 面保留） |
| 脚本 `ai-sprint` / `ai-sprint:test` | 根 `package.json:42-43` → `packages/openclaw-plugin/templates/langs/zh/skills/ai-sprint-orchestration/scripts/run.mjs` | 该技能目录在仓库内**不存在**（templates/langs/zh/skills/ 仅 pd-* 五项；`rg -l "ai-sprint-orchestration" -g '!*.md'` → 仅 package.json 自身） | H | **A** |
| `test:unit` 陈旧 exclude | `openclaw-plugin/package.json` → `--exclude tests/commands/evolver.test.ts` | 该测试文件已不存在 | H | **A**（外观性） |
| flag `evolution_worker` | `feature-flag-contract.ts:240` | 零运行时读取（见 §2）；census/文档排期 2026-12-01 退役 | H | **B**（按既定排期翻 `gone` 后删） |
| flags `painEvidenceAdmission` + `painEvidenceAdmissionDefault`（+aliases） | `feature-flag-contract.ts:244,250` + `FEATURE_FLAG_ALIASES` | 描述宣称 OFF 时回落 Gate A——但 Gate A 回落已物理删除（`gate-block-helper.ts:207` "Gate A fallback removed"，Gate B 无条件运行）；lifecycle 声称的消费者文件 `pain.ts/llm.ts/gate-block-helper.ts` 经 rg **零命中**——kill switch 是 no-op，registry 元数据失真 | H | **B**（删 flags+aliases，或重接回落——Owner 定） |
| flag `gfi` | `feature-flag-contract.ts:239`（since 2026-05-24，默认 off） | 唯一运行时读取 `pd-cli/runtime-canary.ts:156`（跳过只读快照）；打分链从不检查 flag（治理文档自认"翻转不改变任何写入行为"） | H | **B**（接线或撤旗） |
| flag `diagnostician_split_pipeline` | `feature-flag-contract.ts:254` | 治理文档已标 DEPRECATE/DEFER DELETE；factory 注释自证不再选路（`pain-signal-runtime-factory.ts:481`），余留一致性守卫用 | H | **B** |
| config 字段 `contextInjection.evolutionContext` | `config/pd-config-types.ts:275`、defaults:99（enabled:true）、validate:529-613 | 消费仅 `openclaw-plugin/src/commands/context.ts:256-270`（状态展示+preset 拷贝）；prompt.ts 只消费 `thinkingOs`/`projectFocus`——**该上下文从不被注入**：schema+validator+UI 描述一个不存在的行为 | H | **B**（删字段需 config-compat 说明） |
| 文档化 env 变量 6 个 | `CONFIGURATION_ARCHITECTURE.md:241-251`（`PD_LOG_LEVEL`/`PD_RUNTIME_KIND`/`PD_PIAI_API_KEY`/`PD_OPENAI_API_KEY`/`PD_USE_INTERNALIZATION_ENGINE`/`PD_CONFIG_DIR`） | `grep process.env.<V>` 生产文件 → 各 0 命中；Level 4/5 override 机制（`applyEnvOverrides`/`resolveEnvReferences`）代码不存在（文档 :637 自认"待建"） | H | **B**（修文档或实现——属文档失真主犯之一） |
| 一次性迁移 `workspace-guidance-migration` | `runtime-v2/workspace-guidance-migration.ts`；每次 plugin 注册即跑：`openclaw-plugin/src/index.ts:323` → `core/workspace-guidance-migrator.ts:106` | 改写 AGENTS.md/THINKING_OS.md 等（PLAN.md 时代文本），写 .bak；无 once-guard/marker（migrator 内 `version\|marker\|once` 0 命中），每次启动全量重扫；幂等于干净文件 | H | **B**（宽限期后退役；Phase 0 T1 的遗留项，PRI-730 只删了 RuntimeSelector 未动它） |
| `evolution_tasks` 表 + `@principles/core/evolution-store` 导出 + 隐藏命令 `pd evolution tasks` | `trajectory.ts:299`（建表）、`principles-core/package.json:25-27`、`pd-cli/src/index.ts:185-206` | 写方 `recordEvolutionTask` 零调用；读方保留（历史 DB 行 + quality-scorecard） | H | **B**（读方为历史 DB 保留；**新 workspace 停止建表**需 Owner 拍板） |
| flags `nocturnal`/`idle_trigger`（gone 墓碑）+ installer `MVP_GONE_FLAGS`/`MVP_QUIET_FLAGS` | `feature-flag-contract.ts:404-405`、`create-principles-disciple/src/mvp-config.ts:10-11` | registry 墓碑是契约面；`MVP_GONE_FLAGS` 唯一消费者是其自测 | H | **C 保留**（墓碑）/ installer 常量 L |
| SQLite `migrateSchema`（列迁移+schema_version 001/002） | `store/sqlite-connection.ts:721-775` | 幂等 ALTER+版本门回填，服务存量用户 DB | H | **C 保留**（合法永续） |
| legacy 目录/overlay 迁移 | `openclaw-plugin/src/core/migration.ts`（index.ts:48 调用）、`create-principles-disciple/src/update/legacy-migration.ts`（dry-run 默认）、`installer.ts:757,2920` | 服务既有安装 | H | **C 保留** |
| `dev:evolution-evidence`/`dev:evolution-init` 脚本 | 根 `package.json:34-35` → `scripts/dev/pipeline-evolution/*.mjs` | 文件在；只读 SQLite 取证（PRI-653/685 资产），与已删 worker 无关 | H | **C 保留** |

---

## 6. AI Danger Zones

| File | Why Dangerous（爆炸半径） | 既有护栏 | 缺口 |
|---|---|---|---|
| `principles-core/src/runtime-v2/index.ts`（2161 行，~1792 导出名） | **291 个文件**经 `@principles/core/runtime-v2` 子路径导入；全仓 307 个 core importer 的公共面 | `architecture-regression.test.ts:601` 枚举必需导出 | **无反增长基线**（anti-growth 只盖 plugin/core 目录:393-435，不盖桶本身）；AI 往桶里加导出零阻力——ghost 家族正是这么积累的 |
| `principles-core/src/runtime-v2/store/sqlite-connection.ts`（803 行，20 张 `CREATE TABLE`） | state.db 是用户数据；36 文件直接 import，18 个生产文件经 RuntimeStateManager | `schema-conformance.test.ts`、schema-version 门（`schema-version.ts:15`）、arch test :943（RuntimeStateManager 零内联 SQL） | 列迁移是手写 `PRAGMA table_info` 备份重建（:246,282）；无针对"老版本真实用户 DB"的迁移框架测试 |
| `principles-core/src/telemetry-event.ts:65`（`TelemetryEventType` Union，**170 个 `Type.Literal`**） | 全部 runner/store 遥测经 `BasePeerRunner.emitEvent`（base-peer-runner.ts:341-421）流出 | 已知陷阱 ERR-060：未注册字面量**静默丢弃**→`degradation_triggered` 兜底；ERROR_ARCHIVE 有案（PR #808-810，复发 #902） | **部分裸奔**：`telemetry-event.test.ts:5-61` 只抽查 5 个具名事件；无"emit 字面量 ⊆ union"穷举扫描——第三犯条件齐备。**AI 新增遥测事件时此处是全仓最高频暗雷** |
| `runtime-v2/__tests__/architecture-regression.test.ts`（4315 行） | 它本身就是大部分边界防护的总闸（plugin-core 反增长:393、桶 API:601、内化/检测/pain-gate 零反向依赖:720-777、store 模块化:894、pd-cli 边界:973） | 它 IS the guard | **无 meta-guard**：删/弱测试行可过 lint——AI 为绿测试"调整"基线的诱因真实存在 |
| `create-principles-disciple/src/installer.ts`（3364 行 = 包内 58%） | 唯一部署权威，写 `~/.pd/runtime`；坏发布 = 全用户砖化（AGENTS.md §1.1 事故前科） | 38 个测试文件；release-manager-install-smoke、installer-journal、verify:merge 的 release-target-matrix | config.yaml schema 漂移无 staged-rollout 级测试 |
| `principles-core/io-seam-registry.json`（96 行）+ eslint 规则 | core 无 I/O 不变量的唯一事实 | `eslint.config.js:17,195-208` error 级 + arch test 读同一 JSON | **双键风险**：registry 与代码同 PR 一起改即可让守卫认可新 I/O（无"seam 清单↔实际 import"语义核对） |
| `host-runtime/src` barrel（`index.ts` 等 contract 面） | 44 文件 import；`production-rulehost-gate` 等 contract 文件各只有 1 个直接生产 importer——barrel 才是真表面 | product-host-runtime 测试、flag-alias integration 测试 | host-runtime 导出面**无枚举型 arch test**（core 有、host-runtime 没有） |
| `lefthook.yml` + `scripts/dev/check-dev-worktree.mjs`（197 行） | 多 agent 并发守门（worktree/lease/git-1..9） | judge-only、fail-closed | `check-runtime-contract.js`（286 行）只扫 PR diff 行级 ERR-001/005/013，且有 `PD_RUNTIME_CONTRACT_SCAN=0` 逃生门 |
| 错误手册门（`scripts/check-error-handbook.cjs`） | 手册 300KB 硬门（>300KB fail、>250KB warn）+ ID 一致性；在 verify:merge 内 | 有护栏 | Low |

---

## 7. Recommended Slimming Order

按"减少 AI 理解成本 / 风险比"排序（只建议，不执行）：

1. **Evolution 残余清扫**（收益最高、多数零消费者）：删 feature-test 两个场景文件的 worker 引导、根 `MEMORY.md:30-57` 章节、`plugin-surface-registry.ts:92,142` 两个幽灵面、`openclaw-plugin/src/core/evolution-types.ts` 复制桶 + `runtime-v2/evolution/evolution-types.ts` 14 符号桶导出收窄、`types/queue.ts` 死壳 + queue brand types、`pipeline-health.ts` 的 evolution_queue 阶段（或整个死脚本）、快照收集器两行。flag 与"停止建表"见 4/5。
2. **导航文档真相修复**（零风险、直接消除误导）：`CONFIGURATION_ARCHITECTURE.md`（6 个 env 变量+2 机制不存在、多层方案不存在）、`DATA_ARCHITECTURE.md`（六处失真）、`pd-task-manager.md` 状态块、`USER_GUIDE.md:208` evolution_worker 段、`installer.ts:1693`/`bundle-plugin.mjs:463` 的 `initWorkflowSchema` 僵尸注释、`trace-refiner.ts` 文件头虚假消费者声明。
3. **点前缀死读修复**（小而真：一个"查询恒空"的静默谎言）：`trajectory-store.ts:46`/`evolution-store.ts:56` 的 `.trajectory.db` → `trajectory.db`（或反向统一）；属行为修复，走 bug 单并补 round-trip 测试。
4. **死 flag / 死配置清理**：`empathy_observer`（A）、`painEvidenceAdmission*` 对+aliases（B：删或重接回落）、`gfi`（B）、`contextInjection.evolutionContext`（B）、`ai-sprint` 脚本对（A）、`test:unit` exclude（A）。
5. **telemetry union 穷举守卫**（加护栏非减面，但直接拆雷）：静态扫描 emit 字面量 ⊆ `TelemetryEventType` union，落实 ERR-060 的 Enforcement Decision（复发两次、无机械化守卫，按 §14 已满足触发条件）。
6. **Diagnostician 工件双写收敛**：SPEC 已在（`docs/specs/diagnostician-artifact-store-convergence.md`），等 Owner 审；收敛前 AI 触碰 diag-router-runner.ts 属高危区。
7. **`workspace-guidance-migration` 退役**（Phase 0 T1 遗留）：每启动热路径重扫（`openclaw-plugin/src/index.ts:323`），需 Owner 确认宽限期结束。
8. **update legacy inline updater 瘦身**：2386 行 legacy 与 ReleaseManager 共居 `routes/update.ts`——**观察期内不动**；待 `apply`/`rollback` 补齐后按 PRI-729 框架收编。
9. **trajectory 三轨大收敛**（最大战役，SPEC 先行）：双 DDL 双写方 + 复制类型 + 点前缀轨 + 孤儿队列 + pain 三写同根；跨 4 包消费者。Phase 0 T4 结论不变，且仍未占坑。
10. **桶面预算护栏**（可选）：把 anti-growth 基线扩到 `runtime-v2/index.ts`（1792 名冻结），防止 ghost 家族再次积累。

---

## 8. Do Not Touch List

当前核心资产（AI 勿因"看起来像 legacy/重复"而动）：

- **runtime-v2 内化管线 runner**：`internalization/` evaluator-runner / rollout-reviewer-runner / artificer-runner / base-peer-runner、Dreamer/Philosopher/Scribe（`internalization-consumer-cycle.ts:330,544-556` 生产实例化）——活的心脏。
- **Activation + writers**：`runtime-v2/activation/`、`activation_decisions`/`global_rulecode_pauses` 等表链——可逆激活是产品核心能力。
- **ReleaseManager + MutationController + legacy inline 兜底**：`release-manager.ts`、`server/update/mutation-controller.ts`、`routes/update.ts` 的 legacy 分支是**设计内 fail-loud 兜底**（PRI-659/729 契约），观察期勿重切。
- **Pain 准入链**：`governance-signal-admission.ts`（1,165 行）/`governance-observation-store.ts`（1,137 行）/`production-pain-evidence.ts`——与 core 的 governance-experience 是不同层职责，**不是重复实现**（Phase 0 已逐一核过消费者；flag `abstraction_layer_v1` 双写方同理）。
- **Installer 部署路径**：`installer.ts` install/backup/staging/manifest 全链 + `src/update/` 事务日志——唯一部署权威（ADR-0023/0024）。
- **pd-cli 命令注册面**（68 命令，含隐藏的 `evolution tasks`）：§10 CLI 契约，外部脚本依赖。
- **护栏资产本身**：`io-seam-registry.json` 机制、`architecture-regression.test.ts`、`schema-conformance` 系列、lefthook 守卫、错误手册门、`sqlite-connection.ts` 的 `migrateSchema` 与各 legacy 迁移（服务存量用户 DB，合法永续）。
- **quality-scorecard 的 `evolution_tasks` 读取**（`data-extractor.ts:54`）：读历史 DB 行的活路径。
- **Lab/demo 资产**（story-a-demo、golden-trace fixture/synthetic/proven-channel/pain-flood、`dev:evolution-*` 脚本）：Owner 实验在用；问题只是命名空间位置。
- **empathy agent / Console 展示面**：死掉的只是 `empathy_observer` flag，不是这些。

---

## 9. Proposed Follow-up Issues

只建议，不创建 PR：

| # | 提案工单 | 范围锚点 | 前置 |
|---|---|---|---|
| F1 | Evolution 残余清扫（§7.1 全清单） | §2 表 | 多数零消费者可直接删；flag 退役并入既定 2026-12-01 排期 |
| F2 | 导航文档真相修复（§7.2 六处） | §5/§2 证据 | 无；纯文档+注释 |
| F3 | 点前缀死读 bug 修复（`.trajectory.db`） | §4-2 | bug 单 + round-trip 测试 |
| F4 | 死 flag/死配置清理包 | §5 A/B 类 | painEvidenceAdmission 需 Owner 二选一（删 vs 重接回落） |
| F5 | telemetry union 穷举守卫（ERR-060 Enforcement Decision） | §6 | 按 §14 复发条件已成立，选 blocking/advisory |
| F6 | Diagnostician artifact store 收敛（已有 SPEC） | §3-5 | Owner 审 SPEC |
| F7 | trajectory 三轨收敛 SPEC（占坑） | §4 | SPEC 先行，勿直接开工 |
| F8 | workspace-guidance-migration 退役决策 | §5 | Owner 一句话（宽限期是否结束） |
| F9 | （低优）update legacy updater 瘦身 + 桶面反增长基线 | §7.8/7.10 | 观察 + PRI-729 框架 |

---

## 10. Concept Map（Q5）

判定原则：不强行合并；区分"真实不同概念"与"历史残留"。

| 家族 | 现实中的概念 | 判定 | 备注 |
|---|---|---|---|
| Rule / Principle / Policy / Guidance | Principle（顶层泛化判断，P_001，candidate→probation→active→archived→deprecated，GLOSSARY:236-244）→ Rule（绑定 principleId 的场景可验证表达，R_001_a，存于账本 `principle-tree-ledger.ts:491-503`）→ Implementation（载体 IMPL_，type=code 者用 **RuleCode 方言**——`pd-cli/src/commands/rulecode.ts:1-15` 确认 RuleCode 现在**只是** code 型 Implementation 的代码方言+静态校验+沙箱重放，不是 Rule 同义词）。Policy/Guidance 无代码实体（仅配置命名/UI 文案） | **层级真实**；Policy/Guidance 仅词面残留 | GLOSSARY §4 已封禁 Law/Doctrine/Guideline/PolicyRule/ConstraintCode；#1616 语义对齐后 RuleCode 边界清晰 |
| Task / Workflow / Job | Task（TaskRecord，1 task:N runs，state.db）/ Workflow（WORKFLOW_FUNNELS 阶段漏斗表，只读 YAML，非可执行工作）/ Job（DAG 拓扑，`internalization-job-graph.ts:1-11`） | **runtime-v2 内三者真实不同**；残留 = plugin `pd-task-*` 层（与 core task 名字撞车、职责不同）+ `EvolutionTask`→TaskRecord 迁移"进行中"（GLOSSARY §5:303） | 合并风险在 plugin-vs-core task 双名，不在三个词 |
| Session / Trace / Episode | Session（GFI 摩擦会话，`session-tracker.ts:1-28`，不入库）/ Trace（**一词两库**：pain-chain 读模型 trace 走 state.db `trace.ts:1-9`；原始证据走 trajectory.db）/ Episode（代码 0 命中，仅 pipeline-evolution 文档与 website） | **"Trace"过载是真实混淆源**；Episode 纯文档残留；Session 独立 | 跨库断链已被 `governance-signal-admission.ts:22-27` 注释承认 |
| Pain / Evidence / Incident / Friction | PainSignal（正典，GLOSSARY:19-28）vs Governance signal（上游观察，admission 层，两者是**管线先后层不是同义词**）/ Evidence（≥5 种含义的伞词：rulehost-evidence、pain-evidence、activation_evidence_snapshots、evidence-guards、trajectory-evidence）/ Friction（GFI，flag `gfi` 死） | Pain vs signal **真实分层**；Evidence **过载**（AI 易把 activation snapshot 与 pain evidence 混谈）；`unified-friction-observer.md` 自我声明未实现（探索稿） | PainEvent 旧名残留迁移"进行中" |
| Update / Upgrade / Release / Publish | 一个内聚子系统（`create-principles-disciple/src/update/` 21 文件）：update=用户行为、release=工件+渠道、publish=元数据发布步骤；"upgrade" 仅测试/文档用词 | **角色真实不同**，词面漂移仅 cosmetic | 无 `pd update` CLI 命令——update 活在 installer bootstrap 路径，AI 别在 pd-cli 里找 |

---

## 11. AI Navigation Map（Q6）

推荐路径（全部经基线验证存在且名实相符）：

```text
START  AGENTS.md                      ← 产品边界/宪法/稳定 ID（可信）
  ↓
docs/architecture/README.md           ← 导航索引
  ↓
GLOSSARY.md + DOMAIN_MODEL.md         ← 先学语言再读代码（可信）
  ↓
PD_ARCHITECTURE_OVERVIEW.md + COMPONENTS.md
  ↓
Runtime entry（按宿主挑一个入口读到底）：
  - openclaw-plugin/src/index.ts      （plugin 启动序 + 服务注册）
  - pd-cli/src/index.ts               （operator 命令面）
  - pd-console/src/server/index.ts    （console 组合根 :260,265,612）
  - host-runtime/src/index.ts         （宿主无关组合）
  - create-principles-disciple/src/index.ts （安装/更新）
  ↓
runtime-v2 管线：internalization/ → activation/ → store/
  ↓
数据速查（本报告 §4 cheat-sheet；DATA_ARCHITECTURE.md 须先看下方黑名单）
  ↓
护栏：architecture-regression.test.ts + lefthook.yml + verify:merge
  ↓
Tests（feature-testing/ + 各包 __tests__）
```

**会误导的文件（Do not trust before verification）**：

| 文件/位置 | 谎言 |
|---|---|
| `docs/architecture/CONFIGURATION_ARCHITECTURE.md` | 多层 config 方案（Level 2/3 yaml、6 个 env 变量、2 个 override 机制）代码不存在；现实 = `.pd/config.yaml` 单文件 |
| `docs/architecture/DATA_ARCHITECTURE.md` | authority 路径 `schema-definitions.ts` 不存在；表清单与真实 DDL 不符；`audit-log.jsonl`/`pain_signals` 代码零命中 |
| `docs/architecture/pd-task-manager.md` | "PDTaskService 待完成"——实际已注册并 reconcile（`pd-task-service.ts:6-27`） |
| `docs/architecture/unified-friction-observer.md` | 自我声明的概念探索稿，RawObservation 等类型不存在 |
| 根 `MEMORY.md:30-57` | 教你验证已删除的 EvolutionWorker |
| `docs/runbooks/USER_GUIDE.md:208` | 把死 flag `evolution_worker` 当活子系统介绍 |
| `packages/principles-core/src/runtime-v2/index.ts` | 1792 个导出名 ≠ 1792 个能力；零消费者家族混于其中（§2） |
| `runtime-v2/trace-refiner.ts` 文件头 | 宣称的消费者（Diagnostician/GoldenTrace）不 import 它 |
| `installer.ts:1693`、`scripts/bundle-plugin.mjs:463` | `initWorkflowSchema` 僵尸注释；workflows.yaml 已不被读 |
| `feature-flag-contract.ts:242-250` 注释 | "roll back = set painEvidenceAdmissionDefault false"——回落 Gate A 已物理删除，照做是 no-op |

**通用验证反射**（本审计方法论，供后续 AI 复用）：
1. 任何"这个模块负责 X"的判断 → `rg` 找 production importer（剔测试/桶/自身），0 命中即为幽灵候选；
2. 任何存储判断 → 找 `CREATE TABLE`/DDL 与 INSERT/UPDATE 调用点，而不是找文件名；
3. 任何 flag 判断 → contract 定义 + `load*/isFeatureEnabled` 读取路径双向核对；
4. 文档先当假设，`docs/architecture/` 中 §11 黑名单五份须反着读。

---

## 附录 A：与 Phase 0 审计的增量对照

| Phase 0 (09-10, 57f0dfebb) | 本审计 (09-12, 4dce7d94) |
|---|---|
| C1 runtime-v2 三幽灵（RuntimeSelector/guidance-migration/story-a-demo） | RuntimeSelector **已删**（PRI-730）；guidance-migration **仍在热路径**（§5）；story-a-demo 桶面未收窄但实现有活入口（`pd demo story-a`） |
| C2 evolution worker ≈2,976 LOC | **已删**（PRI-737 #1613/#1614）；残余清单见 §2/§5（本文新增实证） |
| C3 trajectory 三轨 | **未收敛**，且补齐了点前缀死读、双 DDL 双写方、孤儿队列三个具体断点（§4） |
| C4 workflow-funnel-loader 双实现 | 本轮未复审合并状态；确认 workflows.yaml 已不被读、僵尸注释残留（§4） |
| C7 配置域已收敛 | 成立；新增 4 个死/僵尸 flag + 1 个死 schema 字段（§5） |
| C8 update 域观察期 | 观察 continues；已绘出精确分流面（§3-1） |

## 附录 B：方法与证据

- 基线副本：`D:\pd-labs\pri751-baseline-4dce7d94`（`git archive origin/main` 导出，逐字节等同 4dce7d94；审计后可删）。
- 5 路并行只读扫描 + 关键论断二次抽查（导出计数、flag 行、死读路径、热路径接线、遥测字面量计数、死脚本目标、MEMORY.md 幽灵章节均经独立复核）。
- 已知局限：导出名计数为正则近似（±5%）；flag 总数 47 为 `{ id: '` 计数；`workflow-funnel-loader` 双实现现状未逐行 diff（Phase 0 C4 结论未推翻也未复认）。
