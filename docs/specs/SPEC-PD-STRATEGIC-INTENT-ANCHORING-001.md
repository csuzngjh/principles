# SPEC-PD-STRATEGIC-INTENT-ANCHORING-001

# Strategic Intent Anchoring
## 战略意图锚定的原则形成机制

 项目  内容 
------
 SPEC Version  1.1 
 Status  Ready for Implementation Preflight 
 Priority  P0 
 Scope  Intent  Principle Formation  IntentContract 
 Development Strategy  Product First 
 Compatibility  Existing Intent  Principle  RuleCode 
 Implementation  End-to-End 
 Release  Open Core Capability 

---

# 1. 项目目标

## 1.1 背景

PD 已经具备从真实 Pain 到行为原则，再到宿主行为影响的基本机制。

现有体系包括：

- Owner Strategic Intent
- Pain Capture
- Diagnostician
- Dreamer
- Philosopher
- Scribe
- IntentContract
- Artificer
- Evaluator
- Owner Approval
- Principle Activation
- RuleCode  RuleHost
- Examiner

但 Owner 的长期战略目标和意图尚未充分进入原则形成管道。

目前存在的主要问题：

1. 战略意图能够参与部分诊断，但没有充分成为正式的原则形成依据。
2. Diagnostician 到 FormationContext 的战略信息传递需要进一步核实和补齐。
3. Dreamer、Philosopher、Scribe 缺少统一、稳定的战略意图来源契约。
4. 现有 IntentContract 主要描述局部行为意图，不能完整表达长期战略来源与原则之间的关系。
5. 战略意图与系统核心原则之间的冲突缺少统一的审查表达。

## 1.2 本次核心目标

将 Owner 的长期 Strategic Goal 和 Strategic Intent 建设为 PD 原则形成过程中的第二个战略锚点。

使其与 PD 内置的十个核心原则共同参与新原则的形成，并通过现有 IntentContract、Owner Approval、Principle Activation 和 RuleCode 机制，最终影响宿主行为。

核心链路：

Owner Strategic Intent → Pain → Diagnosis → Principle Formation → IntentContract → Owner Approval → Principle  RuleCode Activation → Host Behavior

本次重点是补齐战略意图与原则形成之间的连接，而不是重建现有原则系统。

## 1.3 本次交付的价值

PD 不再只是根据眼前的 Pain 帮助宿主生成行为原则。

它还能够理解 Owner 长期希望实现什么、希望保护什么价值，以及哪些行为不能为了短期目标而牺牲。

这些战略要求最终通过正式原则转化为宿主可以持续遵循的行为约束。

---

# 2. 已确认的架构决策

以下决策已经与 Owner 对齐，实施时不得擅自改变。

## 2.1 双锚点

Anchor A：PD Core Principles

PD 内置的十个核心原则。

负责提供系统级基础行为准则，参与新原则形成和审查。

Anchor B：Owner Strategic Goal & Intent

Owner 的长期战略方向。

负责提供长期目标、价值、取舍、不可妥协的边界和阶段性重点。

两者共同参与原则形成，不相互取代。

## 2.2 战略关联采用按需原则

不是每一条 Pain 和新原则都必须关联 Owner Strategic Intent。

只有存在实际关联时才将战略意图纳入具体原则。

与战略无关的 Pain 仍然正常走现有原则形成流程。

不得为了满足战略锚点要求而制造虚假的关联。

## 2.3 IntentContract 整体重新设计

不采用简单增加几个字段的方式。

重新明确 IntentContract 的职责：

连接战略来源、真实 Pain、核心原则、行为要求和验证依据。

但不让 Contract 承担独立审批系统或独立生命周期管理系统的职责。

## 2.4 复用现有成熟机制

必须优先复用：

- Intent Document  Version Store
- Internalization Pipeline
- FormationContext
- Existing IntentContract Consumers
- Owner Decision  Approval
- Principle Activation
- Artificer  Evaluator
- Production RuleHost
- Examiner

除非 Preflight 证明现有能力确实无法满足要求，否则不得新增平行模块。

## 2.5 产品优先

先完成核心功能，再通过真实运行积累数据并持续优化。

不要求在开发前建立大规模模型行为数据集。

不要求通过大量对照实验寻找最优 Prompt。

不将数月或数年的长期行为对齐证明作为本次发布条件。

---

# 3. 概念定义

 概念  含义 
------
 Strategic Goal  Owner 希望实现的长期结果 
 Strategic Intent  Goal 背后的价值、理由、取舍和边界 
 Strategic Focus  当前阶段优先推进的战略事项 
 Core Principles  PD 内置的十个系统级核心原则 
 Pain  真实发生的问题、失败和纠正信号 
 Principle  从经验中提炼的可复用行为准则 
 IntentContract  连接原则来源与行为要求的正式契约 
 RuleCode  将原则转化为可执行行为约束 
 Examiner  验证原则是否真正影响宿主行为 

现有 `INTENT.md` 的 Why、Desired Outcome、Non-negotiables、StopEscalation、Current Strategic Focus 应继续得到支持。

不要求本次重新建设 Goal 文档系统。

---

# 4. 现有代码 Preflight

这是实施的第一个步骤。

必须基于最新 main  HEAD 核对真实源码，不能直接照搬历史审计中的文件位置和接口假设。

Preflight 必须一次性完成，作为实施准备，不得演变成新的研究项目。

## 4.1 必须核实的项目

 模块  必须确认的事实 
------
 Intent Document  当前文档 Schema 和实际读取行为 
 Intent Version Store  是否能恢复历史版本，是否具备 Hash 和持久化能力 
 Diagnostician ABC  Strategic Intent 和 intentTension 的实际传递路径 
 FormationContext  当前诊断信息和战略信息的投影结构 
 Dreamer  实际输入契约和前序结果来源 
 Philosopher  实际输入输出契约 
 Scribe  Contract 生成、校验和持久化位置 
 IntentContract V1  全部生产消费者及其兼容要求 
 Core Principles  十个原则的真实注册表、稳定标识和版本能力 
 Owner Review  现有 UI、API、Decision 和 Approval 机制 
 Artificer  Evaluator  当前 Contract 消费方式 
 Feature Flags  `intent_engineering` 的真实职责、默认值和配置优先级 
 Cognitive Activation  正式原则的实际激活和宿主消费路径 
 RuleCode Activation  Artificer、Evaluator、RuleHost 的实际执行链路 
 Examiner  当前是否已经能够通过现有记录追溯 Principle 和 Runtime Evidence 

## 4.2 Preflight 输出

只需要提供一份简洁的源码审计结果：

1. 最新 HEAD 和分支状态。
2. 现有实际调用链。
3. IntentContract 的全部生产消费者。
4. 当前可以直接复用的模块。
5. 必须修改的模块。
6. 需要兼容的历史数据。
7. 发现的真实阻塞问题。

不要求额外撰写一份大型架构研究报告。

## 4.3 Preflight 决策规则

如果现有模块能够满足需求：

直接复用，不增加新的抽象。

如果现有模块只有轻微缺陷：

在原模块内进行最小修复。

如果发现某项假设不成立：

根据真实源码调整实现方式，但必须保持本 SPEC 的产品目标和范围。

如果发现会显著扩大工作量的架构缺口：

先记录为阻塞问题，给出最小替代方案，不允许本地代理自行启动大规模重构。

---

# 5. 目标数据链路

```text
Owner Strategic Goal & Intent
             |
             v
Existing INTENT.md + IntentDocVersion（contentSnapshot = 完整历史内容）
             |
             v
Pain
             |
             v
Diagnostician Stage A          <-- 唯一的 INTENT.md 读取点
             |                     读取后由服务端捕获 contentHash + capturedAt
             v
Stage A 不可变产物（intentTension + 战略快照引用）
             |
             v
Stage B / Stage C（只透传 Stage A 的 intentTension，不重读 INTENT.md）
             |
             v
candidateId 候选链：diagnosis → dreamer → philosopher → scribe
             |
             v
FormationContext（既有投影的扩展，不是新对象）
             |
             v
Dreamer → Philosopher → Scribe
             |
             v
IntentContract V2（V1 五字段原样保留 + 可选战略字段）
             |
             v
Existing Owner Review / Approval
             |
             v
Existing Principle / RuleCode Activation
             |
             v
Host Runtime
```

十个 Core Principles 作为另一个锚点，沿用现有原则注册和形成机制参与上述流程。

这张图表达的是数据与决策关系，不要求每个阶段新建独立服务。

关于名词：PD 当前**没有 Formation 聚合实体**（全仓无 formation 表/类型），一次原则形成的真实身份是一条以 `candidateId` 为标识的候选链（`pain → diagnosis → dreamer → philosopher → scribe`，见 `principle_candidates` 与 `candidate-identity.ts`）。本文档其余部分沿用历史上的 "Formation" 说法时，均指这条候选链，**不表示存在 `formationId`，也不要求新建 Formation 表或 FormationIntentBinding**。同样，"Intent Snapshot" 不是独立存储：它是 Stage A 读取 INTENT.md 时捕获的 `contentHash + capturedAt`，随 Stage A 的不可变产物一起持久化。

---

# 6. Strategic Intent Snapshot

## 6.1 目标

每一次原则形成任务必须使用一致的 Owner Strategic Intent 版本。

防止 Owner 修改 `INTENT.md` 后，同一条原则在不同形成阶段读取到不同的战略内容。

## 6.2 实现原则

优先复用现有 Intent Version Store。

不默认新增数据库、表或独立快照服务。

现状事实（决定了实现位置）：

- INTENT.md 只在 Diagnostician Stage A 被读取一次；生产代码中 `readIntentDoc()` 的唯一调用点是 `diag-rootcause-runner.ts`（Stage B / C 只继承 Stage A 的结果）。
- 读取端口返回 `raw / contentHash / path` 三个字段，**不返回版本号**；`contentHash` 由服务端计算。
- 现有 `IntentDocVersionStore` 的版本记录已包含 `contentSnapshot`（完整历史内容），因此历史原文可按 `contentHash` 关联恢复，不需要把完整 Intent 文档复制到形成阶段。

因此在**读取发生的那一刻**（Stage A）完成快照，而不是在并不存在的 "Formation 创建流程" 中完成：

1. Stage A 读取当前有效 Intent（受 `intent_engineering` 开关控制）。
2. 使用读取端口已返回的 `contentHash` 作为快照身份（服务端计算，不接受模型填写）。
3. 将 `contentHash` 与 `capturedAt` 写入 Stage A 产物（作为 `intentTension` 的 lineage）。
4. Stage B / C、Dreamer、Philosopher、Scribe 只读上游产物，不再读取 `INTENT.md`。
5. 如需历史原文，按 `contentHash` 关联现有版本记录；只有在版本记录缺失且原文不可恢复时，才允许把原文写入现有 Artifact 存储。

`intentVersionId` 是可选引用：仅当能可靠关联到现有版本记录时才写入；无法关联时以 `contentHash` 为准。

当 `intent_engineering` 关闭、或 INTENT.md 不存在 / 超大 / 读取失败时，Stage A 不产生快照，本次形成按"未配置战略意图"降级（见 §7.1 与 §12），不报错、不阻塞原则形成。

## 6.3 Snapshot 最小语义

```ts
interface StrategicIntentSnapshot {
  intentVersionId string;
  contentHash string;
  capturedAt string;
  sourceDocumentId string;
}
```

这是逻辑接口示意。

如果现有数据模型已有等价字段，直接复用，不要创建重复字段。

完整内容应能通过可信的版本记录或 Artifact 恢复。

## 6.4 时间语义

战略快照的时间语义固定为：**Stage A 读取 INTENT.md 的时刻**（`capturedAt`）。

需要区分并可同时保留的时间只有三个：

- Pain 原始发生时间：`occurredAt` 在 Pain payload 中是可选字段（`context-payload.ts`），可能缺失。
- Pain 捕获 / 记录时间：证明这条 Pain 何时进入系统。
- 战略快照捕获时间：`capturedAt`。

系统中不存在 "Formation 启动时间"，本 SPEC 不引入该概念。

不得把 Stage A 时刻的战略意图伪装成 Pain 发生时的战略意图：当 `occurredAt` 缺失时，证据引用只能标注"捕获时间"，不得回填成 Pain 发生时间。

## 6.5 版本一致性

同一个候选链（同一 `candidateId`）的：

- Diagnostician Stage A / B / C
- Dreamer
- Philosopher
- Scribe
- 以及以上任一阶段的重试

必须使用**同一个**战略快照。

实现语义（与现有产物模型一致）：

- Stage A 成功后，其产物（含 `intentTension` 与 `contentHash` / `capturedAt`）是这条链唯一的战略依据；下游只读该产物，不重新读取 `INTENT.md`。
- 下游阶段重试时，读取的是上游已成功的产物，因此不会换成新版本。
- 只有 **Stage A 自身重试**会重新读取 `INTENT.md`；此时下游产物尚未生成，不会出现同一链路混用两个版本的情况。
- 下游不得用新的 `INTENT.md` 覆盖或补写上游签发的 `contentHash`；出现不一致时按 §13 的"可观察降级"处理，不静默替换。

Owner 后续修改 Intent，不影响已经产生 Stage A 产物的候选链。

---

# 7. Strategic Relevance 与 Conflict Assessment

两个概念必须分开。

相关性回答：当前 Pain 是否与 Owner Strategic Intent 有关？

冲突回答：当前候选原则是否与某个战略锚点发生矛盾？

不能将它们合并成一个枚举。

## 7.1 Strategic Relevance

```ts
type StrategicRelevance =
   'relevant'
   'not_applicable'
   'insufficient_evidence'
   'not_configured';
```

含义：

 状态  处理方式 
------
 relevant  纳入战略意图相关内容 
 not_applicable  正常形成原则，不强行关联 
 insufficient_evidence  保留不确定性，不伪造关联 
 not_configured  Owner 尚未配置战略意图，继续使用现有原则形成机制 

判定责任人与派生方式（避免各阶段重复判断、互相覆盖）：

- **唯一判定点是 Diagnostician Stage A。** 现有实现已经由 Stage A 产出 `intentTension`，Stage C 只做 additive passthrough（Stage A 没有产出时不补造，模型幻觉产出时被删除）。本次不新增第二个判定点。
- `not_configured` **由代码派生，不由模型判断**：`intent_engineering` 关闭，或读取端口返回 `flag_disabled / not_found / oversized / read_error` 时，本次不产生 `intentTension`，按未配置处理。
- 其余三态是 Stage A 在拿到 Intent 内容后作出的判断，必须同时给出 `relatedIntentFields`（来源章节）与 `explanation`（理由）。
- 下游 Dreamer / Philosopher / Scribe **不得重新判定 relevance**，只能引用 Stage A 的结论并在 Contract 中如实转述；这与现有"Stage C 不生成 intentTension"的约束同源。
- 现有 `intentTension.source`（`none / action_drift / intent_suspect / healthy_tension`）表达的是张力类型，**不是** relevance 四态，二者不得互相替换或直接映射为同一个枚举。relevance 是本次新增的派生判断，取值来源只能是 Stage A 产物。

## 7.2 Conflict Assessment

```ts
type ConflictStatus =
   'none'
   'potential'
   'confirmed';
```

- none：没有发现冲突。
- potential：存在潜在冲突，需要进一步审查。
- confirmed：已有充分依据确认冲突。

冲突处理结果由现有 Owner Decision  Approval 机制记录。

不要在 IntentContract 中另建一套冲突审批状态机。

## 7.3 判断依据

Strategic Relevance 不能只依赖关键词匹配。

至少需要：

- 当前 Pain 或 Diagnosis 的证据。
- 对应战略章节。
- 关联理由。

Conflict 不能只依赖模型给出的主观结论。

必须提供涉及的原则、战略章节或行为要求，以及对应证据。

服务端负责验证引用真实性。

模型负责提出判断，不负责伪造证据。

---

# 8. IntentContract V2

## 8.1 重新定位

IntentContract V2 是一条正式原则的形成依据和行为契约。

它负责回答：

1. 这条原则从哪里产生？
2. 解决什么真实 Pain？
3. 是否与 Owner Strategic Intent 相关？
4. 关联了哪些 Core Principles？
5. 原则希望宿主形成什么行为？
6. 哪些行为不能发生？
7. 如何验证这些行为？

它不负责：

- Owner 身份认证。
- 独立审批。
- 原则激活状态管理。
- Runtime 权限管理。
- 独立生命周期管理。

这些继续由现有模块负责。

## 8.2 最小结构

以下是语义示意，不要求逐字复制为新的 TypeScript 类型。

```ts
// V2 是 V1 的加法扩展：V1 五个字段的名称、语义、必填性一字不动。
// 现有校验器 isValidIntentContractV1() 只校验这五个非空字符串，
// 并允许对象带额外字段，因此"V1 五字段 + 可选战略字段"天然向后兼容。
interface IntentContractV2 extends IntentContractV1 {
  schemaVersion: 2;

  // 只放"引用"：证明本原则依据哪一份 Intent，不放任何判断。
  strategicIntent?: {
    contentHash: string;          // Stage A 服务端捕获
    capturedAt: string;           // Stage A 读取时刻
    intentVersionId?: string;     // 仅当能关联现有版本记录
    relevantSections?: Array<     // 只允许 INTENT.md 五个固定章节键
      | 'why'
      | 'desired_outcome'
      | 'non_negotiables'
      | 'stop_escalation'
      | 'current_strategic_focus'
    >;
  };

  // 只放"判断与证据"：不重复版本引用。
  strategicAssessment?: {
    relevance:
      | 'relevant'
      | 'not_applicable'
      | 'insufficient_evidence'
      | 'not_configured';

    rationale?: string;

    // 每个冲突必须能同时定位"对谁"和"凭什么"。
    conflicts?: Array<{
      against: 'core_principle' | 'owner_intent';
      ref: string;                // principleId 或 INTENT 章节键
      status: 'potential' | 'confirmed';
      evidenceRefs: string[];     // 诊断证据引用或 INTENT 章节键
    }>;
  };

  // 只放实际参与判断的 Core Principle 稳定 ID。
  corePrincipleRefs?: string[];
}
```

与上一版草案的差异（均为删减，不新增职责）：

- **删除** `source.formationId / painRefs / diagnosisRefs`：PD 没有 Formation 实体；候选链身份是 `candidateId`，Pain 与诊断来源已由 V1 的 `evidenceSource` 与产物 lineage 承载。
- **删除** `principleIntent.*`：V1 的 `ownerIntent / targetBehavior / forbiddenBehavior` 已经分别是目的、目标行为与禁止行为的唯一权威，另建一套会形成第二个真相。
- **删除** `validation.*`：V1 的 `validationExpectation` 已是验证字段，Evaluator 正在消费它；`observableSignals` 属于重复定义。
- **保留并最小化** `strategicIntent`（引用）与 `strategicAssessment`（判断），以及 `corePrincipleRefs`。

持久化位置不变：仍写在 Scribe 产物 `contentJson.intentContract` 中（现有位置、现有校验器扩展点），**不新增表、不新增存储、不迁移历史数据**。

实施时必须复用现有数据类型、References 和 Schema 验证机制。

如果现有字段能够表达相同语义，不要重复定义。

## 8.3 字段职责

每个事实只保留一个权威位置。下表是本次修订后的唯一口径：

| 事实 | 唯一权威字段 | 不再新增的重复字段 |
|---|---|---|
| 这条原则要达成什么、禁止什么 | V1 `ownerIntent` / `targetBehavior` / `forbiddenBehavior` | `principleIntent.*` |
| 依据哪份 Intent（版本与章节） | `strategicIntent.contentHash` / `capturedAt` / `relevantSections` | `source.formationId`、`source.strategicIntent.versionId` |
| 战略相关性判断与理由 | `strategicAssessment.relevance` / `rationale` | 另一个 relevance 枚举 |
| 双锚点冲突及双方定位 | `strategicAssessment.conflicts[]` | `conflictStatus` + 平行数组 `conflictEvidenceRefs` |
| 如何验证行为 | V1 `validationExpectation` | `validation.observableSignals` / `failureConditions` |
| 依据的真实证据 | V1 `evidenceSource` + 产物 lineage | `source.painRefs` / `source.diagnosisRefs` |

### Strategic Intent 引用

记录：

- `contentHash`：Stage A 服务端捕获的内容哈希（不接受模型填写）。
- `capturedAt`：Stage A 读取时刻。
- `intentVersionId`（可选）：仅当能关联到现有 `IntentDocVersionStore` 记录。
- `relevantSections`：只允许 `why / desired_outcome / non_negotiables / stop_escalation / current_strategic_focus` 五个键——与现有 `IntentRelatedFieldSchema` 保持同一枚举，避免出现无法定位的"章节字符串"。

不要求为了本次任务建立新的 Core Principle Version System。

如果现有注册表已有版本标识，直接引用。

如果没有，先复用稳定 ID 和现有版本信息，不要为此重构十个核心原则。

### Strategic Assessment

记录：

- `relevance`：四态之一；`not_configured` 由代码派生（开关关闭或文档不可读），其余三态来自 Stage A 判断。
- `rationale`：为什么相关或不相关；不得写成 Upstream Intent 的复述。
- `conflicts[]`：每一项同时给出 `against`（对 Core Principle 还是对 Owner Intent）、`ref`（具体 principleId 或章节键）、`status`、`evidenceRefs`，因此可以定位冲突双方，而不是只给一个状态字符串。

不能用自然语言解释替代真实 Evidence References。

### Core Principle References

记录实际参与本条判断的 Core Principle 稳定 ID。

未参与判断的原则不得为了"看起来完整"而列入。

### 行为与验证

行为要求与验证要求继续由 V1 字段承载，V2 不复制：

- `ownerIntent`：Owner 想防止或达成什么。
- `targetBehavior` / `forbiddenBehavior`：目标行为与禁止行为。
- `validationExpectation`：Evaluator 判断一条规则是否忠实的依据（现已被 Evaluator 消费，不得另建第二套验证字段）。

不要求增加独立的行为评估平台。

## 8.4 V1 兼容

必须支持现有 V1 Contract。

规则：

1. 新形成的原则使用 V2。
2. 历史 V1 保持原样。
3. V1 不得被静默升级或伪造战略来源。
4. 旧数据继续可读。
5. 下游如果需要 V2，使用最小兼容 Adapter。
6. 不要求批量迁移历史原则。

实施前必须先核实所有 V1 消费者。

不得只修改 Scribe 而遗漏 Artificer、Evaluator 或其他实际消费者。

---

# 9. 内部化阶段的最小改造

本次不是重新设计 Dreamer、Philosopher 和 Scribe。

只补齐它们对战略锚点的输入、判断和结果传递。

## 9.1 Diagnostician

职责：

- 继续完成原有 Pain 根因诊断。
- 获取本次形成任务的 Intent Snapshot。
- 评估 Pain 与战略意图的相关性。
- 保留相关战略章节和证据。
- 保留现有 intentTension。

ABC 阶段不得丢失已经形成的战略依据。

不得在每个阶段重新读取 Intent 文档。

## 9.2 FormationContext

这是本次关键的代码连接点之一，但它是**既有投影的扩展**，不是新对象。

现状（`formation-context.ts`）：

- `FormationContext` 已包含 `dreamerProposals`、`dreamerContextRefs`、可选 `sourceDiagnosis`、`provenance`、`truncationNotes`。
- `sourceDiagnosis` 的投影（`projectDiagnosisOutput`）当前只读 `rootCause / summary / violatedPrinciples / evidence / recommendations / confidence`，**不读 `intentTension`**——这正是战略信息在 Stage A 之后丢失的位置。
- 序列化总预算 `FORMATION_TOTAL_MAX_CHARS = 8000`；超预算时的降级阶梯会把 `sourceDiagnosis` **整段丢弃**，并写入 `truncationNotes`。

因此本次只做两处连接：

1. 在 `sourceDiagnosis` 投影中透传 Stage A 的 `intentTension`（含 `relatedIntentFields / evidence / explanation / evidenceStrength / intentDocHash`），作为读取战略信息的唯一入口。
2. 在 `provenance` 中增加战略快照引用（`contentHash` / `capturedAt` / 可选 `intentVersionId`）。放在 `provenance` 而不是新增顶层块，是因为它属于身份信息而非内容，且现有降级阶梯不会丢弃 `provenance`（只会截断其中的 `lineageArtifactIds`）；但消费方仍必须按"可能不存在"处理，因为历史产物没有该字段。

`FormationContext` 必须能够提供：

- 战略快照引用（可缺失）。
- Stage A 形成的 Intent Tension（可缺失）。
- 现有 Pain 和诊断证据。
- 现有 Core Principle 上下文。

优先级与降级要求：

- 任何读 `sourceDiagnosis` / 快照引用的阶段，必须先处理"字段不存在"的情况，并按 rc-9 给出可观察的降级理由（不得静默当作"无战略关联"）。
- 不新增顶层 `StrategicContext` 对象，不重复 `dreamerProposals[].strategicPerspective`（该字段在 `DreamerOutputV1` 中已存在且必填）。

不新建第二套 FormationContext。

## 9.3 Dreamer

Dreamer 必须能够考虑：

- 当前 Pain。
- 诊断结果。
- Owner Strategic Intent 相关内容。
- 十个核心原则及现有相关原则上下文。

职责：

生成能够解决当前问题，同时考虑长期战略方向的候选原则。

输出需要包含简洁的战略依据或不适用理由。

不要求生成冗长的战略分析报告。

## 9.4 Philosopher

职责：

- 判断候选原则是否具备长期可复用性。
- 检查与 Core Principles 的关系。
- 检查与 Owner Strategic Intent 的关系。
- 识别可能的长期副作用。
- 识别潜在冲突。

输出必要的判断结果和证据。

不重新设计 Philosopher 的整体推理流程。

## 9.5 Scribe

这是本次最重要的改造点。

Scribe 必须：

1. 接收固定的 Strategic Intent Snapshot。
2. 接收 Diagnostician 的最终结果。
3. 接收 Dreamer 的候选原则。
4. 接收 Philosopher 的判断。
5. 接收现有 Core Principles 上下文。
6. 形成正式原则。
7. 生成 IntentContract V2。

Scribe 必须将战略来源和判断结果落实到 Contract。

不得：

- 重新读取最新 Intent。
- 自行修改战略内容。
- 伪造证据。
- 静默消除冲突。
- 为了满足 Schema 编造关联。

## 9.6 RolloutReviewer

只做必要的 Contract 审查扩展，并且只承担它能拿到的输入。

现状：RolloutReviewer 的上下文由 `buildContext()` 沿 `dependencyTaskIds` 解析被评审产物得到，输入是原则/规则产物本身，**拿不到 Stage A 的 INTENT 原文与诊断产物**。因此不能要求它校验内容 Hash。

审查职责按"语义 / 确定性"划分：

RolloutReviewer（语义复核）：

- Contract 结构是否完整、行为字段是否自洽。
- Strategic Relevance 的结论与 `rationale` 是否一致、是否有对应 `relatedIntentFields`。
- 目标行为与原则声明是否一致。
- 是否存在尚未处理的冲突（`conflicts[]` 中 `potential` / `confirmed`）。
- Evidence References 是否能定位到本轮上下文中的真实证据。

确定性校验器（Stage A / Scribe 的现有校验路径）：

- `contentHash` 是否等于 Stage A 捕获值。
- `intentDocHash` 是否与捕获值一致；不一致时记录 `intent_hash_mismatch` 并将该条判断降级为 `insufficient_evidence`（不静默改写、不阻断整条链）。
- 引用枚举是否落在允许集合内（章节键只能是五个固定键）。

不重新设计整个 RolloutReviewer。

## 9.7 Artificer  Evaluator

只做必要的 V2 兼容。

Artificer：

- 读取正式行为契约。
- 生成符合目标行为和禁止行为的 RuleCode。
- 保留现有权限和安全约束。

Evaluator：

- 根据 Contract 检查 RuleCode。
- 确保目标行为得到实现。
- 确保禁止行为没有被引入。

不重写 Artificer 或 Evaluator。

不修改已经有效的 RuleHost 执行机制。

---

# 10. 双锚点冲突治理

## 10.1 冲突原则

当 Owner Strategic Intent 与 PD Core Principles 发生实质冲突：

- 不自动覆盖。
- 不自动折中。
- 不静默忽略。
- 保留双方原始依据。
- 进入 Owner Review。

系统级不可绕过的安全约束始终不能被 Owner Intent 覆盖。

## 10.2 冲突处理粒度

冲突作用的对象是**候选链上的原则产物**，身份是 `candidateId` / `artifactId`，不是"Formation"。

现状事实：

- 一次诊断可以产生多个候选；`principle_candidates` 一个候选一行，各自有独立 `candidate_id`。
- 审批记录按产物（artifactId）记录；审批分组模型按候选血缘分组，并且**per-record** 计算 `approveBlock`（现有 6 个 block code），同组中一条记录被阻断不会围栏住兄弟记录。

因此：

- 冲突只阻断受影响的那一条候选 / 产物，其他候选继续正常定稿与激活。
- **不新增候选级冲突状态机**：用现有 `approveBlock` 机制表达"该记录当前不可审批"，并附带 `reason` 与 `nextAction`；建议新增一个 block code（如 `strategic_conflict_unconfirmed`），由服务端审批预检与卡片读取同一判定。
- 需要 Owner 裁决时，走现有 Owner Decision / Approval 与 `intent_decisions` 记录，不新建冲突审批表。

不得因为一个候选冲突而无条件阻断整条候选链或整个形成批次。

## 10.3 Owner Review

使用现有 Owner Review 和 Decision 机制。

向 Owner 展示：

- 原始 Pain。
- 对应诊断证据。
- Owner Strategic Intent 版本。
- 相关战略章节。
- 涉及的 Core Principle。
- 候选原则。
- 冲突原因。
- 处理建议。

Owner 可以：

- 要求修改候选原则。
- 修改自己的战略意图。
- 拒绝候选原则。
- 保留待处理状态。

Owner Decision 不得用于绕过系统级安全约束或降低 Core Principles 的系统保护等级。

## 10.4 冲突解决后

修改候选原则后必须重新进行相关检查。

如果修改了 Owner Strategic Intent：

- 新任务使用新版本。
- 已有 Snapshot 不变。
- 不能直接修改旧 Contract 的战略来源。

冲突处理和审批结果继续使用现有 Decision  Approval 记录。

---

# 11. Owner Review 产品要求

本次只完成核心体验，不重新设计整个 PD Console。

现有机制（本次直接复用，不新建审批入口、不新建冲突流程）：

- `intent_decisions` 表 + `/api/intent-decisions` 路由：已有 `painId / taskId / runId / intentDocHash / source / evidenceStrength / relatedIntentFields / ownerAction / evidenceRefs`，幂等键为 `painId + intentDocHash + ownerAction`，并有 follow-up 回写（`IntentDecisionRecord`）。
- 审批分组模型（`ApprovalsGroupedConsoleModel`）：按候选血缘分组、per-record 阻断码、`artifactDigest` 修订复核。
- 本次只把"战略依据"作为**读取与展示**补充到这些既有视图上。

在现有原则审查或形成结果页面中，能够看到：

1. 原则内容。
2. Strategic Relevance。
3. Strategic Intent 来源和版本。
4. 相关章节。
5. Core Principle References。
6. Pain  Diagnosis References。
7. IntentContract V2。
8. 冲突信息。
9. 现有 Owner Decision  Approval。

如果没有配置 Intent：

明确显示未配置，不影响现有普通原则形成流程。

如果没有战略关联：

明确显示 Not Applicable。

如果证据不足：

明确显示 Insufficient Evidence。

不增加独立的 Goal 管理后台或战略分析仪表盘。

---

# 12. Feature Flag 和开放策略

**结论：复用 `intent_engineering` 作为唯一开关，本次不新增第二个 Flag。**

现状：

- `intent_engineering` 在 Feature Flag 契约中是 `quiet` 类别、默认 `false`；其定义明确写着 "flag-off = no INTENT read, no prompt injection, no intentTension"。
- 同一个开关同时控制两件事：① Diagnostician Stage A 读取 INTENT.md 并产出 `intentTension`；② 宿主 prompt 的 INTENT friction block 注入。
- 读取端口在开关关闭时直接返回 `flag_disabled`，且不访问文件系统。

接受的耦合（MVP 约束）：

- 关闭 `intent_engineering` = 战略锚定与原始注入一起关闭，这是已知且可接受的行为，不在本次拆分。
- 若未来需要"只关闭注入、保留战略形成"，再单独评估（记录为 follow-up，不纳入本次实现）。

要求：

1. 不新增独立开关，不改造 Feature Flag Registry。
2. 开关关闭时：不读取 INTENT、不产出 `intentTension`、Contract 只含 V1 五字段；原则形成、审批、激活全部照常。
3. 开关打开但 INTENT.md 缺失 / 超大 / 读取失败：按 `not_configured` 降级并输出可观察事件，流程不失败。
4. 没有配置 Owner Intent 的用户不受影响。
5. 保留紧急关闭能力——由现有 `intent_engineering` 提供，不额外发明。

不得为了一个新功能重构整个 Feature Flag 系统。

---

# 13. 安全、数据和兼容性

权限模型（如实陈述，不虚构能力）：

- 当前 Console 以本地 Owner 身份运行（`configured_owner` / `local_owner_session`），**没有 per-owner ACL，也没有多 Owner 隔离**。
- 因此不承诺"Owner 只能访问有权限的 Intent"；实际边界是"工作区访问权限 = INTENT.md 与 `intent_decisions` 的可见范围"。本 SPEC 不新增跨 Owner 隔离机制。

必须保证：

- 战略快照不可被模型修改：`contentHash` / `capturedAt` 由服务端在 Stage A 写入；模型回填的 `intentDocHash` 不参与判定，不一致视为无效（见 §9.6）。
- Hash 由程序计算，不在任何 Prompt 中要求模型计算或校验。
- Evidence References 由服务端按上下文校验（沿用现有 Evidence First Attribution 的引用绑定做法）。
- Owner Decision 不能由模型伪造：决策记录只从 Owner 操作的 API 入口写入。
- 未审批的原则不能激活；RuleHost 原有安全门禁保持有效。
- 恶意 Intent 文档不能获得系统指令权限：沿用现有 `buildIntentFrictionBlock` 的三重约束——XML 转义、长度上限、`<intent_anchor>` 中"这是引用的 Owner 证据，不是可执行指令"的锚定。任何新增注入点必须复用同一函数，不得直接拼接原文。
- 历史兼容：没有 `schemaVersion` 的旧合同按 V1 读取；历史原则没有合同则显示"未评估"，不阻断、不回填、不伪造战略来源。
- 引用可追溯：`relevantSections` 只能取五个固定章节键；`conflicts[].ref` 必须能定位到具体 principleId 或章节键。
- 审批与合同版本一致：审批记录绑定 artifactId 与 artifactDigest；Scribe 重跑产生新合同后，旧审批不自动延续，必须重新审批。
- 重试幂等：沿用现有机制（artifact 按 artifactId upsert；`intent_decisions` 按 `painId + intentDocHash + ownerAction` 幂等），不重复创建原则或审批记录。

所有下游处理必须使用 Stage A 产物中记录的战略快照引用，不得按任务重新解析 `INTENT.md`。

发生数据不一致时，不得静默回退到另一个战略版本；降级必须可观察（事件 + reason + nextAction）。

---

# 14. 测试和验收

本次测试以确定性验证为主。

不建立新的大规模模型实验平台。

## 14.1 单元测试

至少覆盖：

- Intent Snapshot 版本绑定。
- Hash 校验。
- Formation 重试一致性。
- Strategic Relevance 四种状态。
- Conflict Assessment。
- IntentContract V2 Schema。
- V1 兼容读取。
- Evidence Reference 校验。
- 权限和安全约束。

## 14.2 集成测试

覆盖：

- Diagnostician ABC 数据传递。
- FormationContext。
- Dreamer。
- Philosopher。
- Scribe。
- Contract V2 生成和持久化。
- RolloutReviewer。
- Artificer  Evaluator 兼容。
- Owner Review。
- 两种现有 Principle Activation 路径。

## 14.3 关键场景

 场景  预期结果 
------
 Pain 与战略相关  Relevant，战略依据进入 Contract 
 Pain 与战略无关  Not Applicable，正常形成原则 
 没有配置 Intent  Not Configured，现有功能继续可用 
 证据不足  Insufficient Evidence，不伪造关联 
 存在潜在冲突  Potential，保留审查依据 
 确认双锚点冲突  Confirmed，相关候选进入 Owner Review 
 修改 Intent  当前 Formation 使用原版本 
 历史 V1 Contract  正常兼容 
 恶意 Intent 内容  不获得系统指令权限 
 未审批原则  禁止激活 

## 14.4 真实宿主验收

必须使用隔离测试环境。

至少完成：

认知原则路径

```text
Pain
→ Intent Snapshot
→ Principle Formation
→ IntentContract V2
→ Owner Approval
→ Principle Activation
→ Host Prompt
→ Runtime Evidence
```

RuleCode 路径

```text
Pain
→ Intent Snapshot
→ Principle Formation
→ IntentContract V2
→ Owner Approval
→ Artificer
→ Evaluator
→ RuleCode Activation
→ Host Runtime
→ Runtime Evidence
```

验收目标：

- 数据确实传递。
- 版本确实一致。
- Contract 确实生成。
- Owner 能够正常审查和审批。
- 正式原则能够激活。
- RuleCode 能够正常执行。
- Runtime Evidence 能够追溯到 Principle 和 Contract。

使用现有测试设施，不为本次任务新建测试平台。

不要求大规模 Prompt 对照实验。

不要求证明长期行为已经完全对齐。

---

# 15. 开发范围和优先级

## P0：必须完成

1. 最新源码 Preflight。
2. Strategic Intent Snapshot。
3. Diagnostician 到 FormationContext 的数据传递。
4. Dreamer 战略上下文消费。
5. Philosopher 双锚点审查。
6. Scribe 生成 IntentContract V2。
7. V1 兼容。
8. 双锚点冲突治理。
9. RolloutReviewer 必要扩展。
10. Owner Review 最小体验。
11. Artificer  Evaluator 必要兼容。
12. 两种现有原则路径的真实宿主验收。
13. Feature Flag 必要调整。
14. 用户使用说明。

P0 的重点是完整交付上述核心能力，而不是重构所有相关模块。

## P1：开放后迭代

- Intent 历史版本可视化。
- 战略关联查询。
- Owner Review 高级筛选。
- 历史原则战略关联展示。
- Examiner 长期趋势分析。
- 更丰富的战略效果评估。

## 不纳入本次

- 独立 Goal Engine。
- 独立 Memory 系统。
- 第二套 Principle Formation Pipeline。
- 第二套 IntentContract 审批系统。
- 第二套 RuleHost。
- 十个核心原则重构。
- Examiner 产品化重构。
- 大规模模型评估平台。
- 自动战略修改和自动目标重规划。
- 与本次目标无关的 UI 和架构重构。

---

# 16. Definition of Done

以下条件全部满足才能宣布完成。

 验收项  标准 
------
 源码核查  已基于最新 HEAD 完成 
 Snapshot  版本固定、Hash 可验证 
 数据传递  ABC 到 Scribe 完整 
 双锚点  Core Principles 与 Owner Intent 共同参与 
 Dreamer  能够消费战略上下文 
 Philosopher  能够识别战略一致性与冲突 
 Scribe  生成 V2 Contract 
 V1  历史数据兼容 
 Conflict  只阻断受影响候选 
 Owner Review  能够查看依据并处理冲突 
 Artificer  正确消费 V2 
 Evaluator  正确验证 V2 行为要求 
 Cognitive Path  真实宿主激活通过 
 RuleCode Path  真实宿主执行通过 
 Security  原有安全边界保持有效 
 Tests  确定性测试通过 
 Browser  真实浏览器操作验收通过 
 Docs  用户和配置说明完成 
 Audit  提供完整交付报告 

---

# 17. 本地 AI 实施纪律

本节是本次开发的强制约束。

## 17.1 先核实，后修改

Preflight 结束后直接进入实施。

不得无限扩大审计范围。

不得反复重新研究已经确认的架构决策。

## 17.2 优先修改现有模块

每增加一个新模块、新类型或新存储结构，必须先确认：

现有模块为什么不能满足需求？

如果没有明确理由，不允许新增。

## 17.3 禁止范围扩张

发现问题时分级：

- P0：数据、安全或核心链路阻断，必须修复。
- P1：核心用户旅程无法完成，必须修复。
- P2：体验和非阻塞优化，记录到后续迭代。
- 新需求：不纳入本次任务。

不允许因为 P2 问题重新设计整体架构。

## 17.4 禁止无休止实验

允许：

- 单元测试。
- 集成测试。
- Schema 测试。
- 有限真实宿主验收。
- 针对已发现缺陷的修复。

禁止：

- 无限轮次模型对照。
- 不断扩大实验数据集。
- 为追求模型文字一致而反复重构 Prompt。
- 把长期行为对齐证明作为发布前置条件。

## 17.5 不允许虚报完成

以下都不能单独作为完成依据：

- Schema 已建立。
- Prompt 已修改。
- CI 已通过。
- 数据库迁移成功。
- 页面已经显示战略意图。
- Scribe 已经生成 Contract。

必须验证真实形成、Owner 审批、原则激活和宿主运行链路。

## 17.6 交付纪律

- 使用最新 main。
- 保留现有工作区的未提交修改。
- 不覆盖其他正在进行的工作。
- 提供 Commit 和 PR。
- 不擅自合并或部署。
- 所有未完成项必须如实披露。

---

# 18. 最终交付

本地 AI 最终提供：

1. Preflight 源码核查结果。
2. 实际改造文件清单。
3. IntentContract V2 说明。
4. Snapshot 和版本一致性说明。
5. 形成管道数据流说明。
6. Owner Review 操作说明。
7. Feature Flag 说明。
8. 自动化测试报告。
9. 浏览器验收报告。
10. 认知原则真实宿主验收报告。
11. RuleCode 真实宿主验收报告。
12. 安全和兼容性报告。
13. Commit。
14. Pull Request。
15. Owner Review Card。

---

# 19. 最终产品定义

本次任务完成后：

Owner 可以定义自己的长期目标和战略意图。

PD 将 Owner Strategic Intent 与十个系统核心原则共同作为战略锚点。

当真实 Pain 出现时，PD 不再只关注眼前问题，而是能够理解问题与 Owner 长期方向之间的关系。

Dreamer、Philosopher、Scribe 使用一致的战略依据，形成符合真实证据、系统原则和长期方向的行为原则。

IntentContract 将这些依据转化为可追溯、可验证的行为要求。

经过 Owner 审批后，原则通过现有认知原则或 RuleCode 机制激活，最终影响宿主行为。

最终交付的不是一个更复杂的 Intent 管理器，而是一条真正连接人类长期战略方向与 Agent 长期行为治理的原则形成机制。

---

END OF SPEC v1.1

---

# 修订记录（2026-11-14）

> 依据：PD-SIA 架构评审（只读）＋ 对 `origin/main`（6bc0874a）源码的逐项复核。本次只修订文档，不改代码。
> 计数口径：`rg` 在 `packages/*/src` 下匹配符号，排除 `__tests__` / `.test.ts`。

| # | 章节 | 审查发现 | 改了什么 | 依据（代码语义位置） |
|---|---|---|---|---|
| 1 | §5 | 图中假设存在 "Formation Intent Snapshot" 与 Formation 聚合 | 改为真实链路：Stage A 读取→产物携带快照→B/C 透传→candidateId 链；补充名词说明（无 Formation 实体，不引入 FormationIntentBinding） | 全仓无 `CREATE TABLE ... formations`；候选身份见 `internalization/candidate-identity.ts`、`store/commit/diagnostician-committer.ts`（写 `principle_candidates`） |
| 2 | §6.2 | "在 Formation 开始时绑定版本"在代码中没有落点 | 改为在 Stage A 读取时捕获 `contentHash + capturedAt` 并写入 Stage A 产物；`intentVersionId` 降为可选 | `diag-rootcause-runner.ts:198` 是 `readIntentDoc()` 唯一生产调用点；`intent-doc-reader-port.ts:31-38` 只返回 raw/contentHash/path |
| 3 | §6.2 | 担心"历史版本无法恢复完整内容" | 明确现有版本记录含完整内容，无需复制原文或迁移 | `intent/intent-doc-version.ts:3-17`（`IntentDocVersion.contentSnapshot` + `getVersion`） |
| 4 | §6.4 | 引入了并不存在的 "Formation 启动时间" | 只保留三个时间：Pain `occurredAt`（可选）、捕获/记录时间、Stage A `capturedAt` | `context-payload.ts:144`（`occurredAt: Type.Optional(...)`） |
| 5 | §6.5 | 下游重试会重读最新 Intent 的担忧未被约束 | 写明只有 Stage A 自身重试会重读；下游重试只读上游已成功产物 | `diag-router-runner.ts:848-874`（Stage C additive passthrough，不生成） |
| 6 | §7.1 | relevance 由谁判定、`not_configured` 如何产生未定义 | 指定 Stage A 为唯一判定点；`not_configured` 由代码派生；明确 `intentTension.source` ≠ relevance | `diag-rootcause-output.ts:70-111`（source / relatedIntentFields 枚举）；`intent-doc-reader-port.ts:46-50`（`flag_disabled/not_found/oversized/read_error`） |
| 7 | §8.2 | V2 重构了 V1 语义（`source` / `principleIntent` / `validation`），会破坏现有消费者与 Artificer 预检 | 改为 `extends IntentContractV1`，V1 五字段逐字保留，只追加 `schemaVersion / strategicIntent? / strategicAssessment? / corePrincipleRefs?` | `internalization/intent-contract.ts:40-64`（只校验五个非空字符串、不拒绝额外键）；`artificer-intent-preflight.ts:538-549`（合同缺失即阻断） |
| 8 | §8.3 | `source` 与 `strategicAssessment` 职责重叠；`principleIntent.rationale` 与 Owner Intent 混淆；`observableSignals` 重复 | 增加"一事一权威"字段表；`relevantSections` 限定五个固定键；`conflicts[]` 用 `against/ref/evidenceRefs` 定位双方 | `diag-rootcause-output.ts:102-108`（五个 relatedIntentField）；`context-payload.ts` 与 V1 `validationExpectation` 已被 Evaluator 消费 |
| 9 | §9.2 | 把 FormationContext 当作"新建上下文对象"，且未注意诊断投影不读 `intentTension`、预算会整段丢弃诊断 | 改为"既有投影扩展"；指出 `projectDiagnosisOutput` 不读 `intentTension`；写明 8000 字符上限与诊断整段丢弃路径 | `formation-context.ts:363-445`（投影字段）、`:66`（`FORMATION_TOTAL_MAX_CHARS = 8000`）、`:595-606` 与 `:675-683`（整段丢弃） |
| 10 | §9.6 | 要求 RolloutReviewer 校验 Hash，但其输入不含 INTENT 原文与诊断产物 | 拆成"Reviewer 语义复核"与"确定性校验器校验 hash"；补 `intent_hash_mismatch` 降级 | `rollout-reviewer-runner.ts:425-499`（`buildContext` 只解析被评审产物）；全仓无对 `intentDocHash` 的服务端比较 |
| 11 | §10.2 | "Formation 级审批 / 只阻断一个候选"与现状不符 | 改为候选/产物粒度；复用 per-record `approveBlock`，不新增状态机 | `pd-console/src/server/models/ApprovalsGroupedConsoleModel.ts:50-64,105-126`（block code + "a block ... must never fence its siblings"）；`principle_candidates` 一候选一行 |
| 12 | §11 | 未识别既有 `intent_decisions` 与审批分组机制 | 明确复用 `intent_decisions` / `/api/intent-decisions` / 审批分组，不新建审批入口 | `intent/intent-decision-record.ts:34-49,112-135`；`pd-console` 路由与分组模型 |
| 13 | §12 | 建议"解耦 flag / 新增独立开关"（评审建议），与 Owner 约束冲突 | 改为复用 `intent_engineering` 作为唯一开关，写明耦合与关闭降级 | `feature-flags/feature-flag-contract.ts:288`（quiet、默认 false、flag-off 语义）；`openclaw-plugin/src/hooks/prompt.ts:1185-1200`（注入受同一 flag 控制） |
| 14 | §13 | "Owner 只能访问有权限的 Intent"在现有实现中不成立；未覆盖注入、历史数据、审批 digest | 如实写单 Owner 模型；补充转义/上限/锚定约束、历史"未评估"策略、审批 digest 重审规则 | `intent/intent-friction-block.ts:81-110`（XML 转义 + 上限 + anchor）；`pd-console/src/server/index.ts:617-656`（本地 Owner 身份）；`approval-review-material.ts`（`targetBehavior` 从合同读取） |
| 15 | §9.1 | 残留 "本次 Formation" 指代 | 改为"本次形成任务" | 同 #1 |

未采纳的建议及原因：

- **新增独立 flag（`strategic_intent_anchoring`）**：Owner 明确要求不新增第二个 flag；且现有 `intent_engineering` 已是同一职责的唯一开关，拆分需要新增配置面与迁移，违反最小改造。
- **FormationIntentBinding 新结构**：系统中没有 Formation 实体，新结构没有承载者；Stage A 产物已能承载快照引用。
- **V2 全量字段重构**：会破坏 V1 五字段的既有 27 个生产文件消费者（`rg 'intentContract|IntentContractV1|extractIntentContract' packages/*/src --glob '!**/__tests__/**'` 计数），并使 Artificer 预检的 `intent_contract_missing` 判定语义漂移。