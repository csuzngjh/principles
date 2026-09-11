# PRI-731 — Evolution Worker 真实链路审查与退役评估（Phase 0 Reality Audit）

> 日期：2026-09-11
> 基线：`origin/main` `403722fc3`（worktree `ai/PRI-731-evolution-worker-audit`）
> 性质：**只读审查**。无代码修改、无行为变化、无 flag 变更、无 migration。生产数据来自本机 live 环境的只读取证（SQLite readonly 模式 + 日志文本）。
> 关联项目：Linear「PD 产品瘦身与架构收敛」

---

## 1. Executive Summary

**Evolution Worker 在生产环境从未运行过一次完整周期：它的启动 flag 自 2026-06-01 起默认关闭、live workspace 连 config.yaml 都不存在，全盘找不到任何一个它理应产出的状态文件；它如今是一个每 15 分钟醒来一次、只做"丢弃遗留队列项 + 清扫 workflow TTL + flush 会话 + 写一个无人读取的状态文件"的维护空转循环——而它名字所暗示的"进化引擎"职责（pain→分析→原则→rule）早已被 Runtime-v2 管线整体接管（源码内自述）。** 它对系统的唯一真实持续影响是：让每个新接触 PD 的 AI/开发者误以为存在一套与 Runtime-v2 并行的进化机制（本审计的前置 Phase 0 报告就已因它误判过一次 flag 治理状态）。

建议：**DEPRECATE**（声明退役 + 三个解缠迁移），随后以独立工单删除 worker 链本体。

---

## 2. Reality Audit

### 2.1 当前真实职责与入口（Q1）

**唯一入口**：OpenClaw plugin 启动路径，flag 门控。

```
openclaw-plugin/src/index.ts:351   startedWorkspaces 守卫（每 workspace 每进程一次）
openclaw-plugin/src/index.ts:360   shouldStartEvolutionWorker(workspaceDir, logger)
openclaw-plugin/src/index.ts:106     └─ 定义；读 flag 'evolution_worker'
openclaw-plugin/src/index.ts:60      └─ loadFeatureFlagFromWorkspace → host-runtime pd-config.ts:118
                                        computeFeatureFlagsFromConfig（正式 flag 契约，非旁路）
openclaw-plugin/src/index.ts:362   EvolutionWorkerService.start({workspaceDir, stateDir:.state, ...})
openclaw-plugin/src/index.ts:371   （未启动分支）SystemLogger 'EVOLUTION_WORKER_DISABLED' + 结构化日志
```

**心跳循环**（无 cron、无 CLI 触发、无外部 scheduler——纯 setTimeout 自续）：

```
service/evolution-worker.ts:607  start()：initialDelay=5s，interval=config 'intervals.worker_poll_ms' 或默认 15 分钟（:638）
service/evolution-worker.ts:643  runCycle()（每次结束 :749 setTimeout 自续）：
  ├─ :172  processCompilationBackfill()        编译补偿（fire-and-forget）
  │    ├─ Phase 1（:186-227）扫描 principle_training_state.json 里无 compilationRetryCount 的
  │    │        旧 principle，标记重试；写 COMPILATION_BACKFILL_DONE 标记（每进程一次）
  │    └─ Phase 2（:229-330）PrincipleCompiler.compileOne()（:259）：
  │             模板生成代码（template-generator，非 LLM）→ 代码校验 → golden trace 重放
  │             （调用 core runtime-v2 的 replayGoldenTrace）→ registerCompiledRule
  │             （ledger-registrar.ts:33）→ 写 principle-tree-ledger（implementations+rules）
  │             失败 5 次 → principle.evaluability='manual_only'
  ├─ :672  processEvolutionQueueWithResult → processEvolutionQueue（:387）
  │        读 .state/evolution_queue.json → V1→V2 迁移（queue-migration.ts）
  │        → 过滤丢弃全部 pain_diagnosis 项（:433-437，注释："Runtime v2 owns pain diagnosis…
  │          EvolutionWorker cannot revive the old .pain_flag -> prompt path"）
  │        → 校验/rc-4 过滤 → 保存。**到此返回——不再执行任何队列任务**
  │        （旧处理器已移除：processDetectionQueue 于 PRI-451 Wave 1；processPromotion 于 D-05/06）
  ├─ :694  WorkflowStore TTL 清扫（过期 subagent workflow → 删除子会话、状态置 expired）
  ├─ :730  runWorkflowWatchdog（:173 workflow-watchdog.ts，异常检测）
  ├─ :732  dictionary.flush() + flushAllSessions()（session-tracker 持久化）
  └─ :735  writeWorkerStatus（:542）→ .state/worker-status.json
```

**队列生产者**：`registerEvolutionTaskSession`（evolution-worker.ts:470，唯一入队函数）**在全仓没有任何调用者**（rg 全仓仅定义与注释命中）。即：当前没有任何代码路径会向 evolution_queue.json 写入新任务。

**结论（真实职责）**：当前 EvolutionWorker = 「编译补偿（对空账本无效）+ 队列遗留项清道夫 + subagent workflow 清扫/看门狗 + 会话 flush + 只写不读的状态文件」。它名字暗示的"进化"职责已全部不在。

### 2.2 与 Runtime-v2 的重复关系（Q2）

| 能力 | Evolution Worker（旧链） | Runtime-v2（新链） | 是否重复 | 建议 |
| --- | --- | --- | --- | --- |
| trajectory 采集 | TrajectoryDatabase 写 trajectory.db（hooks 5 处写入；非 worker 本体） | runtime-v2 store（state.db: tasks/runs/artifacts）+ trajectory locators | 部分重复（双库并存） | 属 PRI-730 审计已登记的 trajectory 三轨收敛，另立 SPEC，不在本链 |
| pain 分析 | **已退役**：queue 明确丢弃 pain_diagnosis（evolution-worker.ts:433-437） | PainSignalBridge → SplitDiagnosticianRunner（pain_diagnoses 表） | **否（已让位）** | 源码自述 Runtime-v2 专属 |
| 原则生成 | 无（PAIN_CANDIDATES 提升系统已删，D-05/06） | pain-to-principle 管线 + principle_candidates 表 | 否 | — |
| rule 生成 | **残留**：processCompilationBackfill 用 PrincipleCompiler（模板，非 LLM）把旧 principle 编译成 implementation+rule 写 ledger | Artificer（LLM 生成 implementationCode）→ Evaluator 评审 | **重复**（模板编译 vs LLM 生成，两条 rule 产出路径） | 随 worker 删除；live 账本为空，无迁移成本 |
| activation | 无（worker 不触碰 activations） | ActivationDispatcher + activation/writers | 否 | — |
| training/评审 | 无（evaluator/rollout 属 Runtime-v2 internalization/） | internalization/（evaluator-runner 等） | 否 | — |
| 行为信号记录 | recordEvolutionSuccess/Failure + epTier（engine scorecard，内存+evolution-scorecard.json） | governance-observation-store / signal-collector（host-runtime） | **重复**（旧信号通道仍在被活跃 hooks 写） | 迁移：hooks 改写 Runtime-v2 信号通道后删旧通道（见 2.4 可迁移） |
| 状态展示 | evolution-status 命令（evolution-reducer + funnel loader） | Console read-models（operator-health 等 8 个） | **重复**（两套 Operator 面板） | 随 worker 退役该命令，或迁移到 read-model |

### 2.3 生产使用实况（Q3）

**Flag `features.evolution_worker.enabled`**：
- 默认值：**false**。`principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts:240`：`{ id: 'evolution_worker', category: 'quiet', enabled: false, since: '2026-06-01', description: 'Legacy evolution worker heartbeat (MVP-Quiet per ADR-0014 §2.5)' }`（lifecycle 元数据在 feature-flag-lifecycle.ts:104；plugin-surface-registry.ts:98/148 记录 PRI-288 门控）。
- **纠正 Phase 0 报告的一个错误**：该 flag **在正式 flag 契约内**（PRI-730 审计曾称其"旁路 flag"，经本次核实为误——当时 grep 命中被 cwd 事故吞掉）。
- 读取方：plugin 启动门（index.ts:360）经 host-runtime pd-config.ts:118 统一计算。修改方：仅用户编辑 `.pd/config.yaml` 的 `features.evolution_worker.enabled`。

**Live 数据取证**（本机，2026-09-11 只读核查）：

| 证据项 | 位置 | 结果 |
| --- | --- | --- |
| live workspace 的 PD config | `D:\Code\principles\.pd\config.yaml` | **不存在** → flag 恒为默认 false → worker 从未在 live workspace 启动 |
| `.state/worker-status.json`（每周期无条件写入，:542） | 全机搜索（~/.openclaw、~/.pd、/d/workspace、/d/Code/principles、/d/pd-labs） | **不存在** → worker 从未完成过哪怕一个周期 |
| `.state/evolution_queue.json` | 同上 | **不存在** → 队列从未被创建 |
| `.state/COMPILATION_BACKFILL_DONE` | 同上 | **不存在** → 编译补偿从未运行 |
| `.state/evolution-scorecard.json`（engine 分数持久化，evolution-engine.ts:55） | 同上 | **不存在** → epTier 恒为初始档 |
| principle_training_state.json（编译目标账本） | `D:\Code\principles\principle_training_state.json` | **空树**：0 principles / 0 rules / 0 implementations |
| `memory/evolution.jsonl`（engine 事件流） | live | 35 行，全部是 `pain_detected`（2026-06：9 条有机记录；2026-09-01：26 条全是同一手工测试 `empty_workspace_test`，source=manual）。无 tier 晋升、无编译、无 worker 周期事件 |
| SystemLogger（memory/logs/） | live 仅有 SYSTEM_2026-06-08.log | 零 EVOLUTION 事件 |
| trajectory.db（~/.openclaw，readonly） | pain_events=3、sessions=2，最新 **2026-06-19** | 旧链数据库自 6 月 19 日后零写入 |
| state.db（D:\Code\principles\.pd，readonly） | pain_diagnoses=0、tasks=0、principle_candidates=0、pi_artifacts=0、activations=0 | Runtime-v2 主库在该 workspace 全空 |

**结论：没有任何生产运行数据。worker 的全部指纹文件（本应无条件产生的）均不存在。**

### 2.4 消费者矩阵（Q4）

```
Evolution Worker 链
 ├─ A. hooks/gate.ts:85,477      epTier → RuleHost 输入富化（evolution.epTier 字段）   [可迁移]
 ├─ B. hooks/after-tool-call-helpers.ts:305  recordEvolutionSuccess/Failure            [可迁移]
 ├─ C. hooks/pain.ts + signal-collector-host（evolution-logger → memory/evolution.jsonl）[可迁移]
 ├─ D. commands/evolution-status.ts（reducer + funnel loader + runtime-summary）        [可迁移]
 ├─ E. core/workspace-context.ts（evolution-reducer）                                   [随 D]
 ├─ F. core/event-log.ts（worker 心跳的 _eventLog 参数已弃用为未使用形参 :387）          [无依赖]
 └─ G. worker 本体（service/evolution-worker.ts 777 + evolution-dedup 74 +
        queue-io 120 + queue-migration 153 + workflow-watchdog 174 +
        subagent-workflow/store + core/evolution-engine 613 + evolution-reducer 882 +
        evolution-logger 357 + core/principle-compiler/*）                              [可删除]
```

| 分类 | 项 | 原因 |
| --- | --- | --- |
| 必须保留 | 无 | ——（没有任何"仅由 worker 链承担且无替代"的生产能力） |
| 可迁移 | A/B/C/D（四处活跃调用点） | 它们是活跃 hooks/命令，但依赖的是"空转引擎"的恒定值/双写日志/旧面板；Runtime-v2 已有对应承接（RuleHost 信号通道、pain-signal-observability、read-models）。迁移 = 让活跃调用点停止指向旧链，不是新建机制 |
| 可删除 | G（worker 链本体，约 **3.0K LOC**） | 唯一入口被默认关闭的 flag 门控且从未启动；零队列生产者；零产物；F 的 event-log 依赖已是未使用形参 |

### 2.5 删除风险分析（Q5）

若（在完成可迁移项解缠后）删除 worker 链本体：

| 模块 | 风险 | 证据 |
| --- | --- | --- |
| OpenClaw plugin 启动 | 极低：仅移除一个从未走通的分支；未启动分支已是日志常态 | flag 默认 false（feature-flag-contract.ts:240）；live 无 config.yaml |
| Pain pipeline | 无：worker 明确不处理 pain（:433-437 主动丢弃）；pain 链在 Runtime-v2（PainSignalBridge→Diagnostician） | 源码自述 + pain_diagnoses 表归 Runtime-v2 |
| trajectory | 无直接风险：worker 仅经 TrajectoryRegistry 读会话（编译上下文）；trajectory.db 的 writer 是 hooks 不是 worker | compiler.ts imports（TrajectoryDatabase 类型仅作编译上下文） |
| RuleHost | 低（需先解缠 A）：`evolution.epTier` 是 RuleHost 输入契约字段；恒为初始档。迁移=字段保持但来源固定/或随契约注记退役，RuleHost 规则语义不变 | gate.ts:84-86；epTier 无持久化分数（scorecard 文件不存在） |
| Activation | 无：worker 链不触碰 activations（state.db activations 表读写方全在 runtime-v2） | 2.3 取证：worker 无任何 DB writer |
| Console | 无：Console 不读 worker 产物（evolution 字样仅 enum/i18n 标签与 FailedTasks/Focus 页的 Runtime-v2 数据） | pd-console rg 命中均为标签文案 |
| 内化管线 | 无：golden trace 重放被 compiler 消费，但 replayGoldenTrace 本体在 core，属 runtime-v2 资产，不随 worker 删除 | compiler.ts import 自 '@principles/core/runtime-v2' |

**唯一真正的风险是"不解缠就删"**：直接删 engine 会折断 A/B/C 三个活跃 hook 调用点的编译。这就是为什么建议 DEPRECATE（分两步）而不是一次性 DELETE。

---

## 3. Architecture Map

**旧链（Evolution Worker，现实中的空转）**：

```
[flag evolution_worker=false，从未开启]
  ↓ plugin startup (index.ts:360)
EvolutionWorkerService.start (evolution-worker.ts:607)
  ↓ setTimeout 15min 自续 (:643 runCycle)
  ├→ 编译补偿：principle_training_state.json（空树）→ PrincipleCompiler(模板) → ledger  [无输入，从未运行]
  ├→ 队列：evolution_queue.json（不存在）→ 丢弃 pain_diagnosis → 校验 → 保存            [零生产者]
  ├→ WorkflowStore TTL 清扫 + watchdog（subagent-workflow，仅 worker 自己创建的 workflow） [空转]
  └→ worker-status.json（零读者）                                                      [只写]
旁路写入（不经 worker，活跃）：hooks → evolution-logger → memory/evolution.jsonl（pain_detected 双写）
旁路读取（不经 worker，活跃）：gate.ts/after-tool-call → EvolutionEngine.getTier/record*（恒定初始档）
```

**新链（Runtime-v2，生产实证）**：

```
PainSignal（hooks/pain.ts / pd pain record / PainSignalBridge）
  ↓ Diagnostician（SplitDiagnosticianRunner，state.db pain_diagnoses）
  ↓ Internalization Pipeline（internalization/：evaluator-runner / rollout-reviewer / artificer-runner）
  ↓ Artificer（LLM 生成 implementationCode + goldenTraceCases）
  ↓ Evaluator（评审门，PiEvaluator）
  ↓ ActivationDispatcher（可逆激活，activation/writers）
  ↓ RuleHost（gate.ts 输入富化 → 规则执行）
```

---

## 4. Decision Recommendation

**DEPRECATE**（不是 KEEP，也不是立即 DELETE）。

理由：
- KEEP 不成立：零生产运行（2.3 全套指纹缺失）、零队列生产者、职责已被 Runtime-v2 源码级接管（2.2）、flag 契约描述自认 "Legacy … heartbeat (MVP-Quiet)"。
- DELETE 现在不成立：四处活跃调用点（A/B/C/D）仍编译依赖旧链符号；需先做三次小迁移（各为一个独立小 PR）。
- 与 update 系统收敛同构：先证明两个机制没有必要并存（本文档），再删除旧机制。

**最终决策依据（任务核心问题）——新 AI Agent 是否会误判？会，而且已经发生。** 证据：
1. PRI-730 前置审计（我自己）在第一遍调查中把 `evolution_worker` 误判为"不受治旁路 flag"——正是因为 evolution 域的混乱信号干扰了取证。
2. 队列 schema 仍声明四种 TaskKind（pain_diagnosis/sleep_reflection/model_eval/keyword_optimization，queue-migration.ts:110-115），读代码的人会以为存在四条在役任务管线；实际 pain_diagnosis 被主动丢弃、其余无人生产。
3. `commands/evolution-status.ts`、console 的 evolution 标签、`gate.ts` 的 epTier 都在暗示"有一个活的进化系统"。
4. 目录名 `service/evolution-worker.ts` 与 core `runtime-v2/` 并列，认知上构成"两代架构并存"，而实际一代从未通电。

## 5. Follow-up Proposal（建议的后续工单，未立项）

1. **迁移 1（hooks 解缠，小 PR）**：`gate.ts` epTier 改为常量/契约注记退役 + `after-tool-call-helpers` 停写 recordEvolution*；RuleHost 输入契约同步注记。
2. **迁移 2（日志双写解缠，小 PR）**：`hooks/pain.ts`、`signal-collector-host` 停写 evolution-logger（memory/evolution.jsonl），pain 观测统一走 pain-signal-observability（events_*.jsonl）。
3. **迁移 3（面板退役，小 PR）**：`commands/evolution-status.ts` + reducer + workspace-context 依赖移除（Owner 面板统一到 Console read-models）。
4. **删除工单（主收益）**：删除 G 链本体（evolution-worker/dedup/queue-io/queue-migration/workflow-watchdog/subagent-workflow/evolution-engine/reducer/logger/principle-compiler，约 3.0K LOC）+ `evolution_worker` flag 契约项退役（按 §16 quiet flag 生命周期）+ `scripts/evolution_daemon.py` 等 repo 根化石（已发现，顺带清点）。
5. （非本链，另行立项）trajectory 三轨收敛 SPEC 与 workflow-funnel-loader 双实现合一——PRI-730 审计已登记。

---

## 附：取证命令与可复现性

- flag 契约：`rg 'evolution_worker' packages/principles-core/src/runtime-v2/feature-flags/`
- 入队生产者缺失：`rg 'registerEvolutionTaskSession' packages/`（仅定义+注释）
- 指纹文件缺失：`find ~/.openclaw ~/.pd /d/workspace /d/Code/principles /d/pd-labs -name 'worker-status.json' -o -name 'evolution_queue.json' -o -name 'evolution-scorecard.json' -o -name 'COMPILATION_BACKFILL_DONE'`
- DB 只读核查：`better-sqlite3` readonly 模式列出的两库计数（2.3 表）
- 事件流统计：`memory/evolution.jsonl` 35 行 JSON 解析（全部 pain_detected；2026-09 条目全部 source=manual）
