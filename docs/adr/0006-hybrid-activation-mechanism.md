# ADR-0006: 5 通道混合激活机制

> **状态**: Proposed
> **日期**: 2026-05-15
> **关联 ADR**: ADR-0003（Peer Agent 状态机）, ADR-0004（L2 自动校正与回放）
> **关联文档**: `ACTIVATION_CHANNELS.md`（详细通道设计）

## 1. 背景

PD 的 Internalization Pipeline（ADR-0003）以 7 个 Peer Runner 串联完成"原则候选 → 实现工件"的转换，最终输出 `PIArtifact(validationStatus=validated)`。

但 ADR-0003 **没有规定** validated 的 PIArtifact 如何**实际改变代理行为**。这是 PD 系统的"最后一公里"问题。

### 1.1 问题表现

代码现状显示：

- `prompt` 通道：靠 `LedgerPrincipleEntry.status=active` 在 `before_prompt_build` hook 中被读取注入。这是**自然耦合**，没有显式调度
- `code_tool_hook` 通道：靠 `Implementation.lifecycleState=active` 在 `RuleHost.evaluate()` 中被加载。也是自然耦合
- `skill` 通道：**完全未实现**
- `model_training` 通道：Trainer 输出 PIArtifact，但下游消费方未连接
- `defer_archive` 通道：**完全未实现**

也就是说：**目前 5 个通道中，只有 2 个通道靠"工件状态变更"间接生效，剩下 3 个通道的激活路径根本不存在**。

### 1.2 设计意图变更

原设计意图：**全自动化激活**（一旦 RolloutReviewer 通过即激活）。

实践发现：**全自动激活在高风险通道上不可接受**，原因：

1. **L2 通道**（code_tool_hook）：错误的 hook 代码会立即影响所有代理的工具调用，可能造成大规模误杀
2. **L3 通道**（model_training）：训练数据低质量会污染模型权重，难以回滚
3. **可观测性不足**：自动激活后人无法及时发现问题

故设计意图调整为：**混合激活**——低风险全自动，高风险必须人工审批。

---

## 2. 决策

引入显式的 **`ActivationDispatcher`** 组件，按通道路由 PIArtifact 到对应的激活策略。每个通道有明确的"风险等级"和"默认激活策略"。

### 2.1 5 通道激活矩阵（强制规范）

| 通道 ID | 中文 | 内化等级 | 风险 | 默认激活策略 | 可配置覆盖 |
|--------|------|---------|------|-------------|-----------|
| `prompt` | 提示词通道 | L1 | 低 | **全自动** | 否 |
| `defer_archive` | 延迟归档通道 | N/A | 低 | **全自动** | 否 |
| `skill` | 技能通道 | L1.5 | 中 | **全自动** | 是（可改为 require_approval） |
| `code_tool_hook` | 代码钩子通道 | L2 | 高 | **必须人工审批** | 否 |
| `model_training` | 模型训练通道 | L3 | 极高 | **必须人工审批 + 二次确认** | 否 |

### 2.2 激活流程

```
[PIArtifact: validationStatus=validated, channel=X]
         │
         ▼
┌────────────────────────┐
│  ActivationDispatcher  │
└──────────┬─────────────┘
           │ 按 channel 路由
           ├─────────┬─────────┬──────────┬─────────────┐
           │         │         │          │             │
           ▼         ▼         ▼          ▼             ▼
      [prompt]  [archive]  [skill]   [code_hook]   [training]
       自动      自动      默认自动   人工审批      人工审批+二次
        │         │         │          │             │
        │         │         │          ▼             ▼
        │         │         │     ApprovalQueue  ApprovalQueue
        │         │         │     (high risk)    (critical)
        │         │         │          │             │
        │         │         │          ▼             ▼
        │         │         │     [pd-console]   [pd-console]
        │         │         │      人工 review   review + 二次
        │         │         │          │             │
        │         │         │     ┌────┴────┐   ┌───┴────┐
        │         │         │     ▼         ▼   ▼        ▼
        │         │         │  approve  reject approve reject
        │         │         │     │       │      │       │
        ▼         ▼         ▼     ▼       │      ▼       │
   ┌─────────────────────────────────┐    │  ┌──────────┐│
   │  ChannelWriter（按 channel 实现）│    │  │ Trainer  ││
   └─────────────────────────────────┘    │  │ Pipeline ││
           │                                │  └──────────┘│
           ▼                                │              │
   [活动状态生效]                            ▼              ▼
                                      RejectionFeedback   RejectionFeedback
                                            │              │
                                            ▼              ▼
                                  [回到 Internalization Pipeline 优化]
```

### 2.3 ActivationDispatcher 组件契约

位置：`@principles/core/runtime-v2/activation/`（新建）

```typescript
interface ActivationDispatcher {
  /**
   * 处理一个已验证的 PIArtifact，按 channel 路由到对应激活流程。
   *
   * @returns 激活结果或审批等待状态
   */
  dispatch(input: DispatchInput): Promise<DispatchResult>;
}

interface DispatchInput {
  artifactId: string;
  channel: InternalizationChannel;
  /** 来自 RolloutReviewer 的发布建议 */
  rolloutDecision: 'auto_activate' | 'require_approval' | 'reject';
  /** 触发方（system / agent / human） */
  actor: ActivationActor;
  idempotencyKey?: string;
}

type DispatchResult =
  | { decision: 'activated'; activatedAt: string; channelTarget: string }
  | { decision: 'queued_for_approval'; approvalId: string; queuedAt: string }
  | { decision: 'rejected'; reason: string; rejectionFeedbackId: string }
  | { decision: 'skipped'; reason: 'already_active' | 'channel_disabled' };
```

### 2.4 ChannelWriter 接口（每通道一个实现）

```typescript
interface ChannelWriter {
  channel: InternalizationChannel;

  /** 检查此 artifact 是否可以激活到此通道 */
  canActivate(artifact: PIArtifact): Promise<CanActivateResult>;

  /** 实际写入激活状态（已通过审批或自动激活） */
  activate(artifact: PIArtifact, context: ActivationContext): Promise<ActivationOutcome>;

  /** 撤销激活（rollback） */
  deactivate(activationId: string): Promise<void>;
}

interface ActivationContext {
  approvedBy?: string;          // 人工审批时的批准人
  approvedAt?: string;
  approvalNote?: string;
  idempotencyKey: string;
}
```

每通道的具体实现：

| 通道 | ChannelWriter 实现 | 写入位置 |
|------|------------------|---------|
| `prompt` | `LedgerPromptWriter` | `Ledger.principles[id].status = 'active'` |
| `defer_archive` | `LedgerArchiveWriter` | `Ledger.principles[id].status = 'archived'` |
| `skill` | `SkillFileWriter` | `{workspace}/.principles/skills/{skillId}/SKILL.md` |
| `code_tool_hook` | `RuleHostWriter` | `Ledger.implementations[id].lifecycleState = 'active'` + 写入 `.principles/implementations/code/{implId}/` |
| `model_training` | `TrainingExporter` | `{workspace}/.pd/training-exports/{batchId}/` |

### 2.5 ApprovalQueue 组件

位置：`@principles/core/runtime-v2/activation/approval-queue.ts`（新建）

```typescript
interface ApprovalQueue {
  /** 把待审批工件入队 */
  enqueue(input: ApprovalEnqueueInput): Promise<ApprovalRecord>;

  /** 列出待审批项（pd-console 调用） */
  listPending(filter?: ApprovalFilter): Promise<ApprovalRecord[]>;

  /** 通过审批，触发后续激活 */
  approve(approvalId: string, approver: string, note?: string): Promise<ApprovalDecisionResult>;

  /** 拒绝审批，触发反馈循环 */
  reject(approvalId: string, approver: string, reason: string): Promise<ApprovalDecisionResult>;

  /** 批量操作（仅低风险通道允许） */
  batchApprove(filter: ApprovalFilter, approver: string): Promise<BatchResult>;
}

interface ApprovalEnqueueInput {
  artifactId: string;
  channel: InternalizationChannel;
  riskLevel: 'medium' | 'high' | 'critical';
  /** critical 风险必须二次确认 */
  requiresSecondConfirmation: boolean;
  metadata: Record<string, unknown>;
}

interface ApprovalRecord {
  approvalId: string;
  artifactId: string;
  channel: InternalizationChannel;
  riskLevel: 'medium' | 'high' | 'critical';
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
  /** 仅 critical 风险有此字段 */
  secondConfirmationRequired?: boolean;
  secondConfirmedAt?: string;
  secondConfirmedBy?: string;
}
```

存储：`{workspace}/.pd/state.db` 的 `approvals` 表（新建 schema）。

### 2.6 RejectionFeedback 反馈环

人工拒绝必须产生结构化反馈，而非静默丢弃。

```typescript
interface RejectionFeedback {
  feedbackId: string;
  approvalId: string;
  artifactId: string;
  channel: InternalizationChannel;
  rejectionReason: string;
  rejectedBy: string;
  rejectedAt: string;
  /** 反馈用途：是否触发下游优化 */
  feedbackAction: 'retry_with_correction' | 'discard' | 'escalate';
  /** 给 Internalization Pipeline 的纠正提示 */
  correctionHints?: string[];
}
```

当 `feedbackAction = retry_with_correction` 时：
- 在 TaskStore 创建一个新的 Dreamer 任务
- 将 `correctionHints` 注入到 prompt context
- 形成 "失败 → 优化" 的闭环

---

## 3. 各通道详细策略

### 3.1 prompt 通道（自动）

**触发**：RolloutReviewer 决定 `auto_activate` → ActivationDispatcher 直接调用 `LedgerPromptWriter`。

**操作**：
- 设置 `Ledger.principles[id].status = 'active'`
- 设置 `Ledger.principles[id].activatedAt = now`

**生效**：下次 `before_prompt_build` hook 调用时，`PromptBuilder` 自动读取 active principles 注入。

**回滚**：`pd-cli pd-rollback principle <id>` 可立即回退状态。

### 3.2 defer_archive 通道（自动）

**触发**：RoutingPolicy 决定该原则应被归档（如已被 L2 实现替代）。

**操作**：
- 设置 `Ledger.principles[id].status = 'archived'`
- 添加归档原因到 `archivedReason` 字段

**生效**：`PromptBuilder` 不再注入此原则。

### 3.3 skill 通道（默认自动，可配置）

**触发**：RolloutReviewer 决定 `auto_activate` 且 `config.skill_channel.auto_activate = true`（默认值）。

**操作**：
- 写入 `{workspace}/.principles/skills/{skillId}/SKILL.md`
- 写入 `{workspace}/.principles/skills/{skillId}/manifest.json`
- 注册到 Skill 索引

**生效**：OpenClaw 的 skill 系统读取 `.principles/skills/`。

**配置覆盖**：`config.skill_channel.auto_activate = false` 时，进入审批队列。

**风险考量**：Skill 是文档型内化，风险中等。默认自动是因为：
- 不直接拦截工具调用
- 可被代理选择性使用（不强制）
- 易于回滚（删除文件即可）

### 3.4 code_tool_hook 通道（必须人工审批）

**触发**：RolloutReviewer 决定 `require_approval` 或 `auto_activate`（无论哪种，本通道**强制**走审批流程）。

**审批前**：
- 必须通过 GoldenTrace replay 测试（详见 ADR-0004）
- 必须通过 forbidden pattern 检查
- 必须有 source artifact lineage 完整可查

**入队**：
```typescript
approvalQueue.enqueue({
  artifactId,
  channel: 'code_tool_hook',
  riskLevel: 'high',
  requiresSecondConfirmation: false,
  metadata: {
    proposedRuleId,
    goldenTraceReport,
    forbiddenPatternCheckResult,
  },
});
```

**审批方式**：
- `pd-console` 提供 UI：展示代码 diff、replay 报告、调用样本
- 审批人需明确填写"我已审查代码并理解风险"
- 审批操作记录在审计日志

**通过后**：
- `RuleHostWriter.activate()` 写入实现文件
- 设置 `Ledger.implementations[id].lifecycleState = 'active'`
- `RuleHost` 在下一次 `before_tool_call` 加载新实现

**初始模式**：默认以 `shadow mode` 激活 30 个调用周期（详见 ADR-0004）。

### 3.5 model_training 通道（必须人工审批 + 二次确认）

**触发**：Trainer Runner 输出 `validationStatus=validated` 的训练数据。

**审批前**：
- 训练数据必须通过 quality gate（最少样本数、领域覆盖等）
- 必须有明确的训练目标和评估指标

**入队**：
```typescript
approvalQueue.enqueue({
  artifactId,
  channel: 'model_training',
  riskLevel: 'critical',
  requiresSecondConfirmation: true,  // ★ 必须二次确认
  metadata: {
    datasetSize,
    qualityMetrics,
    estimatedTrainingCost,
    targetCheckpoint,
  },
});
```

**审批方式**：
- pd-console 展示训练数据样本、统计指标、成本估算
- 第一步：审批人 approve
- 第二步：**等待 24 小时冷却期** + **第二个审批人确认**（防止单点失误）
- 详见 `SECURITY_ARCHITECTURE.md` 中的 dual-approval 机制

**通过后**：
- `TrainingExporter.activate()` 导出到 `{workspace}/.pd/training-exports/{batchId}/`
- 通知外部训练系统（pd 不直接训练）
- 训练完成后由 `model_deployment_registry` 单独管理 checkpoint 部署

---

## 4. 配置规范

### 4.1 channel 激活配置

位置：`{workspace}/.pd/config/activation.yaml`（新建）

```yaml
activation:
  channels:
    prompt:
      mode: auto                    # 不可改
    defer_archive:
      mode: auto                    # 不可改
    skill:
      mode: auto                    # 可改为 require_approval
      auto_activate: true
    code_tool_hook:
      mode: require_approval        # 不可改
      shadow_mode_cycles: 30        # 激活后先以 shadow 模式运行 N 个调用周期
    model_training:
      mode: require_approval        # 不可改
      requires_second_confirmation: true  # 不可改
      cooldown_hours: 24            # 二次确认冷却期
      second_approver_must_differ: true   # 二次审批人必须不同于第一次
```

### 4.2 默认安全策略

如果 `activation.yaml` 不存在或解析失败，使用安全默认值：

- 所有通道：`require_approval`
- 所有 channel writer：`activated_count = 0`
- 启动时记录警告："activation config missing, defaulting to require_approval for all channels"

---

## 5. 与现有代码的关系

### 5.1 不变项

- `RolloutReviewer` 继续输出 `decision` 字段（auto_activate / require_approval / reject）
- 现有的 `Ledger.principles[id].status` / `Ledger.implementations[id].lifecycleState` 字段语义不变
- `RuleHost` 加载 active implementations 的逻辑不变

### 5.2 新增项

| 新组件 | 包 | 作用 |
|--------|----|----|
| `ActivationDispatcher` | core | 通道路由 |
| `ApprovalQueue` | core | 审批队列管理 |
| `RejectionFeedback` | core | 拒绝反馈 |
| `ChannelWriter` 接口 | core | 通道写入抽象 |
| `LedgerPromptWriter` | core | prompt 通道实现 |
| `LedgerArchiveWriter` | core | defer_archive 通道实现 |
| `SkillFileWriter` | core | skill 通道实现 |
| `RuleHostWriter` | core | code_tool_hook 通道实现 |
| `TrainingExporter` | core | model_training 通道实现 |
| pd-console 审批 UI | console | 人工审批界面 |
| `approvals` SQLite 表 | core | 审批记录 |

### 5.3 变更项

| 现有组件 | 变更 |
|---------|------|
| `RolloutReviewerRunner` | 在 succeed 路径上调用 `ActivationDispatcher.dispatch()` |
| `pd-cli` | 新增 `pd activation list` / `pd activation status` 命令（**只读**） |
| `pd-console` | 新增 `/approvals` 路由 |
| `Ledger` schema | 增加 `activatedAt` / `archivedReason` / `activatedBy` 字段 |

---

## 6. 不变量与约束

### 6.1 强约束

1. **不允许绕过审批**：高风险通道的写入必须通过 `ActivationDispatcher`，不得直接调用 `ChannelWriter.activate()`
2. **审批操作不可逆地记录**：通过/拒绝必须写入 `approvals` 表，不得静默
3. **审批人不能审批自己提交的工件**：第一审批人 != artifact 的最初触发方（如果触发方是人）
4. **二次确认必须是不同审批人**：`model_training` 通道的两次确认人必须不同
5. **拒绝必须产生反馈**：每个 reject 操作必须写入 `RejectionFeedback`，不得无理由拒绝

### 6.2 安全约束

1. **配置文件防篡改**：`activation.yaml` 修改时必须通过 `pd-cli pd activation config set` 命令，触发审计日志
2. **冷却期不可绕过**：`model_training` 的 24 小时冷却由代码强制，不允许 config 覆盖
3. **shadow mode 不可跳过**：`code_tool_hook` 通道激活后必须经过 30 个调用周期 shadow mode

### 6.3 幂等性约束

- 同一个 artifactId 重复 dispatch 是幂等的（返回上次结果）
- 同一个 approvalId 重复 approve/reject 返回 `ALREADY_DECIDED` 错误
- ChannelWriter.activate() 必须幂等（基于 idempotencyKey）

### 6.4 可观测性约束

每个 ActivationDispatcher 调用必须发出 telemetry：

```typescript
{
  eventType: 'activation_dispatched' | 'activation_completed'
            | 'approval_queued' | 'approval_decided',
  artifactId: string,
  channel: InternalizationChannel,
  decision: string,
  latencyMs: number,
  actor: ActivationActor,
}
```

---

## 7. 测试要求

### 7.1 单元测试

- 每个 ChannelWriter 的 canActivate / activate / deactivate
- ApprovalQueue 的 enqueue / approve / reject / batch
- ActivationDispatcher 的路由逻辑

### 7.2 集成测试

- 完整链路：PIArtifact validated → Dispatch → Approval → Activate
- 拒绝流：Reject → RejectionFeedback → 新 Dreamer 任务
- 配置覆盖：skill 通道改为 require_approval 后行为正确

### 7.3 安全测试

- 不能绕过审批：直接调用 ChannelWriter 必须失败
- 审批人不能审批自己的工件
- 二次确认必须是不同审批人
- 配置篡改有审计

### 7.4 架构守护测试

- `pd-cli` 不能直接调用 `approve()` / `reject()`（这些只允许从 pd-console 入口）
- 任何 ChannelWriter 的写入必须经过 ActivationDispatcher

---

## 8. 实施计划

### 阶段 1：契约与读侧（约 1 个 Sprint）
- [ ] 定义 `ActivationDispatcher` / `ChannelWriter` / `ApprovalQueue` 接口
- [ ] 创建 `approvals` SQLite schema
- [ ] 实现 `LedgerPromptWriter` 和 `LedgerArchiveWriter`（最简单的两个）
- [ ] pd-cli 增加只读命令 `pd activation list`

### 阶段 2：自动通道与审批队列（约 2 个 Sprint）
- [ ] 实现 `SkillFileWriter`
- [ ] 实现 `ApprovalQueue` 全部 API
- [ ] 实现 `RejectionFeedback` 写入
- [ ] RolloutReviewer 集成 ActivationDispatcher

### 阶段 3：高风险通道（约 2 个 Sprint）
- [ ] 实现 `RuleHostWriter`（含 shadow mode）
- [ ] 实现 `TrainingExporter`
- [ ] 实现二次确认机制

### 阶段 4：审批 UI（约 2 个 Sprint）
- [ ] pd-console 增加 `/approvals` 路由
- [ ] UI 设计：列表、详情、审批操作
- [ ] 审计日志展示

### 阶段 5：守护与文档（约 1 个 Sprint）
- [ ] 架构守护测试
- [ ] 完整集成测试
- [ ] `ACTIVATION_CHANNELS.md` 详细文档

---

## 9. 替代方案（已拒绝）

### 替代方案 A：完全自动化
**拒绝理由**：用户已确认在 L2/L3 通道不可接受。

### 替代方案 B：完全人工审批
**拒绝理由**：违背 PD"代理优先"的设计哲学，操作员瓶颈会拖垮整个系统。低风险通道完全可以自动化。

### 替代方案 C：通道激活逻辑分散在 RolloutReviewer / 各 Writer 内
**拒绝理由**：失去单点路由，难以统一加审批层和审计层。ActivationDispatcher 是必要的中枢。

### 替代方案 D：使用现有 Ledger.status 字段，不引入审批表
**拒绝理由**：Ledger 不应承载审批历史（违反单一职责）；审批是过程，Ledger 是结果。

---

## 10. 后续展望

未来可扩展（不在本 ADR 范围）：

- **风险评分自适应**：基于历史拒绝率动态调整通道默认策略
- **批量审批**：低风险变更聚合后一次审批
- **审批委托**：临时把审批权限委托给信任的代理
- **AI 辅助审批**：让 PD 自身基于 PIArtifact 给出风险评估和建议（人最终决定）
- **审批 SLA**：定义审批响应时间，超时自动拒绝或升级
- **多通道一致性激活**：同一原则在多个通道同时激活时的事务保证
