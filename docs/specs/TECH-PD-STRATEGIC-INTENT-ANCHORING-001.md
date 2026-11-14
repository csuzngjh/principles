# TECH-PD-STRATEGIC-INTENT-ANCHORING-001

# PD Strategic Intent Anchoring 技术方案

**Version:** 1.0  
**Related SPEC:** SPEC-PD-STRATEGIC-INTENT-ANCHORING-001 v1.1  
**Status:** Proposed Technical Design  
**Priority:** P0  
**Architecture Strategy:** Minimal Extension / Reuse Existing Infrastructure  
**Implementation Mode:** Incremental End-to-End Delivery

---

# 1. 技术设计目标

## 1.1 核心问题

本次需要解决的不是如何把 Owner 的 Intent 文档传给更多 LLM。

真正的问题是：

如何让 Owner 的长期战略意图进入 PD 已有的原则形成数据管道，并且能够在原则形成过程中被理解、判断、记录，最终成为正式原则的组成依据。

因此，本次技术实现需要完成三个层次：

| 层次 | 技术目标 |
|---|---|
| Data Propagation | 战略意图能够可靠地传递到原则形成阶段 |
| Decision Participation | 战略意图能够参与候选原则的判断 |
| Contract Materialization | 战略判断能够正式记录在 IntentContract 中 |

三个层次必须同时成立。

仅仅修改 Prompt、增加上下文字段或者保存一份 Intent Snapshot，都不构成完整交付。

## 1.2 架构约束

本次严格遵守：

1. 不新建 Goal Engine。
2. 不新建独立 Strategic Intent 服务。
3. 不新建第二套 Principle Formation Pipeline。
4. 不新建独立 IntentContract 存储系统。
5. 不新建第二套 Approval 系统。
6. 不重构 Principle Activation。
7. 不重构 Production RuleHost。
8. 不重构 Examiner。
9. 不为了版本管理而重建十个核心原则的注册系统。
10. 不引入与当前需求无关的数据库和基础设施。

优先使用现有模块、类型、Artifact、存储和 API。

---

# 2. 目标架构

## 2.1 逻辑架构

```text
                  OWNER
                    |
                    v
          Existing INTENT.md
                    |
                    v
          Existing Intent Reader
                    |
                    v
          Existing Version Store
                    |
                    v
          Stage A Intent Snapshot
          (contentHash + capturedAt)
                    |
                    |
                    v
PAIN ----------> DIAGNOSTICIAN
                    |
                    v
             FormationContext
                    |
          +---------+---------+
          |                   |
          v                   v
       DREAMER          CORE PRINCIPLES
          |                   |
          +---------+---------+
                    |
                    v
                PHILOSOPHER
                    |
                    v
                  SCRIBE
                    |
                    v
             IntentContract V2
                    |
                    v
            Existing Rollout Review
                    |
                    v
           Existing Owner Approval
                    |
             +------+------+
             |             |
             v             v
       Cognitive       RuleCode
       Principle        Pipeline
             |             |
             v             v
       Existing         Existing
       Activation       Artificer
             |             |
             v             v
          Host          Evaluator
                           |
                           v
                       RuleHost
```

注意：

这是一张逻辑架构图，不代表需要创建这些同名的新服务。

所有模块必须优先映射到当前仓库中的真实实现。

## 2.2 需要修改的核心位置

原则上只涉及五个改造区域：

| 改造区域 | 主要任务 |
|---|---|
| Stage A Intent Snapshot | 读取时固定战略意图版本 |
| Diagnostician / FormationContext | 补齐战略上下文传递 |
| Dreamer / Philosopher / Scribe | 将战略意图纳入原则形成 |
| IntentContract / RolloutReviewer | 形成和审查 V2 契约 |
| Existing Consumers | 兼容 V2，保证现有审批和激活继续工作 |

其他模块只在发现实际兼容问题时才修改。

---

# 3. 模块一：Strategic Intent 版本绑定

## 3.1 设计目标

解决一个关键的一致性问题：

Owner 在原则形成过程中修改了 INTENT.md，不能导致同一条原则使用多个不同的战略版本。

## 3.2 实现方式

优先复用现有：

- Intent Reader（`IntentDocReader` 端口）
- Intent Version Store（`IntentDocVersionStore`）
- 现有 `PIArtifactStore`

不要新建 Snapshot Service。

**前提修正**：系统中没有 Formation 创建流程，也没有 `formationId`。INTENT.md 的唯一生产读取点是 Diagnostician Stage A，因此快照必须在那里完成，而不是在不存在的前置步骤里。

逻辑：

```text
Start Diagnostician (Stage A)
       |
       v
Read Current Intent        (readIntentDoc, 受 intent_engineering 控制)
       |
       v
Content Hash               (读取端口已由服务端计算)
       |
       v
Write into Stage A artifact (intentTension + contentHash + capturedAt)
       |
       v
Stage B / C passthrough
       |
       v
Dreamer → Philosopher → Scribe（只读上游产物）
```

## 3.3 最小数据结构

**删除 `FormationIntentBinding`。** 理由：PD 没有 Formation 实体（无 formation 表 / 类型 / id），一个新的绑定结构没有承载者；形成身份是 `candidateId`，一致性由 Stage A 的不可变产物保证。

快照由 Stage A 产物承载（写入现有 `pi_artifacts.contentJson`，不新增表）：

```ts
// Stage A 产物中的战略快照引用（逻辑示意）
interface StageAIntentSnapshotRef {
  contentHash: string;       // 服务端从 readIntentDoc() 结果写入
  capturedAt: string;        // Stage A 读取时刻
  intentVersionId?: string;  // 可选：能关联 IntentDocVersionStore 时
}
```

已有的 `intentTension.intentDocHash` 就是这个引用在诊断产物中的现存载体，优先复用它，不另建平行字段。

完整 Intent 原文不重复存储到每个阶段：

- 首选按 `contentHash` 关联 `IntentDocVersionStore` 的 `contentSnapshot`；
- 只有在版本记录缺失且原文不可恢复时，才把原文写入现有 `PIArtifactStore` 并通过 artifact 引用关联。

## 3.4 Hash 要求

Hash 必须：

- 由程序计算。
- 使用现有 Hash 实现优先（读取端口已返回 `contentHash`）。
- 与对应版本的实际内容一致。
- 可以在后续阶段重新验证。

不允许让 LLM 生成或修改 Hash。

现状缺口（必须在实现时补齐）：Stage A 目前只把 `contentHash` 注入 Prompt，**没有比较模型回填的 `intentTension.intentDocHash`**。因此实现时必须：

1. 由服务端把捕获值写入产物；
2. 模型回填的 hash 视为无效（不采信、不覆盖服务端值）；
3. 出现不一致时记录 `intent_hash_mismatch` 并降级，不静默改写。

## 3.5 重试行为

所有形成阶段只读**上游已成功产物**中记录的快照引用，不按任务重新解析 `INTENT.md`。

禁止：

```text
Retry Dreamer
    |
    v
Read Latest INTENT.md
```

正确行为：

```text
Retry Dreamer
    |
    v
Load upstream artifact (Stage A intentTension + contentHash)
    |
    v
Use the recorded snapshot
```

为什么这已经足够：

- Stage A 成功后其产物不可变；下游重试读到的是同一份产物。
- 只有 Stage A 自身重试会重新读取 `INTENT.md`，而此时下游产物尚不存在，不会出现同一链路混用两个版本。
- 因此不需要 `Formation ID`、不需要持久化的"绑定记录"，也不需要新的幂等键。

这样可以保证：Dreamer、Philosopher、Scribe 和所有下游重试使用同一份战略意图。

---

# 4. 模块二：FormationContext 扩展

这是本次最关键的数据连接改造。

## 4.1 当前问题

此前源码审计发现，Diagnostician 已经存在 Owner Intent 读取和 Intent Tension 诊断能力。

但战略意图没有充分、稳定地进入后续 FormationContext。

因此不能假设 Dreamer、Philosopher、Scribe 已经完整获得这些信息。

## 4.2 目标

扩展现有 FormationContext，不新建第二套上下文对象，也**不新增顶层 `StrategicContext`**。

现状：`FormationContext` 已有 `dreamerProposals / dreamerContextRefs / sourceDiagnosis / provenance / truncationNotes`。要补的只是两个既有位置上的投影：

| 需要的信息 | 放在哪里 | 来源 | 是否新增字段 |
|---|---|---|---|
| 战略相关性 relevance | 由 `intentTension` 确定性派生 | Stage A `intentTension.source` + 是否存在 `intentTension` | 否（派生，不落库） |
| 关联理由 | `intentTension.explanation` | Stage A | 否 |
| 相关章节 | `intentTension.relatedIntentFields`（五个固定键） | Stage A | 否 |
| 冲突信息 | 不在 FormationContext 判断，由 Philosopher / Scribe 写入 Contract `conflicts[]` | 下游判断 | 否 |
| 快照引用 | `provenance.strategicIntentRef` | Stage A 产物 | 是（1 个可选字段） |

结构示意：

```ts
// 既有 FormationContext 上的两个可选扩展（不是新对象）
interface FormationContextStrategicExtension {
  sourceDiagnosis?: {
    // ...既有字段不变
    intentTension?: unknown;   // Stage A 原样透传，由现有 IntentTension 校验器解析
  };
  provenance: {
    // ...既有字段不变
    strategicIntentRef?: {
      contentHash: string;
      capturedAt: string;
      intentVersionId?: string;
    };
  };
}
```

全部 optional；首版即使缺失也必须能正常运行，且不得因此丢弃现有诊断字段。

`relevance` 的派生规则（确定性，不额外调用模型）：开关关闭或文档不可读 → `not_configured`；有 `intentTension` 且 `source != 'none'` → `relevant`；有 `intentTension` 且 `source == 'none'` → `not_applicable`；文档可读但无 `intentTension` → `insufficient_evidence`。

这只是逻辑示意。

如果现有 FormationContext 已经存在相近字段，应直接扩展，不要重复创建。

## 4.3 上下文传递规则

FormationContext 必须保留：

- 原始 Pain。
- Diagnostician 最终结果。
- Intent Snapshot Reference。
- Strategic Relevance。
- Intent Tension。
- 相关 Core Principles。
- 相关证据引用。

不能因为增加 Strategic Context 而丢失现有诊断字段。

## 4.4 控制上下文长度

不要在每个阶段重复注入完整 INTENT.md。

建议：

1. 固定版本和 Hash。
2. 提取必要的战略章节。
3. 保留 Non-negotiables 等关键约束。
4. 只将当前阶段需要的战略内容投影到 Prompt。
5. 所有阶段仍然能够通过 Reference 追溯完整原文。

战略文档是数据，不是系统指令。

必须沿用现有 Prompt 的信任边界和内容隔离方式。

---

# 5. 模块三：Diagnostician 改造

## 5.1 Stage A

Stage A 是战略相关性判断的主要入口。

输入：

- Pain。
- Owner Strategic Intent。
- 十个 Core Principles 的现有上下文。
- 历史诊断证据。

输出：

- 原有根因诊断。
- Strategic Relevance。
- 相关章节。
- 关联理由。
- 初步 Intent Tension。

不能为了战略分析而破坏原有诊断能力。

## 5.2 Stage B / C

继续执行现有诊断任务。

必须保证：

- 保留 Intent Snapshot Reference。
- 不重新读取最新 Intent。
- 保留 Stage A 的关联判断。
- 后续阶段可以补充判断。
- 不得无证据地改变关联状态。

如果现有 A/B/C 已经有统一的上下文传递机制，直接复用。

## 5.3 状态处理

没有配置 Intent：

```text
relevance = not_configured
```

有 Intent 但无法判断：

```text
relevance = insufficient_evidence
```

明确无关：

```text
relevance = not_applicable
```

存在实际关联：

```text
relevance = relevant
```

冲突状态独立记录，不覆盖 relevance。

---

# 6. 模块四：Dreamer / Philosopher / Scribe

这是本次真正让战略意图参与原则形成的核心区域。

## 6.1 Dreamer

Dreamer 不应该只关注：

当前 Pain 应该如何解决？

还应该考虑：

这个候选行为是否符合 Owner 的长期战略方向？

输入：

- 原始 Pain。
- Diagnostician 最终结果。
- StrategicContext。
- Core Principles。
- 现有必要的历史原则上下文。

输出在现有候选原则结构上补充必要信息：

```ts
interface StrategicProposalAssessment {
  relevanceRationale?: string;
  relevantIntentSections?: string[];
  corePrincipleRefs: string[];
  potentialConflicts: string[];
}
```

如果现有 Proposal Schema 已经能表达这些信息，不增加重复字段。

不要求 Dreamer 为每条候选生成独立战略报告。

## 6.2 Philosopher

Philosopher 的任务不是重复 Dreamer 的判断。

它应该进一步检查：

1. 候选原则是否只是局部补丁？
2. 是否具有跨场景复用性？
3. 是否符合相关 Core Principles？
4. 是否与 Owner 长期目标一致？
5. 是否牺牲了长期价值换取短期收益？
6. 是否存在尚未解决的冲突？

输出应复用现有 Philosopher 结果结构。

仅补充缺少的战略判断字段。

## 6.3 Scribe

Scribe 是 IntentContract V2 的唯一正式生成责任点。

它必须：

- 使用固定 Intent Snapshot。
- 使用 Diagnostician 最终结果。
- 使用 Dreamer 候选。
- 使用 Philosopher 结果。
- 使用 Core Principle References。

生成正式 IntentContract V2。

关键要求：

Scribe 不得自行创造前面阶段没有依据的战略关联。

如果前序证据不足，必须如实记录 insufficient_evidence。

如果前序发现冲突，必须保留冲突。

如果战略无关，允许生成正常原则。

## 6.4 三个阶段的职责边界

| 阶段 | 核心职责 |
|---|---|
| Dreamer | 产生考虑战略方向的候选 |
| Philosopher | 审视长期一致性和潜在冲突 |
| Scribe | 将最终判断落实为正式原则与 Contract |

不得让三个阶段重复执行相同的战略判断任务。

---

# 7. 模块五：IntentContract V2

## 7.1 设计原则

V2 应当是一个轻量级、可追溯的正式契约。

不应该变成一个包含大量状态、配置和业务流程的复杂对象。

建议只保留 V1 五字段 + 三组可选信息：

1. V1 `ownerIntent / targetBehavior / forbiddenBehavior / evidenceSource / validationExpectation`（逐字不动，行为与验证的唯一权威）
2. Strategic Intent 引用（`strategicIntent`）
3. Strategic Assessment（`strategicAssessment`）
4. Core Principle 引用（`corePrincipleRefs`）

## 7.2 数据结构

与 SPEC §8.2 保持一致：V2 是 V1 的加法扩展。

```ts
interface IntentContractV2 extends IntentContractV1 {
  schemaVersion: 2;

  strategicIntent?: {
    contentHash: string;          // Stage A 服务端捕获
    capturedAt: string;
    intentVersionId?: string;
    relevantSections?: Array<
      | 'why'
      | 'desired_outcome'
      | 'non_negotiables'
      | 'stop_escalation'
      | 'current_strategic_focus'
    >;
  };

  strategicAssessment?: {
    relevance:
      | 'relevant'
      | 'not_applicable'
      | 'insufficient_evidence'
      | 'not_configured';

    rationale?: string;

    conflicts?: Array<{
      against: 'core_principle' | 'owner_intent';
      ref: string;
      status: 'potential' | 'confirmed';
      evidenceRefs: string[];
    }>;
  };

  corePrincipleRefs?: string[];
}
```

与上一版草案的差异（均为删减）：

- 删除 `source.formationId / painRefs / diagnosisRefs`：无 Formation 实体，来源已由 V1 `evidenceSource` 与产物 lineage 承载。
- 删除 `principleIntent.*` 与 `validation.*`：V1 对应字段已是唯一权威。
- `conflictStatus + conflictEvidenceRefs` 合并为 `conflicts[]`，使每个冲突自带双方定位。

## 7.3 数据验证

使用现有 Schema Validation 机制。

服务端负责验证：

- Schema Version。
- Reference 是否存在。
- Reference 是否有权限。
- Intent Version 是否匹配。
- Hash 是否正确。
- 字段是否满足最小要求。
- 目标行为是否为空。
- 冲突状态是否具有对应证据。

不允许模型提交一个看似合法但无法追溯的 Contract。

## 7.4 冲突状态的可信度

需要特别区分模型提出的冲突与系统确认的冲突。

- `potential` 可以由模型提出。
- `confirmed` 必须经过现有审查机制或确定性规则确认，并保留证据。
- 没有证据的冲突不能直接成为 confirmed。

不要额外创建一套冲突评估服务。

优先在现有 RolloutReviewer 中完成确认。

## 7.5 版本兼容

建议采用：

```text
Existing V1 Records
        |
        v
Existing V1 Reader
        |
        v
Existing Downstream Logic


New Formation Run（候选链）
        |
        v
Scribe V2
        |
        v
Version-aware Contract Reader
        |
        v
Existing Downstream Logic
```

实施原则：

- V1 保持原样。
- 新形成的 Contract 使用 V2。
- 下游通过现有读取入口区分版本。
- 只有必要消费者才增加 V2 兼容。
- 不进行全量历史数据迁移。

如果现有消费者只需要读取 targetBehaviors 等行为字段，应使用最小的统一读取投影，而不是要求所有消费者理解全部战略字段。

---

# 8. 双锚点冲突治理实现

## 8.1 处理位置

优先在现有 RolloutReviewer 和 Owner Review 流程中处理。

不新增 Conflict Manager 服务。

## 8.2 冲突处理规则

```text
IntentContract V2
       |
       v
Strategic Assessment
       |
       v
Conflict Status
       |
       +----------------+
       |                |
       v                v
      None          Potential
       |                |
       v                v
 Normal Review      Owner Review
                        |
                        v
                    Confirmed?
                     /     \
                   No       Yes
                   |         |
                   v         v
                Continue   Block Candidate
                              |
                              v
                         Owner Decision
```

这里的 Owner Decision 不能直接豁免 Core Principles 或系统安全约束。

## 8.3 冲突粒度

使用现有 `candidateId` / `artifactId` 定位，冲突只作用于受影响的那一条候选产物。

现状（与上一版假设不同）：

- 审批按产物（artifactId）记录，不是"Formation 级"。
- 审批分组模型已经 per-record 计算 `approveBlock`（现有 6 个 block code：`identity_unresolved / artifact_unavailable / budget_exceeded / route_unconfirmed / authority_unreadable / content_unconfirmed`），并明确"一条记录被阻断不得围栏住兄弟记录"。

因此实现方式为：

- 新增一个 block code（例如 `strategic_conflict_unconfirmed`），服务端审批预检与卡片读取同一个判定；`reason` 说明冲突对象（`against` + `ref`），`nextAction` 指向 Owner 决策入口。
- 不新增候选级冲突状态机，不新增 DB 状态字段，不新建审批工作流。
- 无冲突的候选照常审批与激活。

## 8.4 冲突解决

允许：

- 修改候选原则。
- 修改 Owner Strategic Intent。
- 拒绝候选。
- 保留待审。

修改后重新生成或重新审查 Contract。

原有 Contract 和战略快照保留，不能直接修改历史依据。

---

# 9. Owner Approval 和 Activation

本次不重建审批与执行体系。

## 9.1 Owner Approval

继续使用现有 Owner Decision / Approval。

需要保证审批引用的是确定版本的：

- Principle。
- IntentContract。
- Strategic Intent Snapshot。

不允许客户端或 LLM 直接伪造审批状态。

如果现有 Approval Record 已经具备版本关联能力，直接复用。

## 9.2 Cognitive Principle

沿用现有 Principle Activation。

只验证：

- 新原则可以正常审批。
- 激活后正确进入现有宿主上下文。
- 原则版本与 Contract 对应。
- 不依赖原始 INTENT.md 常驻注入。

## 9.3 RuleCode

沿用：

- Artificer
- Evaluator
- Existing RuleCode Activation
- Production RuleHost

只确保 V2 Contract 的行为要求能够被 Artificer 和 Evaluator 正确消费。

不修改 RuleHost 核心执行机制。

## 9.4 Examiner

不重构 Examiner。

如果现有 Principle ID、Activation ID 和 Runtime Evidence 已经能够形成追溯关系，直接复用。

只有在确实缺少必要的 Contract Reference 时，才增加最小关联。

---

# 10. 持久化与一致性

## 10.1 最小持久化策略

优先使用现有：

- Intent Version Store（`IntentDocVersionStore`）。
- `PIArtifactStore`（Stage A / Scribe 产物）。
- Scribe 产物中的 `intentContract`（合同实际存储位置）。
- Existing Approval Store。

不默认新增数据库表。

如果现有 Artifact 存储已经能够持久化结构化 Contract，优先使用它。

只有经过源码核实，确认现有存储无法满足查询、索引或事务要求时，才考虑最小 Schema Migration。

## 10.2 幂等

同一候选链的重试：

- 不创建新的 Intent Snapshot（复用 Stage A 已记录的快照）。
- 不产生不同的 Contract 来源版本。
- 不重复创建相同候选原则。
- 不重复执行 Owner Approval。

继续使用现有 `taskId` / `artifactId` 与现有幂等机制。

## 10.3 原子性

Contract 持久化必须与现有形成阶段的成功状态保持一致。

如果现有系统已经提供 Artifact 和阶段状态的事务边界，直接复用。

不为本次功能创建新的事务协调系统。

## 10.4 版本一致性

最重要的约束：

```text
candidateId（候选链身份）
    |
    v
Stage A artifact（intentTension + contentHash + capturedAt）
    |
    v
Intent Hash
    |
    +---- Diagnostician B / C
    |
    +---- Dreamer
    |
    +---- Philosopher
    |
    +---- Scribe
    |
    +---- IntentContract V2
```

所有阶段必须使用同一份快照引用。

---

# 11. Feature Flag 技术方案

结论：**复用 `intent_engineering` 作为唯一开关，不新增 flag，也不拆分开关职责。**

现状核查（`feature-flag-contract.ts` + `prompt.ts` + `diag-rootcause-runner.ts`）：

- `intent_engineering`：`quiet` 类别、默认 `false`。
- 它同时控制两条路径：
  1. Stage A 读取 INTENT.md 并允许产出 `intentTension`；
  2. 宿主 prompt 的 INTENT friction block 注入。
- 关闭时，读取端口直接返回 `flag_disabled` 且不访问文件系统；prompt 侧不注入。

接受的耦合：

- "关闭 = 战略锚定与原始注入一起关闭"是 MVP 阶段的已知约束，本次不拆分。
- 若未来需要独立控制，再评估；不在本次新增配置面。

关闭与降级行为（必须测试）：

- 关闭：不读 INTENT、无 `intentTension`、Contract 仅 V1 五字段；形成 / 审批 / 激活全部照常。
- 开启但文档不存在 / 超大 / 读取失败：按 `not_configured` 降级，输出可观察事件，流程不失败。
- 未配置 Intent 的用户不受任何影响。
- 紧急关闭能力由现有 flag 提供。

---

# 12. 测试技术方案

## 12.1 单元测试

重点覆盖：

- Stage A Intent Snapshot（contentHash / capturedAt 由服务端写入）。
- Hash Verification（不一致 → `intent_hash_mismatch` 降级）。
- 候选链重试（下游只读上游产物，不重读 INTENT.md）。
- Strategic Relevance。
- Conflict Status。
- Contract V2 Schema。
- V1 Compatibility。
- Reference Validation。

## 12.2 集成测试

重点验证：

```text
Intent Reader
    |
    v
Stage A Snapshot
    |
    v
Diagnostician
    |
    v
FormationContext
    |
    v
Dreamer
    |
    v
Philosopher
    |
    v
Scribe
    |
    v
IntentContract V2
```

测试必须证明：

数据不仅传递，而且每个阶段的结构化结果能够被下游使用。

## 12.3 冲突测试

至少覆盖：

1. Owner Intent 与 Core Principle 一致。
2. Owner Intent 与 Core Principle 存在潜在冲突。
3. 确认冲突。
4. 冲突候选被阻断。
5. 无冲突候选继续处理。
6. 修改候选后重新审查。
7. Owner Intent 修改后使用新 Snapshot。
8. 系统级安全约束不能被 Owner Decision 绕过。

## 12.4 真实宿主验收

使用现有隔离环境。

认知原则和 RuleCode 各完成一次完整链路。

验证真实 Runtime 使用的是经过审批的原则版本。

不以模型文字完全一致作为验收条件。

---

# 13. 实施顺序

建议按照以下顺序实施，避免同时修改太多模块。

## Phase 0：源码 Preflight

- 检查最新 HEAD。
- 确认 Intent Version Store。
- 确认 Contract V1 全部消费者。
- 确认 FormationContext。
- 确认 Core Principle Registry。
- 确认 Owner Review。
- 确认两种 Activation 路径。

交付：简洁的源码映射表和实际改造清单。

## Phase 1：数据一致性基础

完成：

- Stage A Intent Snapshot（服务端写入 contentHash / capturedAt）。
- FormationContext 投影扩展（`intentTension` + `provenance.strategicIntentRef`）。
- Hash Verification。
- 重试一致性（下游只读上游产物）。

先保证数据可靠。

## Phase 2：原则形成链路

完成：

- Diagnostician 数据传递。
- Dreamer 战略参与。
- Philosopher 双锚点评估。
- Scribe V2 Contract。

先完成真正的战略锚定。

## Phase 3：契约与治理

完成：

- V1/V2 兼容。
- RolloutReviewer。
- Owner Review。
- 冲突处理。
- 现有 Owner Approval 关联。

## Phase 4：下游兼容

完成：

- Artificer V2 兼容。
- Evaluator V2 兼容。
- 两种现有激活路径验收。

不重构 Runtime。

## Phase 5：产品验收与开放

完成：

- 自动化测试。
- 浏览器验收。
- 真实宿主验收。
- 用户文档。
- Feature Flag 正式开放。
- PR 和审计报告。

阶段顺序是实施建议，不要求每个 Phase 都创建独立 PR。

优先使用能够保持代码完整性和 CI 质量的提交粒度。

---

# 14. 代码复杂度控制

这是本次技术方案最重要的工程约束。

## 14.1 不增加重复抽象

禁止同时存在：

- IntentSnapshotService + IntentVersionService（职责重复）。
- StrategicContextService + FormationContext（职责重复）。
- StrategicConflictManager + RolloutReviewer（职责重复）。
- ContractV2Store + Existing Contract Store（职责重复）。
- StrategicApprovalService + Existing Approval（职责重复）。

如果现有模块能够承担职责，不创建新服务。

## 14.2 不增加无意义的状态

Strategic Relevance 与 Conflict Status 是两个必要维度。

除此之外，不再增加：

- Strategic Alignment Lifecycle。
- Strategic Intent Confidence Lifecycle。
- Strategic Governance State Machine。
- Strategic Evolution State Machine。

除非实际业务需求已经存在且源码能够证明必要性。

## 14.3 不过度拆分

优先：

- 扩展现有 TypeScript 类型。
- 扩展现有 Schema。
- 扩展现有 Prompt Builder。
- 扩展现有 Artifact。
- 扩展现有 Reviewer。

不要为了代码形式上的整洁创建大量仅有一层转发的 Adapter、Service 和 Factory。

## 14.4 数据字段控制

新增字段必须满足至少一个条件：

1. 保证版本一致性。
2. 支持战略判断。
3. 支持证据追溯。
4. 支持行为验证。
5. 支持现有下游兼容。

不能明确说明用途的字段不加入。

## 14.5 数据库控制

默认不新增独立数据库。

默认不新增独立表。

默认不增加新的后台任务和调度系统。

优先复用现有存储。

## 14.6 复杂度审查

每个新增模块、文件、数据库字段和依赖，都必须能够回答：

- 现有哪个模块无法完成这个职责？
- 为什么不能直接扩展现有实现？
- 不增加它是否会导致真实功能缺失？
- 它是否会增加长期维护成本？

不能回答清楚，就不应该新增。

---

# 15. Definition of Done

本次技术实施完成必须满足：

| 项目 | 标准 |
|---|---|
| Intent Snapshot | 同一候选链使用 Stage A 记录的同一快照 |
| FormationContext | 战略信息完整传递 |
| Diagnostician | 保留原有诊断并支持战略判断 |
| Dreamer | 能够消费战略依据 |
| Philosopher | 能够审视双锚点 |
| Scribe | 正确生成 V2 |
| Contract | V1/V2 兼容 |
| Conflict | 相关候选正确进入审查 |
| Approval | 沿用现有 Owner Decision |
| Artificer | 能够消费 V2 |
| Evaluator | 能够验证 V2 |
| Cognitive Activation | 真实宿主验收通过 |
| RuleCode Activation | 真实宿主验收通过 |
| Security | 现有安全边界不被削弱 |
| CI | 全部通过 |
| Browser | 真实浏览器验收通过 |
| Complexity | 没有不必要的新服务、数据库和状态机 |

---

# 16. 最终技术原则

本次技术实现应该遵循：

**不改变 PD 已经成熟的行为治理机制，只补齐战略意图进入这些机制的必要连接。**

Owner Strategic Intent 是上游战略依据。

Core Principles 是系统级行为锚点。

Pain 是现实证据。

Dreamer、Philosopher 和 Scribe 负责将这些依据转化为新的行为原则。

IntentContract 是正式契约。

Owner Approval 是治理门槛。

Principle Activation 和 RuleHost 是已经存在的执行机制。

Examiner 是后续行为验证机制。

本次不需要再发明新的治理系统。

最终希望得到的是一条简单、可靠、可追溯、能够长期维护的战略意图内部化管道。

**让 PD 能够把人类长期珍视的方向，转化为 Agent 能够持续遵循的行为原则。**

---

**END OF TECHNICAL DESIGN**

---

# 修订记录（2026-11-14）

> 依据：PD-SIA 架构评审（只读）＋ 对 `origin/main`（6bc0874a）源码的逐项复核。本次只修订文档，不改代码。

| # | 章节 | 审查发现 | 改了什么 | 依据（代码语义位置） |
|---|---|---|---|---|
| 1 | §2.1 / §2.2 | 架构图与改造区域表把 "Formation Intent Binding" 当成既有模块 | 改为 "Stage A Intent Snapshot（contentHash + capturedAt）" | `diag-rootcause-runner.ts:198`（唯一读取点） |
| 2 | §3.2 | 流程图以 "Create Formation → Bind Version to Formation" 为前置步骤，该步骤不存在 | 改为在 Stage A 内读取 + 捕获 + 写入产物 | 全仓无 formation 表/创建流程；`intent-doc-reader-port.ts:31-38` |
| 3 | §3.3 | `FormationIntentBinding` 是需要新建的结构，没有承载实体 | 整节删除，改为 Stage A 产物承载 `contentHash / capturedAt / intentVersionId?` | 无 Formation 实体；`PIArtifactStore` 已持久化 Stage A 产物；`intentTension.intentDocHash` 已存在 |
| 4 | §3.4 | 要求 hash "可重新验证"，但现实现没有比较模型回填值 | 明确服务端写入、模型回填无效、不一致走 `intent_hash_mismatch` 降级 | `diag-rootcause-runner.ts:191-217` 只注入 contentHash；全仓无 `intentDocHash` 服务端比较 |
| 5 | §3.5 | 用 "Formation ID 取绑定" 描述重试，但该 ID 不存在 | 改为"只读上游已成功产物"；说明仅 Stage A 重试会重读 | `diag-router-runner.ts:848-874`（Stage C 只透传） |
| 6 | §4.2 | 提出新增顶层 `StrategicContext`，与既有投影重复 | 改为"两个可选投影"（`sourceDiagnosis.intentTension` + `provenance.strategicIntentRef`），并给字段来源表 | `formation-context.ts:363-445`（诊断投影不读 intentTension）、`:66`（8000 上限） |
| 7 | §7.1 / §7.2 | V2 结构与 SPEC §8.2 修订后不一致，且包含 `formationId` / `principleIntent` / `validation` | 对齐为 `extends IntentContractV1` + 三个可选组；删除重复字段 | `intent-contract.ts:40-77`（V1 只校验五字段且允许额外键） |
| 8 | §7.5 / §10.1 / §10.2 / §10.4 / §12.1 / §12.2 / §13 / §15 | 残留 "Formation" 身份、`Formation Records/Artifacts`、`Formation Binding` 等指代 | 统一改为候选链 / Stage A 产物 / `PIArtifactStore` 的实际说法，不留悬空引用 | 同 #3；`principle_candidates` 以 `candidate_id` 为身份 |
| 9 | §8.3 | "如果只有 Formation 级审批，则增加最小局部状态控制"与现状不符 | 改为候选/产物粒度，复用 per-record `approveBlock`，新增一个 block code，不新增状态 | `ApprovalsGroupedConsoleModel.ts:50-64,105-126` |
| 10 | §11 | 给出"情况 A/B/C"并要求可能新增独立开关 | 改为确定结论：复用 `intent_engineering`，不拆分、不新增 | `feature-flag-contract.ts:288`；`prompt.ts:1185-1200` |

未采纳的建议及原因：

- **新增独立 flag**：Owner 明确要求不新增第二个 flag；现有开关已是同一职责的唯一入口。
- **FormationIntentBinding**：没有 Formation 实体承载，且一致性可由 Stage A 不可变产物保证。
- **顶层 `StrategicContext`**：与既有 `FormationContext` 投影职责重复，违反"不新增重复抽象"。