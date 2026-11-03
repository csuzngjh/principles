# PRI-750 Trajectory Data Reality Audit

- 日期：2026-09-12
- Baseline commit：`4dce7d942`（origin/main，Merge PR #1616，2026-09-12）
- 审计环境：独立 detached worktree `D:/pd-labs/pri750-audit-tree`（基于 origin/main 4dce7d942）。主 checkout（D:\Code\principles，HEAD 5d755be2e 落后 174 commits）**未做任何变更**——其暂存区存在 330 个文件的他人在途工作，与本次审计无关，已完整保留。
- Live 实证对象：`D:/.openclaw/workspace`（`~/.openclaw/openclaw.json` 权威指向）、`~/.pd`、`~/.openclaw`。
- 只读保证：全程未修改代码 / 未删除表 / 未改 schema / 未建 migration / 未建 PR；live SQLite 全部以 `sqlite3 -readonly` 打开。本文件是唯一新建产物（未跟踪）。

---

## Executive Summary

**一句话结论：PD 的数据真相源总体收敛于两个活跃库——`.pd/state.db`（治理/管线决策层，runtime-v2 权威）与 `.state/trajectory.db`（行为捕获/pain 摄取层，多宿主汇聚点）——二者职责边界基本清晰；但存在一条从未接通的历史读链（core 的 `.state/.trajectory.db` 隐藏路径）、一张仓库注释自认的 DDL 重复、五张零生产者的死表，以及一处「回执只喂遥测、不进决策」的确认。**

关键判定（详见后文证据）：

1. **无全局性多真相源**。trajectory.db（捕获）与 state.db（治理）是分层而非重复；`pd history` 的检索权威被代码显式声明为 state.db（`session-history-import.ts:26` "Primary retrieval always goes through `.pd/state.db` only"）。
2. **一条真实断链读**：`principles-core/trajectory-store.ts:46` 与 `evolution-store.ts:56` 读 `<ws>/.state/.trajectory.db`（隐藏文件），而全仓唯一 writer（plugin `TrajectoryDatabase`）写 `<ws>/.state/trajectory.db`（可见文件，`paths.ts:53`）。live 工作区不存在隐藏文件 → `pd samples-list/samples-review`、`pd evolution-tasks-list/show` 四个 CLI 永远返回空。
3. **五张死表（零生产 writer）**：`evolution_tasks`、`evolution_events`、`task_outcomes`、`trust_changes`（仅一次性 legacy import 写入过）、`sample_reviews`（review 链活着但上游 0 行）。live 库行数全部为 0。
4. **DDL 双份是仓库承认的既成事实**：plugin `trajectory.ts:151-153` 注释明言 core `pain-signal-observability.ts` "duplicates a subset of this DDL (acknowledged duplication)"，靠人工同步纪律维持。
5. **`principle_applications` 回执账本（live 185 行）的消费者只有遥测/Console/统计面**，无任何 activation/promotion 决策逻辑读它——PRI-747「回执不进决策」在数据层再次确认，本审计为其提供精确数据拓扑。
6. 训练数据导出链（ORPO/SimPO 视角）当前**不具备完整性前提**：样本表 0 行、样本 `principle_ids_json` 硬编码 `'[]'`（无原则标注）、CLI 读链断、多处 demo/e2e 写入器与真实库同构。

---

## 1. Data Storage Map

### 1.1 工作区数据拓扑（live 实测 `D:/.openclaw/workspace`）

```
<workspace>/  (D:/.openclaw/workspace)
├── .pd/
│   ├── state.db                    ← runtime-v2 治理库【A：生产权威】
│   ├── config.yaml (+ 4 个 .bak)
│   ├── feedback/  host-tool-semantics/
├── .state/
│   ├── trajectory.db               ← 行为捕获/pain 摄取库【A：生产权威】(8MB, WAL 活跃)
│   ├── trajectory.db.bak-before-gateb-graduation-20260903  【D：遗留备份】
│   ├── subagent_workflows.db       ← PRI-737 已退役 workflow store【D：死数据】(11.8MB, 05-13 后未动)
│   ├── evolution-scorecard.json    ← live 有活跃写入(09-11)，但当前 main 无 writer【B?】
│   ├── principle_training_state.json ← host-runtime/pd-cli 读【B】
│   ├── hygiene-stats.json          ← plugin hygiene/tracker.ts 写【B】
│   ├── evolution_queue.json        ← 4 字节空文件，仅测试 fixture 引用【D】
│   ├── correction_keywords.json / pain_settings.json / exports/ blobs/ logs/ sessions/ principles/
├── .principles/  memory/  (.agents / .openclaw 为宿主目录)
```

### 1.2 机器级游离 DB（live 实测）

| 文件 | 大小/时间 | 表 | 判定 |
|-|-|-|-|
| `~/.openclaw/trajectory.db` | 32KB，2026-06-19 后未动 | pain_events, sessions（两表旧代 schema） | 【D】旧布局遗留 |
| `D:/Code/principles/trajectory.db` | 155KB，2026-09-01 | 完整 16 表 schema | 【C/D】以仓库根为 workspace 误跑产物（测试/冒烟残渣），主 checkout 未跟踪 |
| `~/.openclaw/agents/*/agent/openclaw-agent.sqlite`（多份） | 活跃 | 宿主自有 agent 会话存储 | 宿主（OpenClaw）资产，**非 PD 数据面**，不审计 |
| `~/.pd/runtime/**` | 安装运行时 | — | 安装器资产（AGENTS.md §1.1 硬边界），非数据链路 |

### 1.3 非 SQLite 文件态存储（简列）

| 存储 | Owner | 说明 |
|-|-|-|
| `.state/pd_tasks.json` | openclaw-plugin `core/pd-task-store.ts:11` | 文件态任务表；唯一消费者 `pd-task-reconciler.ts:194/275`；live 未生成 |
| `memory/logs/*.jsonl`（EventLog） | openclaw-plugin `core/event-log.ts`（7 天保留，`EVENT_LOG_RETENTION_DAYS`） | 观测事件流（写入者：plugin 各 hook；读者：governance-audit/rollback/pain 命令）|
| `.state/principle_training_state.json` | host-runtime `milestone-readers.ts`、pd-cli `health.ts`（读） | 训练里程碑状态 |
| `.state/evolution-scorecard.json` | **当前 main 无 writer**（rg 零命中） | live 活跃更新（09-11 22:24），writer 只能来自 installed 旧版运行时 → 疑似已从代码退役但 live 仍在产出，需核实 |

---

## 2. Database Inventory

| Storage | 位置 | Owner Package | 职责 | Status |
|-|-|-|-|-|
| `state.db` | `<ws>/.pd/state.db` | principles-core `runtime-v2/store/sqlite-connection.ts`（连接层 SSoT，`:59-65` 定路径） | runtime-v2 治理管线：tasks/runs/artifacts/candidates/approvals/activations/回账/死信/intent | **A** 当前生产 source（live 2.9MB，09-12 01:11 仍在写） |
| `trajectory.db` | `<ws>/.state/trajectory.db` | openclaw-plugin `core/trajectory.ts`（schema SSoT，`paths.ts:53` 定路径） | 行为捕获：sessions/turns/tool_calls + pain 摄取 + governance 观测 | **A** 当前生产 source（live 8MB，WAL 活跃） |
| `.trajectory.db`（隐藏） | `<ws>/.state/.trajectory.db` | principles-core `trajectory-store.ts:46`、`evolution-store.ts:56`（只读原语） | 无任何 writer；指向一个 live 不存在的文件 | **D** 断链读目标 |
| `subagent_workflows.db` | `<ws>/.state/` | （PRI-737 已删初始化；`runtime-init.ts:294-296` "no longer initialized … zero producers … left untouched"） | 旧 evolution worker 的 workflow store | **D** 死数据（live 11.8MB） |
| `governance_*`（7 表） | 附着在 trajectory.db 内 | host-runtime `governance-observation-store.ts:326`、`governance-signal-admission.ts:348` | Codex 摄取链：observations/admissions/rollouts/checkpoints | **B** 设计活跃、本机 dormant（live 库中表不存在=从未落表） |
| e2e/demo 库 | 测试临时目录 | `pd-console/scripts/e2e-seed.ts`、`pd-cli demo-story-a-runner.ts` | 测试种子 | **C** |
| lab 库 | `D:/pd-labs/*` | 实验资产 | episode 实验 | **C** |

---

## 3. Schema Reality

### 3.1 trajectory.db（16 表 + 7 张 governance 附表）

Schema SSoT：`openclaw-plugin/src/core/trajectory.ts:158 applyTrajectorySchema()`（`trajectory.ts:147-156` 注释声明 DDL 单一来源；`pd runtime init` 经 `initTrajectorySchema()` 复用，`runtime-init.ts:255` 表清单一致）。

**已知重复**：`principles-core/src/runtime-v2/pain-signal-observability.ts:201-349` 持有同一 schema 子集的 DDL（`ensureTrajectorySchema`），注释自认 duplication（`trajectory.ts:151-153`），靠人工同步。其用途：runtime-v2 pain 记录路径（`recordPainSignalObservability:462`，调用方 `pain-to-principle-service.ts:193/236`）在 plugin 不在场时自举 schema 并写入。

### 3.2 state.db（20 表）

Schema SSoT：`principles-core/src/runtime-v2/store/sqlite-connection.ts`（`schema_version=3`，live 实证）。表：tasks, runs, artifacts, pi_artifacts, principle_candidates, principle_applications, approvals, activations, activation_control_states, activation_decisions, activation_evidence_snapshots, global_rulecode_pauses, pain_diagnoses, dead_letter_pains, intent_decisions, intent_doc_versions, reconciliation_cursor, pending_agent_drafts, commits, schema_version。

### 3.3 隐藏 `.trajectory.db`（断链目标）

core `trajectory-store.ts` 期待 `correction_samples`+`sample_reviews`；`evolution-store.ts` 期待 `evolution_tasks`。测试直接手工建这些表于隐藏路径（`evolution-store.test.ts:151`），生产从未有 writer 指向该路径（全仓 rg 唯一命中即这两个文件+测试）。

---

## 4. Writer Matrix

方法：全仓 `INSERT (OR xxx) INTO <table>` / `UPDATE` / `DELETE FROM` 系统扫描（首轮单行 grep 漏掉 `INSERT OR IGNORE` 两处，已用宽松模式重扫修正——见 §12 方法学）。

### 4.1 trajectory.db 表

| 表 | 生产 Writer | 证据 | live 行数 | 判定 |
|-|-|-|-|-|
| sessions | plugin `TrajectoryDatabase.recordSession`（`trajectory.ts:573`）；core `pain-signal-observability.ts`（~:397）；host-runtime `production-pain-evidence.ts:297/384`、`governance-signal-admission.ts:664` | 多宿主/多入口汇聚，canonical_pain_id 幂等 | 286 | 活跃（多 writer 合理：hook 路径/runtime-v2 CLI 路径/host 路径） |
| assistant_turns / user_turns / tool_calls | plugin `trajectory.ts:587/616/640`；host-runtime 两处补写 tool_calls（`production-pain-evidence.ts:298/385`、`governance-signal-admission.ts:666`） | | 1068/451/4813 | 活跃 |
| pain_events | plugin `trajectory.ts:676/708`（recordPainEvent）；core `pain-signal-observability.ts`（~:414）；host-runtime `production-pain-evidence.ts:299`、`governance-signal-admission.ts` | canonical_pain_id UNIQUE 去重 | 13 | 活跃（3 入口设计性汇聚，非分叉） |
| gate_blocks | plugin `trajectory.ts:740`（recordGateBlock ← `hooks/gate-block-helper.ts:72`） | | 0 | 写链活、本机未触发 |
| trust_changes | plugin `trajectory.ts:755`——**唯一调用点 `:1772` 在 `importLegacyEvents()` 一次性 legacy import 内** | | 0 | **死表**（无持续生产者，无外部读者） |
| principle_events | plugin `trajectory.ts:771`——调用点 `:1810`（同 legacy import）+ `evolution-reducer.ts:123` | | 117（停在 09-01，恰为 legacy import 时刻） | 名义活、实际冻结 |
| task_outcomes | plugin `trajectory.ts:785` recordTaskOutcome——**全仓零调用方** | | 0 | **死表** |
| evolution_tasks | plugin `trajectory.ts:804/844` recordEvolutionTask/updateEvolutionTask——**全仓零调用方**（PRI-737 退役 evolution worker 后遗留） | | 0 | **死表**（读者仍在，见 §5） |
| evolution_events | plugin `trajectory.ts:909` recordEvolutionEvent——**全仓零调用方** | | 0 | **死表** |
| correction_samples | plugin `trajectory.ts:1907` `maybeCreateCorrectionSample`（`INSERT OR IGNORE`，由 `recordUserTurn` 流程 `:662` 触发）——**writer 活着** | | **0**（451 user turns 未命中 mining 条件） | 活但空 |
| sample_reviews | plugin `trajectory.ts:1472` + core `trajectory-store.ts:139`（CLI review） | | 0 | 上游 0 行 → 实效死 |
| ingest_checkpoint / exports_audit / schema_version | plugin `trajectory.ts:1826/1932/478` | | 3/0/— | 活 |
| governance_observations 等 7 表 | host-runtime `governance-observation-store.ts:569 ingestGovernanceObservations`（调用方 codex-adapter `ingestion.ts:108/196`）、`governance-signal-admission.ts:742 admitGovernanceSignals`（调用方 codex-adapter `admission.ts:141`） | | **表不存在** | 设计活跃、本机 Codex 链从未落表（与 PRI-747「Codex gate 零反馈」互证） |

### 4.2 state.db 表

| 表 | 生产 Writer | 证据 | live 行数 |
|-|-|-|-|
| tasks | runtime-v2 `store/task/sqlite-task-store.ts`；legacy `pd-cli/legacy/legacy-import.ts`；`internalization-integrity-remediation.ts` | | 198 |
| runs | `store/run/sqlite-run-store.ts`、`store/lifecycle/lease-manager.ts`、`internalization-integrity-remediation.ts`、legacy `legacy-import.ts` + `session-history-import.ts`（compat 导入，checkpointed） | | 254 |
| artifacts / commits / principle_candidates | `store/commit/diagnostician-committer.ts` | | 13/13/42 |
| pi_artifacts | `store/artifact/sqlite-pi-artifact-store.ts` | | 162 |
| principle_applications | **plugin `core/principle-application-ledger.ts:83/162/234`**（flag `principle_receipt_ledger` 默认 ON，`feature-flag-contract.ts:350`；接线 `hooks/prompt.ts:19`、`hooks/gate.ts:23`、`hooks/llm.ts:8`、`hooks/trajectory-collector.ts:32`） | | 185 |
| approvals | `activation/sqlite-approval-store.ts:157`（INSERT OR IGNORE） | | **0** |
| activations + activation_control_states/decisions/evidence_snapshots + global_rulecode_pauses | `activation/sqlite-activation-safety-store.ts`、`sqlite-activation-state-store.ts` | | 1/0/0/0/0 |
| pain_diagnoses | `store/pain-diagnosis/sqlite-pain-diagnosis-store.ts:113` | | **0**（诊断语义在 live 上走 `tasks.diagnostic_json`） |
| dead_letter_pains | `store/pain/sqlite-dead-letter-store.ts`（plugin `hooks/pain.ts:268` 亦开连接） | | 0 |
| intent_decisions / intent_doc_versions | `store/intent/sqlite-*-store.ts` | | 0/0 |
| reconciliation_cursor | `store/reconciliation-cursor-store.ts` | | 1 |
| pending_agent_drafts | `feedback/pending-agent-draft-store.ts` | | 0 |

---

## 5. Consumer Matrix（要点）

| 数据 | 消费者 | 用途 | 备注 |
|-|-|-|-|
| state.db tasks/runs/artifacts/pi_artifacts | console `EvidenceChainConsoleModel/PrincipleTrajectoryModel/GovernanceConsoleModel/GovernanceProjectionCollector/OwnerDecisionConsoleModel/failed-tasks`；pd-cli `health/candidate/runtime-artifact-repair/mainline-snapshot-assembler/config-doctor`；core read models（`pain-chain-read-model`、`internalization-chain-integrity-read-model`、`candidate-audit`、`operator-health-read-model`…）；host-runtime `production-rulehost-gate.ts:195`（readonly）、`active-principle-prompt.ts:63`（readonly）、`internalization-consumer-cycle.ts:202` | 治理面/诊断链/注入/健康 | **消费面最厚、全链健康** |
| state.db `runs`（历史查询） | `store/history/sqlite-history-query.ts`（`pd history query`、`pd context build`） | 检索权威（`session-history-import.ts:26` 显式声明 state.db 唯一） | runs 同时承载管线 run 与导入会话两种形态（见 §7.3） |
| state.db principle_applications | host-runtime `milestone-readers.ts:174-175`（遥测 EXISTS）、pd-cli `principles-stats.ts:302-320`、console `ReceiptsConsoleModel` | 遥测/统计/Console | **无任何决策消费者**（activation/promotion 链不读它）——PRI-747 确认 |
| state.db activations/approvals/pi_artifacts | plugin `rule-host.ts`、`rulecode-safety-circuit.ts`、`runtime-v2-prompt-activation-reader.ts`、`principle-receipt-metadata.ts` | gate/注入判定 | 活 |
| trajectory.db pain_events | console `EvidenceChainConsoleModel.ts:185-211`、`GovernanceConsoleModel`；pd-cli `pain-list.ts`、`quality-scorecard/data-extractor.ts`；host-runtime `milestone-readers.ts`、`governance-signal-admission.ts:662` | pain 展示/遥测/准入去重 | 活 |
| trajectory.db turns/tool_calls | plugin `keyword-optimization-service.ts:103`、context assembler 注入（`TrajectoryTurnReader` 接口，`trajectory-turn-reader.ts`）；pd-cli `build-trajectory-evidence.ts`、`session-history-import.ts`（迁移读）；host-runtime `production-pain-evidence.ts:295`（证据读） | 行为上下文/证据 | 活 |
| trajectory.db gate_blocks | console `GovernanceConsoleModel`、`quality-scorecard/data-extractor.ts` | 展示/评分卡 | 活（读）；写链活但 0 行 |
| trajectory.db `evolution_tasks` | core `evolution-store.ts`（→ pd-cli `evolution-tasks-list/show`）、`quality-scorecard/data-extractor.ts:54` | CLI 展示/评分卡 | **读死数据**（writer 零） |
| trajectory.db `principle_events` | `quality-scorecard/data-extractor.ts` | 评分卡 | 读冻结数据 |
| `.state/.trajectory.db`（隐藏） | core `trajectory-store.ts`（→ pd-cli `samples-list/samples-review`）、`evolution-store.ts`（→ evolution-tasks CLI） | 样本审查/任务查看 | **断链**：live 文件不存在，函数 catch 后静默返回 `[]`（`trajectory-store.ts:69-72`） |
| trajectory.db correction_samples（可见文件） | plugin `exportCorrections`（`trajectory.ts:1563` ← `commands/export.ts:37`） | 训练样本导出（approved_only 可选） | 上游 0 行 |
| EventLog JSONL | plugin `governance-audit.ts`、`commands/rollback.ts`、`commands/pain.ts` | 审计/回滚/命令 | 活（7 天滚动） |

---

## 6. Authority Map（每个核心概念的唯一来源判定）

| 概念 | Authority | 判据 | 结论 |
|-|-|-|-|
| Session / Turns / ToolCalls | `.state/trajectory.db` | 唯一持续 writer=plugin；state.db `runs` 中的会话形态是 checkpointed compat 导入（一次性、可重放） | **单一权威** ✓（state.db 为派生副本） |
| Pain（信号层） | `.state/trajectory.db pain_events` | 三入口汇聚 + canonical_pain_id UNIQUE 去重（`trajectory.ts:671` 注释） | **单一权威** ✓（多 writer 是摄取汇聚，不是多真相） |
| Pain（管线状态层） | `.pd/state.db` tasks/diagnoses/dead_letter | runtime-v2 唯一写 | 单一权威 ✓ |
| Principle（候选/治理） | `.pd/state.db principle_candidates`（+ approvals/activations 生命周期） | diagnostician-committer 唯一生产入口 | 单一权威 ✓ |
| Principle（行为事件流） | trajectory.db `principle_events` | 仅观测语义 | 名义活/实际冻结（09-01 后无新增） |
| Activation | `.pd/state.db activations + activation_*` | safety store 唯一 writer；plugin/host 只读 | **单一权威** ✓ |
| Approval | `.pd/state.db approvals` | sqlite-approval-store 唯一 writer | 单一权威 ✓（live 0 行：本机决策未走该表，与 PRI-629 备忘一致，非数据缺陷） |
| 回执（Applications） | `.pd/state.db principle_applications` | plugin ledger 唯一 writer，flag 门控 | 单一权威 ✓；消费者只有遥测面 |
| 治理观测（Codex） | trajectory.db `governance_*` | host-runtime 唯一 writer | 单一权威 ✓（本机 dormant） |
| 修正样本（训练） | trajectory.db `correction_samples` | plugin mining 唯一 writer | 权威单一，但 **CLI 读链断**（§4.1） |
| Task（管线） | state.db `tasks` | runtime-v2 唯一 | 单一权威 ✓ |
| Task（evolution 语义） | trajectory.db `evolution_tasks` | **无 writer** | 死概念（PRI-737 遗留） |

**总体：每个概念都有唯一权威，未发现「双写对等真相源」。** 存在的问题全部是「断链」与「死数据」，不是「多权威打架」。

---

## 7. Duplicate Data Risk

### 7.1 trajectory vs state —— 判定：**A. 职责不同（分层），非迁移未完成、非重复保存**

- trajectory.db = 行为捕获 + pain 摄取 + 治理观测（证据层，写多读相对薄）；
- state.db = 治理管线状态机 + 决策/生命周期（决策层，读写均衡）。
- 唯一交叠：`session-history-import.ts` 把 OpenClaw 会话 turns 转写成 state.db `runs`（供 `pd history`/`pd context build`），自带 ingest_checkpoint、自述 "COMPATIBILITY IMPORT — not authoritative retrieval"。这是**受控的派生副本**（P4 合规），但见 7.3 风险。

### 7.2 DDL 双份（plugin trajectory.ts vs core pain-signal-observability.ts）

非数据重复，是 **schema 真相源重复**：同一物理库的两套 DDL，注释承认需人工并行更新（`trajectory.ts:151-153`）。漂移后果：core 自举路径建出的表若落后 plugin 版本，后续 plugin ALTER 依赖 try/catch 容错——目前一致，但无机械守卫（仅 `pain-signal-observability.test.ts` 单侧测试）。

### 7.3 state.db `runs` 的双概念承载

`runs` 既是 runtime-v2 管线 run（run-store/lease-manager 写），又是导入会话的容器（session-history-import 写）。`SqliteTrajectoryLocator` 靠 run_id/alias 查它。两类语义共存一表，是**概念重载**而非数据重复；若未来训练导出按 run 粒度取样，需区分 `source`，否则管线 run 与对话 run 会互相混入。

### 7.4 event vs history

不混淆：EventLog JSONL（7 天滚动观测流）≠ trajectory.db 捕获（结构性历史）≠ state.db runs（检索历史）。三者用途、保留策略不同，边界清楚。

### 7.5 文件态小存储

`evolution-scorecard.json`（live 活跃更新、main 无 writer）是当前唯一「来源不明却活跃」的状态文件——最接近「隐性第二真相源」的候选，需核实 installed 运行时版本行为（§11-B）。

---

## 8. Training Data Integrity Risk（ORPO/SimPO 导出视角）

若未来从 trajectory.db 导出 preference pair（correction → bad assistant turn），当前数据面的缺陷清单：

| # | 风险 | 证据 | 严重度 |
|-|-|-|-|
| T1 | **静默空导出**：`listCorrectionSamples` 对不存在的 DB 静默返回 `[]`（`trajectory-store.ts:69-72`）；若导出工具走 core 原语（隐藏路径），将无声导出 0 条且无任何告警 | rc-9 违例模式 | 高 |
| T2 | **样本无原则标注**：mining 写入 `principle_ids_json` 硬编码 `'[]'`（`trajectory.ts:1915` 附近，`.run(..., '[]', ...)`） | attribution 维度缺失 | 高 |
| T3 | **跨库重复样本**：sample_id 去重仅限单库（sha256 内容键 + INSERT OR IGNORE）；若未来从「可见库 + 历史隐藏库/备份/实验室库」合并，同对话可产生多份 pair | trajectory.db.bak-*、pd-labs 库并存 | 中 |
| T4 | **测试/演示数据同构混入**：`e2e-seed.ts`、`demo-story-a-runner.ts`、`pain-flood-simulation-runner.ts` 写入与生产完全同构的表；仓库根 `D:/Code/principles/trajectory.db` 即一次误跑实证。导出工具若以目录为 workspace 参数，一指错就扫进假数据 | live 已现成案例 | 高 |
| T5 | **stale 信号污染筛选**：评分卡（quality-scorecard）读取 `principle_events`（冻结于 09-01）与 `evolution_tasks`（恒空）计算质量分；若以评分卡挑训练样本，等于用死信号筛选 | §5 消费者矩阵 | 中 |
| T6 | **多 writer schema 漂移**：三处 pain/sessions 写入方各自维护列清单容错（`getSessionsColumns`）；导出解析器若按单一 schema 读，可能错位读他方写入的行 | `pain-signal-observability.ts:397-407` | 低 |
| T7 | 回执账本有 90 天类保留清理（`principle-application-ledger.ts:65` sweepRetention），导出若不固定 cutoff，两次导出结果集不可比 | ledger 文件 | 低 |

---

## 9. Dead Data Candidates（全部附证据，按置信度排序）

| # | 对象 | 证据 | 置信度 |
|-|-|-|-|
| 1 | trajectory.db `evolution_tasks` 表 + core `evolution-store.ts` + pd-cli `evolution-tasks-list/show` 命令 | recordEvolutionTask/updateEvolutionTask 全仓零调用方（PRI-737 删 worker 后遗留）；live 0 行 | 高 |
| 2 | trajectory.db `evolution_events` 表 | recordEvolutionEvent 零调用方、零外部读者；live 0 行 | 高 |
| 3 | trajectory.db `task_outcomes` 表 | recordTaskOutcome 零调用方、零读者；live 0 行 | 高 |
| 4 | trajectory.db `trust_changes` 表 | 唯一写入在一次性 `importLegacyEvents()`；无外部读者；live 0 行 | 高 |
| 5 | core 读链隐藏路径 `.state/.trajectory.db` | 全仓唯一引用=trajectory-store.ts:46 / evolution-store.ts:56；live 无此文件；四条 pd-cli 命令永远空转 | 高（断链实证） |
| 6 | live `.state/subagent_workflows.db`（11.8MB） | `runtime-init.ts:294-296` 自述 PRI-737 起不再初始化、"zero producers"、"left untouched" | 高（删除动作需 Owner） |
| 7 | live `~/.openclaw/trajectory.db`（两表旧代） | 06-19 后未动；现役路径在 workspace 内 | 高（删除动作需 Owner） |
| 8 | 主 checkout `D:/Code/principles/trajectory.db` | 仓库根误跑产物（16 表、09-01） | 高（需 Owner 确认非有意保留） |
| 9 | live `.state/evolution_queue.json`（4 字节） | 仅测试 fixture 引用 | 中 |
| 10 | live `.state/evolution-scorecard.json` | main 无 writer，却活跃更新（writer 只能是 installed 旧版） | 中（先核实再处置） |
| 11 | trajectory.db `sample_reviews` | review 链代码活着，但上游 correction_samples live 0 行 | 低（随 T 链决策） |

---

## 10. Protected Assets（禁止误删清单）

以下对象**看起来可能可疑但必须保留**（本审计明确反对按名字清理）：

1. `.pd/state.db` 全部 20 表——含当前 0 行的 `approvals`、`pain_diagnoses`、`intent_*`、`pending_agent_drafts`、`dead_letter_pains`：writer/reader 接线完整且是活跃 SPEC 面（live 0 行 = 本机未触发，不是死链）。
2. trajectory.db 的 `sessions/user_turns/assistant_turns/tool_calls/pain_events`（live 热数据，286 sessions / 4813 tool_calls / 13 pain_events）。
3. `principle_applications` 回执账本（185 行）——PRI-750 Feedback Loop 设计的现成输入，不是死数据。
4. `governance_*` 7 表的 schema 代码——本机未落表是「Codex 链未启用」，不是「已废弃」（codex-adapter 摄取链代码活跃）。
5. `ingest_checkpoint` / `reconciliation_cursor` / `schema_version`——幂等/游标/迁移元数据。
6. `memory/logs` EventLog JSONL——7 天滚动观测流，正在写入。
7. `~/.pd/runtime/**` 与 `~/.openclaw` 宿主自有存储——安装器/宿主资产（AGENTS.md §1.1 硬边界）。

---

## 11. Recommended Follow-up

### A. Delete Ready（Owner 批准后可执行，代码面收敛）

- A1 删除 `evolution_tasks` / `evolution_events` / `task_outcomes` / `trust_changes` 四表及其 DDL、`recordEvolutionTask/updateEvolutionTask/recordEvolutionEvent/recordTaskOutcome/recordTrustChange` 方法、core `evolution-store.ts`、pd-cli `evolution-tasks-*` 命令、quality-scorecard 对死表的 SELECT。
- A2 处置 live 游离文件（Owner 执行）：`subagent_workflows.db`、`~/.openclaw/trajectory.db`、`D:/Code/principles/trajectory.db`、`evolution_queue.json`（遵守 DATA_CLEANUP_GUIDELINES，先备份后删）。
- A3 `importLegacyEvents()` legacy import 路径（ingest_checkpoint 已标记完成的机器上已是死代码路径）——随 A1 一并评估。

### B. Need SPEC（需要设计决策，不宜顺手改）

- B1 **断链读修复**：`trajectory-store.ts` / `evolution-store.ts` 改指可见 `trajectory.db`（与 paths.ts SSoT 对齐）或整体退役 samples CLI——影响 4 条操作员命令，需 Owner 选向。
- B2 **DDL 双份收敛**：让 core 只依赖 plugin 导出的 `initTrajectorySchema`（反转依赖）或抽出共享 schema 模块；同时加「两侧 schema 一致性」机械守卫。
- B3 **回执进决策**：`principle_applications` → promotion/retirement/confidence 反馈环——即 PRI-750 本单的 Feedback Loop 设计，数据面已就绪（185 行真实回执沉淀）。
- B4 **训练导出前置整备**：T1-T7 清单作为导出 SPEC 的验收项（尤其 T1 静默空导出必须改 fail-loud、T2 标注缺失必须补 producer）。
- B5 `evolution-scorecard.json` 来源核实（installed 1.235 运行时 vs main 源码差异），确认后归入 A 或保留。
- B6 `runs` 双概念（管线 run vs 导入会话）在训练/检索语义上的区分规则。

### C. Keep（现状正确，不动）

- trajectory.db / state.db 双库分层架构本身（§7.1 判定 A）。
- pain 三入口汇聚 + canonical_pain_id 去重设计。
- `principle_applications` 账本及其 flag 门控。
- EventLog JSONL 观测流、文件态小存储（pain_settings/hygiene-stats/principle_training_state）。
- state.db 当前 0 行但接线完整的治理表。

---

## 12. 方法学备注（给后续审计者的教训）

1. **单行 grep 会在 SQLite SQL 上说谎**：`INSERT OR IGNORE INTO` / `INSERT OR REPLACE INTO` 不匹配 `INSERT INTO <table>`。本轮因此两次险些误判（`principle_applications`、`correction_samples`）。最终 Writer Matrix 以宽松模式 `INSERT( OR [A-Z_]+)? INTO [a-z_]+` 全量重扫为准。**任何「零 writer」结论必须经过 OR 变体复扫。**
2. 不信文件名/模块名：`SqliteTrajectoryLocator` 查的是 state.db 的 runs/tasks（不是 trajectory.db）；`pain-signal-observability.ts` 名为观测实为生产 writer。
3. Live 判定必须独立于代码存在：correction_samples writer 活着但 live 0 行；governance_* 代码活着但 live 未落表——「代码在」≠「数据流在」。
4. 工具环境：Mimosa hook 会拦截命令文本中出现源码路径的 Bash 调用（哪怕只是 sed 只读）——读源码片段用 Read 工具。

---

## 附：Live 实证原始数据（2026-09-12 01:11–01:20 采集）

trajectory.db（可见）：sessions 286 (max 09-11T17:12) / assistant_turns 1068 / user_turns 451 / tool_calls 4813 / pain_events 13 (09-11T07:55) / correction_samples 0 / sample_reviews 0 / principle_events 117 (max 09-01T11:17) / task_outcomes 0 / trust_changes 0 / gate_blocks 0 / evolution_tasks 0 / evolution_events 0 / exports_audit 0 / ingest_checkpoint 3 (max 09-01T12:26)；governance_% 表：不存在。

state.db（schema_version=3）：tasks 198 / runs 254 / artifacts 13 / pi_artifacts 162 / principle_candidates 42 / principle_applications 185 / approvals 0 / activations 1 / activation_control_states 0 / activation_decisions 0 / activation_evidence_snapshots 0 / pain_diagnoses 0 / dead_letter_pains 0 / intent_decisions 0 / intent_doc_versions 0 / reconciliation_cursor 1 / pending_agent_drafts 0 / global_rulecode_pauses 0 / commits 13。
