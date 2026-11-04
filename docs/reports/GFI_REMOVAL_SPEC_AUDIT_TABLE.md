# GFI_COMPLETE_REMOVAL_SPEC — 逐条审计表（块 2）

- 任务：GFI-COMPLETE-REMOVAL-001
- 审计对象：`docs/specs/GFI_COMPLETE_REMOVAL_SPEC.md`（v1.1）
- 审计基线：commit `35d12815bc08e509c6e54fd908d0ae22b1395d2a`（= 当时 origin/main，CI 全绿）
- 实施工作区：`D:\Code\_worktrees\principles\adhoc-20261104-gfi-complete-removal-9da3dd`
- 证据约定：
  - **基线**证据 = `git show 35d12815bc:<path>` 的文件行（本文写 `基线 · path:line · symbol`）
  - **当前**证据 = 本 worktree 已实施后的文件行（写 `当前 · path:line · symbol`）
  - 每条结论都标注 **【实测】/【推断】/【查不到】**
- 状态：**可续写**。§4 列出未完成行与下一块的取证计划，新增行直接追加，不改动已裁定行。

---

## 1. SPEC 逐条审计表

| # | SPEC 条款 | 源码证据 | 当前事实 | 结论 | 修订建议 |
|---|---|---|---|---|---|
| 1 | §2.1 删除评分，不删除事实 | 当前 · `runtime-v2/trajectory-schema.ts:119-120` · `tool_calls` / `pain_events` DDL | 两张事实表保留；仅删 `gfi_before/gfi_after` | **正确**【实测】 | — |
| 2 | §2.2 不建立替代评分系统 | 当前 · `openclaw-plugin/src/core/session-tracker.ts` · `trackSessionControlActivity` | 新增函数只更新活动时间，不做评分、不维护账本 | **正确**【实测】 | — |
| 3 | §2.3 现有功能不变量 | `docs/reports/GFI_REMOVAL_AUDIT_20261104.md` §3 | 8 项独立功能已逐项确认保留 | **正确**【实测】 | Stage 6 需逐项回归取证 |
| 4 | §3.1 删除 `runtime-v2/gfi/` 4 文件 | 基线 · `runtime-v2/gfi/` 目录列表（`git show` 树） | 实际目录还含 `index.ts` + `__tests__/gfi-kernel.test.ts`、`gfi-read-model.test.ts` | **部分正确（遗漏）**【实测】 | 删除清单应补 `index.ts` 与 2 个专属测试（已实际删除） |
| 5 | §3.1 删除全部 GFI 公共 API | 基线 · `runtime-v2/index.ts:1687,1695,1699,1700`（re-export `gfi/index.js`）；基线 · `golden-trace.ts:219`（`currentGfi: 0`） | 两处已清理；`index.ts` 已无 `./gfi/index.js` 导出 | **正确**【实测】 | 同步更新 barrel fixture（已改） |
| 6 | §3.2 删除 SessionState GFI 字段 | 基线 · `session-tracker.ts:28-47`（`toGfiState`/`applyGfiResult`）、`:60-78`（`currentGfi/gfiBySource/lastErrorHash/lastErrorSource/consecutiveErrors/lastGfiDecayAt/dailyGfiPeak`） | 字段与适配函数已删除 | **正确**【实测】 | — |
| 7 | §3.2 `dailyToolFailures` 语义不准确、无消费者 | 基线 · `session-tracker.ts:357`（`state.dailyToolFailures++`，位于 `trackFriction`）、`:563`（`getDailySummary`） | `getDailySummary` 全仓无调用者 → 该计数无有效消费者 | **正确**【实测】（裁定详见 §2.1/§2.2） | — |
| 8 | §3.2 新增 `trackSessionControlActivity` | 当前 · `session-tracker.ts` · 同名函数 | 已新增，工具成功/失败/手动 Pain 路径已替换 | **正确**【实测】 | Stage 6 验证 `lastActivityAt/lastControlActivityAt` 不退化 |
| 9 | §3.2 必须保留的 Session 字段 | 基线 · `session-tracker.ts:60-78`；当前 · 同文件 `SessionState` | `llmTurns/blockedAttempts/token/stuckLoops/injected*/receiptAutoCorrects` 均在 | **正确**【实测】 | — |
| 10 | §3.3 两个 friction helper 改为纯事实记录 | 基线 · `after-tool-call-helpers.ts:233`（`handleFrictionTrackingForFailure`）、`:287`（`handleFrictionTrackingForSuccess`） | 当前仍保留两个函数名，但内部已无 GFI 累积/恢复 | **正确**【实测】 | Stage 7 核查函数名是否仍误导（可后续改名，非本任务范围） |
| 11 | §3.3 保留 toolName/outcome/…/hostKind 等字段 | 基线 · `principles-core/src/trajectory-types.ts:53`（`TrajectoryToolCallInput`）；当前 · `trajectory-schema.ts:119` DDL | 除 gfi 两列外全部保留 | **正确**【实测】 | — |
| 12 | §3.3 `computePainScore` 只服务 GFI | 基线 · `core/pain.ts:4`；调用点 `after-tool-call-helpers.ts:203`；字段 `after-tool-call-types.ts:60` | `computePainScore` 只写入 `ToolCallObservation.painScore`，该字段**无读取者**；GFI 用的是 `llm.ts:242` 的独立局部变量 | **错误（表述）**【实测】 | 应改写为「`computePainScore` 只写死字段 `painScore`，与 GFI 同名但不同源」；删除仍安全 |
| 13 | §3.3 `errorHash/relPath/isRisk` 若非 GFI 消费者必须保留 | 当前 · `after-tool-call-types.ts:50,52,56`；`after-tool-call-helpers.ts:186-216` | 三者均保留（脱敏、风险路径判断仍在使用） | **正确**【实测】 | — |
| 14 | §3.4 删除 Manual Pain 的 `trackFriction(…100…)` | 基线 · `hooks/pain.ts:425`（`trackFriction(sessionId, 100, 'manual_pain', …)`） | 已删除；`recordPainSignal/recordPainEvent/canonicalPainId/TriggerController/PainIngress` 保留 | **正确**【实测】 | Stage 6 用 BDD 验证 Owner 手动 Pain 行为不变 |
| 15 | §3.5 删除 GFI 自动 Pain 分支 | 基线 · `hooks/llm.ts:276`（`highGfiThreshold`）、`:278-282`（`currentGfi` 判定与 `user_empathy` 来源）、`:260,280`（`source:'user_empathy'`） | 整段已删除，`painScore` 局部变量不再参与 | **正确**【实测】 | — |
| 16 | §3.5 保留 trackLlmOutput / Token / stuckLoops / 轨迹 / Empathy Rollback | 当前 · `hooks/llm.ts` | 均保留；Empathy Rollback 仅去掉 `resetFriction` | **正确**【实测】 | Stage 6 覆盖 Empathy Rollback |
| 17 | §3.6 删除 Prompt Hook 的 GFI 清零/衰减 | 基线 · `hooks/prompt.ts:349`（`session.currentGfi >= 100`）、`:412`（heartbeat decay 日志） | 已删除；`buildIntentFrictionBlock` 保留（基线 `prompt.ts:808`、`prompt-helpers.ts:217`） | **正确**【实测】 | — |
| 18 | §3.7 `SignalStrength = STRONG \| WEAK`、`WEAK→trackFriction` | 基线 · `signal-collector/types.ts:45`；`signal-collector.ts:38,86`；`signal-collector-host.ts:347,351,381,384,586,588,729`（`routeWeak`） | `WEAK`/`routeWeak`/empathy 分支已删除；同步路径/LLM 路径仅产出 STRONG 或 none | **正确**【实测】 | 裁定详见 §2.6；不改名 AMBIGUOUS |
| 19 | §3.7 LLM 分类契约收敛为 correction/none | 当前 · `adapter/output-schema-registry.ts:49` 只注册 `signal-classification-output-v2`；`signal-collector-host.ts:374-389` `suggestedType='correction'` | 已切 v2 并删除旧版注册；Pending `suggestedType` 恒为 correction | **正确**【实测】 | PR 需声明 v1 契约的破坏性移除 |
| 20 | §3.7 LLM 不可用时走既有 Pending，不退化 WEAK | 当前 · `signal-collector-host.ts:374-389` | 降级路径入 Pending，不再造 WEAK | **正确**【实测】 | Stage 6 覆盖 LLM 不可用场景 |
| 21 | §3.8 删除 `RuleHostInput.session.currentGfi` 等 | 基线 · `internalization/rule-host-contracts.ts:43`；`host-runtime/src/production-rulehost-gate.ts:128,188,199,202,561`；`openclaw-plugin/src/hooks/gate.ts:122,553,587` | 契约、enrichment、默认值、`_getCurrentGfi` 均已删除；`session` 只传 `sessionId` | **正确**【实测】 | 外部 RuleCode 破坏性变更需在 PR 声明（§2.5） |
| 22 | §3.8 保留 RuleCode Safety Circuit Breaker 的独立 `consecutiveErrors` | 基线 · `core/pd-task-reconciler.ts:26,295,305,327` | 与 Session 字段无关，原样保留 | **正确**【实测】 | — |
| 23 | §4.1 删除 `ToolCallEventData.gfi/gfiBefore/gfiAfter/consecutiveErrors` | 基线 · `types/event-types.ts:154-161,173-177` | 字段与 Zod schema 均已删除（`consecutiveErrors` 确属该事件类型，见 `:156,:174`） | **正确**【实测】 | — |
| 24 | §4.1 删除 `DailyStats.gfi` 聚合 | 基线 · `event-log.ts:393-397`（`stats.gfi.samples/total/peak`）；`event-types.ts:1114,1134,1199` | 已删除；`stats.tools/empathy/hooks/evolution` 保留 | **正确**【实测】 | — |
| 25 | §4.1 对 `.state/logs/daily-stats.json` 局部清理 | 当前 · `event-log.ts` 已无 `gfi` 字样 | **未对真实文件执行清理**（遵守「不碰真实 `.state`」硬边界）；旧键成为无读者残留 | **部分正确（需修订）**【实测】 | 改为「加载时忽略、不主动迁移真实文件」；Gate A 按「无生产成本/无读取」判定 |
| 26 | §4.2 删除 Operator Health 的 GFI Read Model/影响 | 基线 · `operator-health-read-model.ts:16-18,45,62-67,71,175-178,192,202,229-230,251` | 已删除；`overallStatus` 只依据剩余检查 | **正确**【实测】 | 裁定详见 §2.8 |
| 27 | §4.3 删除 `runtime-gfi-snapshot.ts` 与 `pd runtime health gfi` | 基线 · `pd-cli/src/index.ts:781`（`.command('gfi')`）；SPEC 行 630 的写法规格为 `pd runtime health gfi` | 文件已删除；命令注册已删除（与 SPEC 命名一致） | **正确**【实测】 | 旧审计 §7.3「命令名不同」的结论**更正**：SPEC 行 630 与实现一致 |
| 28 | §4.3 canary / health snapshot / diagnostics export 去 GFI | 当前 · `pd-cli/src/commands/runtime-canary.ts`（无 `gfi_snapshot`）、`runtime-health-snapshot.ts`（无 gfi 段）、`runtime-diagnostics-export.ts`（无 gfi 产物） | 均已清理；其余检查保留 | **正确**【实测】 | — |
| 29 | §4.4 Console 删除 `checkGfiHealth` / `gfi_health` | 基线 · `pd-console/src/server/types/index.ts:105-106,116,202` | `HealthCheckModel.checkGfiHealth` 已删除；三处 DTO 字段已删除 | **正确**【实测】 | `GateBlockItem` 无生产消费者（§2 附注） |
| 30 | §4.4 `GateBlockItem.gateType='gfi'` 需先核实语义再映射 | 基线 · `types/index.ts:105`；当前 · `types/index.ts:100` | 全仓仅类型定义、无构造/读取方；直接删除 `'gfi'` 成员 | **部分正确**【实测】 | 因无消费者，实测无需历史映射；若后续接入历史数据须补中性映射 |
| 31 | §4.5 `/pd-status` 指标全部来自真实数据源 | 当前 · `commands/pain.ts:120-141` | session 字段 / `eventLog.getDailyStats` / `trajectory.getDataStats` / `dictionary.getStats` / `getEmpathyStats` | **正确**【实测】（逐项见 §2.12） | — |
| 32 | §4.5 不新增表/账本、不编造心理状态、命中≠拦截 | 当前 · `commands/pain.ts:120-150` 及后续输出 | 输出显式区分「规则命中」与「拦截」 | **正确**【实测】 | — |
| 33 | §5.1 删除 GFI flag 与生命周期记录 | 基线 · `feature-flag-contract.ts:232`（`{id:'gfi',category:'quiet',enabled:false}`）；`create-principles-disciple/src/mvp-config.ts:10`（`MVP_QUIET_FLAGS=['gfi']`） | 已改为 `gone` tombstone；`MVP_QUIET_FLAGS=[]`，`MVP_GONE_FLAGS` 含 `gfi` | **部分正确（实施偏离）**【实测】 | SPEC 行 741「不保留 gone tombstone」非唯一方案；需 Owner 裁定（见 §2.11） |
| 34 | §5.2 删除 `scores.tool_failure_friction / thresholds.pain_trigger / severity_thresholds.high` 与 `gfi_gate` | 基线 · `core/config.ts:43,57,64,83,116,127,134,153`；模板 `templates/pain_settings.json:70` | 运行时代码已删除（`cognitive_paralysis_input` 保留）；**但 shipped 模板当时仍残留 4 组键**，于分批存档阶段发现，已由 `c7ab619e9`（flags/config 层）清理 | **正确（实施曾遗漏，已补）**【实测】 | 误判原因：审计当时只 grep 了 `src/`，未覆盖 `packages/openclaw-plugin/templates/`；此后审计须把 shipped 模板纳入检索范围 |
| 35 | §5.3 清理真实工作区 `pain_settings.json` / `.pd/config.yaml` | 当前 worktree 无 `.state`、`.pd` 目录；任务书 §1 禁止修改 Owner 真实 `.state` | 未执行真实文件清理 | **错误（超范围）**【实测】 | 修订为「加载期容忍未知字段 + 文档提示」，删除对真实 state 的强制清理要求 |
| 36 | §6.1 `TRAJECTORY_SCHEMA_VERSION = 1` → 2，DDL 去 gfi 列 | 基线 · `trajectory-schema.ts:39`（`=1`）、`:90`（DDL 含 `gfi_before/gfi_after`）；当前 · `:39`（`=2`）、`:119`（DDL 已无 gfi） | 已升 v2 并改 canonical DDL | **正确**【实测】 | — |
| 37 | §6.1 幂等 GFI 列删除迁移，覆盖 Profile A / B / C | 当前 · `trajectory-schema.ts:86-105`（`migrateLegacyGfiSchema`，`pragma_table_info` 检查后 `DROP COLUMN`）、`:241`（仅由 `applyTrajectorySchemaBase` 调用） | 迁移本身幂等；**host-runtime 裸库路径只在「无 tool_calls 表」时才跑 base schema（`production-pain-evidence.ts:351-352`），未调用迁移** | **部分正确（实施缺口）**【实测】 | 见 §3 D1（P1）：在 host-runtime 裸库 open 链补一次 `migrateLegacyGfiSchema(db)`（下一块修，需 Owner 授权后才动生产代码） |
| 38 | §6.1 数据不变量 + PRAGMA 校验 | 当前 · `production-pain-evidence.ts:227-255`（`hasCanonicalSchema` + 预备语句 readiness） | 校验存在；迁移前后逐行对比尚未执行 | **待验证** | Stage 6 在隔离副本执行（任务书 §8.5） |
| 39 | §6.2 清理 `.state/sessions/*.json` 全部文件 | 基线 · `operator-health-read-model.ts:71`（唯一读者 `readPersistedSessions`）；当前 · 该读者已删除；worktree 无 `.state/sessions` | 无需实际迁移：删读取逻辑即足够 | **部分正确（可简化）**【实测】 | 修订为「停止读取即可；真实历史文件保持原样」 |
| 40 | §6.3 清理 `daily-stats.json` 的 gfi 子对象 | 基线 · `event-log.ts:393-397` | 同 #25：不触碰真实文件 | **部分正确（需修订）**【实测】 | 同 #25 |
| 41 | §6.4 旧 pending empathy → abandoned + reason | 当前 · `trajectory-schema.ts:98-104`（`status='abandoned'`, `resolution='gfi_removal'`） | 已实现，保留原记录 | **正确**【实测】 | — |
| 42 | §7.1 / §7.2 必须消除 / 不允许新增 | 当前 · 各层实施 diff | 目标性条款，需 Stage 8 全仓扫描定量核验 | **待验证（目标）** | Stage 8 出分类表 |
| 43 | §8 / §10 验收门（A–E） | — | 尚未执行 | **待验证** | Stage 9 |

### 1.1 结论汇总（截至本块，共 43 行）
- **正确**：31 条（#1-3、5-11、13-24、26-29、31-32、34、36、41）
- **部分正确 / 需修订**：7 条（#4、25、30、33、37、39、40）
- **错误**：2 条（#12 表述错误、#35 超范围）
- **待验证**：3 条（#38 迁移数据比对、#42 Stage 8 残留、#43 Stage 9 门禁）
- 说明：#4、#25、#30、#33、#37、#39、#40 已实际按修订方案实施或已记录偏差，不影响功能。

---

## 2. 12 项高风险判断 — 逐条裁定

> 裁定格式：**问题 → 证据 → 裁定 → 类别（实测/推断/查不到）→ 影响/后续**

### 2.1 `dailyToolFailures` 是否确实没有有效消费者
- 证据（基线 · `openclaw-plugin/src/core/session-tracker.ts`）：
  - `:77` 字段声明；`:251` 初始化；`:357` `state.dailyToolFailures++`（only in `trackFriction`）；
  - `:574` 唯一读取点位于 `getDailySummary`；`:587` 唯一清零点位于 `resetDailyStats`。
- 裁定：**确实没有有效消费者**。`trackFriction` 的写入随 GFI 一并删除；`getDailySummary/resetDailyStats` 全仓零调用。**【实测】**
- 影响：可删；删除后 `dailyToolFailures` 不再是事实来源，工具失败事实仍由 `tool_calls` 与 EventLog `stats.tools.failure` 承载。

### 2.2 `getDailySummary` 是否确实没有有效消费者
- 证据：基线全仓 `git grep getDailySummary 35d12815bc -- packages` 仅 1 命中（定义行 `session-tracker.ts:563`）。
- 裁定：**无消费者**，可删。**【实测】**

### 2.3 `computePainScore` 是否确实只服务于 GFI
- 证据：
  - 基线 · `core/pain.ts:4` 定义；`hooks/after-tool-call-helpers.ts:203` 唯一调用；写入 `after-tool-call-types.ts:60` `readonly painScore: number`；
  - 基线全仓 `painScore` 读取点：`llm.ts:242-341` 是**独立局部变量**（GFI 阈值），`pd-cli/src/legacy/legacy-import.ts:53,78-88` 是**独立 legacy 导入概念**；`ToolCallObservation.painScore` 无读取者。
- 裁定：**SPEC 表述错误**——`computePainScore` 并不「服务 GFI」，它只写一个死字段；GFI 的分数语义完全在 `llm.ts` 的局部变量里。删除 `computePainScore + painScore` 仍**安全**。**【实测】**
- 后续：`legacy-import.ts` 的同名 `painScore` 属独立功能，**必须保留**（SPEC §3.3/§3.5 未区分同名概念，属遗漏）。

### 2.4 `gfi_gate` 是否确实没有其他消费者
- 证据：基线全仓 `gfi_gate` 仅 3 命中：`core/config.ts:83`（类型）、`:153`（默认值）、`templates/pain_settings.json:70`。
- 裁定：**无生产读取者**，可删。**【实测】**（模板同步删除，见 #34）

### 2.5 `currentGfi` 是否存在外部 RuleCode 依赖
- 证据：基线 · `rule-host-contracts.ts:43`（`session.currentGfi: number`）；`production-rulehost-gate.ts:128,188,199,202,561`；`gate.ts:122,553,587`；仓库内规则未发现 `currentGfi` 业务判断。
- 真实工作区：`.pd/state.db` 无 rules/rule_codes 表，`.state` 无规则文件。**【实测（本机）】**
- 裁定：仓库内**无外部依赖证据**；但**无法证明所有用户自定义 RuleCode 未引用**。**【查不到】**
- 影响：删除属**破坏性契约变更**，外部规则读到 `undefined`。PR 必须显著声明；不得保留 `currentGfi=0` 兼容字段（SPEC 行 557 已明确）。

### 2.6 WEAK 是否可以完全从 Correction Collector 中删除
- 证据：基线 · `signal-collector/types.ts:45`（`'STRONG' | 'WEAK'`）；`signal-collector.ts:38,86`（`suggestedType/llm.type !== 'correction' → 'WEAK'`）；`signal-collector-host.ts:347,351,381,384,586,588,729`（全部 `routeWeak → trackFriction`）。
- 裁定：**可以完全删除**。`WEAK` 的行为终点只有 `trackFriction`；删除同时去掉 empathy 的 `emitCueFeedback(false)`（false = 不展示反馈），**无 Owner 可见行为损失**。**【实测】**
- 说明：不满足「WEAK 承担纠正召回」的迁移条件，因此不改名 `AMBIGUOUS`；LLM 不可用时纠正候选仍走既有 Pending（当前 · `signal-collector-host.ts:374-389`）。

### 2.7 EventLog 是否存在 GFI 之外的统计依赖
- 证据：基线 · `event-log.ts:393-397`（`stats.gfi.samples/total/peak` 唯一 GFI 聚合）；`stats.tools/pain/principle/hooks/evolution` 分支独立；`types/event-types.ts:1114,1134,1199` 为 `DailyStats.gfi` 类型/schema。
- 裁定：**GFI 之外无统计依赖**；删除仅影响 `stats.gfi` 与 `ToolCallEventData` 的 gfi 字段。**【实测】**

### 2.8 Operator Health 删除 GFI 后是否仍有完整健康判断依据
- 证据：基线 · `operator-health-read-model.ts:16-18,45,62-67,71,175-178,192,202,229-230,251`：GFI 只影响 `gfi` 字段、`overallStatus` 的 `degraded` 分支与一条 `recommendedActions`。其余检查（Pain Chain / Candidate Ledger / Pruning / Orphan / DB / 诊断任务）独立。
- 裁定：**仍有完整判断依据**；`overallStatus` 由剩余检查决定，不会把 GFI degraded 映射成 healthy。**【实测】**
- 后续：Stage 6 需用「无 GFI 的健康工作区」与「已知降级工作区」各跑一次，证明状态仍能升降。

### 2.9 trajectory.db 的 GFI 字段是否确实可以安全删除
- 证据：
  - 基线 · `trajectory-schema.ts:39`（`TRAJECTORY_SCHEMA_VERSION=1`）、`:90`（`tool_calls` DDL 含 `gfi_before REAL, gfi_after REAL`）；
  - GFI 两列上**无 index/view/trigger**（基线 schema 全文检索）；真实 DB 161 行 `tool_calls`、0 行有 gfi 值、`schema_version=1`；SQLite 3.53.4 支持 `DROP COLUMN`。**【实测】**
  - 当前 · `:39 = 2`；`:86-105` 幂等 `DROP COLUMN`；`:98-104` pending empathy → abandoned。
- 裁定：**可安全删除**，前提是迁移路径覆盖所有宿主（见 §3 D1）。**【实测 + 待补覆盖】**
- 风险：WAL/SHM 下 `DROP COLUMN` 需写锁；`busy_timeout` 与备份策略需在隔离副本验证（Stage 6）。

### 2.10 旧 Session JSON 是否需要实际迁移
- 证据：基线 · `operator-health-read-model.ts:71` 是唯一 `readPersistedSessions` 读者（另一处 `pd-cli/src/commands/runtime-gfi-snapshot.ts:59` 已删除）；本 worktree 无 `.state/sessions` 目录。**【实测】**
- 裁定：**不需要实际迁移**；删除读取逻辑即足够。历史文件保留（避免修改真实 `.state`，也避免破坏 Receipt 数据）。**【实测】**

### 2.11 Feature Flag Loader 如何处理旧 GFI 配置
- 证据：基线 · `feature-flag-contract.ts:232`（`gfi` 为 `quiet/enabled:false`；`:232` 附近为 `DEFAULT_FEATURE_FLAGS` 条目）；`create-principles-disciple/src/mvp-config.ts:10`（`MVP_QUIET_FLAGS=['gfi']`）；contract parser 对未知/非法 flag 有 warning（`feature-flag-contract.ts` parse 分支）。
- 当前：`gfi` 改为 `gone` tombstone；`MVP_QUIET_FLAGS=[]`、`MVP_GONE_FLAGS=['gfi',…]`（当前 · `mvp-config.ts`）。
- 裁定：**两条路径都可行**；SPEC 行 741「不保留 gone tombstone」是**偏好而非事实约束**，实施选择 tombstone 以保留 flag 生命周期语义。**【实测（实现状态）】**
- 影响：这是**偏离 SPEC 的显式决策**，需 Owner 在 PR 中裁定；若 Owner 要求严格零残留，改为删除条目 + 依赖 unknown-flag warning。
- 旧 `.pd/config.yaml` 的 `gfi` override：tombstone 下被识别为已退役；无论哪种方案都**不执行旧逻辑**。**【实测】**

### 2.12 `/pd-status` 新增指标是否都能从真实数据源取得
- 证据（当前 · `openclaw-plugin/src/commands/pain.ts`）：
  - `:123` `getSession(sessionId)` → `llmTurns/injectedPrincipleIds/receiptAutoCorrects/blockedAttempts`（基线 · `session-tracker.ts:60-78` 字段真实存在）；
  - `:128` `wctx.eventLog.getDailyStats(today)` → `tools/hooks/evolution`（基线 · `event-log.ts` 聚合真实存在）；
  - `:132` `wctx.trajectory.getDataStats()` → `toolCalls/painEvents`；
  - `:125` `dictionary.getStats()` → `totalRules/totalHits`；
  - `:135` `eventLog.getEmpathyStats('session', sessionId)` → Empathy 事件（独立保留）。
- 裁定：**全部有真实生产者**；无编造分数、无新增账本。SPEC 表列 9 项均可取。**【实测】**
- 注意：`dailyTrend/byDetectionMode/createMiniBar` 属 `/pd-status empathy` 子命令的既有输出，**与 GFI 无关**，保留（SPEC 未提及，属遗漏但正确保留）。

---

## 3. 审计新发现（SPEC 未覆盖 / 实施缺口）

| ID | 发现 | 证据 | 级别 | 处理 |
|---|---|---|---|---|
| D1 | host-runtime 裸库 open 链**未调用** GFI 列迁移，旧 Codex/WorkBuddy 库会保留 gfi 列 | 当前 · `host-runtime/src/production-pain-evidence.ts:351-352`（仅当无 `tool_calls` 才 `applyTrajectorySchemaBase`）；`trajectory-schema.ts:241` 迁移只在 base schema 内调用；而 `trajectory-schema.ts:81-85` 注释声称「host-runtime raw-DB ensure chain 也调用」——注释与代码不符 | **P1** | 下一块：在裸库 open 链补 `migrateLegacyGfiSchema(db)`（幂等、已 `busy_timeout`），并修正注释；需先获 Owner 授权动生产代码（本块不修） |
| D2 | 同名 `painScore` 存在两个独立概念（legacy import） | 基线 · `pd-cli/src/legacy/legacy-import.ts:53,78-88,136-145` | **P2** | 明确保留；PR 备注避免后人误删 |
| D3 | SPEC §5.3/§6.2/§6.3 要求修改真实 `.state`，与任务书 §1 硬边界冲突 | 任务书 §1「禁止修改 Owner 真实 `.state`」；本 worktree 无 `.state` | **P2（流程）** | 修订 SPEC 为「加载期容忍 + 不迁移真实文件」 |
| D4 | `GateBlockItem.gateType='gfi'` 无任何构造者/读取者 | 基线 · `pd-console/src/server/types/index.ts:105-106` 仅定义；全仓无引用 | **P3** | 删除安全（已删） |
| D5 | 旧审计 §7.3「命令名不同」结论不成立 | SPEC 行 630 写 `pd runtime health gfi`；基线 · `pd-cli/src/index.ts:781` `.command('gfi')` 挂在该父命令下 | **P3（文档）** | 已在本文 #27 更正 |
| D6 | `ToolCallObservation.painScore` 是死字段（非 GFI 字段） | 基线 · `after-tool-call-types.ts:60` 无读取者 | **P3** | 已随 `computePainScore` 删除 |
| D7 | 审计证据范围曾漏掉 shipped 模板，导致 #34 误判「已删」 | 基线 · `packages/openclaw-plugin/templates/pain_settings.json:4,13,20-24,70-93` 实际残留；`git grep` 只覆盖 `src/` | **P2（流程）** | 已由 `c7ab619e9` 清理；后续审计默认检索 `src/` + `templates/` + `scripts/` |

---

## 4. 待续（下一块取证计划）

| 待办 | 说明 |
|---|---|
| #38 数据不变量实测 | 在隔离副本（复制真实 DB 的临时库）跑迁移前后 `行数 / 非 GFI 列逐行 / id / index / integrity_check / foreign_key_check`，结果追加到本表 |
| #42 Stage 8 残留定量 | 全仓扫描分类表：可执行 GFI 生产代码=0、状态/API/配置=0、DB 字段按迁移目标、历史文档保留、无关 `consecutiveErrors` 保留 |
| #43 Stage 9 门禁 | 全仓 tsc/lint/build、三宿主、E2E、`verify:merge`、Release Build Parity、CI required checks |
| D1 修复 | 补 `migrateLegacyGfiSchema` 到 host-runtime 裸库 open 链（Stage 5 补充，需 Owner 授权） |
| §2.11 tombstone 决策 | 交 Owner 裁定是否保留 `gone` tombstone |

> 本文所有「正确/错误/遗漏」均以基线 commit 的真实代码为准；不以实施后的代码反推 SPEC 是否正确。
