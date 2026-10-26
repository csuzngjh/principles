# PRI-1048 治理焦点规则归属队列：修复父子任务重复并改成可理解的来源、阶段与操作卡片

> 交付日期：2026-10-26 ｜ 分支：`ai/PRI-1048-rule-binding-focus-cards` ｜ 类型：Console 界面修复（P2）
> 工单：PRI-1048（PRI-987 子范围）｜ 后端恢复（PRI-1047）不在本票范围，本票只消费其既有真实资格

---

## Owner Review Card

**1. Problem（验证过的真实问题）**
治理焦点「规则的正式原则归属」队列把 9 条规则候选显示成 18 条，且每条是整段长文的下划线按钮：无来源反馈、无当前阶段、无下一步动作。Owner 反馈："那么一堆的文字什么意思，这样的功能是给人用的吗，完全看不懂啊"。真实 workspace（`C:/Users/Administrator/.codex/pd-workspace`）只读核对确认 18=9×2。

**2. Before**
`RuleCandidateBindingConsoleModel.list()` 同时遍历 diagnostician 与 diag_router 任务并逐个调用 `getCandidatesByTaskId` 后直接 `items.push`。而该 store 查询本身按 `t.task_id=? OR t.input_ref=?` 跨「自身+子任务」取候选——父诊断已带出 router 候选，router 遍历再带出一次。既有 split 测试只 `toContain`，无唯一性断言，故 CI 绿但重复。

**3. After**
- 队列聚合所有者按 canonical candidateId 去重（真实 workspace：18→9，distinct 一致）；共享 store 查询语义不变，其他消费者不受影响。
- 队列 DTO 扩展为只读投影：来源痛苦信号原文+来源+时间（trajectory.db 单次批量只读）、诊断任务状态、绑定态与所关联原则正文/版本/修订号（ledger 权威）、生成链阶段（dreamer→philosopher→scribe→artificer→evaluator→rollout_reviewer，受阻携带服务端 reasonCode 与 detail）、修订资格（真实 `resolveRuleBindingRevisionTarget` 解析 + 与 `reviseRuleBindingOnce` 完全相同的预算规则）、汇总计数（组数/候选数/已关联/待决定/受阻分开）。
- 前端改为按痛苦信号分组的有界卡片（默认 3 组，可展开剩余）：每张卡默认回答三问——来自哪次反馈（组头原文+来源+日期）、当前在哪步（阶段徽章+受阻原因人话）、我要做什么（明确下一步行）；原文全文保留、截断只作标题预览；技术 ID/原始 JSON/资格原因码折叠进「技术详情」。
- 52d 场景如实表达：`已关联原则（设计确认门禁 v1）→ 生成停在「规则生成(artificer)」：草案引用核验未通过（textual_basis_unanchored）→ 尚未生成新规则 → 当前无需拥有者批准——这是材料问题，需要先修订草案`。修订资格按真实后端判定：该候选预算已用（`revision_budget_exhausted`，epoch 3），不显示「修订并继续」按钮，给准确受限说明与查看原因入口。
- review 决策面同样增强：来源原话（不再只有 ID）、已关联原则正文+详情链接（不再只有 UUID）、生成/资格状态。

**4. Existing mechanism reused**
绑定/撤回/修订复用既有 `mutateRuleCandidateBinding` / `reviseRuleBindingOnce`（含 revise-once 路由）；身份解析复用 `resolveCandidatePrincipleIdentity`；修订资格直接调用生产解析器 `resolveRuleBindingRevisionTarget`（本次仅加入 barrel 导出，无逻辑复制）；pain 读取复用 EvidenceChainConsoleModel 的 trajectory.db 只读模式；卡片样式复用 Focus 既有 PendingReviewCard 模式与 tokens。

**5. Complexity Delta**

```text
New durable source of truth: NO
New persisted schema/state: NO
New subsystem/service/background process: NO
New public abstraction/interface: YES（队列/review DTO 扩展——工单点名的缺失字段补齐；跨包导出 resolveRuleBindingRevisionTarget 一行）
New runtime feature flag: NO
New cross-package dependency: NO（pd-console 已依赖 core，仅新增一个既有函数导入）
New host/platform-specific behavior: NO
New external/network capability: NO
```

**6. Design reason（最小一致解）**
去重发生在队列聚合所有者（工单指定），一行 Set 防重；不改共享查询避免破坏 pain-chain/admission 等十余个消费者。投影字段全部从既有权威派生（trajectory.db / state.db 任务链 / ledger 文件 / 生产资格解析器），无新状态账本、无 LLM 摘要调用。资格判定若在投影里复算会与后端漂移（ERR-152），故直接消费生产函数。

**7. Verification**
- 红绿：先写真实 SQLite split 负控（红：`expected 1 but got 2`，复现 18=9×2），修复后绿。
- 模型/路由/校验器/纯函数：pd-console 全套 **2979 通过（156 文件，另 1 例预期失败为既有负控）**，含新增 dedup 5 例（split 去重/孪生保留/重复加载/零写入/201→200 上界驱动 ERR-134）、投影 10 例（bound 受阻/ready/in-flight/not_built/撤销/ledger 不可读/缺原话/trajectory 不可读区分 rc-9/review 增强/预览与 reviseRuleBindingOnce 实判一致 P4 钉扎）、validators 8 例（重复 candidateId 整包拒收、可空字段必须显式存在、'invalid' 哨兵区分合法 null 与畸形行）、panel 5 例（穷举状态映射、i18n 双语键存在、源码契约）。
- core：architecture-regression + revision 并发 + internalization 契约 **510 通过**；barrel 冻结快照 +1 同步。
- e2e（真实浏览器，Owner token 认证模式，隔离临时 workspace）：新增 5 例全过；主套件 **80 过**、owner 套件 **7 过**（seed 增强无回归）。
- 生产只读核对（修复后模型对真实 workspace）：`displayed: 9, distinct: 9`，`summary {painGroups:7, candidates:9, bound:1, unlinked:8, blocked:1}`，52d 四要素如实（见上）。
- 零治理写入：模型级断言 list()/review() 前后 state.db 字节哈希不变；生产核对全程只读 handle。

**8. Risk**
- 投影依赖任务命名/血缘约定（dreamer seed 携带 candidateId、pi_metadata.dependencyTaskIds）；若后端票（PRI-1047）调整链结构，`walkChain` 的阶段展示可能退化为 `advanced/ambiguous`——不会误报，但需要跟进文案。
- resume 'ready' 的展示窗口窄（bind 即消耗预算），属真实语义而非缺陷。
- e2e 依赖 seed 的 ledger 原则带 `version` 字段（本次补齐，与生产形状一致）。

**9. Rollback / recovery**
纯 UI/投影变更，无数据迁移。回滚 = revert 该 PR：队列恢复旧 DTO/旧面板（18 条重复回归），治理数据无损。「修订并继续」按钮仅在资格 ready 时渲染，无新增常驻后台行为。

**10. Follow-ups（刻意不做）**
- PRI-1047：后端草案契约修复与正式恢复断路（本票只消费资格，不实现恢复）。
- 队列分页（当前上限 200 条 + truncated 标记已够当前规模）。
- review 页搜索同时筛痛苦/候选列表（工单未要求）。

---

## 根因与修复细节

### 根因
`SqliteCandidateStore.getCandidatesByTaskId` 的 `WHERE t.task_id=? OR t.input_ref=?` 是既有有意义的「自身+子任务」查询（pain-chain、admission 等消费者依赖）。队列层同时遍历两类任务再逐任务调用它，router 提交的候选被双重带出。真实 workspace 9 条候选全部提交在 `diag_router-*` 子任务上，故每条出现两次。

### 修复位置
- `packages/pd-console/src/server/models/RuleCandidateBindingConsoleModel.ts`：`list()` 用 `Map<candidateId, entry>` 聚合；扫描一次 `listTasks()` 构建任务/链上下文；trajectory.db 单次 `IN` 批量取 pain；ledger 单次读补原则正文与 decidedAt；`MAX_QUEUE_ITEMS=200` 封顶 + `truncated` 如实标记。
- 资格：`deriveResume` 先调生产 `resolveRuleBindingRevisionTarget`（拒绝原因原样透出），再对解析出的 scribe 应用与 `reviseRuleBindingOnce` 相同的预算检查（`ruleBindingRevisionCauseId` / `rule-binding:` 前缀），点击时 revise-once 路由仍权威复核。

### 计数红绿
- 红（修复前，真实 split 夹具）：router 候选 `expected 1, got 2`。
- 绿（修复后）：真实 workspace `displayed=9=distinct`；`summary` 组数(7)与候选数(9)分开；同 pain 双候选（如 manual_1790771465646 两规则、manual_1791868470372 两规则）均保留、可分别查看。

## 浏览器证据（U04/U05）

e2e：`packages/pd-console/tests/e2e-owner/rule-binding-queue.spec.ts`（Owner token 登录，不绕认证；隔离临时 workspace seed）：
1. 首屏计数与去重：3 候选/2 组，卡片 testid 无重复。
2. 三问卡片：组头含反馈原话「你新增LLM调用层时没先给我可审阅的SPEC…」；受阻卡含「草案引用核验未通过」「尚未生成新规则」「当前无需拥有者批准」「修订预算已用完」；无「修订并继续」按钮；「技术详情」默认折叠；展开后含原则正文+详情链接+来源原话。
3. 允许的 bind：真实 eligible target 选择→关联→准确回执「关联已保存，但修订尚未开始」（该候选无链，诚实降级）→计数实时 2 已关联/1 待决定；stale `expectedRevision=0` 请求 → **409 stale_revision**。
4. 320px 窄屏无横向溢出。
5. 队列接口失败 → 可见 alert，不渲染空待办。

截图（Owner 验收材料）：`.tmp/pri1048-e2e/01-first-screen.png`、`02-target-card-expanded.png`、`03-after-bind-receipt.png`、`04-narrow-320.png`、`05-queue-error.png`。

**三问验收**（默认卡片直接回答，无需读 JSON/UUID/多段解释）：
- 这是哪次反馈？→ 组头「来自反馈：<原话首行> · Owner 反馈 · 日期」
- 现在卡在哪？→ 徽章「已关联 · 受阻」+「生成停在『规则生成』：草案引用核验未通过…尚未生成新规则」
- 我要做什么？→「下一步：生成受阻且当前不可恢复（修订预算已用完）；需修订草案，后续版本会提供正式恢复入口」+「当前无需拥有者批准」

## 独立评审结论（两轮）

**Standards 评审**（独立子代理，对照 AGENTS.md/rc-*/EP-*）：无 P0/P1；8 项发现全部采纳修复——
1. P2 每卡重复读 ledger 全文件 → list()/review() 单次快照贯穿（身份解析仍走 adapter 权威）。
2. P2 trajectory 读失败被误标「未记录」（rc-9）→ 区分 `unreadable`（记录暂不可读）与 `unknown`（未记录），并有负控测试。
3. P2 下一步文案/左条用三元链折叠状态联合（ERR-106）→ 全部改为穷举 `Record` 映射。
4. P2 truncated 提示把总数当已显示数 → 传 `items.length`，文案明确「计数仅覆盖已显示条目」。
5. P3 截断时五项计数基准不一致 → 统一按已显示条目计算。
6. P3 裸 teal 调色板类（EP-13）→ 改主题 token（green）。
7. P3 双语各有一个死键 `revoke` → 删除。
8. P3 预算谓词与后端漂移风险（P4）→ 增加钉扎测试：投影预览必须与 `reviseRuleBindingOnce` 实判同因拒绝。

**Spec 评审**（独立子代理，对照 U01–U06 与硬边界）：**U01–U06 全 PASS**；确认未新增 LLM 调用、未改绑定/审批/激活权威、core 仅一行既有函数 barrel 导出、修订按钮只消费真实资格、PRI-1047 未被越界实现；备注的测试删减为同类边界的等价替换（-1/1.5 负例由 MAX_SAFE_INTEGER+1 与 -1 保留覆盖）。

## 情绪价值（减少读不懂和被迫决策）

- 负面情绪转化：被信息淹没（18 条重复长文按钮）→ 清醒感（9 张分组卡片，三问自答）；被迫决策的不确定（「是不是要我批什么」）→ 掌控感（明确「当前无需拥有者批准，这是材料问题」）；看不懂术语码 → 信任（reasonCode 有人话映射，原文码仍可查）。
- 缺数据不伪装：原话缺失显示「原话未记录」，ledger 不可读显示「材料异常」，不编造、不静默。

## 交付状态分层（不把本地改动当作用户已更新）

- **源码交付**：本 PR（代码+测试+changeset+报告），提交于 `ai/PRI-1048-rule-binding-focus-cards`。
- **实际安装**：未执行。正式安装 2.3.13 的 Console 仍是旧行为；本修复将随正规发布链（changeset → version PR → 安装器）进入用户安装包，不由本票本地改安装文件。
- **可用性验证**：隔离 fixture 的真实浏览器 e2e 全过 + 真实 workspace 只读投影核对（数据侧证明 18→9 与 52d 四要素）；Owner 对新界面的最终走查待安装更新后进行。

## 验证清单汇总

| 项 | 结果 |
| --- | --- |
| split 去重红→绿（真实 SQLite） | ✅ 红 got 2 → 绿 1 |
| pd-console vitest 全套 | ✅ 2976/2976（156 文件） |
| core 相关套件（barrel/architecture/revision/internalization） | ✅ 510/510 |
| Playwright 主套件 / owner 套件 | ✅ 80 过 / 7 过（含新增 5） |
| 生产 workspace 只读核对 | ✅ 9/9，52d 四要素如实 |
| 零治理写入断言（list/review 字节哈希） | ✅ |
| tsc --noEmit（pd-console） | ✅ 无错误 |
| i18n 双语键齐（cr10 治理测试） | ✅ |
