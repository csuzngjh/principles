# PD 控制台“审批”体验审计（Owner 视角）

- 日期：2026-11-06
- 范围：控制台首页（`/focus`）上所有呈现为“需要你处理 / 待批准 / 待恢复”的条目
- 性质：只读调查，未改代码、未写生产库、未部署、未发版
- 结论版本：v1（基于真实运行中的控制台）

---

## 0. 一句话结论

控制台的真正问题，是把四类完全不同的东西混进了一个“需要你处理”列表：

1. 真能裁决的；
2. 能归属但很重的；
3. 只能看、不能动的；
4. 已经过期、永远批不了的。

实测当前运行中的控制台：工作台 **100 条“需要你处理”**，另有 **8 条“需要恢复”**，合计 **108 条可见待办**。其中**真正能点“批准”的只有 4 条（3.7%）**；32 条审批卡片里有 **28 条的“批准”按钮是灰的，而且不告诉 Owner 为什么**。

所以 Owner 的体验必然是：点“开始”，前几条全是死路；往下翻，绝大多数不是“审批”，而是系统没做完的归属和过期残留。

---

## 1. 调查方法与数据来源

- 数据来自本机正在运行的控制台（`127.0.0.1:3100`），使用 Owner token 调用首页实际使用的接口：
  - `/api/v1/governance/experience`
  - `/api/v1/governance/owner-decisions`
  - `/api/v1/principles/owner-decision-inbox`
  - `/api/v1/approvals/grouped`
  - `/api/v1/approvals/:id`
  - `/api/v1/principles/:id/owner-decision-view`
  - `/api/v1/governance/rule-candidate-bindings`
  - `/api/v1/governance/queue`
  - `/api/v1/activations`
- “可批准”不是估算：按控制台自身的 `approveReady` 规则（`ApprovalSubjectReading.tsx:53-63`）对 32 条 pending 审批逐条重算。
- 工作时使用的临时探针脚本已删除（`.tmp/approval-audit` 已清理）。

---

## 2. 实测统计

### 2.1 首页条目构成

| 指标 | 实测值 |
|---|---:|
| 工作台“需要你处理” | **100** |
| ├─ Rollout 验证卡片 | 4 |
| ├─ 待审批卡片 | 32 |
| └─ 候选归属卡片 | 64 |
| “需要恢复”卡片 | 8 |
| “被阻塞”聚合提示 | 39（只渲染成 1 行文字，不是 39 张卡片） |
| 历史数据提示 | 39（源码明确“不是待办事项”） |

### 2.2 审批可执行性

| 指标 | 实测值 |
|---|---:|
| pending 审批 | 32 |
| **approve-ready** | **4** |
| not-ready | **28** |
| └─ 原因：候选未归属（`unlinked:<artifactId>`） | **15** |
| └─ 原因：原则已 blocked、当前版本无决定入口 | **13** |

- 审批通道：prompt 31 条、code_tool_hook 1 条。
- 提示词容量：3080 / 4000，已 truncated，容量状态 unconfirmed；2 个 pending 组超预算。
- 即使 4 条可批准，批准后仍可能因容量被拒，这是第二个风险。

### 2.3 候选归属

| 指标 | 实测值 |
|---|---:|
| 候选总数 | 64 |
| 已绑定 | **0** |
| 未归属 | **64** |
| 痛点簇 | 61 |
| 单个候选可选目标 | 约 51 个候选原则 |

### 2.4 口径混乱

同一屏上至少有五个“待处理”数字：

| 数字 | 来源 |
|---:|---|
| 100 | 工作台 `workItems.length` |
| 21 | 队列 `pendingHumanReviewCount` |
| 12 | 经验快照 `needs_recovery` |
| 8 | Owner inbox `recovery` |
| 39 | Owner inbox `blocked`（聚合） |

页头 `被阻塞 39 · 需要恢复 8` 中的 39 实际只渲染成一行聚合文字，不是 39 张卡片。

### 2.5 真正的“可执行 / 不可执行”

| 类别 | 数量 | 占 108 条可见待办 |
|---|---:|---:|
| 可“批准” | 4 | 3.7% |
| 审批卡片（含只能拒绝/替换） | 32 | 29.6% |
| 可“归属” | 64 | 59.3% |
| 完全无动作（4 验证 + 8 恢复） | 12 | 11.1% |

严格意义上的“审批”只有 4 条；“真正可以审批的少得可怜”是准确感受，不是错觉。

---

## 3. 逐类核对

### 3.1 部署审批（32 条）

- **谁生成**：`approvals` 表中的审批行，由 `ApprovalsGroupedConsoleModel` 按原则分组；分组键由 `principle-id-resolution` 解析，解析失败退化为 `unlinked:<artifactId>`（`ApprovalsGroupedConsoleModel.ts:371`）。
- **接口**：`POST /api/v1/approvals/:approvalId/approve`、`/reject`、`/edit`。
- **能不能完成**：
  - 批准要求：审批仍 pending；决定视图里存在同 approvalId、同 channel、同 artifact 的 `decisionSubject`；material 可用；revision 匹配；material gate 全部 satisfied（`ApprovalSubjectReading.tsx:53-63`）。
  - 必然失败：15 条是 `unlinked:`，决定视图不存在；13 条原则 `decisionState=blocked`，`decisionSubjects=[]`。这两类批准按钮永远灰。
- **Owner 权限**：接口只要求控制台已认证；经验快照里 `principle_approval` 的 observedAuthority 是 `operator_legacy`，不是 configured-owner。
- **下游消费者**：批准 → activation 生效 → 提示词注入渲染器消费（当前 3080/4000）。状态会变。
- **本质**：32 条里只有 4 条“真审批”；28 条是**过期/无归属的清理对象**，却被建模成审批。

### 3.2 规则提升（rulecode_decision）

- **谁生成**：`OwnerDecisionConsoleModel` 从 shadow activation 生成，`allowedActions=['promote','reject_after_shadow']`（`OwnerDecisionConsoleModel.ts:345-351`）。
- **接口**：激活页上的 promote / reject_after_shadow。
- **能不能完成**：能，但首页卡片只有“去激活页”链接，没有内嵌动作。
- **当前数量**：0（没有 active shadow）。

### 3.3 Rollout 验证（4 条，排在最前）

- **谁生成**：`tasks` 表 `status='needs_human_review'`、`task_kind='rollout_reviewer'`，证据缺口为 `lineage_unresolvable`。
- **动作**：`allowedActions: []`，没有任何批准/拒绝动作（`OwnerDecisionConsoleModel.ts:156-193`）。
- **实际呈现**：“证据不可用” + 一个“去恢复”链接（`OwnerDecisionCard.tsx:239-250`）。
- **本质**：100% 假审批，是修复/诊断提示。
- **更严重**：队列有 21 个待人工评审任务，只有 4 个进入 Owner 面；其余 **17 个完全没有卡片**，被 `return null` 静默丢弃（`OwnerDecisionConsoleModel.ts:156-162`）。页面既噪声过大，又不完整。

### 3.4 候选归属（64 条）

- **谁生成**：`RuleCandidateBindingConsoleModel`，64 个候选全部 `unlinked`，0 bound。
- **接口**：绑定/撤销接口存在，要求 reason、target、revision digest（`RuleCandidateBindingPanel.tsx:203-212`）。
- **能不能完成**：技术上能，但每条都要 Owner 手填理由，并在约 51 个候选原则里选一个；64 × 51 选 1，是主要不可用来源。
- **下游消费者**：绑定后 `resumeOnce` 触发 scribe/artificer，有真实消费者。
- **本质**：真决策，但应聚合、预排序、批量处理，不应 64 条平铺进首页。

### 3.5 “需要恢复”8 条

- **谁生成**：`OwnerDecisionViewModel` 的 `recovery` 组。
- **动作**：无。`InboxItem` 只有一个“查看原则”的链接。
- **本质**：运行时恢复状态/诊断，不是待办。

### 3.6 “被阻塞”39 条

- **谁生成**：inbox `blocked` 组，全部是 aggregate（`attention !== 'individual'`）。
- **动作**：无。
- **本质**：历史 lineage 缺失的批量提示，应折叠为一行状态说明。

### 3.7 “历史未知”39 条

- **本质**：数据质量说明；源码已明确“不是待办事项”（`FocusPage.tsx:1027-1038`），但和真实待办出现在同一屏。

### 3.8 逐类总表

| 类别 | 谁生成 / 规则 | 动作与接口 | 能完成吗 / 必然失败条件 | Owner 权限 | 下游 | 本质 |
|---|---|---|---|---|---|---|
| 部署审批 32 | `approvals` 行，按原则分组；解析失败 → `unlinked:` | `POST /approvals/:id/approve|reject|edit` | 仅 4 条能批；15 条无决定视图，13 条原则 blocked | 已认证控制台即可；authority 为 `operator_legacy` | activation → prompt 注入 | 4 真审批 + 28 清理对象 |
| 规则提升 0 | shadow activation | 激活页 promote/reject | 能，但需跳转 | 需 configured owner | activation | 真授权 |
| Rollout 验证 4 | NHR rollout 任务，lineage 缺口 | 无（`allowedActions: []`） | 永远不能；只有“去恢复” | N/A | failed-tasks | 假审批 / 诊断 |
| 候选归属 64 | 未归属候选 | bind / revoke，需 reason + target | 能；但 64×51 选 1 | 需认证 Owner 身份 | scribe/artificer | 真决策但过重 |
| 需要恢复 8 | ledger recovery 状态 | 无 | 永远不能 | N/A | 运行时自动恢复 | 状态通知 |
| 被阻塞 39 | ledger blocked（聚合） | 无 | 永远不能 | N/A | 无 | 批量数据质量提示 |
| 历史未知 39 | 旧数据无 lineage | 无 | 永远不能 | N/A | 无 | 说明文字 |

---

## 4. Owner 首页是怎么混在一起的

1. **一个扁平数组，按来源顺序拼接**：规则提升 → 决定 → 审批 → 归属（`FocusPage.tsx:847-886`）。
2. **排序不是优先级**：数组第一段是 4 条没有动作的验证卡片，所以一进页面先遇到死路。
3. **标题只报总数**：`需要你处理` + `workItems.length`（`FocusPage.tsx:921-926`）；没有“可操作 / 仅提示”的分列。
4. **全部同等强调**：同一张卡片样式、同一个类型徽标；类型只表达“这件事关于什么”，不表达“你能不能做”（`OwnerWorkbench.tsx:9`）。
5. **不可折叠、不可筛选**：100 条平铺，右侧单条详情；没有分组、优先级、可操作筛选。
6. **重复呈现**：64 条归属同时出现在折叠的“运行记录”完整面板（`FocusPage.tsx:1050`）。
7. **计数口径五套**：100 / 21 / 12 / 8 / 39；页头 39 只对应一行聚合文字（`FocusPage.tsx:997-1027`）。
8. **点“开始”先撞死路**：前 4 条验证卡片全部没有可执行动作。

---

## 5. 根因判断

根因**不是**“历史上把所有事件都塞进 approval 队列”。`approvals` 表本身只有 32 条 pending，都是真审批行。真正的问题是：

### 5.1 决定面膨胀 + 缺少“可执行性”契约

`OwnerWorkItem` 只有 `kind` 和 `allowedActions`，没有 `actionability` 与 `precondition`。渲染层无法区分“决策 / 提示 / 已过期”。

### 5.2 模型违反自己的契约

`OwnerDecisionConsoleModel` 顶部明确写 “INV-01: 只有 `allowedActions` 非空的条目才进入列表”（`OwnerDecisionConsoleModel.ts:7`），但 173 / 193 行却用 `allowedActions: []` 把不可执行条目放进列表。假审批从这里进入首页。

### 5.3 审批没有生命周期收尾

artifact 换版、原则变 blocked 后，旧 pending approval 不会被 supersede / cancel；`approvals.status` 也没有 `superseded`。实测 13 条“原则已 blocked、无当前决定入口”的残留永久灰着。

### 5.4 归属与审批的前置依赖没有建模

scribe artifact 没有 `sourcePrincipleId`，解析器退化为 `unlinked:<artifactId>`（`principle-id-resolution.ts:18-31`，已知 F3/F4）。15 条审批因此不可能批，必须“先归属”；但首页把两者当成并列待办，不表达依赖。

### 5.5 自动归属没有产出

64/64 unlinked、0 bound，等于把整个归属工作原样推给 Owner。

### 5.6 多套投影各自算账

experience readiness 甚至给出 `no_pending_decision`，而审批面有 32 条 pending；同一事实在不同投影里得到不同结论。

---

## 6. 改造方案（按优先级）

### P0 — 先止血

#### A. 给工作台加“可执行性”分区与真实计数

- 每项派生 `actionability: actionable | blocked | informational`：审批看 `approveReady`，归属看 binding 状态，验证看 `allowedActions`，恢复/阻塞/历史一律 informational。
- 页头从“需要你处理 100 项”改为“待你决策 4 项 · 待归属 64 项 · 其余仅提示”。
- 把 4 条验证 + 8 条恢复 + 39 阻塞 + 39 历史全部移到默认折叠的“状态与数据质量”区。
- 改动点：`FocusPage.tsx:847-886/926`、`OwnerWorkbench.tsx:74`、i18n。
- 影响面：首页首屏；风险：低；工作量：**小**。
- 验收：同一份 live 数据，首屏只出现 4 条可批准 + 64 条归属（可折叠），不再出现 4 条死卡在最前。

#### B. 灰按钮必须给原因和下一步

- 28 条 not-ready：
  - 15 条显示“候选尚未归属，先归属才能批准”，并给直接归属入口；
  - 13 条显示“该批准来自已阻塞/旧版本，系统将视为过期，可批量关闭”。
- 改动点：`ApprovalSubjectReading.tsx:53-63/159` 增加 `blockedReason` 与渲染。
- 风险：低；工作量：**小–中**。
- 这是“假审批”观感最直接的修复。

### P1 — 降噪与正确性

#### C. 自动收尾过期审批（数据生命周期）

- 对“原则 blocked / 当前版本没有 subject / 超过宽限期”的 pending approvals 标记 `superseded` 或 `cancelled`，写审计理由，可回滚。
- 影响：一次清掉 28 条灰按钮中的大部分；需在 core 的 approval 生命周期实现。
- 风险：治理数据必须可逆、留痕、有明确宽限期；工作量：**中**。

#### D. 64 条归属收成 1 条入口

- 首页只保留一张“64 个候选待归属（61 个痛点簇）”卡片，点进去是独立归属工作台；
- 目标列表按相似度预排序，默认给 Top 3，而不是 51 选 1。
- 影响：首页直接减少 63 条；风险：中（新增分组视图，不新增数据源）；工作量：**中**。

#### E. 让 17 条隐形人工评审可见

- 在“系统侧处理中”区显示队列真实数量与原因，不伪装成 Owner 决策，也不静默丢弃。
- 影响：修复 21 vs 4 的信任缺口；工作量：**中**。

#### F. 统一计数口径

- 明确四个名称：待决策、待归属、系统恢复中、历史数据；每个数字只出现一次。
- 影响：消除 100 / 21 / 12 / 8 / 39 的混乱；风险：低；工作量：**小**。

### P2 — 一致性收尾

#### G. 权限锁定一致化

- 当前 `lockedReason` 只传给决定卡和审批卡，不传给归属面板；未认证时归属按钮看似可用、实际 403。要么都锁并说明，要么统一放行。
- 工作量：**小**。

#### H. 规则提升卡去掉“假动作”观感

- 卡片内嵌 promote/reject，或明确标注“去激活页处理”，并从“待你决策”计数中单列。
- 工作量：**小**。

#### I. 删除重复的归属面板

- 折叠运行记录里的完整 `RuleCandidateBindingPanel` 与工作台重复，收敛为一个入口。
- 工作量：**小**。

---

## 7. 方案分类速查

| 分类 | 条目 | 处置 |
|---|---|---|
| 保留为需决策 | 4 条可批准审批 | 内嵌批准/拒绝，优先展示 |
| 保留为需决策但聚合 | 64 条候选归属 | 收成 1 个入口 + 预排序 |
| 保留为需授权（跳转） | rulecode 提升（当前 0 条） | 内嵌动作或明确跳转 |
| 改为通知/建议 | 4 条验证、8 条恢复、39 阻塞、39 历史 | 折叠为“状态与数据质量” |
| 可直接自动关闭 | 13 条旧版本/原则 blocked 的 pending 审批 | supersede/cancel + 审计 |
| 必须先补前置动作 | 15 条 unlinked 审批 | 先归属，再批准；首页表达依赖 |

---

## 8. 风险与未做的事

- 本次未做任何代码、数据、部署改动。
- 方案 C（自动收尾审批）涉及治理数据，必须单独设计审计与回滚，不应和 UI 改造同一个 PR。
- 方案 D 只改变展示聚合方式，不改变归属接口契约；后端仍按单候选处理。
- 4 条“可批准”审批在批准时仍可能因提示词容量被拒（容量状态 unconfirmed），修复 B 之后应继续观察 422 比例。

---

## 附录：关键代码位置

| 主题 | 位置 |
|---|---|
| 工作台条目拼接 | `packages/pd-console/src/ui/pages/focus/FocusPage.tsx:847-886` |
| 工作台总数 | `.../FocusPage.tsx:921-926` |
| 阻塞/恢复计数 | `.../FocusPage.tsx:997-1027` |
| 归属面板重复 | `.../FocusPage.tsx:1050` |
| 列表平铺、类型非优先级 | `.../OwnerWorkbench.tsx:9,74-76` |
| 决定条目契约 INV-01 | `packages/pd-console/src/server/models/OwnerDecisionConsoleModel.ts:7` |
| 不可执行条目入列 | `.../OwnerDecisionConsoleModel.ts:156-193` |
| 审批批准门槛 | `.../focus/ApprovalSubjectReading.tsx:53-63,159` |
| 验证卡“去恢复” | `.../focus/OwnerDecisionCard.tsx:239-250` |
| 审批分组与 unlinked 退化 | `.../server/models/ApprovalsGroupedConsoleModel.ts:371` |
| 归属绑定接口 | `.../focus/RuleCandidateBindingPanel.tsx:203-212` |
| unlinked 解析背景（F3/F4） | `.../server/models/principle-id-resolution.ts:18-31` |
