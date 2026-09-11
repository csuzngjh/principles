# PRI-736 Evolution Status Reality Audit

> 日期：2026-09-11
> 性质：**只读 Reality Audit**。无代码修改、无删除、无 migration、无 flag 变更。
> 关联：Linear「PD 产品瘦身与架构收敛」；前置审计 `PRI-731-evolution-worker-reality-audit.md`（本审计对其结论做了独立复核，未照抄）。

---

## 1. Baseline

```
commit: e144d21f9e3121f8c0446335c65375e4726ed2d0 (= origin/main, 2026-09-11)
```

- 本地 main 自 `b789b4463` fast-forward 60 个 commit 至 `e144d21f9`。
- 基线内已包含 **PR #1606（PRI-735）：停止向 legacy evolution logger 双写 pain 事件** ——本审计按当前代码口径取证。

---

## 2. Current topology

### 2.1 唯一真实 surface：OpenClaw 斜杠命令 `/pd-evolution-status`

```
OpenClaw chat
 └─ openclaw-plugin/src/index.ts:897-910   registerCommand("pd-evolution-status")（无条件注册，无 flag 门）
     └─ src/commands/evolution-status.ts:194   handleEvolutionStatusCommand()
         ├─ src/core/workspace-context.ts:106      WorkspaceContext.evolutionReducer（懒构造 EvolutionReducerImpl）
         ├─ src/core/evolution-reducer.ts:612      reducer.getStats()（原则计数）
         ├─ src/service/runtime-summary-service.ts RuntimeSummaryService.getSummary()（988 行，全部数据装配）
         │    ├─ {stateDir}/.state/evolution_queue.json        进化队列（:347）
         │    ├─ {stateDir}/.state/evolution_directive.json    legacy 指令文件（:350，仅兼容展示）
         │    ├─ {stateDir}/.principles/db/task-store.db       诊断链 pending 计数（:371-382，readonly）
         │    ├─ {stateDir}/logs/daily-stats.json              当日计数（:236-239）
         │    ├─ {stateDir}/logs/events_YYYY-MM-DD.jsonl       事件日志（:229 → readEvents :654）
         │    └─ session-tracker 持久化会话状态                 GFI
         └─ principleLifecycle.recomputeAll()                  内化路由建议（Runtime-v2 lifecycle read-model）
```

### 2.2 明确不存在的 surface（全仓零命中，按关键词逐一验证）

| 关键词/候选 surface | 结果 |
| --- | --- |
| `evolution dashboard`（全仓） | **零命中** —— 不存在任何 dashboard 页面 |
| pd-console server routes / API（`rg -i evolution pd-console/src/server`） | **零命中** —— Console 无任何 evolution API/route/read-model |
| pd-cli evolution-status 命令 | 不存在（pd-cli 另有 `evolution tasks list/show`，读 `.state/.trajectory.db`，属 trajectory 三轨问题，见 §7） |
| e2e feature-testing 场景引用 evolution-status | **零命中** |
| Console 页面级 evolution 组件 | 不存在。`PrinciplesPage.tsx:125` 的 `EvolutionBlock` 是原则卡叙事块（PRI-558），`FocusPage.tsx:303` 仅注释，`enum-labels.ts:95-96` 仅 i18n 标签 |

---

## 3. Consumers

| Consumer | 文件 | 是否真实使用 |
| --- | --- | --- |
| OpenClaw 命令注册表（Owner 可在 chat 调用） | `openclaw-plugin/src/index.ts:899` | YES（入口存在，无条件注册） |
| Console onboarding 卡片 | `pd-console/src/ui/components/onboarding/slashCommands.ts:28` + i18n（zh-CN/en.json） | 仅宣传文案（文本列表），非数据消费 |
| Console onboarding 测试 | `pd-console/tests/ui/components/SlashCommandsCard.test.ts` | 测试依赖（随删） |
| pd-mentor 技能模板（安装到用户 workspace） | `templates/langs/{en,zh}/skills/pd-mentor/SKILL.md:31/58/69/81` | YES —— **主动指示 agent 使用该命令**，且描述已失真（宣称"EP 等级/信任积分"，实际输出无此内容） |
| 插件 SKILL.md | `openclaw-plugin/SKILL.md:25,29` | 文档 |
| README / user-guide / COMMAND_REFERENCE（en+zh） | `packages/website/docs/user-guide.md` 等 | 文档 |
| flag 治理元数据 | `principles-core/.../feature-flag-lifecycle.ts:98`（`gfi` 的 consumers 列表） | 元数据引用 |
| 插件单元测试 | `openclaw-plugin/tests/commands/evolution-status.test.ts`（9 处）、`tests/index.test.ts`（注册断言） | 测试依赖（随删） |
| **RuntimeSummaryService 的生产消费者** | — | **仅 evolution-status 命令一个**（全仓唯一） |
| Console / host-runtime / pd-cli 对本命令数据的程序化消费 | — | **无** |
| e2e | — | **无** |

---

## 4. Data dependency（逐段核实：今天谁写、谁读、live 有没有数据）

Live 取证（2026-09-11，只读）覆盖 `~/.openclaw`、`~/.pd`、`D:/Code/principles/.pd`、`D:/workspace`：

### 4.1 逐段裁定

| 输出段 | 数据源 | 生产者现状 | live 实况 | 裁定 |
| --- | --- | --- | --- | --- |
| Control Plane / GFI | session-tracker 持久化 + `logs/events_*.jsonl` | 事件链唯一写方 = Runtime-v2 `pain-signal-observability.ts:474`；GFI 评分 flag `gfi` **默认 false**（`feature-flag-contract.ts:239`，2026-05-24 起），且全仓未发现该 flag 的运行时门消费点（治理元数据而已）；新 GFI 权威已是 runtime-v2 gfi read-model（`pd runtime health gfi`） | events 最新文件 **2026-08-16**，此后 27 天零写入；当前 live workspace 无 logs 目录 | **死亡（陈旧）** |
| 最近 Pain 信号 / Gate 事件 | 同上 events_*.jsonl | 同上 | 同上 | **死亡（陈旧）** |
| 进化队列 | `.state/evolution_queue.json` | **全仓零生产者**：唯一入队函数 `registerEvolutionTaskSession` 无调用者（独立复核证实 PRI-731 结论）；worker 心跳被 `evolution_worker` flag 默认关闭（:240）；`hooks/trajectory-collector.ts` 的 enqueue 是其自有 SQLite 写队列，与该队列无关 | 全机不存在该文件 | **结构性死亡** |
| Legacy Directive / Phase 3 | `evolution_directive.json` + 空队列 | 指令文件无写入方；输出自述 "compatibility-only display artifact"、"queue is only truth source" | 全机不存在 | **结构性死亡**（输出自己承认是兼容展示） |
| Heartbeat 诊断链 | `.principles/db/task-store.db` + daily-stats | `task-store.db` **全仓唯一引用就是这次读取，无任何写入方**（Runtime-v2 任务实际存于 state.db）；daily-stats 的 `evolution.*` 计数（诊断任务/报告/候选/心跳）在全部 32 天历史（2026-06-10→08-16）中**恒为 0** | 文件不存在 → 恒 0 | **双重死亡（结构 + 经验）** |
| 原则统计（candidate/probation/active/deprecated） | `EvolutionReducer` 重放 `memory/evolution.jsonl` | 流中仅 `pain_detected` 有生产者（observability writer + pain 命令/hook `emitSync`）；`candidate_created` **全仓零生产者** → 原则集合永远为空 → `getActivePrinciples()` 恒 `[]` | `D:/Code/principles/memory/evolution.jsonl` 35 行全是 pain_detected（6 月 9 条有机 + 09-01 26 条同一手工测试） | **结构性死亡** |
| 内化路由建议 | `principleLifecycle.recomputeAll()` → Runtime-v2 `buildLifecycleReadModel` | **活机制**（Runtime-v2 自有 read-model，status 只是搭车消费） | live 数据为空 → 恒空 | 机制活，但属 Runtime-v2，不构成本命令的存在理由 |
| Workflow Funnels | per-workspace WORKFLOWS_YAML | 可选 | 不存在 → 段落跳过 | 空 |

### 4.2 双写问题（任务重点）

任务假设的 `Pain → eventLog + evolution logger` 双写：**曾经存在，PRI-735（PR #1606）已于本基线内移除**（`hooks/pain.ts`、`hooks/after-tool-call-helpers.ts`，−26 行）。

现状：pain 信号由**单一写方**（`pain-signal-observability.ts`）扇出三个汇：

1. `logs/events_*.jsonl` —— 本命令读取（但其内容段已死，见 4.1）；daily-stats 同源；
2. `memory/evolution.jsonl` —— 唯一读者是 legacy EvolutionReducer，而其生命周期事件零生产者 → **写了没人能有效读的孤儿汇**；
3. `trajectory.db pain_events` —— trajectory 三轨收敛（PRI-730 SPEC 范畴，不在本审计裁决）。

另：~~PRI-735 之后 `core/evolution-logger.ts`（EvolutionLogger 类）**全仓零生产调用者**（仅测试 globalSetup 的 dispose 引用），是残留死代码。~~ **【执行期更正 2026-09-11】**：上述"零调用者"结论系 Phase 0 检索输出被截断所致，**不成立**。`createTraceId()`（同模块导出）有 3 个生产消费者：`hooks/pain.ts:25`（pain 管线）、`core/signal-collector-host.ts:42`、`hooks/after-tool-call-helpers.ts:23`。故 evolution-logger 模块**不可随本链删除**；EvolutionLogger 类本身的退役（createTraceId 迁往中性工具模块后）另立 follow-up。

### 4.3 与 worker 的耦合（纠正一个常见误判）

- evolution-status 命令**不依赖 worker 进程**（只读文件，且不读 `worker-status.json`）——删 status 不影响 worker 退役节奏；反之亦然。
- `worker-status.json` 的唯一读取方是 `pd-cli errors-list.ts:149`（读 errors 数组）——这属于 **worker 链（PRI-731/PRI-737 之外另计）** 的删除影响，与本命令无关。

---

## 5. Reality conclusion

**Decision: DELETE READY**（经 PRI-737 工单、Owner 批准后执行物理删除）

判定依据（对照任务三分类）：

1. **无生产消费者** —— 唯一程序化消费者为零；"消费"它的只有宣传面（onboarding 文案、技能模板、文档）和它自己的测试。
2. **无数据链路** —— 7 个数据段中 6 个结构性死亡（零生产者或读取无人创建的文件）或陈旧死亡（27 天零写入、评分 flag 默认关、权威已迁 Runtime-v2）；唯一活段（内化路由）是 Runtime-v2 自有 read-model 的搭车展示。
3. **无运行时耦合** —— runtime hooks、console server、host-runtime、pain pipeline、activation、RuleHost 无任何 import/调用；纯只读展示，无自有持久化，删除无数据迁移风险。
4. **每次展示都是负价值** —— 新 Owner 按 onboarding 指引运行它，看到的是全零 + '---' + 警告，并被暗示存在一套与 Runtime-v2 并行的"进化引擎"（正是 PRI-731 执行摘要点名的误导源）。pd-mentor 模板还在用失真描述（"EP 等级/信任积分"）主动引导调用。

诚实边界：仓库内无命令调用 telemetry，**无法证明 Owner 从未手动运行过该命令**。故不在本审计内直接删除，走 PRI-737 由 Owner 最终裁决——这也符合任务预设流程。

对比说明：不选 KEEP（非核心能力：核心原则注入走 Runtime-v2 `PromptActivationReader`，`prompt.ts:580-615` 中 legacy reducer 仅作永远为空的去重集）；不选 DEPRECATE FIRST（纯只读、零状态，删除不存在数据迁移或回滚窗口价值；入口文案/模板更新在删除 PR 内一并完成即可，保留一个全零命令的"退役期"只延长误导）。

---

## 6. Evidence（file:line 索引）

Surface 与消费者：

- `packages/openclaw-plugin/src/index.ts:897-910` —— 命令注册（无条件）
- `packages/openclaw-plugin/src/commands/evolution-status.ts:194` —— handler；`:54/:125` EN/ZH 输出
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` —— 988 行数据装配；唯一消费者=本命令
- `packages/pd-console/src/ui/components/onboarding/slashCommands.ts:28` —— onboarding 宣传
- `packages/openclaw-plugin/templates/langs/{en,zh}/skills/pd-mentor/SKILL.md:31,58,69,81` —— 技能模板引导（描述失真）
- `packages/openclaw-plugin/SKILL.md:25`、`packages/website/{zh/,}docs/user-guide.md`、`packages/openclaw-plugin/docs/COMMAND_REFERENCE{,_EN}.md` —— 文档面
- `packages/openclaw-plugin/tests/commands/evolution-status.test.ts`、`tests/index.test.ts`、`packages/pd-console/tests/ui/components/SlashCommandsCard.test.ts` —— 测试面

数据链与死亡证据：

- 队列零生产者：`rg registerEvolutionTaskSession` 全仓仅定义；`service/evolution-worker.ts:433-437`（pain_diagnosis 项被显式丢弃）
- `task-store.db` 全仓唯一引用：`runtime-summary-service.ts:371`（无写入方）
- `feature-flag-contract.ts:239`（gfi 默认 false）、`:240`（evolution_worker 默认 false）；`feature-flag-lifecycle.ts:98`（gfi consumers 列含本命令）
- reducer 生命周期事件零生产者：`core/evolution-reducer.ts:383`（candidate_created 仅内部方法）、`promote :177/:236/:399` 只能提升"已存在"原则；`hooks/prompt.ts:55,580-615`（legacy 注入集为 Runtime-v2 的空去重集）
- pain 观测单写方三汇：`principles-core/src/runtime-v2/pain-signal-observability.ts:474,497,507`
- PRI-735 双写移除：PR #1606（`hooks/pain.ts`、`hooks/after-tool-call-helpers.ts`）
- `worker-status.json` 读取方= `pd-cli/src/commands/errors-list.ts:149`（worker 链，非本命令）
- `pd evolution tasks list/show` 读 `.state/.trajectory.db`：`principles-core/src/evolution-store.ts:56`
- EvolutionLogger 残留：~~`core/evolution-logger.ts`（零生产调用者）~~（执行期更正：`createTraceId` 有生产消费者，见 §4.2——模块不删，类退役另立 follow-up）

Live 取证（2026-09-11，只读）：

- `~/.openclaw/logs/`：events_2026-06→**08-16**（最新 08-16）；daily-stats.json 覆盖 2026-06-10→08-16 共 32 天，`evolution.*` 诊断计数全 0
- 全机不存在：`evolution_queue.json`、`worker-status.json`、`task-store.db`、`evolution_directive.json`、`~/.openclaw/.pd/`
- `D:/Code/principles/memory/evolution.jsonl`：35 行全部 pain_detected（9 条 6 月有机 + 26 条 09-01 手工测试残留）
- `D:/Code/principles/.pd/`：state.db 存在但全表空（PRI-731 同日 readonly 复核），无 logs、无 `.principles/`

---

## 7. Next action recommendation

**PRI-737 Evolution Status Removal**（已建单，挂「PD架构瘦身」）。建议删除范围（一个 PR 内闭环）：

1. 命令注册 + handler：`index.ts:897-910`、`commands/evolution-status.ts`
2. 数据装配：`service/runtime-summary-service.ts`（988 行，唯一消费者随之消失）
3. core 孤儿类型：`principles-core/src/runtime-v2/types/runtime-summary-types.ts` + 两处 barrel re-export（跨包契约变更，按 §19 全量核验消费者——当前证据显示仅 plugin service 消费）
4. 宣传面同步：Console onboarding 卡片条目 + i18n + `SlashCommandsCard.test.ts`、插件 i18n `commands.ts`、`SKILL.md`、pd-mentor 模板（en/zh）、user-guide（en/zh）、README、COMMAND_REFERENCE
5. 测试：`evolution-status.test.ts` 删除、`index.test.ts` 注册断言更新
6. flag 元数据：`feature-flag-lifecycle.ts:98` gfi consumers 移除本命令（metadata-only）
7. 孤儿汇处置决策（在执行单内明确，勿静默遗留）：`memory/evolution.jsonl` 写汇与 `logs/daily-stats.json` 的 evolution 计数累积在删除后失去读者——建议随本单评估一并摘除，或显式移交 PRI-730 trajectory/telemetry 三轨收敛；`core/evolution-logger.ts` 因 `createTraceId` 有 pain 管线/信号采集生产消费者（见 §4.2 执行期更正），**不删除**，类退役另立 follow-up

不在本单范围（另立）：worker 链本体（PRI-731 已建议 DEPRECATE，等 2026-12-01 隔离窗口）、`pd evolution tasks list/show` 与 trajectory.db（PRI-730 三轨收敛）、Console PrinciplesPage 的 EvolutionBlock 叙事块（PRI-558，数据来自 Runtime-v2，非本链）。

验证方式建议：删除后 `verify:merge` 全绿 + OpenClaw 冒烟确认 `/pd-evolution-status` 返回未知命令 + `rg -i "evolution.?status"` 全仓仅剩历史文档命中。
