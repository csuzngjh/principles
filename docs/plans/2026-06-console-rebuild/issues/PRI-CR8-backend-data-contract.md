# PRI-CR8：后端数据契约调整（MVP6 指标暴露 + 激活 join）

**Type**: AFK
**Priority**: P1（被 CR3/CR4/CR6 消费，应早于它们的联调）
**Blocked by**: PRI-CR2
**必读**: `../01-shared-constraints.md`（F 诚实约束、**G.1 数据契约**、H 安全规则）

## 背景

这是本批**唯一允许碰后端的工单**，且只碰**返回结构**，不碰数据访问层、不碰回路。
目标：把已计算但未暴露的 lifecycle 指标（MVP6）暴露给前端，并把激活记录从
`artifactId` join 到 Owner 可读的 `principleId`。两者都是"数据契约微调"，不是新回路。

## What to build

1. **MVP6：暴露 lifecycle 指标。** 新增只读 route
   `GET /api/v1/lifecycle/principles/:principleId`，调用
   `lifecycle-metrics.ts` 的 `computePrincipleAdherence` / `computeRuleMetrics`，
   返回 `LifecycleMetricsResponse`（见 G.1）。
   - **必须**在返回里带 `insufficientData` 标志与一个 `note` 字段，明确"该原则无
     rule 时指标为空 / 不代表行为变化"（诚实约束 F.1）。
   - 不新造指标，不改指标算法。
2. **激活 join：`artifactId → principleId`。** 新增只读 route
   `GET /api/v1/activations`，返回全通道激活记录 `ActivationRecord[]`（见 G.1）。
   在 Model 层用 `SqlitePIArtifactStore` 取 `PIArtifactSnapshot.sourcePrincipleId`，
   把 `activations` 记录 join 成"按原则聚合的激活事实"。
   - **不得**返回触发/命中计数（不存在，属 MVP5）。
3. **审批按原则聚合（为 CR4 服务）：** 新增只读 route
   `GET /api/v1/approvals/grouped`，返回 `ApprovalGroup[]`（见 G.1），把"同一原则
   的多条 channel 审批记录"聚合为"一条原则一个待决条目"（读模型层聚合，不改审批
   写逻辑、不加 modify）。
4. **治理队列聚合（为 CR3 首页服务）：** 新增只读 route
   `GET /api/v1/governance/queue`，返回 `GovernanceQueueResponse`（见 G.1），
   聚合待审查数、行为偏差信号数、停滞信号。

## Acceptance criteria

- [ ] lifecycle-metrics route 返回结构化 JSON，HTTP response body 为单一可解析 JSON
      对象（`LifecycleMetricsResponse`，见 G.1）。
- [ ] 无 rule 的原则返回 `insufficientData: true` + 解释性 `note`，不返回伪造数值。
- [ ] 激活 route 能按 `principleId` 返回激活事实；记录确实来自 `sourcePrincipleId`
      join，不是猜测拼接（避免 ERR-004/008 lineage 不一致）。
- [ ] 激活 route **不含**任何触发/命中计数字段。
- [ ] 审批聚合返回"一条原则一个条目"，内部保留其 channel 审批记录引用。
- [ ] 所有新 route 对未知/缺失数据**失败响亮或诚实降级带原因**（ERR-002/009）。
- [ ] 解析 DB/artifact 数据遵循 H 节（`unknown` + 校验，不用 `as`）。
- [ ] 不修改数据访问层、不修改回路、不新增 MVP2–MVP5 行为。
- [ ] `cd packages/principles-core && npm run build && npm run test` 通过；
      `cd packages/pd-console && npm run build && npm run test` 通过；`npm run lint` 通过。

## 实施提示（防范围蔓延）

- 这条工单的红线是**只读、只调形状**。如果你发现"要让指标有意义就得改诊断器/加
  rule/加触发计数"——**停止**，那是 MVP2/MVP5，不属于本批。
- `sourcePrincipleId` 可能为空（prompt 原则的 artifact 不一定挂 principleId）：
  此时如实返回"未关联原则"，不要编造。
- 参考 `ApprovalsConsoleModel.dispatchActivationAfterApproval` 里已有的
  `SqlitePIArtifactStore` 用法，复用同样的读取方式。

## MVP 三问

- **不做会怎样**：MVP6 指标永远埋没（你六条里唯一纯 console 的缺陷），生效情况页
  拿不到按原则聚合的激活事实。
- **怎么观察**：新 route 的 JSON 输出 + 针对性测试。
- **怎么关闭**：纯新增只读 route，删除即回退，不影响既有写路径。

## DoD

见 `../01-shared-constraints.md` I 节。
