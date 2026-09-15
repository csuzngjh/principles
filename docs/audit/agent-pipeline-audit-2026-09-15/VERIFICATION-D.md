# VERIFICATION-D — 报告 §6 独立核实（观察者三卡 / 治理下游五环节 / 闭环回边 / 排除清单）

- 核实对象：`docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md`（下称「报告」）
- 声明基线：报告自称锚定 GitHub `main` @ `70d824c4`
- 核实方式：**只读静态核实**。基线文件取自本地对象库 `git show 70d824c4:<path>`（该对象存在，无需 fetch），**未切换分支**，交付工作区保持 `ai/audit-agent-pipeline-report`
- 判定口径：`CONFIRMED` = 代码事实与报告一致；`REFUTED` = 不一致（给正确事实 + 本核实员 file:line）；`DRIFT` = 结论成立但行号/引用不符（给修正行号）；`UNVERIFIABLE` = 环境所限；`NEW` = 报告漏记（本核实员补充）
- 管辖范围：报告 §6（§6 第一部分三卡、第二部分治理五环节、第三部分闭环回边、第四部分 F-E* 清单与排除清单）
- 核实员：PD Developer（Issue #31）；本文档为**独立核实产物**，不修改报告任何内容

---

## 1. 摘要统计

### 1.1 判定计数

计数口径：§2 逐项判定表（D-1..D-4）中带编号的判定行，逐行一个判定。

| 判定 | 数量 | 说明 |
|---|---|---|
| CONFIRMED | 155 | 代码事实与报告一致；其中绝大多数为行号精确命中（含 31 处「多段行号清单」整段命中，如 RuleHostWriter 门禁 10 项、promote 12 段、gate 护栏 8 处） |
| REFUTED | 3 | 事实表述有误（见 §1.3） |
| DRIFT | 2 | 结论成立，行号需修正（见 §3） |
| UNVERIFIABLE | 1 | 报告自身编号缺口（F-E8，见 D-4 #8） |
| NEW（判定行内标记） | 3 | 报告转述不完整/漏记为「注释」或漏记事实（signalCollector「阈值 70」、activation「skill 无 writer」、闭环「第二 shadow→live 写者」） |
| **判定行合计** | **164** | |
| NEW 独立条目（§4） | 13 | NEW-1 .. NEW-13 |

**总体结论**：报告 §6 的事实骨架高度可靠——三卡提示词逐字引用**全部**对得上（含 emoji/中文/转义原样），治理五环节的状态转移、事务边界、授权门与行号绝大多数精确，F-E9 排除清单四项中三项为构造性成立。发现的偏差集中在三类：①少量行号笔误（判定为 DRIFT 的 2 处，另 §3 收 2 处建议性修正）；②把源码注释当作实现事实转述（2 处）；③漏记若干结构性事实（§4，13 条），其中 NEW-1/2/3 实质**加深**报告已有的 F-E2/R-10 结论，NEW-5 触及治理授权面，NEW-6/NEW-7 收窄了 F-E9 的适用范围。

### 1.2 最重要的 REFUTED / NEW 前 5

| 排名 | 编号 | 一句话 | 严重度建议 |
|---|---|---|---|
| 1 | **NEW-5** | `POST /api/v1/activations/:id/disable` 不要求 Owner 身份、不写 `activation_decisions`、不检查 control state → 与 `emergency-deactivate` 授权强度不对称；Console UI 上的「停用」按钮走的就是这条弱路径 | P2 |
| 2 | **NEW-1** | correctionObserver payload 的 `hitCount` **结构性恒为 0**（`CorrectionCueLearner.recordHits` 无任何生产调用者），而提示词的 REMOVE 规则恰以「0 hits + FP>0.3」为判据 → 该规则对所有词恒成立 | P2 |
| 3 | **NEW-3** | llm 学习词 earned precision 升 `high` 后，Stage1 短路不再进 Stage2 → 除 correctionObserver 那条（本身失明的）FP 路径外**无任何自动降级机制**，`high` 状态不可逆 | P2 |
| 4 | **NEW-7** | Codex 侧**没有 `rulehost_evaluated` 事件生产通道**（shared gate 不写事件；`codexEventEmitter` 只实现 injected/tool_call）→ Codex 上 shadow 证据恒不可得，promote readiness 结构性 `unavailable` | P2 |
| 5 | **NEW-2** | `CorrectionCueLearner.match()`（`weight × accuracy` 评分）**无生产调用者** → correctionObserver 的 UPDATE-weight 建议实际不作用于检测评分，weight 只能经由 0.7 阈值改变 precision | P2 |

### 1.3 三条 REFUTED 速览

| 编号 | 报告原文 | 实际事实 | 本核实员证据 |
|---|---|---|---|
| R-a | 「原子写 temp+rename，**`:19` 注释**」（correction-observer 卡 · 持久化位置） | `:19` 是类型导入行；原子写注释在 `:9`，实现调用在 `:75` | `correction-cue-learner.ts:9` / `:75` |
| R-b | 「`updates[].reasoning`（**仅日志**，applyResult 不落库）」 | `applyResult` 的 4 条日志均不含 reasoning；reasoning 只在 schema 校验处被 `typeof` 检查，**既不落库也不进任何日志** | `correction-observer.ts:204-206`；`keyword-optimization-service.ts:40-77`（无 reasoning 引用） |
| R-c | 「输出/状态转移：pending → approved / rejected / **cancelled**」（approval 环节） | `'cancelled'` **无任何生产写入者**——全仓仅出现在类型定义、stats 默认值与路由白名单，没有任何 UPDATE/INSERT 会写入它 | `activation-types.ts:140`；`sqlite-approval-store.ts:26`；`approvals.ts:69`；全仓无 `SET status='cancelled'` / `status:'cancelled'` 生产写点 |

---

## 2. 逐项判定表

### 2.1 D-1 §6 第一部分 · 三卡

#### 卡 1：correctionObserver

| # | 报告主张 | 判定 | 证据 / 备注 |
|---|---|---|---|
| 1 | 类在 `correction-observer.ts:56`，`run()` 在 `:133-228` | CONFIRMED | `:56` `export class CorrectionObserver {`；`:133-228` `async run(...)` 至闭合 |
| 2 | 输入 schema `:6-26` | CONFIRMED | `CorrectionObserverPayloadSchema` 6–26 |
| 3 | 输出 schema `:30-41` | CONFIRMED | `CorrectionObserverOutputV1Schema` 30–41 |
| 4 | system prompt `:61` = `You are a correction keyword optimizer.` | CONFIRMED | 逐字节一致 |
| 5 | 消息体 `buildPrompt` `:95-127` **全文逐字** | CONFIRMED | 逐行比对 31 行文本，**字节级一致**（动态注入点 `termsList` `:82-84`、`messages` `:86-88`、`trajectory` `:90-93` 位置与格式均对） |
| 6 | 提示词 `:119` FP 判定指令 | CONFIRMED | 逐字一致 |
| 7 | 提示词 `:121` `max 100 chars` | CONFIRMED | 逐字一致 |
| 8 | 输出校验 `:186`（updated）/`:192-208`（updates）/`:210-219`（fpTerms）/`:221-225`（fpAnalysisStatus） | CONFIRMED | 四段行号全部精确 |
| 9 | `reasoning` 只查类型不查长度（`:204-206`） | CONFIRMED | `:204-206` 仅 `typeof entry.reasoning !== 'string'` |
| 10 | weight 无数值校验、应用侧 clamp `keyword-optimization-service.ts:53-55` | CONFIRMED | `:53-55` `Math.max(0.1, Math.min(0.9, update.weight))` |
| 11 | `falsePositiveRate` schema `:35` 允许但 applyResult 不读取 | CONFIRMED | `:35` 定义；`applyResult` 全文无该字段引用 |
| 12 | 触发：`CorrectionObserverService` `correction-observer-service.ts:320-406`，间隔 15min / 启动延迟 10s（`:50-51`） | CONFIRMED | `:320-406` service 对象；`:50` `15*60*1000`、`:51` `10_000` |
| 13 | 单消费者边界 + epoch（`:23-47`, `:369-384`） | CONFIRMED | 边界变量 23–47；`isStale` + 重入闸 369–384 |
| 14 | 启用前提 `:153-198`, `:337-355`；默认关闭 `pd-config-defaults.ts:70` | **DRIFT** | 逻辑正确，但 correctionObserver 的默认关闭行是 **`:69`**；`:70` 是 `empathyObserver: false` |
| 15 | `AgentScheduler` `agent-scheduler.ts:21-55` 仅类型 dispatch；"periodic" 在 `:11` | CONFIRMED | `:21-55` 类体；`:11` `AgentScheduleMode = 'realtime' \| 'periodic'`；`'periodic'` 全仓无实现消费者 |
| 16 | `parentSessionId` 固定值（`:283`）、`workspaceDir`（`:284`） | CONFIRMED | 精确命中 |
| 17 | `keywordStoreSummary` 投影 `:266-277` | CONFIRMED | `:266-277` |
| 18 | `recentMessages` 20 sessions 取前 5（`:52-53`, `:252-264`） | CONFIRMED | `:52` MAX_RECENT_SESSIONS=20、`:53` MAX_PAYLOAD_SESSIONS=5；`:252-264` |
| 19 | `buildTrajectoryHistory` `keyword-optimization-service.ts:107-136`，上限 50 | CONFIRMED | `:107-136`；`:126`/`:132` 两处 50 上限 |
| 20 | **F-E2**：`userMessage` 恒空串（`:120-124` / R-10 引 `:121-123`） | CONFIRMED | `:120-122` 注释明言 rawText 不可得、`:123` `userMessage: ''` |
| 21 | `applyResult` 落库 `<stateDir>/correction_keywords.json`，`source='llm'`（`:56`） | CONFIRMED | `:56` `learner.add({..., source: 'llm' })` |
| 22 | FP 落库 `:81-98`，权重 ×0.8 注释 `:93` | CONFIRMED | `:81` 门槛、`:93` 日志 `(weight x0.8)`；实际权重变更在 `correction-cue-learner.ts:167` |
| 23 | 单条操作失败 log-and-skip `:73-76` | CONFIRMED | `:73-76` |
| 24 | 词库上限 200：`learner.add` 抛错 `correction-cue-learner.ts:179-181` | CONFIRMED | `:179-181`；常量 `correction-types.ts:62` = 200 |
| 25 | 无更新时早退 `:35-38` | CONFIRMED | `applyResult` 的 `!result.updated \|\| keys===0` 早退 |
| 26 | 周期失败 `:308-317` + 健康计数 `:200-210`；未就绪静默跳过计成功 `:232-239` | CONFIRMED | 三段精确 |
| 27 | 批量确认 `batchConfirmPendingSignals` `:72-143` → `confirmPendingSignal` `signal-collector-host.ts:411-436`；attempts≥5 `:57-58`、`:98-105` | CONFIRMED | 全部命中；`:58` MAX_ATTEMPTS=5 |
| 28 | `precisionFor` earned precision：TP≥3 且 FP=0 升 high（`governance-signal-admission.ts:104`, `:161-172`） | CONFIRMED | `:104` `EARNED_PRECISION_MIN_TP = 3`；`:169` 判据 |
| 29 | 词库投影 mtime 刷新 `governance-signal-admission.ts:237-269`；OpenClaw/Codex 共用 `signal-keyword-store.ts:29-36` | CONFIRMED | `:237-269`（mtime 分支 `:290`）；`signal-keyword-store.ts:29-36` 委派 |
| 30 | 持久化位置「原子写 temp+rename，**`:19` 注释**」 | **REFUTED**（行号） | 见 §1.3 R-a：注释在 `:9`，实现 `:75` |
| 31 | `updates[].reasoning`「**仅日志**」 | **REFUTED** | 见 §1.3 R-b |

#### 卡 2：empathyObserver

| # | 报告主张 | 判定 | 证据 / 备注 |
|---|---|---|---|
| 1 | 类 `:36`、`run()` `:68-135` | CONFIRMED | 精确 |
| 2 | 输入 schema `:6-10`、输出 schema `:12-23` | CONFIRMED | 精确 |
| 3 | system prompt `:41` | CONFIRMED | 逐字 |
| 4 | 消息体 `buildPrompt` `:57-63` **全文逐字** | CONFIRMED | 字节级一致（含 `JSON.stringify(userMessage.trim())` 注入形式） |
| 5 | 校验 `:118-127`；超时默认 120s `:49` | CONFIRMED | 精确 |
| 6 | 失败路径 `:93-96`, `:99-107`, `:110-113`，且**因无调用方全部不可达** | CONFIRMED | 三段精确；无生产实例化 |
| 7 | **全仓 `new EmpathyObserver` 仅在测试**（`empathy-observer.test.ts:26,48,65,80,99`、`real-e2e:62`） | CONFIRMED | `git grep` 于 `70d824c4` 得 6 处，全部在 `__tests__`；无 service/hook/scheduler 注册（`AgentScheduler.register` 全仓唯一生产点在 `correction-observer-service.ts:291`） |
| 8 | schema 注册 `output-schema-registry.ts:47`，但无生产 `startRun` 引用该 ref | CONFIRMED | `:47` 注册；全仓 `empathy-observer-output-v1` 仅 2 处（注册 + `empathy-observer.ts:77`） |
| 9 | Console 渲染点 `ControlCenterPage.tsx:879-890` | CONFIRMED | `:879-890` 双层 gate（enabled + localStorage ack） |
| 10 | `EmpathyObserverCostHint.tsx:12-35` | CONFIRMED | `:12-35`（含 `:35` `COST_ACK_KEY`） |
| 11 | flag retired `feature-flag-contract.ts:251`、`feature-flag-lifecycle.ts:109` | CONFIRMED | `:251` `category:'gone'`；`:109` RETIRED 注释 |
| 12 | 绑定仍在 `pd-config-types.ts:124`；默认 disabled `pd-config-defaults.ts:70`；MVP 安装 `mvp-config.ts:382` | CONFIRMED | 三处精确（此处 `:70` 确为 empathyObserver，与卡 1 #14 的漂移互为反证） |
| 13 | 词库遗产 `empathy_keywords.json`：`core/empathy-keyword-matcher.ts` `KEYWORD_STORE_FILE :23` | CONFIRMED | `:23` |
| 14 | 双轨并存（`EMPATHY_SEED_OVERLAY`）`governance-signal-admission.ts:120-122` | CONFIRMED | `:120-122` |
| 15 | 生产共情检测已改道：`signal-collector-host.ts:325-328`, `:542-554`, `:280-302` | CONFIRMED | 三段精确 |

#### 卡 3：signalCollector（简卡）

| # | 报告主张 | 判定 | 证据 / 备注 |
|---|---|---|---|
| 1 | core 纯逻辑 `collectSync` `:23-58` / `mapLlmResultToOutput` `:64-94` | CONFIRMED | 精确 |
| 2 | plugin 外壳 `SignalCollectorHost` `signal-collector-host.ts:150` | CONFIRMED | `:150` |
| 3 | 由 `before_prompt_build` 同步调用 `prompt.ts:404-408` | CONFIRMED | `:406-412` 调用点在 `:404-408` 注释+语句区间内 |
| 4 | trigger 门控 `:72-74` | CONFIRMED | `isUserInteractionTrigger` 72–74 |
| 5 | Stage2 fire-and-forget `:229-242` | CONFIRMED | `:241` `void this.detectAsyncAndRoute(pending)` |
| 6 | Stage1 `scanKeywords` `keyword-stage.ts:21-72`；high 短路 `:44-52`；correction 优先 `:35-37`；ambiguous `:54-63`；零命中 `:65-71` | CONFIRMED | 五段全部精确 |
| 7 | LLM 阶段关闭时 `needsLlmConfirmation=false` `signal-collector.ts:47-57` | CONFIRMED | `:55` `config.enableLlmStage` |
| 8 | Stage2 映射 `:64-94`，correction→STRONG / empathy→WEAK `:83-93` | CONFIRMED | `:86` 三元 |
| 9 | `user_turns` 写入 `:201-215`；STRONG 写 `correctionDetected` `:206` | CONFIRMED | `:206` |
| 10 | 候选持久化 `queueUnconfirmedForBatch` `:356-383` | CONFIRMED | 精确 |
| 11 | system prompt `llm-stage.ts:7` = `你是一个用户反馈分类器。` | CONFIRMED | 逐字 |
| 12 | 消息体 `buildLlmPrompt` `llm-stage.ts:14-25` **全文逐字** | CONFIRMED | 字节级一致（模板字符串全文比对通过） |
| 13 | payload 四路径 `llm-stage.ts:70-85` | CONFIRMED | structured → legacy_string → legacy_envelope → invalid |
| 14 | `SignalCollectorOutput` `types.ts:56-66` + 手写校验 `:70-87`；LLM 契约 `:115-121`；evidence `:51-54`；截断 `signal-collector.ts:7-12` | CONFIRMED | 五段精确（`:7` `MAX_EXCERPT = 200`） |
| 15 | STRONG 限流 `:560-573`；常量共享 `governance-signal-admission.ts:66` | CONFIRMED | `:66` `GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR = 5` |
| 16 | 内容派生 painId `:501-506`，emit `:510-529`（score=70, source=`user_correction`） | CONFIRMED | `:501-506` + `:510-529`（`:520` score、`:518` source） |
| 17 | WEAK→`trackFriction` 摩擦分 20 `:542-554` | CONFIRMED | `:548` `trackFriction(sessionId, 20, ...)` |
| 18 | 「**阈值 70 触发诊断**」 | **NEW（转述注释为事实）** | 源码注释 `:539` 说 70；实际门是 `hooks/llm.ts:280` `Math.max(config.get('severity_thresholds.high')\|\|70, painTrigger+30)` 与 `pain-diagnostic-gate-policy.ts:148,201`。见 NEW-11 |
| 19 | LLM verdict→TP/FP `prompt.ts:224-230` | CONFIRMED | `:224-230` |
| 20 | 回写 `user_turns.correction_detected` `writeBackConfirmedCorrection` `:443-456` | CONFIRMED | `:443-456` |
| 21 | Codex 共享词库与 STRONG 语义 `governance-signal-admission.ts:776` → `insertCorrectionPain` `:497-513` | CONFIRMED | `:776` 入口；`:497-513` 写入器 |
| 22 | flag `signal_collector` 只门控 LLM 深判（`feature-flag-contract.ts:195`） | CONFIRMED | `:195` 描述与 `llm-stage` 消费一致 |
| 23 | `PendingTermStore` 无生产写入者、Console 端点全 stub `signal-keywords-api.ts:38-66,97-107,116-150`；`types.ts:21-35` | CONFIRMED | 全仓 `llm_candidate` 仅类型/mock；stub 恒返 `endpoint_not_implemented`；`pd-console/src/server/routes/**` 无 signal-keywords 路由 |
| 24 | classifier `outputSchemaRef='signal-classification-output-v1'`，startRun `:630-642` | CONFIRMED | `:639` schemaRef、`:634-642` |

### 2.2 D-2 §6 第二部分 · 治理五环节

#### 环节 0：Owner Decision

| # | 报告主张 | 判定 | 证据 |
|---|---|---|---|
| 1 | `collectOwnerDecisionFacts` 只收 evaluator/rollout_reviewer `owner-review.ts:252` | CONFIRMED | `:252` |
| 2 | 决策 artifact id `pi-art-<taskId>-<runId>` `:139-141` | CONFIRMED | `:140` 模板 |
| 3 | `deriveOwnerDecisionCapability` `:495-584`；原因码 `:67-73`；accept 硬门 `:569-573` | CONFIRMED | 三段精确（`:67-73` 四值集合；`:569` `!facts.hardGateFailed`） |
| 4 | `buildOwnerDecisionReview` 快照 `owner-decision-review.ts:114-148`；checklist `:390-434`；manifest/digest `:476-494`；证据不足禁 accept `:449-463` | CONFIRMED | 四段精确（`:390-433` 五项 checklist） |
| 5 | `applyOwnerResolution` `owner-resolution-service.ts:314-530` | CONFIRMED | `:314-530` |
| 6 | stale 逐字段 `:368-380`；resolutionId 派生 `:171-173` | CONFIRMED | `:171-173` `ores_<sha256(reviewKey)[:20]>` |
| 7 | verdict override → resolution(pending) + 任务翻 pending `:505-527` | CONFIRMED | `:506-527`（`:511` attemptCount:0） |
| 8 | `resolveEffectiveRunnerDecision` 唯一解析点 `owner-review.ts:400-406` | CONFIRMED | `:400-406`；唯一实现（`owner-decision-architecture.test.ts` 亦断言） |
| 9 | `revise_once` → `reopenTaskForRevision` `revision-reopen.ts:56-117`；causeId 幂等 `:74-76`；清 verdict+intent 单条 UPDATE `:84-92`, `:111-115` | CONFIRMED | 四段精确 |
| 10 | 标 applied `owner-resolution-service.ts:244-297` | CONFIRMED | `driveReviseOnce` 244–297 |
| 11 | 持久化：tasks.diagnosticJson；artifact 在 pi_artifacts（DDL `:379`） | CONFIRMED | `sqlite-connection.ts:379` |
| 12 | Console 路由 `owner-decisions.ts:211-234`；body 强制 reviewKey+五元组 `:47-61` | CONFIRMED | `:211-234`（list `:211-227`、resolve `:229-234`）；`:47-61` 接口 |
| 13 | 失败码全集 `:69-89`；reopen 失败回滚 `:217-233` | CONFIRMED | `:69-89` 九态；`rollbackPendingResolution` 217–233 |
| 14 | `owner-retry.ts` Recover 在 decision-capable 或 pending resolution 时拒绝 `:84-100` | CONFIRMED | `:91` 条件 |
| 15 | 迁移仲裁单点 `internalization-transition-decision.ts:73-128`；`:97-100`、`:116-119`、`:93-95,113-114` | CONFIRMED | 五段精确 |
| 16 | 自动消费范围 `internalization-consumer-decision.ts:25-32`；flag `feature-flag-contract.ts:208` | CONFIRMED | `:25-32` FULL_CHAIN 六值；`:208` |

#### 环节 1：approval

| # | 报告主张 | 判定 | 证据 |
|---|---|---|---|
| 1 | 入队 `activation-dispatcher.ts:276-338`；条件 `:265`；低风险 `activation-types.ts:8` | CONFIRMED | `:265` `require_approval \|\| !isLowRiskChannel`；`:8` `['prompt','defer_archive']` |
| 2 | skill+conf≥0.95 豁免 `approval-queue.ts:17-22`；阈值 `activation-types.ts:15-17`；注释自认有意 `:263-264` | CONFIRMED（但见 NEW-6） | 三处精确；**注意**：豁免后仍会因无 skill writer 而 `refused: no_writer_for_channel_skill` |
| 3 | 入队前 `canActivate` 预检 `:288-292` | CONFIRMED | `:288-292` |
| 4 | Console 路由 `approvals.ts:122-287`；decidedBy 固定 `operator` `:146/205/260` | CONFIRMED | 三处行号精确 |
| 5 | `ApprovalsConsoleModel.approve` `:144-216`；原子 approved `sqlite-approval-store.ts:226-240`；`ApprovalCompletionService.completeApproval` `:63-192`；失败 resetToPending `:170-184` / `sqlite-approval-store.ts:258-265`；ledger 升级 `:211-213,230-265` | CONFIRMED | 七处行号全部精确 |
| 6 | 状态转移 pending→approved/rejected/cancelled；edit 仅 pending `sqlite-approval-store.ts:267-282` | **REFUTED**（`cancelled`） | 见 §1.3 R-c；edit 部分 CONFIRMED |
| 7 | 行结构映射 `sqlite-approval-store.ts:51-88` | CONFIRMED | `mapRowToRecord` 51–88 |
| 8 | DDL `sqlite-connection.ts:395`；approvalId 确定性 `:138-140`；INSERT OR IGNORE `:156-174`；FK 预检 `:149-154` | CONFIRMED | 四段精确（`:395` approvals 建表） |
| 9 | Console 列表带 MVP 过滤 `approvals.ts:62-91`；CLI `runtime-activation.ts:316` | CONFIRMED | `:62-91`；`:316` dispatcher 构造 |
| 10 | `story_a_approval_completion` 关时照记+显式 warning `:190-197,351-362`；flag `feature-flag-contract.ts:214` | CONFIRMED | 三处精确 |
| 11 | code_tool_hook host 声明不可解析时 dispatch 前拒绝 `:393-401` | CONFIRMED | `ApprovalsConsoleModel.ts:394-401` |
| 12 | already_decided 409 `approvals.ts:161,212` | CONFIRMED | 两处 |

#### 环节 2：activation

| # | 报告主张 | 判定 | 证据 |
|---|---|---|---|
| 1 | 输入快照 `activation-types.ts:61-72` | CONFIRMED | `PIArtifactSnapshot` 61–72 |
| 2 | rollout 自动路径 `internalization-consumer-governance.ts:73-141`；actor `:128-130` | CONFIRMED | `:73-141`；`:129` actor=system/rollout_reviewer |
| 3 | `dispatch` `activation-dispatcher.ts:171-274`；幂等键 `:268-270`；血缘拒绝 `:445-453`；`approved` 独立验证 `:198-261`；安全注释 `:193-197`；低风险直激 `:273` | CONFIRMED | 六段精确 |
| 4 | PromptWriter `low-risk-writers.ts:37-49`；产出 `:52-58` | CONFIRMED | 精确 |
| 5 | RuleHostWriter 门禁九项（`:204,208,231-242,244,249-253,255-257,265-270,277-295,297-325,330-333`）、flag `:41` | CONFIRMED | **十处行号全部精确命中** |
| 6 | `checkRuleActivationContent` `rule-activation-contract.ts:42-75`；背景注释 `:3-24` | CONFIRMED | 精确 |
| 7 | `ActivationDecision` `activation-types.ts:53-59`；`recordActivation` `sqlite-activation-state-store.ts:73-106`；DDL `:439`/`:545` | CONFIRMED | 五处精确（`:94-100` 建 control row） |
| 8 | dry-run 预览 `:295-303`, `:375-382` | CONFIRMED | 精确 |
| 9 | writer 抛错→带原始错误 refused+telemetry `:57-99` | CONFIRMED | `checkCanActivate` catch 57–99（含 `:81` nextAction） |
| 10 | 记录失败 `:395-397`；principleId 缺失 `:346-349` | CONFIRMED | 精确 |
| 11 | Console `routes/activations.ts`；CLI `pd runtime activation list` | CONFIRMED | 路由存在；`/api/v1/activations` 挂在于 `console-index.ts:477-489` |
| 12 | （report 未提）skill channel 无 writer | **NEW-6** | 全仓无 `SkillWriter`/`channel='skill'` 类；见 §4 |

#### 环节 3：shadow

| # | 报告主张 | 判定 | 证据 |
|---|---|---|---|
| 1 | `RuleHostWriter.activate` 恒返回 shadow `:359-363`；PRI-489 注释 `:345-358` | CONFIRMED | 精确 |
| 2 | 运行时 observation-only `rule-host.ts:200-206,494-526` | CONFIRMED | 200–206 shadowDecisions；494–526 mode 判定 + warning |
| 3 | shadow/live 均发 `rulehost_evaluated`（`gate.ts:116-146`） | CONFIRMED（**仅 OpenClaw**） | `:117` shadow、`:134` live；**Codex 不产此类事件**（见 NEW-7） |
| 4 | 影子证据聚合 `rulecode-shadow-summary.ts:15-58`；字段清单与实际一致 | CONFIRMED | 10 字段全对 |
| 5 | 持久化：events JSONL + activations.action 翻转（非新行） | CONFIRMED | `sqlite-activation-safety-store.ts:407` UPDATE 同行；`:255` recover 才 INSERT 新行（不同语义） |
| 6 | `ownerReviewDueAt = promotedAt/activatedAt + 7 天`（`ActivationsConsoleModel.ts:54-55,100,402,527`） | CONFIRMED | `:402` 表达式精确（`7*24*60*60*1000`）；`:55` promotedAt 字段；`:100` readiness；`:527` reader.evaluate |
| 7 | `rulehost_unhealthy` 计入 errors `rulecode-shadow-summary.ts:28-31`；skip 留 skipped `rule-host.ts:67-70,426-428` | CONFIRMED | 两处精确 |

#### 环节 4：promote

| # | 报告主张 | 判定 | 证据 |
|---|---|---|---|
| 1 | 唯一活跃 shadow 要求 `promotion-readiness-reader.ts:22-25`；digest 绑定 `:27-37` | CONFIRMED | 精确 |
| 2 | 10 项必检 `promotion-readiness-evaluator.ts:3-7` | CONFIRMED | 常量 10 值 |
| 3 | 硬阈值 observed≥20/matched≥3/neutralControl≥1/≥24h `:65-68` | CONFIRMED | `:65-68` |
| 4 | errors>0 硬失败 `:47-49` | CONFIRMED | `:48` `unresolved_shadow_unhealthy_evidence` |
| 5 | digest 绑定 `:36-38` | CONFIRMED | `:36-38` |
| 6 | `RuleCodeOwnerDecisionService.promote` `:89-174`；flag 门 `:90-95`；owner 身份 `:96-99`；CLI note `:101-103`；confirm `:104-106`；blocked/unavailable `:111-119`；stale `:120-123`；override `:124-132`；dryRun `:133-139`；commit `:157-166`；失败 `:167-173` | CONFIRMED | **十二段行号全部精确命中** |
| 7 | flag 定义 `feature-flag-contract.ts:191-192` | CONFIRMED | `:191` safety_controls、`:192` owner_live_decision |
| 8 | 单事务 `sqlite-activation-safety-store.ts:366-414`；supersede `:399-404`；action+promoted_at `:406-408`；control CAS `:409-411`；DDL `:502`/`:552` | CONFIRMED | 六处精确 |
| 9 | 简易路径 `promoteActivation` `sqlite-activation-state-store.ts:170-218`，BEGIN IMMEDIATE + 拒重复 | CONFIRMED（数量上） | 行号与事务/重复行断言均对；**但该路径无生产调用者**（见 NEW-6/§4 NEW-6 与 §6） |
| 10 | Console `ActivationsConsoleModel.ts:617+`；CLI `runtime-activation.ts:624-661`；注释 `rule-host-writer.ts:349-352` | CONFIRMED | `:617` promoteRuleCode 起；`:636-646` service.promote 调用 |
| 11 | 回退 `activation-control-types.ts:1-10`；safety store `:140-171,193-209,229-257` | CONFIRMED | `:1-10` 九个 decision kind；`:140-171` pause+release；`:193-209` deactivate；`:229-257` continue_observing+recover |

#### 环节 5：gate

| # | 报告主张 | 判定 | 证据 |
|---|---|---|---|
| 1 | host-neutral 实现 `production-rulehost-gate.ts:134-397`；Codex 接线 `host-runtime/src/index.ts:236-249` | CONFIRMED | 文件总长 397 行，函数 134–396；`:236-249` |
| 2 | 只读开 state.db `:187-195` | CONFIRMED | `:187` 路径、`:191` existsSync、`:195` readonly |
| 3 | 查询 JOIN `:209-220` | CONFIRMED | `:209-220` |
| 4 | 跳过 safety_isolated/非 eligible/重复 ref/非 live `:242-260` | CONFIRMED | `:242-249` 两类跳过、`:255-260` 重复与 live 过滤 |
| 5 | 全局暂停直接放行 `:198-207` | CONFIRMED | `:201-207` |
| 6 | 预算护栏：MAX_ACTIVE_RULES `:223-224`；512KB `:230-233,279-284`；源码字节 `:292-294,340-343`；3s `:33,57-66` | CONFIRMED | 八处行号全部精确（`RULE_SOURCE_BYTES=64KB`、`RULE_BATCH_SOURCE_BYTES=256KB`、`MAX_ACTIVE_RULES=32`） |
| 7 | 退役符号扫描 `:318-323` | CONFIRMED | `:318-323` |
| 8 | 批量沙箱评估 `:349-356`；mergeDecisions `:379-381` | CONFIRMED | 精确 |
| 9 | 空 reason 降级 allow `:382-388` | CONFIRMED | `:382-388` |
| 10 | 一切内部失败 fail-open `:390-392` 等 | CONFIRMED | `:188-190`,`:224`,`:232`,`:280`,`:283`,`:293`,`:342`,`:347`,`:351`,`:355`,`:385`,`:392` |
| 11 | OpenClaw deny 记 trajectory `gate-block-helper.ts:55-93`；DDL/写 `trajectory.ts:253,798-803`；`rule_host_blocked` `gate.ts:159` | CONFIRMED | 五处精确 |
| 12 | Owner 可见性：`routes/governance.ts` + `GovernanceConsoleModel.ts`（报告标「推断」） | CONFIRMED（补强） | `GovernanceConsoleModel.ts:473-475` 查 `gate_blocks` 今日计数 → `:522-523` 输出 `gateBlocksToday` → FocusPage 展示。**报告的「推断」成立** |
| 13 | 激活健康指标 `ActivationsConsoleModel.ts:74 附近 e2e 结构` | **DRIFT** | `:74` 是 `evidenceRefs` 注释；`liveMetrics` 声明在 `:106`、使用在 `:536` |

### 2.3 D-3 §6 第三部分 · 闭环回边

| # | 报告主张 | 判定 | 证据 |
|---|---|---|---|
| 1 | 跳 1：`prompt.ts:404-408` → `signal-collector-host.ts:180-243` | CONFIRMED | 精确 |
| 2 | 跳 2：STRONG → `emitPainDetectedEvent` `:510-529`、painId `:501-506` | CONFIRMED | 精确 |
| 3 | 跳 3：`pain.ts:130-280`；ingress 四决策 `:168-226`；`recordPain` `:228-243`；taskId `pain-to-principle-service.ts:148`；dead letter `:260-280` | CONFIRMED | 五段精确（ingress 分支 `:179/190/202/212`） |
| 4 | ingress 语义（refuse/observation_only/degrade/submit） | CONFIRMED（补强） | `pain-ingress.ts:157-239` 分支与 `:75/78/85/93` 类型联合一致 |
| 5 | 跳 4：auto-consumer 全链 `internalization-consumer-decision.ts:25-32`；cycle 注释 `:348-379` | CONFIRMED | 精确 |
| 6 | 跳 5：rollout approve → `internalization-consumer-governance.ts:125-133` | CONFIRMED | `:125-133` dispatch 调用 |
| 7 | 跳 5 后续（低风险自动激活 / 高风险入 approval → shadow → promote → gate） | CONFIRMED | 与 §2.2 环节 1/3/4/5 判定一致 |
| 8 | 跳 6：LLM 确认 → TP/FP `prompt.ts:224-230` → correctionObserver 周期 → 词库更新；learn→detect 注释 `:130-137` + provider `:161-166` | CONFIRMED（**但证据链弱于报告**） | 行号精确；机制成立，然而见 NEW-1/2/3：反馈质量受「hitCount 恒 0」「weight 不参与评分」「high 后不可逆」三重削弱 |
| 9 | 跳 7：回写 `correction_detected` `:443-456`；注释 `:314-318` | CONFIRMED | 精确 |
| 10 | Codex 路径：`governance-signal-admission.ts:776` → 事务内限流+写 pain+marker `:461-513` → `ensureGovernanceDiagnosticianTask` `:853-945` → `promoteAdmittedGovernanceEvidence` `:958+`；窗口 ≤12 `governance-observation-store.ts:36` | CONFIRMED | 五段精确（`:36` `GOVERNANCE_PROMOTION_PRECEDING_TURNS = 12`；`:945` 函数闭合） |
| 11 | 断裂点：FP 判定输入为空 | CONFIRMED | 同 F-E2 |
| 12 | 断裂点：WEAK 只到 GFI 不进 pain 链 | CONFIRMED | `routeWeak` 只调 `trackFriction` |
| 13 | 「闭环在结构上是闭合的」 | CONFIRMED（附条件） | 结构闭合成立；`dispatchRolloutActivation` 的 `as never` 见 NEW-9；Codex shadow 证据链缺口见 NEW-7 |
| 14 | （报告未提）闭合链上的第二个 shadow→live 写者 | **NEW-6** | 见 §4 |

### 2.4 D-4 §6 第四部分 · 嫌疑清单与排除清单

| # | 条目 | 判定 | 备注 |
|---|---|---|---|
| 1 | 嫌疑 1 = F-E1（empathyObserver 死角色，治理面仍在） | CONFIRMED | 全部证据行号精确；NEW-13 补第三处遗留面 |
| 2 | 嫌疑 2 = F-E2（correctionObserver FP 失明） | CONFIRMED | 行号精确；NEW-1/2/3 显著加深该结论 |
| 3 | 嫌疑 3 = F-E3（PendingTermStore 未接线） | CONFIRMED | 行号精确；补「Console 无服务端路由」 |
| 4 | 嫌疑 4 = F-E4（确定性主键遮蔽重派） | CONFIRMED | `:138-140`+`:156-174`+`approval-queue.ts:39-46`+`resetToPending :258-265` 全部精确 |
| 5 | 嫌疑 5 = F-E5（prompt channel 无行为回边） | CONFIRMED | 三处行号精确 |
| 6 | 嫌疑 6 = F-E6（gate fail-open） | CONFIRMED | 行号精确；**补强**：Codex stderr 确实承接 warnings（`pd-hook.ts:194`，bounded 16），报告「未证实」项现可证实 |
| 7 | 嫌疑 7 = F-E7（TermSource 双轨） | CONFIRMED | 行号精确；NEW-4 补 Console 镜像类型缺 `llm_learned` 导致校验整体失败 |
| 8 | 嫌疑 8 = F-E8 | **UNVERIFIABLE（报告编号缺口）** | REPORT.md 全文无 `F-E8` 定义。§1.3/§1.4 只交叉引用 F-E1..F-E7 与 F-E9；§6 第四部分为「1..9」编号表，第 9 行即排除清单。**建议报告补 F-E8 或在 §1.4 显式声明编号跳空** |
| 9 | 嫌疑 9 = F-E9（排除清单） | 部分成立 | 见 §6 专项 |
| 10 | 「提取方法备注」三条（逐字引用 / 行号以工作树为准 / EmpathyObserver 检索覆盖范围） | CONFIRMED | 逐字引用经字节级复核成立；检索结论经重新 `git grep` 复核成立 |

---

## 3. 行号漂移修正表

| # | 报告引用 | 报告所在 | 实际行号 | 修正建议 |
|---|---|---|---|---|
| D-1 | `pd-config-defaults.ts:70` 作为 **correctionObserver** 默认关闭证据 | §6 卡 1「触发方式」 | `:69`（`:70` 是 `empathyObserver: false`） | 改为 `pd-config-defaults.ts:69` |
| D-2 | `correction-cue-learner.ts:19` 注释 = 原子写 temp+rename | §6 卡 1「持久化位置」 | 注释在 `:9`；实现 `atomicWriteFileSync` 在 `:75`；文件常量在 `:26` | 改为 `correction-cue-learner.ts:9（注释）/ :75（实现）` |
| D-3 | `ActivationsConsoleModel.ts:74 附近 e2e 结构` = liveMetrics | §6 环节 5「Owner 可见性」 | `liveMetrics` 声明在 `:106`、生产使用在 `:536`；`:74` 是 `evidenceRefs` | 改为 `ActivationsConsoleModel.ts:106 / :536` |
| D-4 | `signal-collector-host.ts:404-408` 作为 `detectSync` 调用点 | §6 卡 3「运行入口」 | 调用语句在 `prompt.ts:406-412`（原文笔误了文件名前缀与行号；`:404-405` 是注释） | 改为 `prompt.ts:406-412`（或标注「注释+调用」范围） |

> 说明：报告声明「行号对应当日工作树」，本次核实以 `70d824c4` 对象读取同一批文件，故以上 4 处非因工作树差异，属报告自身笔误。其中 D-1/D-3 已判为 DRIFT，D-2 已判为 REFUTED，D-4 为文件名+行号笔误（不影响结论）。其余 150+ 处行号精确命中。

---

## 4. 完整性补记（NEW）

> 均为「核实员补充」，含 file:line + 严重度建议。**未修改报告任何内容**。

### NEW-1【P2】correctionObserver 的 `hitCount` 结构性恒为 0，使提示词 REMOVE 规则恒成立

- 事实：`CorrectionCueLearner.recordHits()`（`correction-cue-learner.ts:133-145`）是 `hitCount` 的唯一自增点，**全仓无任何生产调用者**（`git grep recordHits` 仅命中定义与 8 处测试 mock）。prompt 的 `hits={hitCount}` 因此恒取 `:273` 投影的 `k.hitCount ?? 0` = `0`。
- 后果：提示词规则 `- REMOVE: If a term has 0 hits after many uses AND high false positive rate (>0.3)`（`correction-observer.ts:118`）对**每一个**词的前置条件恒为真；只要 FP>0.3，LLM 就有充分理由建议 REMOVE。这是 F-E2「FP 失明」之外**第二个结构性失明**：报告只指出「FP 判定输入为空」，未指出「REMOVE 判定输入恒为 0」。
- 证据：`correction-cue-learner.ts:133-145`；`correction-observer-service.ts:273`；`correction-observer.ts:118`；`keyword-optimization-service.ts:67-70`（REMOVE 执行点）。
- 核实员补充：该字段也被报告列为 payload 字段（§6 卡 1 输入表），但未标注其恒零性质。

### NEW-2【P2】`CorrectionCueLearner.match()` 无生产调用者 → weight 不参与检测评分

- 事实：评分函数 `match()`（`correction-cue-learner.ts:97-131`）用 `score = keyword.weight * accuracy`（`accuracy = tp/(tp+fp)`）计算加权命中分。该函数**无生产调用者**（全仓 `.match(` 生产命中仅 `detection-funnel.ts:41` 的字典 match，属另一对象）。
- 后果：correctionObserver 的 `UPDATE` 建议（改 weight）与 `recordFalsePositive` 的 ×0.8 权重衰减（`correction-cue-learner.ts:167`）对**检测结果无直接影响**；weight 唯一生效路径是 `precisionFor`（`governance-signal-admission.ts:161-172`）里的 `weight >= 0.7` 阈值（仅对 `source !== 'llm'` 生效，即 seed/user）。报告 §6 卡 1「下游消费者」写「`updates` → ... → 检测词库」，读起来像 weight 直接影响检测，实际存在这一层空洞。
- 证据：`correction-cue-learner.ts:97-131`；`governance-signal-admission.ts:161-172`；`keyword-optimization-service.ts:60-66`。

### NEW-3【P2】llm 词的 `high` 状态不可逆：升 high 后 Stage1 短路，TP/FP 反馈只剩失明路径

- 事实：llm 词 earned precision 升 `high` 后，`scanKeywords` 命中即 `needsLlmConfirmation=false`（`keyword-stage.ts:44-52`）→ `detectSync` 直接 `routeStrong` 返回（`signal-collector-host.ts:218-227`），**永不进入 Stage2** → `emitCueFeedback` 永不触发（仅存在于 `:311-332` 与 `:423-434`）。而 `recordFalsePositive` 的生产调用点只有两处：`prompt.ts:224-230`（Stage2）与 `keyword-optimization-service.ts:81-98`（correctionObserver，本身失明）。
- 后果：一个误报率上升的 learned 词一旦达到 TP≥3/FP=0（`governance-signal-admission.ts:104,169`）即被固化在确定性 STRONG 路径上，**没有基于真实误报的自动降级**。报告 F-E2 只描述 FP 输入失明，未描述该「单调不可逆」性质。
- 证据：`keyword-stage.ts:44-52`；`signal-collector-host.ts:218-227`、`:311-332`；`prompt.ts:224-230`；`keyword-optimization-service.ts:81-98`；`governance-signal-admission.ts:104,169`。

### NEW-4【P3】Console 的 `TermSource` 镜像缺 `llm_learned`：一旦接线即整库校验失败

- 事实：core 定义 `TermSource = 'seed' | 'migrated' | 'owner_promoted' | 'llm_learned'`（`signal-collector/types.ts:6`），Console 镜像类型只有 3 值（`signal-keywords-types.ts:16`），校验器 `validateUnifiedKeywordStore` 对 `source === 'llm_learned'` 直接 `return null`（`signal-keywords-validators.ts:67`）。
- 后果（**已修正为潜在而非现网故障**）：该 validator 目前**无生产调用者**（`git grep` 仅命中定义与 `tests/ui/signal-keywords-api.test.ts`），且 `SignalKeywordsPage` 只调 `listActiveSignalKeywords()`（`SignalKeywordsPage.tsx:29`）——该函数是 stub（恒返 `endpoint_not_implemented`）。故当前不存在现网可见故障；但该 validator 一旦按 Phase 2 计划接线，任何含 llm 学习词的词库会**整体**返回 null（而非只丢该词），UI 上表现为整个词库不可用。
- 与报告的关系：报告 F-E7 把双轨列为「整洁度问题（无错误行为）」。该判定在当前状态下成立，但未记录「镜像类型少一值 + 失败粒度是整库」这一潜在放大效应。
- 证据：`signal-collector/types.ts:6`；`signal-keywords-types.ts:16`；`signal-keywords-validators.ts:32,58-70`；`SignalKeywordsPage.tsx:6,29`；`signal-keywords-api.ts:38-48`；`governance-signal-admission.ts:150,190`。

### NEW-5【P2】`/:id/disable` 是一条绕过 Owner 授权与决策审计的停用路径

- 事实：`POST /api/v1/activations/:id/disable`（`routes/activations.ts:138-195`）只做 `confirmed:true` 校验，**不要求 Owner 身份**（`authority` 未参与该分支），最终走 `ActivationsConsoleModel.deactivateActivation`（`:673-708`）→ `SqliteActivationStateStore.deactivateActivation`（`:160-168`，仅 `UPDATE activations SET deactivated_at`）。对比同页的 `emergency-deactivate`（`activations.ts:109`）→ `deactivateRuleCode`（`:553-570`）会写 `activation_decisions` 不可变行、并要求 `configured_owner` 身份。
- 后果：同一个 UI 页面上的两条停用路径授权强度不一致：弱路径不落 `activation_decisions`（治理审计面缺行）、不校验 `activation_control_states`、不可被「promote/recover」的证据链解释。报告 F-E4/F-E5/F-E6/F-E7 与 F-E9 均未提及此不对称。
- 证据：`routes/activations.ts:138-195`；`ActivationsConsoleModel.ts:673-708` vs `:553-570` vs `:547/:554/:573`（`requireOwnerDecisionFeature` 三处，disable 路径无）；`sqlite-activation-state-store.ts:160-168`；`ActivationPage.tsx:485`（UI 就调用这条）。
- 严重度理由：Owner 信任/审计面，P2；不宜自定为 P1（无旁路放行、仅缺审计行与身份门）。

### NEW-6【P2】两条「第二条 live 写者 / 无 writer 通道」事实

- (a) `SqliteActivationStateStore.promoteActivation`（`:170-218`）是**第二条 shadow→live 写者**：直接 `UPDATE activations SET action='code_tool_hook_live_activate'`，**无 Owner 决策、无 evidence snapshot、无 `activation_decisions` 行、无 control-state CAS**。它不在 `ActivationStateReadModel` 接口（`activation-types.ts:90-97`）中，生产无调用者（调用者全在 tests：`j10-rule-governance-states`、`rule-host-cache-invalidation`、`rulehost-seed-mvp-e2e`、`cross-package-acceptance`）。报告称之为「简易路径」而未说明其生产不可达与绕过性质。
- (b) 全仓**无 skill channel writer**（无 `SkillWriter`、无 `channel='skill'` 实现，`git grep` 零命中），而 `AUTO_PROMOTABLE_CHANNELS = ['skill']`（`activation-types.ts:17`）与 `decideAutoPromotion` 的豁免分支存在。于是「skill + conf≥0.95 自动豁免」在 dispatch 层实际结局是 `activateArtifact` → `no_writer_for_channel_skill` refused（`activation-dispatcher.ts:351-354`）。报告环节 1 把该豁免写成可用例外，实际上它无法产出激活。
- 证据：`sqlite-activation-state-store.ts:170-218`；`activation-types.ts:17,90-97`；`activation-dispatcher.ts:265-270,351-354`；`low-risk-writers.ts`（仅 Prompt/DeferArchive）；`grep 'skill'` 于 `packages/**/src` 无 writer 实现。

### NEW-7【P2】Codex 侧无 shadow 证据产生通道 → promote 在该宿主结构性不可达

- 事实：`rulehost_evaluated` 事件的生产点只有 OpenClaw 插件（`hooks/gate.ts:117,134`）。host-neutral 的 `createProductionRuleHostGate` 只返回 `HostEventResult`，**从不写事件**；Codex 的 emitter（`pd-hook.ts:25-51`）只实现 `recordRuntimeV2ActivationsInjected` 与 `recordToolCall`。而 shadow 证据读取器只在 OpenClaw 事件目录搜（`runtime-activation.ts:86-112` `RULECODE_EVENT_LOG_CANDIDATE_DIRS`）。
- 后果：Codex 上 `summarizeRuleCodeShadowEvents` 恒得 `observed=0`（或 `sourceDirsFound=0` → `shadow_telemetry_source_unavailable`，`promotion-readiness-evaluator.ts:41-43`），promote readiness 结构性 `unavailable`，shadow→live 在 Codex 上无路径——**不是「无旁路」，而是「无路径」**。报告 §6 环节 3 只说「shadow 与 live 均发 rulehost_evaluated」，未区分宿主；F-E9 第 4 项把「无旁路」当作正向结论，掩盖了这一宿主侧缺口。
- 证据：`production-rulehost-gate.ts`（全文无事件写入）；`codex-adapter/src/pd-hook.ts:25-51`；`hooks/gate.ts:117,134`；`runtime-activation.ts:86-118`；`promotion-readiness-evaluator.ts:41-43`。

### NEW-8【P3】`cancelled` 状态无生产写入者（见 §1.3 R-c）

- 证据：`activation-types.ts:140`（类型）；`sqlite-approval-store.ts:26`（白名单）；`approvals.ts:69`（查询白名单）；`ApprovalsConsoleModel.ts:35,117`（stats 默认）；全仓无写入点。报告环节 1 将其列为可达状态转移。

### NEW-9【P3】`dispatchRolloutActivation` 对 channel 使用 `as never`

- 事实：`internalization-consumer-governance.ts:127` `channel: input.channel as never`（注释自辩「rollout 链的 channel 已由任务元数据校验」）。
- 后果：违反 `rc-2-no-as-bypass`（不得用 `as` 替代运行时校验）。报告在 §6 闭环回边把它当作正常接线，未记录该旁路。
- 证据：`internalization-consumer-governance.ts:125-133`。

### NEW-10【P3】双 gate 实现的事实不对等（护栏只在 shared gate）

- 事实：`MAX_ACTIVE_RULES` / 512KB artifact 预算 / 3s gate deadline / 退役契约符号扫描 / 批量沙箱 全部只在 `production-rulehost-gate.ts`；OpenClaw 的 legacy 路径 `core/rule-host.ts` **没有**同等的 artifact 大小与总时限护栏，也**不调用** `scanRetiredContractSymbols`。
- 后果：报告环节 5 把「预算护栏 + 退役符号扫描」表述为管道级事实，实际只覆盖 shared gate 路径（`openclaw-host-runtime.ts:75`、Codex `pd-hook.ts:186`）；legacy 直调路径（`gate.ts:handleBeforeToolCall`）缺同护栏。
- 证据：`rule-host.ts`（grep 无 `MAX_ACTIVE_RULES` / `scanRetiredContractSymbols`）；`production-rulehost-gate.ts:223-224,230-233,292-294,318-323,340-343`。

### NEW-11【P3】WEAK「阈值 70 触发诊断」是注释而非实现

- 事实：`signal-collector-host.ts:539` 注释写「过 highGfi 阈值(70)才触发诊断」；实际门在 `hooks/llm.ts:280` `Math.max(config.get('severity_thresholds.high') || 70, painTriggerThreshold + 30)` 与 `pain-diagnostic-gate-policy.ts:148,201-202`。
- 后果：报告 §2.2/§6 卡 3 把该注释当事实转述（「阈值 70 触发诊断」）。当 `thresholds.pain_trigger` 被调高时，真实门随之变为 `painTrigger+30`。
- 证据：`signal-collector-host.ts:539`；`hooks/llm.ts:276-287`；`pain-diagnostic-gate-policy.ts:148,201`。

### NEW-12【P3】`updates[].reasoning` 既不落库也不进日志（见 §1.3 R-b）

- 证据：`correction-observer.ts:204-206`（仅类型校验）；`keyword-optimization-service.ts:40-77`（4 条日志均不含 reasoning）。

### NEW-13【P3】empathyObserver 遗留面还有第三处（prompt-helpers / i18n / agent-metadata）

- 事实：除报告已列的「类 + Console 开关 + 成本提示 + 配置键」外，还有：`hooks/prompt-helpers.ts:81-91`（识别 empathy-observer 输出的递归防止逻辑）、`:128-141`（`buildEmpathySilenceConstraint` 要求主 agent 不得输出 `damageDetected/severity/confidence` 字段）、`:315`（从 EmpathyObserver reason 抽关键词）、`pd-console/src/ui/utils/agent-metadata.ts:357-358`、`enum-labels.ts:99`。
- 后果：退役残留面比报告 F-E1 描述的更宽；`buildEmpathySilenceConstraint` 是注入进主 prompt 的**行为约束文本**，若 empathyObserver 已死，该约束的语义依据消失（约束本身仍生效，属提示词面的孤儿）。
- 证据：`prompt-helpers.ts:81-91,128-141,242,315`；`agent-metadata.ts:357-358`；`enum-labels.ts:99`。

---

## 5. 建议修正清单

> 格式：原文 → 建议文。**仅在本核实文档中提出，未改动 REPORT.md。**

| # | 位置 | 原文 | 建议文 |
|---|---|---|---|
| M-1 | §6 卡 1「持久化位置」 | 「原子写 temp+rename，**`:19` 注释**」 | 「原子写 temp+rename（注释 `correction-cue-learner.ts:9`，实现 `:75`）」 |
| M-2 | §6 卡 1「触发方式」 | 「默认关闭 `pd-config-defaults.ts:70`」 | 「默认关闭 `pd-config-defaults.ts:69`」 |
| M-3 | §6 卡 1「下游消费者」 | 「`updates[].reasoning`（**仅日志**，applyResult 不落库）」 | 「`updates[].reasoning`（**既不落库也不进任何日志**；仅 `correction-observer.ts:204-206` 做类型校验）」 |
| M-4 | §6 环节 1「输出/状态转移」 | 「pending → approved / rejected / **cancelled**」 | 「pending → approved / rejected（**`cancelled` 无生产写入者**，仅存在于类型/白名单/stats 默认值）」 |
| M-5 | §6 环节 5「Owner 可见性」 | 「激活健康指标 `ActivationsConsoleModel.ts:74 附近 e2e 结构`」 | 「`liveMetrics`：声明 `ActivationsConsoleModel.ts:106`、生产 `:536`」 |
| M-6 | §6 环节 3「动作」 | 「shadow 与 live 均发 `rulehost_evaluated` 到 events JSONL（`hooks/gate.ts:116-146`）」 | 建议补「**仅 OpenClaw**；host-neutral gate 不产该事件，Codex emitter 亦未实现 → Codex 侧 shadow 证据链为空（见 VERIFICATION-D NEW-7）」 |
| M-7 | §6 卡 3「下游消费者」 | 「WEAK → `trackFriction`（摩擦分 20，**阈值 70 触发诊断**）」 | 「WEAK → `trackFriction`（摩擦分 20）；诊断触发门实为 `hooks/llm.ts:280` `Math.max(severity_thresholds.high \|\| 70, painTrigger+30)`，源码注释中的『70』仅是默认值」 |
| M-8 | §6 卡 1 输入表 + 提示词引用 | `hitCount` 作为有效 payload 字段 | 建议补「**该字段结构性恒为 0**（`recordHits` 无生产调用者）→ 提示词 REMOVE 规则对所有词恒成立（VERIFICATION-D NEW-1）」 |
| M-9 | §6 环节 1 输入段 | 「例外：skill channel + confidence≥0.95 自动豁免人工审批」 | 建议补「**该豁免在当前生产无法产出激活**：无 skill channel writer，dispatch 终局为 `no_writer_for_channel_skill` refused（VERIFICATION-D NEW-6b）」 |
| M-10 | §6 环节 4「输出/状态转移」 | 「简易路径 `promoteActivation` 亦为 BEGIN IMMEDIATE 且拒重复行（`:170-218`）」 | 建议补「**该路径无生产调用者**（仅测试），且绕过 Owner 决策/证据/审计；production 唯一 live 写者是 `commitPromotion`（VERIFICATION-D NEW-6a）」 |
| M-11 | §6 环节 2「Owner 可见性」 | 「Console activations 页（`routes/activations.ts`）」 | 建议补授权不对称说明：「`/:id/disable` 不要求 Owner 身份、不写 `activation_decisions`，与 `/:id/emergency-deactivate` 授权强度不同（VERIFICATION-D NEW-5）」 |
| M-12 | §1.4 / §1.3 交叉引用 | 引用 `F-E1..F-E7`、`F-E9` | 建议显式声明编号跳空（无 F-E8），或补 F-E8 定义（VERIFICATION-D D-4 #8） |
| M-13 | §6 卡 2 断裂嫌疑 1 | 「agent 绑定与 UI 未同步退役」 | 建议补第三处遗留面：`hooks/prompt-helpers.ts:81-91,128-141,242,315`、`agent-metadata.ts:357-358`、`enum-labels.ts:99`（VERIFICATION-D NEW-13） |
| M-14 | §6 环节 5「动作」 | 「预算护栏：MAX_ACTIVE_RULES…gate 总时限 3s…退役契约符号扫描」 | 建议补「上述护栏**仅存在于 host-neutral shared gate**；OpenClaw legacy 直调路径 `core/rule-host.ts` 无同等 artifact/时限护栏与退役符号扫描」（VERIFICATION-D NEW-10） |

---

## 6. F-E9 排除清单重验结论（单独成节）

F-E9 由四项断言组成（报告 §6 第四部分第 9 行 + §1.4 引用）。

| # | 断言 | 结论 | 依据与限定 |
|---|---|---|---|
| 1 | **approvals 表单一 store 实现，无第二真相** | **成立** | 生产写入者只有 `SqliteApprovalQueueStore`（`sqlite-approval-store.ts:156-174,232,248,263,274`）；`MemoryApprovalQueueStore` 仅测试引用（`git grep` 全在 `__tests__`）；读取者（`ApprovalsConsoleModel`、`runtime-v2-prompt-activation-reader.ts:121-125`、`GovernanceProjectionCollector.ts:157`、`principles.ts:97`）全部经同一 store 或只读 SQL。**限定**：`pd-legacy-cleanup --apply` 会对 approvals 执行 `DELETE`（`legacy-cleanup.ts:224`，与 activations/pi_artifacts 同事务）。这是清理写入者而非竞争真相源，不推翻结论，但「单一 store」应限定为「单一创建/状态推进者」 |
| 2 | **promote 的 supersede/recover/emergency 同事务** | **成立** | `commitPromotion` 全程 `BEGIN IMMEDIATE`（`sqlite-activation-safety-store.ts:339-420`），evidence snapshot + decision + supersede + action 翻转 + control CAS 同一事务，且失败即整体 ROLLBACK（`:417-419`）；`deactivateWithDecision`（`:184-215`）、`recoverToShadow`（`:247-259`）、`pauseAllLive`（`:133-152`）、`releaseGlobalPause`（`:161-172`）各自单事务。**仍成立** |
| 3 | **Owner 裁决机判值永不改写、effective decision 单点解析** | **成立** | `runnerDecision` 只由 runner 写入（`evaluator-runner.ts:1682`、`rollout-reviewer-runner.ts:1073`），Owner override 落在 `ownerResolutions[].effectiveDecision`（`owner-resolution-service.ts:462-464`）；`resolveEffectiveRunnerDecision` 是唯一解析点（`owner-review.ts:400-406`，`internalization-transition-decision.ts:145` 是唯一生产消费点，另有架构测试断言「defined exactly once」）；`activation_decisions` 有 `no_update`/`no_delete` 触发器（`sqlite-connection.ts:538-541`） |
| 4 | **shadow→live 无旁路** | **成立，但仅为「未接线」保证，非构造性保证** | 正向：`RuleHostWriter.activate` 恒返回 `code_tool_hook_shadow_activate`（`:359-363`）；`'approved'` 派发也必须过 writer（`activation-dispatcher.ts:260`）；`commitPromotion` 强制 owner+evidence+control CAS。**反证/限定**：存在第二条可写 live 的生产级 API——`SqliteActivationStateStore.promoteActivation`（`sqlite-activation-state-store.ts:170-218`），只需一次 UPDATE 即可完成 shadow→live，**不需 Owner、不需证据、不写 decision 行**；它当前无生产调用者、且不在 `ActivationStateReadModel` 接口内，故旁路成立性依赖「无人接线」而非类型/权限构造。**另**：Codex 宿主根本没有 shadow 证据产生通道（NEW-7），该宿主上 promote 不可达 —— 「无旁路」在该宿主成立的原因是没有路径 |

### 6.1 F-E9 总判定

- **排除清单未被推翻**：三项强成立，第四项成立但需附条件说明。
- **但排除的「强度」被高估**：第 4 项的成立依赖未接线，而不是构造性不可达（NEW-6a）；第 1 项的「单一真相」把清理命令排除在外（可接受但应显式限定）。
- **建议报告改写**：「shadow→live 无旁路（构造性：writer 恒返 shadow + commitPromotion 强制 owner/evidence；**限定**：存在测试级第二写者 `promoteActivation` 与 Codex 宿主无证据通道）」。

### 6.2 与嫌疑清单同等强度的说明

任务要求「排除错了就是漏报，按与嫌疑同等强度核验」。本次对四项均做了**反证搜索**（找第二个写者/第二个真相源/绕过路径/宿主差异），方法为：①枚举全仓对相应表/API 的全部写点；②枚举所有 shadow→live 的 action 赋值点；③逐宿主比对事件生产与读取通道。上述 NEW-5/NEW-6/NEW-7 即为该反证搜索的产物——它们不推翻排除结论，但**收窄了结论的适用范围**，属应当记录的事实。

---

## 7. 未做的事 / 局限

- 未移动任何已存在文件；未修改 `REPORT.md`；未触碰 `packages/**`、`.cnb/**`、`.cnb.yml`。
- 未做 live 运行时取证（`~/.pd/` 状态库），全部判定基于 `70d824c4` 的静态源码事实。
- 未核实 `TAPD`/Linear 工单关联（无凭据，且本次任务未要求）。
- §1.1 计数为本文档判定表行数汇总，口径见各表；同一报告句子被拆成多个判定点时分别计数。
- 报告声称锚定 GitHub `main` @ `70d824c4`，本次使用本地同 hash 对象读取；已抽查 5 个文件与当前检出 HEAD 的差异（`feature-flag-contract.ts` 新增 `prompt_full_pipeline` 于 `:218`、`revision-reopen.ts` PRI-720 分支、`internalization-consumer-governance.ts` `pipelineMode`、`internalization-consumer-cycle.ts` telemetry sink、`feature-flag-lifecycle.ts`），**均为在途 PR 改动，不影响本核实结论的行号**（本文档所有行号均以 `70d824c4` 为准）。
