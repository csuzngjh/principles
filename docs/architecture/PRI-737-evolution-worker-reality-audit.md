# PRI-737 Evolution Worker Reality Audit（Phase 0 —— 链本体删除前复审）

> 日期：2026-09-11
> 基线：`origin/main` `cfe2ac132`（PR #1609 / PRI-736 合并后）。
> 说明：本机主 checkout 落后于 origin/main（停在 `e144d21f9`），本审计全部源码证据通过 `git grep` / `git show origin/main` 取自 fetched ref，未改动主 checkout。live 数据为只读取证。
> 性质：**只读审查**。无代码修改、无 flag 变更、无 PR、无数据库/runtime 数据变更。
> 前序：PRI-731 审计（基线 `403722fc3`，已合入 main）判决 DEPRECATE + 三步解缠。本审计是解缠 2/3（PRI-735，#1606）、3/3（PRI-736，#1609）落地后的删除前复审，即本工单（PRI-737 = 链本体删除主工单）的执行前置。

---

## 1. Executive Summary

**结论：A. DELETE READY —— Evolution Worker 已是历史遗留系统，可以进入物理删除阶段；风险 Low。** 但 Linear 工单上登记的删除范围需要修正：`evolution-reducer.ts` 与 `principle-compiler/*` 是活链共享资产**不可随 worker 删除**，需移出 scope；同时有几处工单未列的删除面（workflow-debug、runtime-init 安装契约、console 标签、python 化石）。

核心证据（全部可复现）：

1. **启动 flag 默认关闭且从未开启**：`evolution_worker` 在正式 flag 契约内 `enabled: false`（`feature-flag-contract.ts:240`，since 2026-06-01）；live workspace config `D:\.openclaw\workspace\.pd\config.yaml:41-43` 显式 `enabled: false`。
2. **worker 在生产从未完成过任何一个周期**：心跳每周期无条件写 `.state/worker-status.json`（`evolution-worker.ts:542`）——该文件在本机全盘不存在。
3. **任务生产者缺位，链路中段是孤岛**：唯一入队函数 `registerEvolutionTaskSession`（`evolution-worker.ts:470`）全仓零调用；`processEvolutionQueue` 现在只做"迁移 V2 → 丢弃 pain_diagnosis → 校验 → 保存"，**不执行任何任务**（旧处理器已在 PRI-451/D-05/06 删除）。
4. **workflow 清扫对象无生产者**：`WorkflowStore.createWorkflow` 生产代码零调用（仅 `pd runtime init` 建空 schema）；live `subagent_workflows.db`（11.8MB）冻结于 2026-05-13。
5. **进化职责已由 Runtime-v2 源码级接管**：pain 诊断（worker 主动丢弃 pain_diagnosis 项，`:424`）、原则形成（pain hook → reducer emitSync）、rule 生成（Artificer）、面板（Console read-models，PRI-736 收敛）。
6. **删除不触碰受保护链路**：worker 对 Runtime-v2 `state.db` 零写入；RuleHost 的 `evolution.epTier` 契约字段已改为常量 `EvolutionTier.Seed`（PRI-731/734），与 worker 无耦合；Activation / Host governance 无接触。

唯一治理注意点：flag lifecycle SSoT 记录的退役标准是"6 个月零激活窗口至 **2026-12-01** 关闭"（`feature-flag-lifecycle.ts:104-111`）。两代审计（PRI-731、本审计）已证明"零激活"为全量事实而非窗口观测，提前删除需要 Owner 在删除 PR 中对该 lifecycle 条目做显式退役决策记录（见 §6/§7）。

---

## 2. Current Topology（真实架构图）

```
OpenClaw startup
  └─ plugin register (openclaw-plugin/src/index.ts)
       └─ before_prompt_build hook（每个 workspace 首次触发，:351 startedWorkspaces 守卫）
            ├─ shouldStartEvolutionWorker (index.ts:105)
            │    └─ 读 flag 'evolution_worker'（经 host-runtime pd-config 正式契约计算）
            │
            ├─【live 实况】flag=false → 结构化日志 EVOLUTION_WORKER_DISABLED（:371-373）→ 结束
            │
            └─【仅手工开启后】EvolutionWorkerService.start (service/evolution-worker.ts:607)
                 ├─ initialDelay 5s 首跑（:753）+ 每 15min setTimeout 自续（:638/:749）
                 │
                 └─ runCycle (:643)
                      ├─ processCompilationBackfill (:172)
                      │    唯一的 compilationRetryCount 重试环 owner
                      │    （reducer 同步编译失败置 count=0 → 依赖此环重试）
                      ├─ processEvolutionQueue (:387→:555)
                      │    读 .state/evolution_queue.json → V2 迁移 → 丢弃 pain_diagnosis
                      │    → rc-4 校验 → 写回。到此为止，不执行任何任务
                      ├─ WorkflowStore TTL 清扫（:682，删子会话/置 expired）
                      ├─ runWorkflowWatchdog（:722 → workflow-watchdog.ts）
                      ├─ dictionary.flush + flushAllSessions（:731-732）
                      └─ writeWorkerStatus → .state/worker-status.json（:542，全仓零读者）
```

**不存在完整链路，必须明确**：本链路只有"中段孤岛"——

- 上游（任务生产）：`registerEvolutionTaskSession` 全仓零调用（rg 仅定义与注释命中）。无任何代码路径写入新队列任务。
- 下游（任务执行）：`processDetectionQueue`（PRI-451 Wave 1 删）、`processPromotion`（D-05/06 删）均已移除；pain_diagnosis 项被主动丢弃。
- workflow 分支：`createWorkflow` 生产代码零调用 → 清扫/看门狗面向的是无人再生产的冻结库。

---

## 3. Producer / Consumer Matrix

| 组件 | 生产者 | 消费者 | 状态 |
| --- | --- | --- | --- |
| `evolution_worker` flag | 用户编辑 config.yaml | plugin 启动门（index.ts:109）经正式契约 | **默认 off，live off**；lifecycle 记录退役标准 2026-12-01 |
| `EvolutionWorkerService` 心跳 | flag 门（唯一入口） | 无（产物零读者） | 生产从未启动 |
| `evolution_queue.json` | **零**（唯一入队函数零调用） | worker（清理写回） | live 为 `[]`（4 字节）；链路孤岛 |
| `evolution_directive.json` | **零**（源码自认 compatibility-only display artifact，`:508-513`） | 唯一读者 runtime-summary-service 已随 PRI-736 删除 → **main 上零读者**，仅剩 paths 定义 | 死文件 |
| `memory/evolution.jsonl` | **Runtime-v2** pain-signal-observability（`pain-signal-observability.ts:497`）+ manual pain record | reducer 事件溯源（importLegacyEvolution 一次性导入） | **活流**（live 最后写入 2026-09-09），owner 非 worker，**不得删除** |
| `subagent_workflows.db` | **零**（createWorkflow 零调用） | worker 清扫/watchdog、`pd workflow-debug` 命令 | live 冻结于 2026-05-13 |
| trajectory.db `evolution_tasks` 表 | **零**（唯一 INSERT `recordTaskOutcome`（trajectory.ts:782/804）零调用） | `pd evolution tasks list/show`（hidden CLI）、quality-scorecard data-extractor（容错读取） | 表冻结，为历史数据只读面 |
| `worker-status.json` | worker 心跳（无条件） | **零读者** | live 不存在 → worker 从未跑过 |
| `evolution_engine`（EvolutionEngine/epTier 分数） | hooks recordEvolution* 已零调用 | gate.ts epTier 已改常量 Seed（PRI-734）；src 零 importer（仅测试+注释） | src 死代码 |
| `EvolutionLogger` 类 | `createEvolutionLogger` 零调用 | 仅 `createTraceId` 工具函数被 3 个 hook import | 类死、traceId 活 |
| `evolution-reducer` | pain hook emitSync / probation 反馈 | prompt 注入去重（prompt.ts:593）、after-tool-call、pain.ts | **活链共享资产，不可删** |
| `principle-compiler/*` | reducer 同步编译（活）、worker backfill（死） | ledger implementations/rules | **活链共享资产，不可删** |

---

## 4. Data Reality（live 只读取证，2026-09-11）

真实 OpenClaw workspace = `D:\.openclaw\workspace`（openclaw.json 配置）。

| 数据项 | 实况 | 判定 |
| --- | --- | --- |
| `.state/evolution_queue.json` | 存在，**4 字节 = `[]`**（2026-09-04） | 空队列，零生产实证 |
| `.state/worker-status.json` | **不存在**（心跳首周期即会写入） | worker 从未完成任何周期 |
| `.state/COMPILATION_BACKFILL_DONE` | 不存在 | 编译补偿从未运行 |
| `.state/evolution_directive.json` | 不存在 | 死 artifact 连文件都未生成过 |
| `.state/subagent_workflows.db` | 11.8MB，mtime **2026-05-13** | 冻结遗留库 |
| `.state/trajectory.db` (+wal) | 7.6MB，mtime **2026-09-11（活跃）** | hooks trajectory 采集（PRI-346）是活能力，**与 worker 无关，不得删**；其 `evolution_tasks` 表因 writer 零调用而冻结 |
| `memory/evolution.jsonl` | 存在，最后写入 2026-09-09（manual pain_detected） | Runtime-v2/pain 管线活流，保留 |
| `.pd/state.db`（workspace） | 活跃（Runtime-v2 主库） | worker 零接触 |
| `D:\Code\principles\.pd\state.db` | 活跃（该 workspace 的 Runtime-v2 库） | 同上 |

---

## 5. Runtime-v2 Relationship（替代映射）

| 旧能力（worker/旧链） | 当前替代 | 判定 |
| --- | --- | --- |
| pain 诊断任务（queue pain_diagnosis） | PainSignalBridge → SplitDiagnosticianRunner（state.db pain_diagnoses） | 已替代；worker 现在主动丢弃该类队列项（`:424`） |
| 原则形成（PAIN_CANDIDATES 提升，D-05/06 已删） | pain hook → reducer `emitSync` → ledger + runtime-v2 principle_candidates | 已替代；reducer 是活链（保留） |
| rule/implementation 生成（模板编译） | Runtime-v2 Artificer（LLM 生成 implementationCode）+ Evaluator 门 | 已替代为唯一产品路径；模板 `PrincipleCompiler` 因 reducer 同步编译共用而保留本体 |
| 编译失败重试（worker backfill 心跳） | **无** —— 重试环唯一 owner 就是 worker；但 live worker 从未启动，现实本来就是"单次同步编译"语义 | 删除=把既成事实显式化；需修正 reducer 内"heartbeat backfill will retry"陈旧注释；是否把重试纳入 Runtime-v2 internalization 另立 follow-up |
| 状态展示（evolution-status 面板） | Console read-models | PRI-736 已删除旧面板链 |
| workflow 子会话编排/清扫 | 无生产者；Runtime-v2 runner 体系自足 | 空转，随删 |
| epTier 行为信号 | 恒定 `EvolutionTier.Seed`（PRI-734），RuleHost 契约字段保留 | 已解缠 |
| 任务队列机制本身 | 无对应物（四 TaskKind 全部零生产者） | 无迁移需求 |

**总判定：Runtime-v2 已覆盖 worker 名义上的全部产品职责；worker 当前真实职责只剩"对一个零生产队列做 janitor + 清扫一个冻结库 + 写一个零读者状态文件"。**

---

## 6. Risk Assessment

**总体：Low**（按 §7 修正后范围执行的前提）。

| 风险点 | 等级 | 依据 |
| --- | --- | --- |
| Pain pipeline / Runtime-v2 / Activation / Host governance | 无 | worker 对 state.db 零写入、不读 pain 链产物、不触碰 activations；pain 链与 worker 唯一历史耦合（.pain_flag→prompt 路径）已被 worker 自己主动丢弃 |
| RuleHost | 无 | `evolution.epTier` 契约字段由常量供给（gate.ts:446-451），删除 worker 不影响 `rule-implementation-runtime` 生成的 `getEpTier()` 读取 |
| 误删活链共享资产 | **中（本审计消除）** | Linear 工单原 scope 含 `evolution-reducer.ts`(882) 与 `principle-compiler/*`——二者是活链资产（prompt 注入、probation 反馈、同步编译），必须移出删除范围（见 §7 修正） |
| 跨包契约 | 低（有明确清单） | plugin index.ts:1055 `export { initWorkflowSchema }` → `pd-cli runtime-init.ts:25,293-304` 调用 + 安装器契约测试 `create-principles-disciple/tests/mvp-config.test.ts:2124-2132` 断言该导出存在。删除需同步改三处 |
| flag 治理 | 低（需 Owner 动作） | lifecycle `retirementCriteria: ... 2026-12-01`。提前退役成立的技术前提（零激活全量证据）已具备，但属对既定 quiet-flag 生命周期标准的提前关闭，应在删除 PR 的 lifecycle 条目中记录显式决策 + 两代审计证据（§16 要求 lifecycle 元数据随退役更新） |
| 数据处置 | 低 | live `evolution_queue.json`([]) 与冻结的 `subagent_workflows.db`：按 DATA_CLEANUP_GUIDELINES 默认保留、不顺手删 runtime 数据；删除 PR 只删代码与 schema 初始化 |
| 编译重试语义显式退化 | 低 | 现实中重试环从未运行过；删除后 reducer 注释需同步修正，避免下一轮审计再误判 |

---

## 7. Recommendation

**进入物理删除阶段（对应本工单 PRI-737 主交付）。范围按本审计修正后执行。**

### 7.1 范围修正（Reality Audit correction，相对 Linear 工单原 scope）

工单原 scope（创建时照抄 PRI-731 G 簇）需要两处收窄、若干处补充：

- **移出 scope（不可删）**：
  - `evolution-reducer.ts`（882）——活链：prompt 注入去重（prompt.ts:593）、pain.ts emitSync、after-tool-call probation 反馈。PRI-736 只删除了它的 evolution-status 消费者，主体仍在役。
  - `principle-compiler/*`——reducer 同步编译（活路径）仍在用；worker backfill 只是它的第二个消费者。
  - `core/evolution-types.ts`、`trajectory-types.ts`——pain/trajectory 活链共享类型。
- **补充进 scope（工单未列，实证可删）**：
  - `commands/workflow-debug.ts`（154）+ 其测试——唯一生产消费者是 WorkflowStore 死库。
  - plugin `index.ts:1055` 导出 `initWorkflowSchema` + `pd-cli runtime-init.ts` workflow schema 块 + 安装器 `mvp-config.test.ts` 契约断言（三处联动）。
  - `pd-console enum-labels.ts:96` `'evolution_worker': '进化工作器'` 标签；`pd-cli errors-list.ts:61` 注释引用。
  - `tests/globalSetup.ts:10`（disposeAllEvolutionEngines）。
  - `scripts/pipeline-health.ts:61-63` 对 evolution_queue/directive 文件的巡检引用。
  - repo 根化石：`scripts/evolution_daemon.py`（363）+ `tests/test_evolution_daemon.py`（95）。
- **保留但需改注释**：reducer 内"heartbeat backfill will retry automatically"（编译重试环随 worker 消失，改述单次同步编译语义）。

### 7.2 删除收益（按修正后 scope，origin/main 计量）

| 项 | 数量 |
| --- | --- |
| src 删除（TS） | ≈ 3,133 LOC：worker 簇 2,173（worker 777 / queue-io 120 / queue-migration 153 / dedup 74 / watchdog 174 / subagent-workflow 721 / workflow-debug 154）+ engine 613 + logger 347（保留 ~10 行 createTraceId 迁往 utils） |
| src 删除（python 化石） | 458 LOC |
| in-file 删减 | ≈ 100 LOC（gate 函数 ~45、flag 契约/lifecycle/surface-registry ~26、paths/path-resolver/migration 条目 ~8、runtime-init ~15、零散注释） |
| 测试删除/调整 | ≈ 5,100 LOC（worker 簇 4,510 + engine 610 + globalSetup/安装器契约调整） |
| flag | −1（evolution_worker 全套：contract + lifecycle + surface-registry×2 + console 标签） |
| 死导出 | −2（registerEvolutionTaskSession、initWorkflowSchema 包导出） |
| 认知收益 | 消灭"两代进化架构并存"假象：queue schema 的四种 TaskKind（实际零生产）、"编译重试环"幽灵、孤岛 worker 目录不再诱导新会话误判（PRI-731 已记录两起真实误判案例） |

### 7.3 执行建议

1. 单一删除 PR（或 worker 簇 + engine/logger 两段小序列），纯删除 + §7.1 三处联动调整 + lifecycle 条目退役记录（注明 Owner 决策与本文档/PRI-731 证据）。
2. 删除 PR 内不触碰任何 runtime 数据文件；live 的空 queue 与冻结 workflow db 处置另按 DATA_CLEANUP_GUIDELINES 走 Owner 决策。
3. follow-up（不在本工单）：trajectory 三轨收敛（PRI-730 已登记）；`pd evolution tasks` CLI 与 quality-scorecard 对冻结 `evolution_tasks` 表的只读消费是否保留，属数据保留政策，单独立项。
4. 若 Owner 倾向保守：亦可等 2026-12-01 窗口自然关闭后执行同一天删除方案——技术内容完全一致，唯一差异是 lifecycle 条目无需提前关闭。**两代审计已把"再等三个月"的信息增益降为零，建议直接执行。**

---

## 附：关键取证命令（可复现）

```bash
# 基线（本机 checkout 落后，全部用 origin/main ref 取证）
git grep -n "registerEvolutionTaskSession" origin/main -- packages   # 仅定义+注释
git grep -n "createWorkflow"        origin/main -- packages          # 生产零调用
git grep -n "recordTaskOutcome"     origin/main -- packages          # 零调用
git grep -n "createEvolutionLogger" origin/main -- packages          # 零调用
git grep -n "evolution_worker"      origin/main -- packages/principles-core/src/runtime-v2/feature-flags/
git show origin/main:packages/openclaw-plugin/src/hooks/gate.ts | sed -n '440,455p'   # epTier=Seed 常量

# live 只读
cat  "D:/.openclaw/workspace/.state/evolution_queue.json"            # []
cat  "D:/.openclaw/workspace/.pd/config.yaml" | sed -n '41,43p'      # evolution_worker: enabled false
ls   "D:/.openclaw/workspace/.state/"                                # 无 worker-status.json
ls -la "D:/.openclaw/workspace/.state/subagent_workflows.db"         # 冻结 2026-05-13
tail -1 "D:/.openclaw/workspace/memory/evolution.jsonl"              # Runtime-v2 活流
```
