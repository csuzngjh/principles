# GFI 彻底移除 — Stage 1/2 独立审计报告

任务：GFI-COMPLETE-REMOVAL-001
基线：`origin/main` @ `35d12815b`
方法：全仓符号扫描 → 生产链路逐层追踪 → 真实数据库只读检查 → 与 SPEC 逐条对照
标注规则：**【实测】**=本地代码/数据库直接证据；**【推断】**=基于代码结构但未运行验证；**【查不到】**=无证据

---

## 0. 结论先行

1. GFI 是**单一写入者、有限读者**的内部评分系统：写入只发生在 `openclaw-plugin`，
   核心状态只存在于 Session JSON、`EventLog` 日统计、`tool_calls` 两列、以及 Console/CLI 观测面。
   没有发现任何一条“非 GFI 功能”以 GFI 数值作为**必要输入**（唯一疑点 RuleHost 的
   `currentGfi` 已核实为富化默认值，见 §6）。
2. SPEC 的总体方向正确，但有 **9 处遗漏或与代码事实不符**（§8），其中 3 处会直接导致
   上线失败或静默退化：host-runtime 的 `hasCanonicalSchema` 仍要求 GFI 两列、
   DB 迁移只在 OpenClaw 路径执行、以及 LLM hook 中整段“自动 Pain 写入”在 GFI 分支删除后成为死代码。
3. `WEAK` 只为 GFI 服务**【实测】**；但 SPEC 描述的“LLM 不可用→WEAK”与代码不符（§8.2）。
   `consecutiveErrors` 只服务 GFI**【实测】**，仓库内另有独立的 cron/探测连续失败计数，必须保留（§4.3）。
4. 真实工作区（`D:\Code\principles`）无 GFI 历史样本、无 pending empathy 行、无 Session JSON、
   无外部 RuleCode 规则**【实测】**；迁移风险主要来自其他用户工作区，不来自本仓库。
5. 最终范围 = SPEC 范围 + 本报告 §9 的补充项；不新增任何替代评分系统。

---

## 1. 全仓 GFI 落点（生产代码）

### 1.1 核心模块（删除）

| 文件 | 角色 |
| --- | --- |
| `packages/principles-core/src/runtime-v2/gfi/gfi-types.ts` | 类型/策略/阈值 |
| `…/gfi/gfi-kernel.ts` | `applyFriction/applyDecay/applyRelief/classifyGfiStage/createGfiSnapshot` |
| `…/gfi/gfi-read-model.ts` | `buildGfiWorkspaceSnapshot/classifyGfiWorkspaceHealth` |
| `…/gfi/index.ts` | barrel |

约 450 行生产代码 + 6 个测试文件。**【实测】**
唯一的生产消费者是 `operator-health-read-model.ts`；其余为 barrel 导出、golden trace 默认值、
架构回归 fixture。**【实测】**

### 1.2 Session 状态（`openclaw-plugin/src/core/session-tracker.ts`）

GFI 字段：`currentGfi, gfiBySource, lastErrorSource, lastErrorHash, consecutiveErrors, lastGfiDecayAt`；
日统计：`dailyToolCalls, dailyToolFailures, dailyPainSignals, dailyGfiPeak`。**【实测】**

函数：`trackFriction`（3 个生产调用点：工具失败、Owner 手动 Pain、WEAK 路由）、
`resetFriction`（4 处：工具成功、empathy rollback、`/pd-status reset`、`/pd rollback`）、
`decayGfi`/`getGfiDecayElapsed`（prompt heartbeat）、`getDailySummary/resetDailyStats`
（零生产调用者）、`toGfiState`（仅 GFI）、`trackBlock`（只维护 `blockedAttempts`，与 GFI 无关）。**【实测】**

### 1.3 Hooks

| 位置 | GFI 行为 | 同函数内必须保留的行为 |
| --- | --- | --- |
| `hooks/after-tool-call-helpers.ts` `handleFrictionTrackingForFailure` | 摩擦增量、错误哈希/来源、连续错误、事件 `gfiBefore/gfiAfter` | Session 活动时间更新、`eventLog.recordToolCall`、trajectory tool_call 写入 |
| 同文件 `handleFrictionTrackingForSuccess` | 半量 reset、成功事件的 GFI 前后值 | 会话活动更新（见 §8.4 语义修正） |
| `hooks/pain.ts` `handleManualPain` | `trackFriction(…,100)` 附带活动更新 | 手动 Pain 信号、Empathy rollback、triage、原则候选生成 |
| `hooks/llm.ts` §GFI 自动 Pain | `highGfiThreshold` 触发 `user_empathy` Pain | LLM 输出观测、triage、Empathy 事件 |
| `hooks/prompt.ts` | 手动 Pain 清零、heartbeat 衰减 | Intent Friction block（独立数据源） |
| `hooks/gate.ts` | `session.currentGfi` + `enrichment.currentGfi` | RuleHost 决策、block 记账 |

### 1.4 观测面

`EventLog` 日统计 `stats.gfi`（`DailyStats.gfi` 还含从未使用的 `resetCount/hourlyDistribution`）**【实测】**；
`tool_calls.gfi_before/gfi_after` + `TRAJECTORY_SCHEMA_VERSION=1`**【实测】**；
`OperatorHealthReadModel` 的 session JSON 解析与 GFI 健康判定**【实测】**；
Console `checkGfiHealth`/`gfi_health`/`gfiAfter`/`gateType:'gfi'` 标签**【实测】**；
CLI `pd runtime health gfi`、`runtime health snapshot` 的 GFI 块、`runtime canary` 的 `gfi_snapshot` 检查、
`control-plane-triage` 的 `gfi_snapshot` 分类、`runtime diagnostics` 的 GFI artifact**【实测】**；
`/pd-status` GFI 条 + Mental Mode + `reset` 子命令**【实测】**；
config `gfi_gate`（零读者）、`thresholds.pain_trigger`、`severity_thresholds.high`、
`scores.tool_failure_friction/exit_code_penalty/spiral_penalty/missing_test_command_penalty`**【实测】**；
feature flag `gfi`（生产唯一读者是 canary）、installer `MVP_QUIET_FLAGS=['gfi']`**【实测】**。

### 1.5 SPEC 未列出但属于 GFI 的代码（本报告新增范围）

| 项 | 证据 | 理由 |
| --- | --- | --- |
| `core/prompt-builder/attitude-directive.ts` `buildAttitudeDirective(gfi)` | 仅 barrel 导出 + 架构回归断言；prompt hook 已不再调用（PRI-291 注释）**【实测】** | GFI 驱动的死公共 API，Gate A 要求清零 |
| `evidence-triage` `gfi_threshold` 来源类型 + `isGfiTriggered` 分支 | 唯一生产者是 `llm.ts` GFI 分支**【实测】** | 分支删除后成为不可达代码 |
| `control-plane-triage` `gfi_snapshot` finding 类别 | 唯一生产者是 canary GFI 检查**【实测】** | 同上 |
| `core/pain.ts` `computePainScore` 及其配置 | `observation.painScore` 无任何读者**【实测】** | 纯 GFI 打分器；同文件 `trackPrincipleValue` 亦零调用 → 整文件删除 |
| Console `enum-labels.ts` `gfi` 标签 | 无生产写入者（`gateType` 只读旧行）**【实测】** | 残留展示项 |

---

## 2. 依赖图（生产方向）

```
工具调用结果 ──► pain.ts handleToolCallOutcome
                 ├─ failure ─► handleFrictionTrackingForFailure ─► trackFriction ─► GFI kernel
                 │                                              ├─► EventLog(recordToolCall: gfi*)
                 │                                              └─► trajectory(tool_calls.gfi_*)
                 └─ success ─► handleFrictionTrackingForSuccess ─► resetFriction(半量) ─► GFI kernel

Owner 手动 Pain ─► pain.ts handleManualPain
                 ├─► trackFriction(100)            ← GFI（仅用于活动时间更新语义）
                 ├─► Empathy rollback（独立，保留）
                 └─► Pain 信号 / Stage-2 pending（独立，保留）

LLM 输出 ─► llm.ts
                 ├─► currentGfi ≥ pain_trigger×severity.high ─► PainSignal(user_empathy)  ← 唯一自动 Pain 来源
                 ├─► Empathy 引擎（独立，保留）
                 └─► extractEmpathySignal → assistant_turns.empathy_signal_json（无读者）

Prompts ─► prompt.ts
                 ├─► 手动 Pain ⇒ GFI=0
                 └─► heartbeat ⇒ GFI 衰减
                 └─► buildIntentFrictionBlock（独立，保留）

Correction Collector ─► signal-collector-host.ts
                 ├─ STRONG correction ─► PainIngress（保留）
                 └─ WEAK(empathy) ─► trackFriction(20)  ← 仅为 GFI

观测读取 ─► operator-health / console / CLI canary / /pd-status / RuleHost enrichment
```

---

## 3. 独立功能清单（必须保留，不得删）

1. Owner 手动 Pain → PainIngress → 原则候选 → Stage-2 Pending（Phase B 架构）。
2. STRONG 纠正检测、关键词学习、`emitCueFeedback`、批量确认 worker。
3. Empathy Engine / Empathy Event / Empathy Rollback（独立于 GFI；`empathy_keywords.json` 与
   Correction collector 的 `correction_keywords.json` 是**两个不同 store**）**【实测】**。
4. `buildIntentFrictionBlock`（意图摩擦，独立数据源）**【实测】**。
5. `blockedAttempts` / Gate 拦截记账 / RuleCode Safety Circuit Breaker（独立计数）**【实测】**。
6. EventLog 工具/痛感/原则统计、Operator Health 其余检查、Session 活动时间、GC。
7. `pd runtime health snapshot`、`pd runtime canary` 的其余检查与 JSON 契约。
8. Installer 的 quiet flag 机制本身（只移除 `gfi` 条目）。

---

## 4. 关键判断点的实证结论

### 4.1 `consecutiveErrors`
- `SessionState.consecutiveErrors` 的读/写仅在 `session-tracker.ts` 的 GFI 内核调用、
  `after-tool-call-helpers.ts`（写入事件字段）、`llm.ts`（GFI 阈值判定）**【实测】**。
- 仓库另有独立的“连续无进展/连续内部错误”计数（`internal-error-circuit-breaker`、cron
  `consecutive_failures`），与 Session 字段无共享状态**【实测】**。
- 结论：Session 字段可删；**不得删除同名的独立机制**。

### 4.2 `WEAK`
- `SignalStrength = 'STRONG' | 'WEAK'`；`WEAK` 唯一来源是 LLM `type:'empathy'`，
  唯一去向是 `routeWeak → trackFriction(20)`**【实测】**。
- 关键词 `empathy` 类别在同步路径返回 `strength:'WEAK'`，调用方只处理 STRONG 或
  `needsLlmConfirmation`，因此同步路径本身不产生行为**【实测】**。
- **但异步降级路径真实存在**：LLM 不可用且命中词属于 empathy 类别时，
  `signal-collector-host.ts:336-353` 构造 `type:'empathy', strength:'WEAK'` 并
  `routeWeak → trackFriction(20)`**【实测】**。SPEC 的描述正确，本报告初稿的判断已更正。
- LLM 可用时：`empathy` verdict 同样走 `emitCueFeedback(false) + routeWeak`（381-384）**【实测】**。
- 结论：WEAK 没有承载纠正召回语义，**不需要迁移**；直接删除 WEAK 与 empathy 分类输入，
  不重命名为 AMBIGUOUS。

### 4.3 `dailyToolFailures` / `getDailySummary` / `computePainScore` / `gfi_gate` / `currentGfi`
`dailyToolFailures` 只被 `getDailySummary` 读取；`getDailySummary`/`resetDailyStats` 在 `src` 内零调用者；
`dailyToolCalls` 在 `src` 内**没有写入者**；`painScore` 只写不读；`gfi_gate` 零读者。**【实测】**

### 4.4 EventLog / Operator Health / Session Tracker / Receipt / Principle Injection
- EventLog：GFI 只影响 `stats.gfi` 分支，`stats.tools/pain/principle` 独立**【实测】**。
- Operator Health：GFI 是唯一需要读取 `.state/sessions/*.json` 的检查；其余检查读 DB/目录/配置。
  移除后 `readPersistedSessions` 与 `PersistedSession` 成为死代码**【实测】**。
- Session Tracker：活动时间/GC 与 GFI 共用 `touchActivity`，必须保留活动更新（§9.1）。
- Receipt / Principle Injection：无 GFI 依赖**【实测】**。

### 4.5 数据库迁移
- canonical authority：`packages/principles-core/src/runtime-v2/trajectory-schema.ts`
  `applyTrajectorySchemaBase`，`TRAJECTORY_SCHEMA_VERSION=1`，由 plugin `initSchema` 与
  `TrajectoryDatabase.initSchema` 各自写入版本行**【实测】**。
- SQLite 3.53.4，支持 `DROP COLUMN`；`tool_calls` 上无 gfi 相关 index/view/trigger**【实测】**。
- OpenClaw 打开 DB 总会执行 schema base；host-runtime（Codex/WorkBuddy）只在新建表时执行，
  且 `hasCanonicalSchema` **要求 gfi 两列存在**。若不改，删除列后 host-runtime 会判定 schema 不合法。**【实测】**
- 真实 DB：161 行 tool_calls、0 行有 gfi 值、`schema_version=1`**【实测】**。

### 4.6 旧 Session JSON
只需停止读取 GFI 字段；无需重写或删除历史文件。`readPersistedSessions` 删除后无其他读者。**【实测】**

### 4.7 外部 RuleCode
- 真实工作区 `.pd/state.db` 无 rules/rule_codes 表；`.state` 无规则文件**【实测】**。
- RuleHost 输入 `session.currentGfi` 与 `RuleInputEnrichment.currentGfi` 存在；
  删除后，外部规则源码若引用 `session.currentGfi` 会读到 `undefined`。本仓库无法证明所有用户规则
  均未引用**【查不到】**。处理：删除字段，并在审计/PR 中显式声明为破坏性契约变更（SPEC 已要求）。

---

## 5. 迁移风险

| 风险 | 等级 | 处理 |
| --- | --- | --- |
| host-runtime schema 判定仍要求 GFI 列 | P0 | 同步更新 `REQUIRED_COLUMNS` 与 INSERT；先 drop 再判定 |
| host-runtime 路径不执行 canonical schema base | P1 | 在 host-runtime ensure 链调用 core 导出的幂等 `dropLegacyGfiColumns` |
| 旧 `daily-stats.json` 含 `gfi` 键 | P2 | 载入时丢弃该键（内存清理），下次 flush 自然消失 |
| 旧 `signal_confirmations` 中 pending empathy | P2 | 终端化（`abandoned`），避免被批量确认当纠正处理 |
| 旧 `correction_keywords.json` 含 empathy 类别 | P2 | 加载器忽略未知类别（不崩溃、不迁移文件） |
| DROP COLUMN 需要写锁 / WAL | P2 | 幂等 + `busy_timeout`；迁移前文档要求备份 |
| 外部 RuleCode 引用 `session.currentGfi` | P1 | SPEC 已批准破坏性变更；记录并提示 |

---

## 6. SPEC 正确项（核实通过）

1. GFI 内核文件清单、`session-tracker` 字段/函数清单、死代码清单基本准确。
2. `dailyToolFailures/getDailySummary/resetDailyStats/computePainScore/gfi_gate` 可删。
3. `buildIntentFrictionBlock` 与 GFI 无关。
4. `WEAK` 不应改名 AMBIGUOUS，且不承载纠正召回。
5. `pain_trigger × severity.high` 是唯一自动 Pain 阈值来源。
6. GFI 公共 API 在 core 内确实没有生产消费者（除 operator health）。

## 7. SPEC 错误项

### 7.1 【实测】SPEC 关于“LLM 不可用 empathy→WEAK”的描述正确（本报告初稿曾误判，已更正）

### 7.2 【实测】`DailyStats.gfi` 字段多于 SPEC 描述
还包含 `resetCount`、`hourlyDistribution`（均未使用），删除类型时需一并处理。

### 7.3 【实测】命令名不同
实际是 `pd runtime health gfi`（`runtimeHealthCmd.command('gfi')`），SPEC 写作 `pd runtime gfi`。

### 7.4 【实测】`trackBlock` 不在删除清单，但其注释与 GFI 健康度耦合
保留 `blockedAttempts`，仅删注释。

## 8. SPEC 遗漏项（必须补入范围）

1. **host-runtime 双路径迁移缺口**（§4.5）——最关键。
2. `llm.ts` 整段自动 Pain 写入在 GFI 分支删除后成为不可达（`painScore` 只由该分支设置）。
3. `control-plane-triage` 的 `gfi_snapshot` 类别与 remediation 文案。
4. `runtime canary` 的 GFI 检查、fixture gate、以及 canary 用例断言。
5. `runtime diagnostics export` 的 GFI artifact 收集。
6. installer `MVP_QUIET_FLAGS`、feature flag 契约 + lifecycle 条目。
7. `buildAttitudeDirective`（死公共 API）。
8. `evidence-triage` 的 `gfi_threshold` 分支。
9. Console `GateBlockItem.gateType:'gfi'` 标签与 `EmpathyEvent.gfiAfter`。
10. `/pd-status reset` 子命令从命令帮助与 i18n 中移除（SPEC 提到删 reset，但未列 i18n）。

## 9. 建议新增的最小代码

1. `trackSessionControlActivity(sessionId)`：替代 GFI 函数附带的 `touchActivity`（仅此一个职责）。
2. `dropLegacyGfiColumns(db)`（core `trajectory-schema.ts` 导出，幂等）：供 plugin 与 host-runtime 共用。
3. 迁移中一次性处理：旧 daily-stats `gfi` 键删除、pending empathy 终态化。
4. （仅测试）characterization：工具成功/失败后 Session `lastActivityAt` 更新、手动 Pain 活动更新。

不新增：替代评分、兼容默认值、feature flag、抽象层。

## 10. 最终范围

**删除**：`gfi/` 全模块；session GFI/日统计字段与函数；hooks 中 GFI 分支与附带 GFI 数据；
LLM 自动 Pain 写入；EventLog `stats.gfi`；`tool_calls` 两列（含迁移）；Operator Health GFI 检查与
session 解析；Console GFI 健康度/DTO/标签；CLI gfi 命令与 canary/diagnostics/triage 的 GFI 项；
`/pd-status` GFI 条/Mental Mode/reset；`gfi_gate`/`pain_trigger`/`severity_thresholds`/GFI 打分配置；
feature flag `gfi` + installer quiet flag；`buildAttitudeDirective`；`computePainScore`；
WEAK/empathy 分类输入（保留 Empathy 引擎与事件）。

**保留**：Phase B 架构、STRONG 纠正、关键词学习、Pending 批量确认、Empathy Engine/Event/Rollback、
Intent Friction、Gate 记账、RuleHost 决策能力（去掉 `currentGfi` 字段）、所有三宿主非 GFI 路径。

**不做**：替代评分系统、GFI 以外的清理、发布面修改、外部 RuleCode 自动改写。
