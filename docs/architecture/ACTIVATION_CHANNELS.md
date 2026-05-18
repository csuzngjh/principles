# Activation Channels 设计（5 通道激活规范）

> **状态**: Active
> **最后更新**: 2026-05-15
> **关联 ADR**: ADR-0006（混合激活机制）, ADR-0004（L2 自动校正）, ADR-0005（Nocturnal 合并）
> **关联文档**: `PD_ARCHITECTURE_OVERVIEW.md`, `INTERNALIZATION_PIPELINE.md`

本文档是 ADR-0006 的工程化展开，详细定义 PD 系统的 5 个内化通道如何**实际作用于代理行为**。

---

## 1. 通道总览

PD 的内化通过 5 个通道生效：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  PIArtifact (validationStatus=validated)                                │
│         │                                                                │
│         ▼                                                                │
│  ┌──────────────────────┐                                               │
│  │ ActivationDispatcher │ ← 唯一入口                                    │
│  └──────────┬───────────┘                                               │
│             │                                                            │
│             │ 按 channel 路由                                            │
│             │                                                            │
│  ┌──────────┼─────────────┬─────────────┬──────────────┬──────────────┐│
│  │          │             │             │              │              ││
│  ▼          ▼             ▼             ▼              ▼              ││
│ prompt  defer_archive   skill      code_tool_hook  model_training     ││
│  L1     N/A             L1.5       L2              L3                  ││
│ 自动    自动            自动*       人审            人审+二次          ││
│  │          │             │             │              │              ││
│  ▼          ▼             ▼             ▼              ▼              ││
│ Ledger    Ledger       Skill File   Implementation  Training Export   ││
│ active    archive      .principles/ Code File       .pd/training/     ││
│                        skills/      .principles/                       ││
│                                     implementations/                    ││
└─────────────────────────────────────────────────────────────────────────┘

*skill 默认自动，可配置为审批
```

---

## 2. 核心组件

### 2.1 ActivationDispatcher

位置：`packages/principles-core/src/runtime-v2/activation/activation-dispatcher.ts`（已落地基础版）

**唯一职责**：接收 validated PIArtifact，根据 channel 路由到对应的激活路径（自动激活 / 入队审批 / 拒绝）。

```typescript
interface ActivationDispatcher {
  dispatch(input: DispatchInput): Promise<DispatchResult>;
}

interface DispatchInput {
  artifactId: string;
  channel: InternalizationChannel;
  /** 来自 RolloutReviewer 的发布建议 */
  rolloutDecision: 'auto_activate' | 'require_approval' | 'reject';
  /** 触发方信息 */
  actor: ActivationActor;
  /** 幂等键（默认由 artifactId + channel 组合） */
  idempotencyKey?: string;
}

type ActivationActor =
  | { kind: 'system'; source: 'rollout_reviewer' | 'recovery_sweep' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'human'; userId: string };

type DispatchResult =
  | {
      decision: 'activated';
      activatedAt: string;
      channelTarget: string;  // 例：'ledger://P_001' | 'file:///.principles/skills/abc/SKILL.md'
      activationId: string;
    }
  | {
      decision: 'queued_for_approval';
      approvalId: string;
      queuedAt: string;
      requiresSecondConfirmation: boolean;
    }
  | {
      decision: 'rejected';
      reason: string;
      rejectionFeedbackId: string;
    }
  | {
      decision: 'skipped';
      reason: 'already_active' | 'channel_disabled' | 'already_in_approval_queue';
    };
```

**路由决策表**：

| RolloutDecision | 通道 | Dispatch 决策 |
|----------------|------|---------------|
| `reject` | 任意 | `rejected` + 写 RejectionFeedback |
| `auto_activate` | `prompt` / `defer_archive` | `activated`（直接调用 ChannelWriter）|
| `auto_activate` | `skill` | 取决于 config：默认 `activated`，配置 require_approval 后 `queued_for_approval` |
| `auto_activate` | `code_tool_hook` | **强制** `queued_for_approval`（覆盖 auto_activate）|
| `auto_activate` | `model_training` | **强制** `queued_for_approval` + `requiresSecondConfirmation=true` |
| `require_approval` | 任意 | `queued_for_approval`（含通道默认风险等级）|

### 2.2 ChannelWriter 接口

每个通道有一个 ChannelWriter 实现，负责"激活"和"撤销激活"。

```typescript
interface ChannelWriter<T = unknown> {
  /** 通道标识 */
  readonly channel: InternalizationChannel;

  /** 检查 artifact 是否可以激活到此通道（前置校验） */
  canActivate(artifact: PIArtifact): Promise<CanActivateResult>;

  /** 实际写入激活状态 */
  activate(artifact: PIArtifact, context: ActivationContext): Promise<ActivationOutcome<T>>;

  /** 撤销激活（rollback） */
  deactivate(activationId: string, context: DeactivationContext): Promise<void>;

  /** 查询激活状态 */
  getActivationStatus(activationId: string): Promise<ActivationStatus | null>;
}

interface CanActivateResult {
  ok: boolean;
  reason?: string;
  /** 风险评估（影响是否需要 shadow mode 等） */
  riskAssessment?: {
    estimatedImpact: 'low' | 'medium' | 'high' | 'critical';
    affectedScope: string[];  // 例：['edit_tool', 'read_tool']
  };
}

interface ActivationContext {
  approvalId?: string;          // 经审批激活时的审批 ID
  approvedBy?: string;
  approvedAt?: string;
  approvalNote?: string;
  idempotencyKey: string;
  /** 是否启用 shadow mode（仅 code_tool_hook 默认 true） */
  shadowMode?: boolean;
  shadowModeCycles?: number;
}

interface ActivationOutcome<T> {
  activationId: string;
  channelTarget: string;       // URI 形式：ledger://... | file://... | sql://...
  activatedAt: string;
  /** 通道特定的元数据 */
  channelMetadata?: T;
}
```

**实现清单**：

| ChannelWriter | 通道 | 写入位置 |
|--------------|------|---------|
| `PromptWriter`（设计稿称 `LedgerPromptWriter`）| prompt | `Ledger.principles[id].status = 'active'` |
| `DeferArchiveWriter`（设计稿称 `LedgerArchiveWriter`）| defer_archive | `Ledger.principles[id].status = 'archived'` |
| `SkillFileWriter` | skill | `{workspace}/.principles/skills/{skillId}/` |
| `RuleHostWriter` | code_tool_hook | `Ledger.implementations[id].lifecycleState = 'active'` + `.principles/implementations/code/{implId}/` |
| `TrainingExporter` | model_training | `{workspace}/.pd/training-exports/{batchId}/` |

### 2.3 ApprovalQueue

位置：`packages/principles-core/src/runtime-v2/activation/approval-queue.ts`（已落地基础版）

> 当前代码实现的 Approval 状态为 `pending / approved / rejected / cancelled`。本文中提到的
> `expired` 与 `awaiting_second_confirmation` 是 ADR-0006 的 future extension，不能按当前生产能力使用。当前代码 `ApprovalStatus` 仅包含 4 种状态：`pending | approved | rejected | cancelled`。

下面是 ADR-0006 的目标接口。当前基础实现已覆盖 `enqueue / listPending / approve / reject / get`，
尚未实现 `secondConfirm / cancel / expired` 等扩展能力。

```typescript
interface ApprovalQueue {
  enqueue(input: ApprovalEnqueueInput): Promise<ApprovalRecord>;
  listPending(filter?: ApprovalFilter): Promise<ApprovalRecord[]>;
  approve(approvalId: string, approver: string, note?: string): Promise<ApprovalDecisionResult>;
  reject(approvalId: string, approver: string, reason: string): Promise<ApprovalDecisionResult>;
  /** 二次确认（仅 critical 风险） */
  secondConfirm(approvalId: string, secondApprover: string): Promise<ApprovalDecisionResult>;

  /** 查询单条 */
  get(approvalId: string): Promise<ApprovalRecord | null>;

  /** 取消待审批（仅本人提交可取消） */
  cancel(approvalId: string, requester: string): Promise<void>;
}

interface ApprovalRecord {
  approvalId: string;
  artifactId: string;
  channel: InternalizationChannel;
  riskLevel: 'medium' | 'high' | 'critical';
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'awaiting_second_confirmation';
  requestedAt: string;
  requestedBy: ActivationActor;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
  /** 仅 critical 风险有此字段 */
  requiresSecondConfirmation?: boolean;
  secondConfirmedAt?: string;
  secondConfirmedBy?: string;
  /** 冷却期信息 */
  cooldownExpiresAt?: string;
  metadata: Record<string, unknown>;
}
```

**存储**：`state.db: approvals` 表（新建）

```sql
CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  requested_by_kind TEXT NOT NULL,
  requested_by_id TEXT,
  decided_at TEXT,
  decided_by TEXT,
  reason TEXT,
  requires_second_confirmation INTEGER DEFAULT 0,
  second_confirmed_at TEXT,
  second_confirmed_by TEXT,
  cooldown_expires_at TEXT,
  metadata_json TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES pi_artifacts(artifact_id)
);

CREATE INDEX idx_approvals_status ON approvals(status, channel);
CREATE INDEX idx_approvals_artifact ON approvals(artifact_id);
```

### 2.4 RejectionFeedback

```typescript
interface RejectionFeedback {
  feedbackId: string;
  approvalId: string;
  artifactId: string;
  channel: InternalizationChannel;
  rejectionReason: string;
  rejectedBy: string;
  rejectedAt: string;
  feedbackAction: 'retry_with_correction' | 'discard' | 'escalate';
  correctionHints?: string[];
}
```

**存储**：`state.db: rejection_feedbacks` 表（新建）

```sql
CREATE TABLE rejection_feedbacks (
  feedback_id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  rejection_reason TEXT NOT NULL,
  rejected_by TEXT NOT NULL,
  rejected_at TEXT NOT NULL,
  feedback_action TEXT NOT NULL,
  correction_hints_json TEXT,
  FOREIGN KEY (approval_id) REFERENCES approvals(approval_id)
);
```

---

## 3. 各通道详细规范

### 3.1 prompt 通道（自动）

#### 用途
最低成本的内化路径。让原则文本进入 LLM 的 system prompt。

#### 触发
- RolloutReviewer 输出 `decision=auto_activate`
- ActivationDispatcher 直接调用 `PromptWriter.activate()`（设计稿原名 LedgerPromptWriter）

#### 操作

```typescript
class PromptWriter implements ChannelWriter {
  channel = 'prompt' as const;

  async canActivate(artifact: PIArtifact): Promise<CanActivateResult> {
    // 检查：
    // 1. PIArtifact.kind === 'principle'
    // 2. 关联的 LedgerEntry 存在且不是 active
    // 3. 原则文本长度合理（< 500 字符建议值）
    return { ok: true, riskAssessment: { estimatedImpact: 'low', affectedScope: ['system_prompt'] } };
  }

  async activate(artifact, context): Promise<ActivationOutcome> {
    const ledgerEntryId = extractLedgerEntryId(artifact);
    await mutateLedger(stateDir, (store) => {
      const principle = store.tree.principles[ledgerEntryId];
      principle.status = 'active';
      principle.activatedAt = context.approvedAt ?? new Date().toISOString();
      principle.activatedBy = context.approvedBy ?? 'system';
    });

    return {
      activationId: `act_prompt_${ledgerEntryId}`,
      channelTarget: `ledger://${ledgerEntryId}`,
      activatedAt: new Date().toISOString(),
    };
  }

  async deactivate(activationId): Promise<void> {
    // 回退：principle.status = 'probation'（保留历史）
  }
}
```

#### 生效时机
下次 `before_prompt_build` hook 触发时，PromptBuilder 自动读取 `Ledger.principles[*].status = 'active'` 注入。

#### 回滚
- pd-cli: `pd principle rollback <id>`
- 自动回滚：如果 90 天内 `painPreventedCount === 0`（无效原则）

#### 性能预算
- canActivate: < 10ms
- activate: < 100ms（含 atomic 文件写入）
- 影响：下次 prompt build 时间 + < 5ms（每个 active 原则）

---

### 3.2 defer_archive 通道（自动）

#### 用途
将原则归档，不再出现在活动注入列表。常用于：
- 已被 L2 实现完全替代的 L1 原则
- 已过时或冲突的原则
- RoutingPolicy 推荐 archive 的原则

#### 触发
- RolloutReviewer / RoutingPolicy 推荐 `defer_archive`
- 全自动，无审批

#### 操作

```typescript
class DeferArchiveWriter implements ChannelWriter {
  channel = 'defer_archive' as const;

  async activate(artifact, context): Promise<ActivationOutcome> {
    const ledgerEntryId = extractLedgerEntryId(artifact);
    await mutateLedger(stateDir, (store) => {
      const principle = store.tree.principles[ledgerEntryId];
      principle.status = 'archived';
      principle.archivedReason = artifact.contentJson?.archiveReason
        ?? 'auto_archived_by_routing_policy';
      principle.archivedAt = new Date().toISOString();
    });

    return {
      activationId: `act_archive_${ledgerEntryId}`,
      channelTarget: `ledger://${ledgerEntryId}#archived`,
      activatedAt: new Date().toISOString(),
    };
  }

  async deactivate(activationId): Promise<void> {
    // 回退到 active 或 probation
  }
}
```

#### 回滚
对归档操作的回滚需要人工干预（pd-console 或 pd-cli `pd principle unarchive <id>`）。

---

### 3.3 skill 通道（默认自动，可配置）

#### 用途
将原则转化为 OpenClaw / Claude Code 的 skill 文档。代理可在需要时调用此 skill。

#### 触发
- RolloutReviewer 输出 `auto_activate`
- 检查 config：`skill.auto_activate`，默认为 `true`
- 如果配置为 `false`，则 `queued_for_approval`

#### 操作

```typescript
class SkillFileWriter implements ChannelWriter {
  channel = 'skill' as const;

  async canActivate(artifact: PIArtifact): Promise<CanActivateResult> {
    // 检查：
    // 1. ScribeOutput 已生成 skill 内容
    // 2. 文件路径冲突检查
    // 3. SKILL.md 内容大小 < 10 KB
  }

  async activate(artifact, context): Promise<ActivationOutcome> {
    const skillId = artifact.contentJson.skillId;
    const skillDir = path.join(workspaceDir, '.principles/skills', skillId);

    fs.mkdirSync(skillDir, { recursive: true });
    atomicWriteFileSync(
      path.join(skillDir, 'SKILL.md'),
      artifact.contentJson.skillContent
    );
    atomicWriteFileSync(
      path.join(skillDir, 'manifest.json'),
      JSON.stringify({ skillId, principleId, version: '1.0.0', activatedAt: now }, null, 2)
    );

    return {
      activationId: `act_skill_${skillId}`,
      channelTarget: `file://${skillDir}`,
      activatedAt: new Date().toISOString(),
      channelMetadata: { skillId, skillDir },
    };
  }

  async deactivate(activationId): Promise<void> {
    // 删除 skill 目录
  }
}
```

#### 配置

```yaml
activation:
  channels:
    skill:
      mode: auto             # 'auto' | 'require_approval'
      auto_activate: true
      max_skills_per_workspace: 50
      skill_size_limit_bytes: 10240
```

#### 风险考量
Skill 是文档型内化，风险中等：
- 不直接拦截工具调用
- 代理可选择性使用（不强制）
- 易于回滚（删除文件）

#### 回滚
`pd-cli pd skill disable <skill-id>` 或人工删除 skill 目录。

---

### 3.4 code_tool_hook 通道（必须人工审批）

#### 用途
**最强的内化形式**之一。在 `before_tool_call` 阶段拦截或修正工具调用参数。属于 L2 硬内化。

#### 触发
- 无论 RolloutReviewer 输出什么，**都强制走审批队列**
- ActivationDispatcher 自动设 `riskLevel = 'high'`

#### 前置校验（canActivate）

```typescript
class RuleHostWriter implements ChannelWriter {
  channel = 'code_tool_hook' as const;

  async canActivate(artifact: PIArtifact): Promise<CanActivateResult> {
    const result = { ok: true, riskAssessment: { estimatedImpact: 'high' as const, affectedScope: [] } };

    // 1. GoldenTrace replay 测试（详见 ADR-0004）
    const replayResult = await replayGoldenTrace(artifact);
    if (!replayResult.allPassed) {
      return { ok: false, reason: `GoldenTrace replay failed: ${replayResult.failures}` };
    }

    // 2. Forbidden pattern 检查
    const code = extractImplementationCode(artifact);
    const forbiddenCheck = checkForbiddenPatterns(code);
    if (!forbiddenCheck.passed) {
      return { ok: false, reason: `Forbidden patterns: ${forbiddenCheck.violations}` };
    }

    // 3. Lineage 完整性
    if (!verifyLineageComplete(artifact)) {
      return { ok: false, reason: 'Source lineage incomplete' };
    }

    // 4. 评估影响范围
    result.riskAssessment.affectedScope = extractAffectedTools(code);
    if (result.riskAssessment.affectedScope.includes('edit') ||
        result.riskAssessment.affectedScope.includes('write')) {
      result.riskAssessment.estimatedImpact = 'critical';
    }

    return result;
  }

  // ... activate
}
```

#### 入队审批

```typescript
// ActivationDispatcher.dispatch() 路径
const canActivate = await ruleHostWriter.canActivate(artifact);
if (!canActivate.ok) {
  return { decision: 'rejected', reason: canActivate.reason };
}

const approval = await approvalQueue.enqueue({
  artifactId: artifact.artifactId,
  channel: 'code_tool_hook',
  riskLevel: canActivate.riskAssessment.estimatedImpact === 'critical' ? 'critical' : 'high',
  requiresSecondConfirmation: false,  // code_tool_hook 不要求二次确认（除 critical 外）
  metadata: {
    proposedRuleId: artifact.sourceRuleId,
    goldenTraceReport: replayResult,
    forbiddenPatternCheckResult: forbiddenCheck,
    riskAssessment: canActivate.riskAssessment,
  },
});

return { decision: 'queued_for_approval', approvalId: approval.approvalId, ... };
```

#### 审批通过后激活（Shadow Mode）

```typescript
async activate(artifact, context): Promise<ActivationOutcome> {
  const implId = artifact.sourceRuleId;
  const implDir = path.join(workspaceDir, '.principles/implementations/code', implId);

  // 1. 写入实现代码
  fs.mkdirSync(implDir, { recursive: true });
  atomicWriteFileSync(
    path.join(implDir, 'entry.ts'),
    artifact.contentJson.implementationCode
  );
  atomicWriteFileSync(
    path.join(implDir, 'manifest.json'),
    JSON.stringify({
      implId,
      ruleId: artifact.sourceRuleId,
      principleId: artifact.sourcePrincipleId,
      activatedAt: context.approvedAt,
      activatedBy: context.approvedBy,
      shadowMode: context.shadowMode ?? true,
      shadowModeCycles: context.shadowModeCycles ?? 30,
      shadowModeStartedAt: new Date().toISOString(),
    })
  );

  // 2. 标记 ledger.implementations[implId] 为 active
  await mutateLedger(stateDir, (store) => {
    const impl = store.tree.implementations[implId];
    impl.lifecycleState = 'active';
    impl.shadowMode = true;  // ★ 默认启用 shadow mode
    impl.shadowModeRemaining = 30;
  });

  return {
    activationId: `act_code_${implId}`,
    channelTarget: `ledger://${implId}`,
    activatedAt: new Date().toISOString(),
  };
}
```

#### Shadow Mode 行为

详见 ADR-0004。要点：

1. **Shadow 期间**（默认 30 个调用周期）：
   - RuleHost 加载实现并执行
   - **不**应用 `decision`（不 block / 不 propose_correction）
   - 每次执行写 `CorrectionAuditEvent`，记录"如果应用，会发生什么"

2. **Shadow 期满**：
   - 自动生成 shadow report
   - 写入 ledger：`shadowMode = false`
   - 进入 live 模式

3. **Shadow 期间发现异常**（如误杀率高）：
   - 自动 deactivate
   - 写 RejectionFeedback
   - 触发新的 Dreamer task（修正建议）

#### 配置

```yaml
activation:
  channels:
    code_tool_hook:
      mode: require_approval         # 不可改
      shadow_mode_default: true       # 不可改
      shadow_mode_cycles: 30          # 可调
      shadow_max_false_positive_rate: 0.05  # 超过即自动 deactivate
      max_active_implementations: 100  # 总量限制
```

#### 回滚

```bash
# pd-cli
pd impl rollback <implId> --reason "false positive too high"

# 自动回滚条件：
# - shadow mode 期间误杀率 > 阈值
# - active 期间触发 RuleHost 异常超过 N 次
```

---

### 3.5 model_training 通道（必须人工审批 + 二次确认）

#### 用途
将训练数据导出，供外部模型训练系统使用。属于 L3 内化（最高强度，最低成本，最大风险）。

#### 触发
- 仅 Trainer Runner 输出（`PIArtifact.kind = 'training_data'`）
- 强制 `requiresSecondConfirmation = true`

#### 前置校验

```typescript
class TrainingExporter implements ChannelWriter {
  channel = 'model_training' as const;

  async canActivate(artifact: PIArtifact): Promise<CanActivateResult> {
    // 1. 训练数据质量门禁
    const dataset = parseTrainingDataset(artifact);
    if (dataset.size < 100) {
      return { ok: false, reason: 'Dataset too small (< 100 samples)' };
    }
    if (dataset.domainCoverage < 0.6) {
      return { ok: false, reason: 'Domain coverage insufficient' };
    }
    if (dataset.duplicateRate > 0.1) {
      return { ok: false, reason: 'Duplicate rate too high' };
    }

    // 2. PII 敏感性扫描
    const piiCheck = await scanForPII(dataset);
    if (piiCheck.hasViolations) {
      return { ok: false, reason: `PII detected: ${piiCheck.violations}` };
    }

    return {
      ok: true,
      riskAssessment: {
        estimatedImpact: 'critical',
        affectedScope: ['model_weights', 'agent_baseline'],
      },
    };
  }

  // ... 入队审批 + 二次确认 + activate
}
```

#### 入队审批

```typescript
const approval = await approvalQueue.enqueue({
  artifactId: artifact.artifactId,
  channel: 'model_training',
  riskLevel: 'critical',
  requiresSecondConfirmation: true,
  metadata: {
    datasetSize: dataset.size,
    qualityMetrics: dataset.metrics,
    estimatedTrainingCost: estimateCost(dataset),
    targetCheckpoint: artifact.contentJson.targetCheckpoint,
    piiCheckPassed: true,
  },
});
```

#### 双人审批流程

```
1. 第一审批人 approve
   → status: awaiting_second_confirmation
   → cooldownExpiresAt: now + 24h
   → 通知第二审批人

2. 等待 24 小时冷却（不可绕过）

3. 第二审批人 secondConfirm（必须不同于第一审批人）
   → status: approved
   → 调用 TrainingExporter.activate()

4. 任一时刻可 reject 终止
```

#### 激活操作

```typescript
async activate(artifact, context): Promise<ActivationOutcome> {
  const batchId = `train_${Date.now()}`;
  const exportDir = path.join(workspaceDir, '.pd/training-exports', batchId);

  // 1. 导出训练数据
  fs.mkdirSync(exportDir, { recursive: true });
  atomicWriteFileSync(
    path.join(exportDir, 'dataset.jsonl'),
    artifact.contentJson.trainingData
  );
  atomicWriteFileSync(
    path.join(exportDir, 'metadata.json'),
    JSON.stringify({
      batchId,
      sourceArtifactId: artifact.artifactId,
      approvedBy: context.approvedBy,
      secondConfirmedBy: artifact.metadata.secondConfirmedBy,
      exportedAt: new Date().toISOString(),
      targetCheckpoint: artifact.contentJson.targetCheckpoint,
    })
  );

  // 2. 通知外部训练系统（webhook / file watcher）
  // PD 不直接训练，由外部系统消费 export

  return {
    activationId: `act_training_${batchId}`,
    channelTarget: `file://${exportDir}`,
    activatedAt: new Date().toISOString(),
  };
}
```

#### 配置

```yaml
activation:
  channels:
    model_training:
      mode: require_approval                 # 不可改
      requires_second_confirmation: true     # 不可改
      cooldown_hours: 24                     # 不可改（可通过 ADR 修改）
      second_approver_must_differ: true      # 不可改
      min_dataset_size: 100
      min_domain_coverage: 0.6
      max_duplicate_rate: 0.1
      pii_scan_required: true
```

#### 回滚
- 训练已开始 → 不可回滚（导出已发生）
- 训练未开始 → `pd-cli pd training-export cancel <batchId>`
- 已部署的 checkpoint 回滚 → 由独立的 `model_deployment_registry` 管理（不属于本通道）

---

## 4. 通道间互斥与冲突

### 4.1 同一原则可同时激活的通道组合

| 组合 | 是否允许 | 备注 |
|------|---------|------|
| prompt + skill | ✅ | 互补 |
| prompt + code_tool_hook | ✅ | prompt 提醒 + code 强制（typical 升级路径）|
| prompt + model_training | ✅ | 渐进式内化 |
| skill + code_tool_hook | ⚠️ | 允许但需注意逻辑一致性 |
| code_tool_hook + model_training | ✅ | L2 + L3 协同 |
| 任意 + defer_archive | ❌ | 互斥（archive 后不再激活其他通道）|

### 4.2 通道升级路径（渐进式内化）

PD 鼓励渐进式内化路径：

```
新原则
  │
  ▼
prompt 通道（自动）        ← 起点
  │
  │ 经过 N 个 painPreventedCount 验证
  ▼
skill 通道（自动）         ← 加深一步
  │
  │ 经过更多验证 + 人工评估
  ▼
code_tool_hook（人审）     ← L2 硬内化
  │
  │ 经过大量样本 + 多人评估
  ▼
model_training（双人审）   ← L3 终极内化
  │
  │ 训练完成 + 验证有效
  ▼
原 prompt 原则可 archive   ← Pruning
```

每步升级都要重新经过完整的 Internalization Pipeline（Dreamer → ... → RolloutReviewer）。

---

## 5. pd-console 审批 UI 规范

### 5.1 路由结构

```
/approvals                    审批队列首页
/approvals/pending            待审批列表
/approvals/{id}               审批详情
/approvals/{id}/approve       批准操作
/approvals/{id}/reject        拒绝操作
/approvals/history            历史记录
/approvals/config             配置管理
```

### 5.2 审批列表页内容

每条 Pending 显示：
- ApprovalId / 提交时间 / 等待时间
- ArtifactId + 关联的 Principle / Rule
- 通道类型 + 风险等级（颜色编码：高=红、中=黄、低=绿）
- 触发方（system / agent）
- "查看详情" 按钮

### 5.3 审批详情页（`code_tool_hook` 示例）

必须展示：
1. **原则与规则文本**：来自 sourcePrincipleId 与 sourceRuleId
2. **代码 diff**：被批准后将激活的 implementation 代码
3. **GoldenTrace 报告**：哪些 case 通过 / 失败
4. **Forbidden pattern 检查结果**
5. **影响范围**：affectedScope 列表
6. **历史血缘**：从 PainSignal 到 PIArtifact 的完整链
7. **相关历史决策**：同类 PIArtifact 过去的批准/拒绝率

操作区：
- ✓ 批准：必须勾选"我已审查代码并理解风险"
- ✗ 拒绝：必须填写理由，可选择反馈动作（retry_with_correction / discard / escalate）
- ↩ 取消：仅原提交人可取消

### 5.4 二次确认页（`model_training` 专用）

第一审批通过后进入冷却：
- 倒计时显示剩余冷却时间
- "通知第二审批人"按钮
- 第二审批人登录后看到 `awaiting_second_confirmation` 状态
- 第二审批人不能与第一审批人相同（前后端双重校验）

---

## 6. 不变量与约束总表

| ID | 约束 | 强制方式 |
|----|------|---------|
| AC-1 | 所有激活必须经过 ActivationDispatcher | architecture-regression test：禁止其他模块直接调用 ChannelWriter |
| AC-2 | code_tool_hook 强制 require_approval | 代码硬编码，config 不可覆盖 |
| AC-3 | model_training 强制 second confirmation | 代码硬编码，config 不可覆盖 |
| AC-4 | 二次审批人必须不同于第一审批人 | ApprovalQueue.secondConfirm 校验 |
| AC-5 | 24h 冷却不可绕过 | ApprovalQueue 时间校验 |
| AC-6 | 拒绝必须产生 RejectionFeedback | reject() 内部强制写入 |
| AC-7 | 激活必须幂等 | idempotencyKey 必填 |
| AC-8 | code_tool_hook 默认启用 shadow mode | RuleHostWriter.activate 默认 shadowMode=true |
| AC-9 | 配置篡改有审计 | 修改 activation.yaml 必须通过 pd-cli + 写日志 |
| AC-10 | Activation 操作必须发出 telemetry | ActivationDispatcher 强制 emit |
| AC-11 | 审批人不能审批自己提交的工件（如果 actor=human） | enqueue/approve 校验 |
| AC-12 | 已激活的工件不能重复激活 | canActivate 检查现有状态 |

---

## 7. 配置完整 schema

`{workspace}/.pd/config/activation.yaml`：

```yaml
activation:
  # 全局开关
  enabled: true

  # 调度行为
  dispatcher:
    max_concurrent_dispatches: 5
    dispatch_timeout_ms: 30000

  # 审批队列
  approval_queue:
    pending_ttl_hours: 168     # 7 天未处理过期
    expired_action: 'auto_reject'
    notification:
      pd_console_email: false
      webhook_url: null

  # 各通道配置
  channels:
    prompt:
      mode: auto                 # 不可改
      max_active_per_workspace: 200
      auto_archive_after_days: 90  # 90 天无 painPreventedCount 自动归档

    defer_archive:
      mode: auto                 # 不可改

    skill:
      mode: auto                 # 'auto' | 'require_approval'
      auto_activate: true
      max_skills_per_workspace: 50
      skill_size_limit_bytes: 10240
      validate_skill_format: true

    code_tool_hook:
      mode: require_approval     # 不可改
      shadow_mode_default: true  # 不可改
      shadow_mode_cycles: 30
      shadow_max_false_positive_rate: 0.05
      max_active_implementations: 100
      golden_trace_required: true
      forbidden_pattern_check_required: true

    model_training:
      mode: require_approval               # 不可改
      requires_second_confirmation: true   # 不可改
      cooldown_hours: 24                   # 不可改
      second_approver_must_differ: true    # 不可改
      min_dataset_size: 100
      min_domain_coverage: 0.6
      max_duplicate_rate: 0.1
      pii_scan_required: true              # 不可改
      max_export_size_mb: 100
```

---

## 8. 可观测性

### 8.1 必发的 Telemetry Events

```typescript
// ActivationDispatcher
'activation_dispatched'        // 每次 dispatch 调用
'activation_completed'         // 成功激活
'activation_skipped'           // 已存在或已禁用

// ApprovalQueue
'approval_queued'             // 入队
'approval_decided'            // approve / reject
'approval_expired'            // TTL 过期
'approval_second_confirmed'   // 二次确认通过

// ChannelWriter
'channel_writer_activated'    // 写入成功
'channel_writer_failed'       // 写入失败
'channel_writer_deactivated'  // 撤销
'shadow_mode_completed'       // shadow 期满
'shadow_mode_aborted'         // shadow 期间触发 abort
```

### 8.2 关键指标

| Metric | 类型 | 意义 |
|--------|-----|------|
| `pd.activation.dispatched_total` | counter | 总分发数 |
| `pd.activation.activated_total` | counter | 总激活数 |
| `pd.activation.rejected_total` | counter | 总拒绝数 |
| `pd.activation.queued_total` | counter | 入队数 |
| `pd.approval.pending_count` | gauge | 当前待审批数 |
| `pd.approval.avg_decision_latency_ms` | histogram | 平均决策延迟 |
| `pd.approval.approval_rate` | gauge | 批准率 |
| `pd.shadow_mode.false_positive_rate` | histogram | shadow mode 误杀率 |
| `pd.shadow_mode.aborted_total` | counter | shadow 期间被 abort 的数量 |

### 8.3 审计日志

所有 approval / activation / deactivation 必须写入 `.state/audit-log.jsonl`：

```json
{"timestamp":"2026-05-15T...","event":"approval_decided","approvalId":"...","artifactId":"...","channel":"code_tool_hook","decision":"approved","actor":"user@example.com","reason":"...","metadata":{}}
```

---

## 9. 测试要求

### 9.1 单元测试

每个 ChannelWriter / ActivationDispatcher / ApprovalQueue 必须有：
- happy path 测试
- 幂等性测试
- 错误分支测试
- 配置覆盖测试

### 9.2 集成测试场景

1. **prompt 通道全自动**：RolloutReviewer auto_activate → ActivationDispatcher → Ledger.active
2. **code_tool_hook 完整审批链**：auto_activate → 强制入队 → pd-console 批准 → shadow mode → live
3. **model_training 双人审批**：入队 → 第一审批 → 24h 冷却 → 第二审批 → export
4. **拒绝反馈环**：Reject → RejectionFeedback → 新 Dreamer task 触发
5. **shadow mode abort**：shadow 期间误杀率超阈值 → 自动 deactivate

### 9.3 安全测试

- 不能绕过审批：直接调用 ChannelWriter.activate() 必须失败
- 同一个人不能完成双重审批
- 配置篡改必须有审计
- 24h 冷却不可绕过

---

## 10. 实施进度

详见 ADR-0006 §8 实施计划。本节维护组件级状态：

| 组件 | 状态 |
|------|------|
| ActivationDispatcher | ✅ 基础版已落地 |
| `PromptWriter`（设计稿名 `LedgerPromptWriter`）| ✅ 基础版已落地 |
| `DeferArchiveWriter`（设计稿名 `LedgerArchiveWriter`）| ✅ 基础版已落地 |
| SkillFileWriter | ❌ 待建 |
| RuleHostWriter | ❌ 待建 |
| TrainingExporter | ❌ 待建 |
| ApprovalQueue + SQLite schema | ✅ 基础版已落地（4 状态；二次确认/过期待扩展） |
| RejectionFeedback | ❌ 待建 |
| pd-console /approvals 路由 | ✅ 基础版已落地 |
| 配置 schema 校验 | ❌ 待建 |
| 审计日志 | ❌ 待建 |

---

## 11. 关联文档

- [ADR-0006](../adr/0006-hybrid-activation-mechanism.md) — 决策依据
- [ADR-0004](../adr/0004-l2-auto-correction-and-replay.md) — code_tool_hook 通道的安全机制
- [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) — 上层视图
- [`INTERNALIZATION_PIPELINE.md`](./INTERNALIZATION_PIPELINE.md) — 上游数据流
- [`COMPONENTS.md`](./COMPONENTS.md) — 组件目录
- [`SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md) — 双人审批的安全考量（待建）
