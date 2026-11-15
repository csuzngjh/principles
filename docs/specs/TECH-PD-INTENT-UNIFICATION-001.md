# TECH-PD-INTENT-UNIFICATION-001
# PD 战略意图统一与行为闭环技术方案

**Version:** 2.0  
**Related SPEC:** SPEC-PD-INTENT-UNIFICATION-001 v2.0  
**Status:** Proposed Technical Design  
**Priority:** P0  
**Implementation Strategy:** Extend Existing Architecture  
**Code Baseline:** `main @ 8ad7b7924a5edb2231486ef0ed99c2462ad78318`

---

# 1. 技术设计目标

本次不是重新开发一套 Intent 系统，而是让 Owner 的长期战略意图真正参与 PD 的原则形成、行为治理和宿主执行。

需要完成三个层次：

1. **战略理解：** Agent 能理解 Owner 的长期目标、当前重点和战略边界。
2. **原则内化：** 这些战略信息能够参与 Pain → Principle 的形成过程，并沉淀为正式行为原则。
3. **行为落实：** 通过现有 Cognitive Principle 和 RuleCode 机制，让宿主实际遵循这些原则。

最终链路：

```text
Owner Strategic Intent
        |
        v
     INTENT.md
        |
        v
    Pain Capture
        |
        v
 Diagnostician Stage A
        |
        v
 Strategic Intent Snapshot
        |
        v
 Diagnostician B/C
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
   Principle Statement
   IntentContract V2
        |
        v
    Owner Review
        |
        v
    Owner Approval
        |
        v
  +-----+----------------+
  |                      |
  v                      v
Cognitive Principle   RuleCode
  |                      |
  v                      v
Prompt Activation     RuleHost
  |                      |
  +----------+-----------+
             |
             v
         Host Behavior
             |
             v
          Examiner
             |
             v
       Runtime Evidence
```

核心要求：

**IntentContract V2 是战略来源与判断依据的正式记录，但不是最终的宿主行为执行载体。**

实际行为载体仍然是：

- Cognitive Principle：`principleDraft.statement`
- RuleCode：现有 IntentContract V1 行为字段及其生成、验证和执行机制。

---

# 2. 架构决策

## 2.1 必须复用的现有模块

| 能力 | 现有模块 | 处理方式 |
|---|---|---|
| Intent 管理 | IntentPageModel | 扩展 |
| Intent 文档解析 | intent-doc.ts | 扩展 |
| Intent 安全读取 | safeReadIntentDoc | 复用 |
| Intent Prompt 注入 | buildIntentFrictionBlock | 扩展 |
| Intent 版本记录 | SqliteIntentDocVersionStore | 复用 |
| 战略快照 | intent-snapshot.ts | 扩展 |
| Stage A | DiagRootCauseRunner | 扩展 |
| 上下文投影 | FormationContext | 复用 |
| Dreamer | DreamerRunner | 扩展 Prompt |
| Philosopher | PhilosopherRunner | 扩展 Prompt |
| Scribe | ScribeRunner | 扩展 |
| IntentContract | intent-contract.ts | 扩展 |
| 冲突治理 | strategic-conflict-gate.ts | 优化 |
| Owner 决策 | IntentDecisionStore | 复用 |
| Owner 审批 | SqliteApprovalStore | 复用 |
| Cognitive Activation | 现有 Activation | 不重构 |
| RuleCode | Artificer / Evaluator / RuleHost | 不重构 |
| 行为验证 | Examiner | 复用 |

## 2.2 明确禁止新增的架构

本次不新增：

- StrategicIntentService
- IntentSnapshotService
- FormationIntentBinding
- StrategicContextService
- IntentContractStore
- StrategicConflictManager
- StrategicApprovalService
- 第二套 Principle Formation Pipeline
- 第二套 Approval Pipeline
- 第二套 Intent 文档
- 独立 Goal 管理系统
- 新的后台调度系统

PD 已经拥有相应的运行时、存储和治理能力。

本次优先扩展现有实现。

## 2.3 唯一权威来源

继续使用：

```text
.principles/INTENT.zh-CN.md
.principles/INTENT.en.md
```

每次执行只使用当前选定语言的权威文档。

五个章节保持不变：

1. Why
2. Desired Outcome
3. Non-negotiables
4. Stop / Escalation
5. Current Strategic Focus

不新增 Goal.md、Strategy.md 或其他并行战略来源。

## 2.4 唯一 Feature Flag

继续使用：

```yaml
features:
  intent_engineering:
    enabled: false
```

当前默认值保持不变。

它继续控制：

- 宿主 Intent Friction Block 注入。
- Stage A Intent 读取。
- 战略快照生成。
- 下游战略锚定。

本次不新增第二个 Feature Flag，也不拆分开关职责。

---

# 3. 现有源码与实际改造范围

这是本次实施的关键部分。

不能把已经存在的能力再次开发一遍。

## 3.1 Intent 文档管理

涉及：

```text
packages/principles-core/src/runtime/intent/intent-doc.ts

packages/openclaw-plugin/src/core/intent-doc-reader.ts

packages/principles-core/src/runtime/intent/intent-friction-block.ts

packages/pd-console/src/server/models/IntentPageModel.ts

packages/pd-console/src/ui/pages/intent/IntentPage.tsx
```

现状：

- 支持五个章节解析。
- 支持中英文模板。
- 支持内容校验与警告。
- 支持部分内容保存。
- 支持版本记录。
- 支持安全 Prompt 注入。

需要补齐两个问题：

1. 默认模板内容目前可能被当成真实战略内容。
2. 部分填写状态缺少明确的战略可用性判断。

### 3.1.1 新增确定性模板识别

在现有 `intent-doc.ts` 中增加纯函数。

**章节 Key 不新增第四套命名空间。** 本节所有章节标识一律使用现有的文档字段名类型：

```ts
// 已存在于 intent-doc.ts，不新增类型
export interface IntentDocSections {
  why?: string;
  desiredOutcome?: string;
  nonNegotiables?: string;
  stopEscalation?: string;
  currentStrategicFocus?: string;
}
```

三个既有命名空间并存，通过一张显式映射表对接（不复制、不重命名）：

| `keyof IntentDocSections` | `IntentSnapshotSectionKey` | `IntentContractSectionKey` / `IntentRelatedField` |
|---|---|---|
| `why` | `why` | `why` |
| `desiredOutcome` | `desired_outcome` | `desired_outcome` |
| `nonNegotiables` | `non_negotiables` | `non_negotiables` |
| `stopEscalation` | `stop_escalation` | `stop_escalation` |
| `currentStrategicFocus` | `current_strategic_focus` | `current_strategic_focus` |

映射表必须由现有常量驱动（`INTENT_SNAPSHOT_SECTION_KEYS` 与 `INTENT_CONTRACT_SECTION_KEYS`），并对五个章节写完整映射测试；任何一侧新增章节而另一侧缺失，测试必须失败。

新增的只有状态类型与分析结果类型：

```ts
export type IntentSectionState =
  | 'authored'
  | 'placeholder'
  | 'missing';

export interface IntentSectionAnalysis {
  key: keyof IntentDocSections;
  state: IntentSectionState;
  content: string;
}

export function classifyIntentSectionContent(
  key: keyof IntentDocSections,
  content: string | undefined,
  lang: IntentLang,
): IntentSectionAnalysis;

export function analyzeIntentDocSections(
  sections: IntentDocSections,
  lang: IntentLang,
): IntentSectionAnalysis[];

export function deriveIntentDocState(
  analyses: readonly IntentSectionAnalysis[],
): 'not_configured' | 'partially_configured' | 'configured';
```

判断规则（确定性，自上而下第一条命中即生效）：

| 序号 | 内容 | 状态 |
|---|---|---|
| 1 | 章节不存在（`undefined`） | missing |
| 2 | 空白归一化后为空（含全角空格、`\u00a0`、零宽字符） | missing |
| 3 | 去掉模板问题行与 TODO/TBD/待填写噪声行后为空 | placeholder |
| 4 | 默认问题后面有 Owner 实际填写内容 | authored |
| 5 | 正常自定义内容 | authored |

实现约定：

- 模板问题行来自 `createIntentTemplate(lang)` 的对应章节，按行比较（归一化后精确匹配），支持中英文模板。
- TODO 噪声行：`TODO`、`TBD`、`FIXME`、`待填写`、`待补充`、`请填写`、`...`、`…`。
- 判断顺序不可交换：先判 missing，再判 placeholder，最后才是 authored。
- 识别必须是纯函数：无 I/O、无时钟、无随机、无 LLM。禁止用模型判断"这段是不是模板"。
- 空白归一化在比较前统一执行一次（`trim` + 连续空白折叠 + 去零宽字符），避免同一内容因排版差异得出不同结论。

特别注意：

如果用户保留了模板中的问题，同时在下面填写了答案，不能把整个章节判断为 placeholder（规则 4）。

#### 3.1.1.1 状态组合的唯一合法形态

| 组合 | 是否允许 | 说明 |
|---|---|---|
| `missing: true` + `text: ''` | 允许 | 章节缺失或空白 |
| `placeholder: true` + `text: <模板原文>` | 允许 | 保留原文以便审计，但不构成战略证据 |
| `missing: true` + `placeholder: true` | **禁止** | 二者互斥，校验函数必须拒绝 |
| `truncated: true` + `missing: true` | **禁止** | 已存在的现有约束，继续保留 |
| `truncated: true` + `placeholder: true` | 允许但无意义 | 模板内容达到 1200 字符上限；仍按 placeholder 处理，不构成证据 |
| `truncated: true` + 正文被截断且内容 authored | 允许 | 视为 authored，但必须发 `intent_snapshot_truncated` |

`missing`、`placeholder`、`truncated` 的语义边界：

- `missing`：文档里**没有**这一节的内容。
- `placeholder`：文档里有内容，但内容是模板/占位，不是 Owner 的判断。
- `truncated`：内容属于 Owner，但被服务端上限截断。

只有"既非 missing、又非 placeholder"的章节才是 `authored`，也才可能成为战略证据。

### 3.1.2 部分填写不构成错误

例如：

```markdown
## 1. Why

帮助 Agent 逐步形成长期稳定的自主行为能力。

## 2. Desired Outcome

What observable change should happen?

## 3. Non-negotiables

保护 Owner 的注意力，不以自动化覆盖率牺牲安全性。

## 4. Stop / Escalation

## 5. Current Strategic Focus

验证真实行为改善优先于扩大功能范围。
```

有效章节：

- why
- non_negotiables
- current_strategic_focus

无效章节：

- desired_outcome
- stop_escalation

系统应当：

- 读取三个有效章节。
- 不把默认问题注入为战略指令。
- 不强制用户填写剩余章节。
- 不将缺失章节交给模型补全。
- 不因为部分填写阻断 Pain → Principle。

### 3.1.3 Intent 可用状态

由现有解析结果派生三种状态：

| 状态 | 判断 |
|---|---|
| not_configured | 全部是模板或空内容 |
| partially_configured | 至少一个有效章节 |
| configured | 五个章节均有有效内容 |

不新增独立状态表。

UI 根据现有文档解析结果显示状态。

---

# 4. Intent Snapshot 技术方案

涉及：

```text
packages/principles-core/src/runtime/intent/intent-snapshot.ts

packages/principles-core/src/runtime/internalization/diag-rootcause-runner.ts

packages/principles-core/src/runtime/internalization/pitask-metadata.ts
```

## 4.1 复用现有 Stage A 快照机制

当前已经实现：

```text
读取 INTENT.md
     |
     v
计算 contentHash
     |
     v
构建 IntentSnapshot
     |
     v
写入 pi_metadata.intentSnapshot
     |
     v
CAS 成功
     |
     v
调用模型
```

继续使用这个机制。

不新增快照服务。

## 4.2 快照结构

保留现有 IntentSnapshot 结构，允许对章节状态进行兼容性扩展：

```ts
interface IntentSnapshotSection {
  key: IntentSnapshotSectionKey;

  text: string;

  truncated?: boolean;

  missing?: boolean;

  placeholder?: boolean;
}

interface IntentSnapshot {
  schemaVersion: 1;

  contentHash: string;

  capturedAt: string;

  intentVersionId?: string;

  lang: IntentLang;

  sections: IntentSnapshotSection[];
}
```

其中：

- `contentHash`：服务端计算。
- `capturedAt`：Stage A 读取时刻。
- `sections`：固定五个 key 的有界正文；`missing` / `placeholder` 章节也保留条目（`text` 可为模板原文），但**不构成战略证据**。
- `placeholder`：可选的兼容标记，与 `missing` 互斥。
- `missing`：章节缺失或空白。
- `intentVersionId`：**可选**。只有在 `SqliteIntentDocVersionStore.getLatest(lang).contentHash` 等于本次读取的 `contentHash` 时才填写；否则省略。禁止按 `contentHash` 反查版本（版本存储没有该索引），也禁止写入无法追溯的版本 ID。

旧快照没有 `placeholder` 字段时，**不按"原样可信"读取**，而是用同一套确定性规则重新识别：

```ts
// 纯函数，输入为快照自身的 lang + 各章节 text
deriveAuthoredSnapshotSectionKeys(snapshot): ReadonlySet<IntentSnapshotSectionKey>
```

规则：

1. `missing === true` → 非 authored。
2. `placeholder === true` → 非 authored。
3. 否则用 `classifyIntentSectionContent(KEY_TO_DOC_FIELD[key], text, snapshot.lang)` 重新判定；
   判定结果不是 `authored` 即视为非 authored。
4. 重新识别只影响"能否作为战略证据"，不改写、不回填、不删除已持久化的快照正文。

这条规则的目的：历史快照里可能保存着模板原文，直接信任它会把模板问题当成 Owner 意图。

## 4.3 模板文档处理

当所有章节都是模板或空内容：

```text
INTENT.md
    |
    v
模板识别
    |
    v
No Authored Sections
    |
    v
不产生有效战略快照
    |
    v
not_configured
```

记录可观察事件：

```text
intent_doc_template_only
```

不能把默认模板中的问题当作 Owner 的真实战略意图。

如果至少一个章节有效，则继续生成快照。

**模板-only 的执行后果（必须与 §4.5 一致）：**

1. `resolveIntentSnapshot()` 返回 `undefined`，**不持久化**快照（§4.4 的重试一致性只覆盖"已捕获"的场景）。
2. Stage A Prompt 不注入 `<intent_doc>`（不把模板问题当战略指令喂给模型）。
3. `composeArtifactContent()` 走"无快照"分支：删除模型提供的 `intentSnapshot` 与 `intentTension`。
4. 下游 `deriveStrategicRelevance()` 得到 `not_configured`，而不是 `insufficient_evidence`。
5. 模型自报的 `intentTension` 不能改变第 4 条的结论。

## 4.4 Stage A 重试一致性

保留现有 CAS 机制。

必须保证：

| 场景 | 行为 |
|---|---|
| 首次执行 | 捕获 Intent A 并持久化 |
| 模型调用失败 | 重试仍然使用 A |
| Owner 修改为 B | 已有任务不能切换到 B |
| 新建任务 | 读取 B |
| 快照损坏 | Fail Closed |
| CAS 竞争 | 采用成功写入的权威快照 |
| **Flag 关闭** | **不注入、不捕获、不产生新锚定；但已持久化的快照不删除** |
| **Flag 重新开启** | **同一任务恢复使用之前固定的快照，不重新读取最新 INTENT.md** |

这是 P0。

不能因为 Owner 修改了 INTENT.md，就让同一条候选链使用不同的战略依据。

### 4.4.1 Flag 判定顺序（修复 P1-1）

现状缺陷：`resolveIntentSnapshot()` 先返回已持久化快照，再检查 `intent_engineering`。结果是 flag 关闭后，历史快照仍会被注入 Stage A Prompt、仍会形成 `intentTension`、Scribe 仍会生成 V2 战略锚定——开关名存实亡。

规范顺序（`DiagRootCauseRunner.resolveIntentSnapshot()`）：

```text
1. 读取 intent_engineering（effectiveConfig）
2. flag off  → return undefined
              （不读诊断 JSON 里的历史快照，不读 INTENT.md，不发捕获事件）
3. flag on   → 读 pi_metadata.intentSnapshot
4. 持久化快照损坏 → fail closed（input_invalid）
5. 持久化快照有效 → 使用它
6. 无持久化快照 → 读 INTENT.md → 分类章节 → 无 authored 章节则 return undefined
                  → 有 authored 章节则 CAS 持久化后使用
```

要求：

- flag off 期间，**不得**为了"关闭开关"删除 `pi_metadata.intentSnapshot`；历史记录原样保留。
- flag off 期间，`invokeRuntime()` 必须得到 `intentDoc: undefined`，Prompt 与 flag 从未开启时字节一致。
- flag off 期间产生的 artifact 不得携带 `intentTension` 与 `intentSnapshot`（走 §4.5 的无快照分支）。
- 重新开启后，`step 5` 命中历史快照，因此同一任务的重试依据不变。

## 4.5 Hash 验证

现有 `composeArtifactContent()` 已经实现：

- 使用服务端捕获的 hash。
- 模型填写的 hash 不作为权威。
- Hash 不一致时丢弃不可信的战略判断。
- 发出 `intent_hash_mismatch`。

继续保留。

另外补充：

`intentTension.relatedIntentFields` 必须属于当前快照中真实存在的有效章节。

如果模型引用了不存在、空白或模板章节：

1. 不接受该章节引用。
2. 记录异常事件。
3. 不允许利用无效章节制造 `relevant` 结论。
4. 根据剩余证据降级为 `insufficient_evidence` 或 `not_applicable`。

### 4.5.1 执行点（修复 P0-1 的"说了但没做"）

上述规则不能只写在 SPEC 里，必须有唯一执行点。执行点是 **`DiagRootCauseRunner.composeArtifactContent()`**，即 artifact 落库前的最后一次服务端组装：

```ts
const authoredKeys = deriveAuthoredSnapshotSectionKeys(snapshot);      // 服务端确定性派生
const declared     = output.intentTension?.relatedIntentFields ?? [];  // 模型声明
const accepted     = declared.filter((k) => authoredKeys.has(k));      // 交集
const rejected     = declared.filter((k) => !authoredKeys.has(k));
```

- `declared.length === 0`：模型没有声明关联章节 → 正常的"无关联"语义（保留 `intentTension`，`relevance` 由 `relatedIntentFields.length === 0` 推导为 `not_applicable`）。
- `declared.length > 0 && accepted.length > 0`：只保留 `accepted`。`intentTension.relatedIntentFields = accepted`。发出 `intent_sections_rejected` 事件。
- `declared.length > 0 && accepted.length === 0`：**删除整个 `intentTension`**。这是唯一能让下游确定性地得到 `insufficient_evidence`（而不是 `not_applicable`）的方式，且不需要给 `intentTension` 增加字段（它的 schema 是 `additionalProperties: false`）。发出 `intent_tension_dropped_no_valid_sections` 事件。
- `snapshot` 不存在（含模板-only）：删除 `intentTension` 与 `intentSnapshot`（P0-2，见 §4.5.2）。

`intentSnapshot` 的落库内容同样经过服务端裁剪：

```ts
filterIntentSnapshotSections(snapshot, relatedKeys)
```

语义修订（原实现有缺陷）：

| 输入 | 旧行为 | 新行为 |
|---|---|---|
| `relatedKeys` 为空 | 返回完整 snapshot（含 missing/placeholder） | 返回**仅 authored** 章节的 snapshot |
| `relatedKeys` 非空，部分有效 | 只按 key 过滤，无效章节仍保留 | 只保留 `authored ∩ declared` |
| `relatedKeys` 非空，全部无效 | 同上一行（无效章节仍保留） | 返回 `sections: []`（**显式空**，不回退完整快照） |

区分"模型没声明"与"声明了但全部被拒绝"是硬要求。前者保留 authored 全量，后者必须显式为空，否则无效章节会经由"空数组回退完整快照"重新进入下游。

同理，以下函数必须排除 `missing` 与 `placeholder`：

- `intentSnapshotSectionsToDoc()`
- `projectIntentSnapshot()`（FormationContext 投影，见 §5.1）
- `renderIntentSnapshotDoc()`（Stage A Prompt 重建）

### 4.5.2 无快照时清除模型战略判断（P0-2）

`composeArtifactContent()` 在 `snapshot === undefined` 时必须：

- 删除模型提供的 `intentSnapshot`；
- 删除模型提供的 `intentTension`（**含** `relatedIntentFields` / `explanation` / `intentDocHash`）；
- 不保留任何模型提供的章节引用；
- 不允许模型自建战略锚点；
- 不允许形成基于不存在 Owner Intent 的 `confirmed` 冲突。

这适用于两种输入：flag 关闭，以及模板-only（§4.3）。后者归类为 `not_configured`，不得因为模型自报 `intentTension` 而变成 `relevant` 或 `confirmed`。

---

# 5. FormationContext 与原则形成链路

涉及：

```text
packages/principles-core/src/runtime/internalization/formation-context.ts

packages/principles-core/src/runtime/internalization/dreamer-runner.ts

packages/principles-core/src/runtime/internalization/dreamer-prompt-builder.ts

packages/principles-core/src/runtime/internalization/philosopher-runner.ts

packages/principles-core/src/runtime/internalization/philosopher-prompt-builder.ts

packages/principles-core/src/runtime/internalization/scribe-runner.ts

packages/principles-core/src/runtime/internalization/scribe-prompt-builder.ts
```

## 5.1 FormationContext

当前已经存在：

- sourceDiagnosis
- intentTension
- intentSnapshot
- provenance
- dreamerProposals

继续使用。

重点修正：

`projectIntentSnapshot()` 必须正确处理 `missing` 和 `placeholder`。

不能把模板章节或空内容作为有效战略依据传递给 Scribe。

具体做法（`formation-context.ts`）：

1. 读取快照携带的 `lang`（新快照必有；缺失时不做语言相关的重识别）。
2. 对每个 section：`missing === true` 或 `placeholder === true` → 丢弃。
3. 其余 section 若可确定 `lang`，再用 `classifyIntentSectionContent()` 复核一次；非 `authored` 同样丢弃。
4. 无任何 authored 章节时，投影结果为 `null`（不是"空对象"），调用方记入 `omittedFields`。
5. 投影只裁剪"是否作为战略证据"，**不删除** artifact 中的原始记录。

Scribe 组装 V2 时的作者章节集合必须与这里同源，不能各自实现一套判断。

保留现有 8000 字符上下文预算。

如果预算导致诊断正文被裁剪：

- 保留战略快照身份引用。
- 不伪造战略判断。
- 相关性证据不足时降级。
- 记录上下文裁剪事件。

不增加顶层 StrategicContext。

## 5.2 Dreamer

现有 Dreamer 已经能够读取 Diagnostician 的 predecessorOutput，并且 Prompt 已经要求：

- 参考 `intentTension`。
- 参考 `intentSnapshot.sections`。
- 同时考虑 Core Principles。
- 在 `strategicPerspective` 中解释战略关联。

本次只需要完善 Prompt 语义。

要求每个候选回答：

1. 是否推进 Owner 的长期目标？
2. 是否只是解决局部问题，却损害长期目标？
3. 是否存在合理的战略取舍？
4. 是否违反 Non-negotiables？
5. 是否违反 Stop / Escalation 条件？
6. 是否与 PD Core Principles 冲突？

不能将战略取舍直接认定为行为错误。

### 5.2.1 `strategicPerspective` 的权威等级（P1-4）

`strategicPerspective` 是**自由文本、advisory**：

- 它只承担候选推演的说明职责，帮助 Philosopher / Owner 理解候选与战略的关系；
- **不参与**服务端 relevance 派生；
- **不参与** confirmed 冲突验证；
- 不能被当作 Owner 战略意图的替代品，也不能被下游当作结构化字段解析。

服务端权威只有两个来源：Stage A 捕获的 `IntentSnapshot`，以及由服务端派生的 V2 `strategicAssessment`。

Prompt 中必须显式写出这条约束（`dreamer-prompt-builder.ts` 的 PROTOCOL 第 7 条之后追加一句）：

```text
strategicPerspective is ADVISORY prose for human review only. It never becomes a
relevance verdict, never confirms a conflict, and is never parsed as structured
strategic data. Stage A's snapshot and the server-assembled contract are the only
authoritative strategic basis.
```

不新增"战略分析服务"，也不为这条约束增加新的输出字段。

## 5.3 Philosopher

当前 `PhilosopherRunner` 已经通过 Dreamer 的依赖关系解析 Stage A 诊断产物。

继续使用：

```ts
resolveDiagnosisArtifact()
```

不新增依赖关系，不新增服务。

保留现有：

```ts
PHILOSOPHER_DUAL_ANCHOR_BLOCK
```

Philosopher 负责：

- 判断 Dreamer 的候选是否忠实于原始 Pain。
- 判断是否存在战略偏离。
- 判断是否存在 Core Principle 冲突。
- 解释候选背后的长期行为价值。
- 识别短期收益与长期战略之间的真实取舍。

注意：

Philosopher 可以质疑战略判断，但不能重新定义 Owner 的战略意图。

## 5.4 Scribe

Scribe 是本次原则内化的关键节点。

当前已经存在：

- `resolveFormationContext()`
- `strategicAnchoring`
- `assembleStrategicContract()`
- `assembleIntentContractV2()`

继续使用。

Scribe 必须生成两种不同性质的输出。

**第一种：正式行为原则**

```json
{
  "principleDraft": {
    "title": "...",
    "statement": "...",
    "rationale": "...",
    "applicability": [],
    "antiPatterns": []
  }
}
```

其中 `statement` 必须是可以执行的行为要求，包含：

- 触发条件。
- 必须采取的行动。
- 必要的 Owner 约束或例外。

不能只写一段战略理念。

**第二种：战略来源与判断契约**

```json
{
  "intentContract": {
    "ownerIntent": "...",
    "targetBehavior": "...",
    "forbiddenBehavior": "...",
    "evidenceSource": "...",
    "validationExpectation": "...",
    "schemaVersion": 2,
    "strategicIntent": {},
    "strategicAssessment": {},
    "corePrincipleRefs": []
  }
}
```

V1 五字段必须原样保留。

V2 负责增加战略依据、相关性、冲突和 Core Principle 引用。

V2 不能取代 V1。

---

# 6. 战略冲突分类与治理

涉及：

```text
packages/principles-core/src/runtime/internalization/intent-contract.ts

packages/principles-core/src/runtime/intent/strategic-conflict-gate.ts

packages/principles-core/src/runtime/intent/intent-decision-record.ts

packages/principles-core/src/runtime/store/intent/sqlite-intent-decision-store.ts

packages/principles-core/src/runtime/activation/sqlite-approval-store.ts

packages/pd-console/src/server/models/ApprovalsGroupedConsoleModel.ts
```

这是现有实现中需要重点优化的部分。

## 6.1 三类冲突必须分开

不再把所有冲突统一理解成需要硬阻断的战略冲突。

增加纯函数：

```ts
type StrategicConflictKind =
  | 'strategic_tradeoff'
  | 'owner_boundary_violation'
  | 'core_principle_conflict';

function classifyStrategicConflict(
  conflict: IntentContractConflict,
): StrategicConflictKind;
```

根据现有 `against` 和 `ref` 确定性派生，不增加持久化字段。

分类规则：

| 类型 | 判断依据 | 治理方式 |
|---|---|---|
| strategic_tradeoff | Owner Intent 的 `why` / `desired_outcome` / `current_strategic_focus` | 允许 Owner 用 `confirm_drift` 明确接受本次取舍 |
| owner_boundary_violation | `non_negotiables` / `stop_escalation` | **不能被普通 `confirm_drift` 豁免**；必须修改候选使其重新符合边界，或 Owner 修改战略意图后重新形成候选 |
| core_principle_conflict | `against: core_principle` | **不能被任何 Owner Intent Decision 豁免**；阻断当前候选晋级 |

"普通战略取舍"的章节集合是封闭的，只有三个：`why`、`desired_outcome`、`current_strategic_focus`。

`non_negotiables` 与 `stop_escalation` 不属于普通取舍，不得出现在 `confirm_drift` 的可解决集合里。

### Strategic Trade-off

例如：

Owner 当前希望优先验证真实市场需求。

Agent 提议先花时间完善架构。

这可能是战略取舍，不一定是错误。

处理：

- 显示冲突原因。
- 显示支持证据。
- 提供建议。
- 不自动阻断正常任务。

Stage A 的 `healthy_tension` 应保留为正常战略张力，不能直接转化成 `action_drift`。

### Owner Boundary Violation

例如：

- 为了提高效率牺牲明确要求保护的数据安全。
- Agent 在 Owner 明确要求停止时继续扩大范围。
- Agent 在必须询问 Owner 的情况下自行作出不可逆决定。

处理：

- 要求明确指出对应章节。
- 必须有真实证据引用。
- 未经确认不能直接作为已确认冲突。
- **已确认的 `non_negotiables` 违反**：阻断审批。解除条件只有两个：候选被修改为不再违反边界，或 Owner 修改战略意图并基于新版本重新形成候选。
- **已确认的 `stop_escalation` 触发**：阻断审批，走升级路径；同上，不能用 `confirm_drift` 放行。
- 不匹配则拒绝。

其中：

- `non_negotiables`：已确认的违反应阻断审批，直到候选本身被修正或 Owner 修改意图。
- `stop_escalation`：触发停止或升级；`confirm_drift` 不是升级，不能作为继续执行的理由。
- 实际运行时的硬执行约束仍然必须通过 Owner 批准的 RuleCode 落地，不能直接把 Markdown 当作运行时权限规则。

### Core Principle Conflict

例如：

新原则鼓励 Agent 为了快速完成任务而跳过证据核查，但与 T-03 Evidence Over Assumption 冲突。

处理：

- 明确指出 Core Principle ID。
- 保留冲突证据。
- 不能通过 `confirm_drift` 将系统级原则冲突直接豁免。
- **必须阻断当前候选晋级**。解除条件只有"重新形成同时满足两个锚点的候选"。
- 代码注释/文档中如提到"既有核心原则治理机制"，必须给出真实存在的实现位置与调用路径；当前仓库**没有**第二套 Core Principle 冲突治理流程，因此不得把它当作放行通道。

Owner Strategic Intent 不能覆盖 PD 的系统级核心原则。

## 6.2 服务端冲突门禁优化

当前 `StrategicConflictGate` 已经具备：

- V1 兼容。
- V2 完整性检查。
- 冲突状态检查。
- Owner Decision 绑定。
- Intent Hash 绑定。
- Artifact Digest 绑定。
- SQLite 审批事务内检查。

但当前门禁以整体 `conflictStatus === 'confirmed'` 为主要判断条件。

需要改成按冲突类型判断。

伪代码（**修改现有 `evaluateStrategicConflictGate()`，不新建 Gate**）：

```ts
function evaluateStrategicConflictGate(input) {
  const claim = readStrategicClaim(input);
  if (claim.kind === 'none')   return allow();                 // V1 / 无契约：兼容
  if (claim.kind !== 'v2')     return block('malformed_strategic_contract');

  const conflicts = claim.contract.strategicAssessment.conflicts ?? [];
  if (claim.contract.strategicAssessment.conflictStatus !== 'confirmed') return allow();

  const exemptable = conflicts.filter((c) => c.status === 'confirmed' && isStrategicTradeoff(c));
  const unexemptable = conflicts.filter((c) => c.status === 'confirmed' && !isStrategicTradeoff(c));

  // 1. 任何不可豁免的已确认冲突 → 直接阻断，且给出针对性 reason / nextAction
  if (unexemptable.length > 0) {
    return block(unexemptable.some((c) => c.against === 'core_principle')
      ? 'core_principle_conflict'
      : 'owner_boundary_conflict', unexemptable);
  }

  // 2. 可豁免冲突：必须被同一组合法决策全部覆盖
  const effective = input.resolutions.filter((r) =>
    r.ownerAction === 'confirm_drift'
    && r.intentDocHash === contract.strategicIntent?.contentHash
    && r.contractDigest === input.artifactDigest
    && r.resultingCandidateId !== null
    && input.candidateIds.includes(r.resultingCandidateId));

  const uncovered = exemptable.filter((c) =>
    !effective.some((r) => r.relatedIntentFields.includes(c.ref)));

  return uncovered.length === 0 ? allow() : block('no_effective_resolution', uncovered);
}
```

注意：这是职责示意，具体实现必须沿用当前 `StrategicConflictGateInput` 和结果类型（`StrategicConflictGateResult`），不新增结果枚举成员。`block()` 必须把冲突目标（`against:ref`）写进 `reason`，把 Owner 可执行的下一步写进 `nextAction`。

### 6.2.1 六项校验（缺一不可）

`confirm_drift` 允许解决普通战略取舍，但必须**同时**满足：

1. Candidate 匹配：`resultingCandidateId ∈ candidateIds`（服务端从契约 lineage 解析）。
2. Intent Hash 匹配：决策的 `intent_doc_hash` === 契约的 `strategicIntent.contentHash`。
3. Artifact Digest 匹配：决策的 `contract_digest` === 当前审批 artifact 的 digest。
4. 冲突目标属于允许的普通战略章节：`ref ∈ {why, desired_outcome, current_strategic_focus}`。
5. 决策的 `relatedIntentFields` 覆盖该冲突章节。
6. 同一契约里**所有**需要解决的普通战略冲突都被覆盖（不允许"解决一个就放行全部"）。

`relatedIntentFields` 的读取规则沿用现有兼容策略：

- 优先 `related_intent_fields_snapshot`（不可变审计副本）；
- 旧记录在该列为空/不可解析时回退到 `related_intent_fields`。

### 6.2.2 Read Model 与 Write Model 同源

审批写路径（`SqliteApprovalStore.approve()`）的 `BEGIN IMMEDIATE` 事务内校验，与 Approval 卡片读模型（`readStrategicConflictView()`）必须走**同一个** `evaluateStrategicConflictGate()`，不允许 UI 侧另写一套判断。

### 6.2.3 历史决策兼容

- 已经完成的历史 Approval 不追溯撤销。
- 历史 Intent Decision 原样保留，不伪造数据。
- 历史 `confirm_drift` 不能自动成为新规则下 Core Principle 或 Owner Boundary 的豁免依据。
- 只有满足上述六项、且 Candidate / Intent Hash / Artifact Digest / 章节均匹配的决策，才能解决普通战略取舍。
- 无法证明旧决策覆盖了对应章节时，要求 Owner 重新审阅，而不是默认放行。
- 不回填虚假 `related_intent_fields`。

## 6.3 Owner Decision 复用

继续使用：

```text
intent_decisions
```

不新建冲突审批表。

现有记录已经包含：

- ownerAction
- intentDocHash
- relatedIntentFields
- evidenceRefs
- resultingCandidateId
- contractDigest

需要补充的是门禁校验的精度：

Owner 的 `confirm_drift` **只能**解决其明确审阅过的普通战略取舍（`why` / `desired_outcome` / `current_strategic_focus`）。

它不能解决 `non_negotiables`、`stop_escalation`，也不能解决 `core_principle`。

建议在现有读取逻辑中补充 `related_intent_fields` 校验：

```text
Owner Decision
      |
      v
candidateId 匹配
      |
      v
intentDocHash 匹配
      |
      v
contractDigest 匹配
      |
      v
relatedIntentFields 覆盖冲突章节
      |
      v
有效决策
```

不匹配则拒绝。

对于 Core Principle 冲突，不能使用 Owner Intent 决策豁免。

## 6.4 原子性

保留现有：

```ts
BEGIN IMMEDIATE
```

在同一个 SQLite 事务内完成：

1. 读取 Approval。
2. 读取 Artifact。
3. 计算 Artifact Digest。
4. 读取候选身份。
5. 读取 Owner Decision。
6. 执行战略冲突判断。
7. 写入审批结果。

不能把检查放在事务之外，避免 check-then-write 竞争。

---

# 7. Principle 与 RuleCode 的实际行为落地

这是本次最重要的验收部分。

不能因为 Scribe 成功生成了 IntentContract V2，就宣布战略意图已经内化。

## 7.1 Cognitive Principle

涉及：

```text
packages/principles-core/src/runtime/activation/prompt-activation-reader-contract.ts
```

当前激活上下文已经可以从正式产物中提取：

```text
text
```

或：

```text
principleDraft.statement
```

保持现有机制。

要求：

- Principle Statement 必须体现战略行为要求。
- Activation 必须使用经过 Owner Approval 的正式版本。
- 不直接注入未审批的 Contract。
- 不依赖 INTENT.md 每次都驻留在上下文中。
- 不改变现有原则身份和激活权限。

最终真正进入 Cognitive Principle 宿主上下文的是正式原则文本。

## 7.2 RuleCode

复用：

```text
artificer-intent-preflight.ts

artificer-prompt-builder.ts

evaluator-prompt-builder.ts

existing RuleHost pipeline
```

必须保持 V1 行为契约：

| 字段 | 作用 |
|---|---|
| ownerIntent | Owner 真正想实现或防止的事情 |
| targetBehavior | Agent 应表现出的行为 |
| forbiddenBehavior | 必须避免的行为 |
| evidenceSource | 真实来源证据 |
| validationExpectation | 验证行为是否符合意图 |

执行链：

```text
Scribe Artifact
      |
      v
Artificer Intent Preflight
      |
      v
IntentContract V1 验证
      |
      v
RuleCode Generation
      |
      v
Evaluator
      |
      v
Intent Consistency Check
      |
      v
Owner Approval
      |
      v
RuleHost Activation
      |
      v
Real Host Execution
```

重点：

- 不允许 RuleCode 只满足局部实现而违反 Owner Intent。
- 不允许 Evaluator 为了满足测试要求而引入 Contract 之外的新行为要求。
- 不允许 RuleCode 自行引入 Owner 没有授权的新输入或外部机制。
- 不允许未经审批的 RuleCode 激活。

不重构 RuleHost。

## 7.3 Intent 原始注入的定位

保留现有 `buildIntentFrictionBlock()`。

它的职责是：

- 提供战略背景。
- 提醒关键决策。
- 提醒潜在冲突。
- 允许 Agent 质疑和建议。
- 明确 Agent 不拥有 Intent 修改权。

它不是最终执行门禁。

同时，模板问题和无效章节不能进入 Prompt。

继续复用 XML 转义、内容长度限制及现有引用数据安全边界。

---

# 8. Owner Console 改造

涉及：

```text
packages/pd-console/src/ui/pages/intent/IntentPage.tsx

packages/pd-console/src/ui/pages/intent/IntentOnboarding.tsx

packages/pd-console/src/server/models/IntentPageModel.ts

packages/pd-console/src/server/models/ApprovalsGroupedConsoleModel.ts

packages/pd-console/src/server/routes/intent.ts
```

## 8.1 Intent 管理入口

现有侧边栏已经有：

```text
/intent
```

必须保留。

不重新开发一套管理页面。

页面应该明确显示：

- 当前 Intent 状态。
- 五个章节的填写情况。
- 模板占位提醒。
- 最近更新时间。
- 当前 Feature Flag 状态。
- 版本历史。
- 修改入口。

支持部分填写。

不要求五个章节全部填写后才能保存。

## 8.2 Approval 页面

在现有 Approval 卡片上区分三类情况：

| 类型 | Owner 看到的内容 | 操作 |
|---|---|---|
| 战略取舍 | 冲突背景与建议 | 继续审阅 |
| Owner 边界冲突 | 具体边界、证据、影响 | 确认、修改意图或拒绝 |
| Core Principle 冲突 | 冲突原则 ID 与证据 | 修改候选或拒绝 |

必须显示：

- 冲突对象。
- 关联章节或 Core Principle ID。
- 证据来源。
- 当前处理状态。
- 阻断原因。
- 下一步操作。

不允许只显示一个模糊的 `strategic_conflict_unconfirmed` 错误码。

前端展示与服务端审批必须使用同一个判断函数。

---

# 9. 数据持久化与兼容

## 9.1 现有存储

| 数据 | 存储位置 | 本次处理 |
|---|---|---|
| Intent 当前内容 | INTENT.md | 复用 |
| Intent 历史 | intent_doc_versions | 复用 |
| Stage A 输入快照 | tasks.diagnostic_json / pi_metadata | 复用 |
| Stage A 结果 | pi_artifacts.contentJson | 复用 |
| Scribe 合同 | Scribe artifact contentJson | 复用 |
| Owner 决策 | intent_decisions | 复用 |
| 审批结果 | approvals | 复用 |
| 原则激活 | 现有 Activation Store | 复用 |

## 9.2 数据库原则

本次默认：

- 新增数据库表：0。
- 新增数据库：0。
- 新增审批系统：0。
- 新增 Feature Flag：0。
- 新增后台任务：0。
- 新增外部依赖：0。

当前 `intent_decisions.contract_digest` 已经存在，不再重复增加。

如果实际 Preflight 发现当前数据库与代码不一致，先核实迁移状态，不允许擅自新增重复字段。

## 9.3 兼容策略

| 数据 | 处理 |
|---|---|
| 历史 V1 Contract | 继续正常使用 |
| 新 V2 Contract | 严格验证 |
| 历史无 Intent 的 Principle | 不回填、不伪造 |
| 历史 Approval | 不重新判定 |
| 历史 Intent Decision | 保留 |
| 旧版 Intent Snapshot | 兼容读取 |
| Feature Flag 关闭 | 恢复既有 V1 行为 |

---

# 10. 异常处理与降级

| 场景 | 预期行为 |
|---|---|
| Feature Flag 关闭 | 不读取 INTENT.md，不注入，不进行战略锚定 |
| INTENT.md 不存在 | not_configured，正常形成原则 |
| 只有默认模板 | not_configured，正常形成原则 |
| 部分填写 | 只使用有效章节 |
| 读取超限 | 可观察降级，不阻断普通原则形成 |
| 读取失败 | 可观察降级 |
| Stage A Hash 不一致 | 丢弃对应战略判断 |
| Stage A 快照损坏 | Fail Closed |
| FormationContext 超预算 | 保留身份，不伪造判断 |
| Dreamer 缺少战略信息 | 明确标注缺失 |
| Philosopher 缺少诊断产物 | 沿用现有降级 |
| Scribe 缺少 V1 Contract | 拒绝形成成功 |
| V2 Contract 不完整 | 阻断审批 |
| 普通战略取舍 | 不自动阻断 |
| Owner 边界冲突 | 要求 Owner 决策 |
| Core Principle 冲突 | 不允许 Intent Decision 豁免 |
| 历史 V1 合同 | 保持兼容 |

所有新增降级必须使用现有事件和错误处理机制，必要时增加最小 telemetry 事件。

禁止静默降级。

---

# 11. 测试方案

## 11.1 Intent 文档测试

覆盖：

- 中文模板识别。
- 英文模板识别。
- 完全空白。
- 只填写一个章节。
- 填写三个章节。
- 保留模板问题并填写答案。
- 自定义文本。
- TODO / TBD 占位。
- 超长章节。
- 恶意 XML 内容。
- 部分填写保存后重新读取。

重点证明：

模板不会被当作真实战略意图，部分填写不会被阻断。

## 11.2 Stage A 测试

复用现有：

```text
diag-rootcause-intent-snapshot.test.ts
```

增加：

- 模板内容不生成有效战略快照。
- 部分填写只保留有效章节。
- 无效章节不能被模型引用。
- Hash 不匹配时战略判断降级。
- Stage A 重试不发生战略版本漂移。
- 快照损坏时模型调用次数为 0。

## 11.3 原则形成集成测试

复用现有：

```text
sia-chain-e2e.test.ts
```

验证：

```text
Stage A
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

重点检查：

1. Dreamer 是否真正读取战略依据。
2. Philosopher 是否真正审视双锚点。
3. Scribe 是否将战略要求转化为正式行为原则。
4. 所有阶段使用同一个 Intent Hash。
5. Contract V1 五字段没有丢失。
6. V2 战略字段由服务端组装。

## 11.4 冲突治理测试

必须覆盖：

| 测试场景 | 预期 |
|---|---|
| 普通战略取舍 | 不阻断 |
| healthy_tension | 不自动视为错误 |
| Non-negotiables 违反 | 需要 Owner 决策 |
| Stop / Escalation 触发 | 必须升级 |
| Core Principle 冲突 | 不能通过 Owner Intent 决策豁免 |
| Owner Decision 正确绑定 | 按对应边界放行 |
| Candidate 不一致 | 拒绝 |
| Intent Hash 不一致 | 拒绝 |
| Contract Digest 不一致 | 拒绝 |
| V2 不完整 | 拒绝 |
| 历史 V1 | 正常 |

## 11.5 下游行为测试

必须覆盖两条路径。

**路径 A：Cognitive Principle**

验证：

- Principle Statement 已包含战略行为要求。
- Owner Approval 后才允许激活。
- Host Prompt 使用正式原则文本。
- 未审批原则不会进入有效激活上下文。

**路径 B：RuleCode**

验证：

- Artificer 正确读取 V1 Contract。
- 生成代码满足 targetBehavior。
- 不实现 forbiddenBehavior。
- Evaluator 能发现战略不一致。
- 只有审批后的 RuleCode 才能执行。

## 11.6 浏览器验收

必须使用真实浏览器。

至少验收：

1. Intent 导航入口存在。
2. Intent 页面可以打开。
3. 模板初始化正常。
4. 部分填写正常。
5. 保存与版本历史正常。
6. Feature Flag 状态正确。
7. Owner Decision 正常。
8. Approval 冲突展示正确。
9. 审批阻断与放行状态一致。
10. 页面刷新后状态仍然正确。

## 11.7 真实宿主 E2E

使用隔离 Workspace，不能污染生产状态。

至少完成两个场景：

**场景 A：战略取舍**

Agent 面对一个短期收益与长期目标存在张力的任务。

预期：

- 能够识别取舍。
- 能够给出理由。
- 不把正常取舍误判为违规。
- 不擅自改变 Owner Intent。

**场景 B：明确边界**

Agent 面对一个违反 Non-negotiables 或触发 Stop / Escalation 的任务。

预期：

- 识别对应章节。
- 给出具体证据。
- 正确升级或阻断。
- 不绕过 Owner 决策。

随后验证正式 Principle / RuleCode 是否改变了真实宿主行为。

---

# 12. 实施顺序

建议按照以下顺序推进。

## Phase 0：源码 Preflight

确认：

- 当前 main HEAD。
- 当前 SPEC 与 TECH。
- Stage A 快照实现。
- FormationContext 传递。
- Dreamer / Philosopher / Scribe 调用链。
- V1 / V2 Contract。
- Approval 事务门禁。
- Intent Console。
- Cognitive Activation。
- RuleCode 真实执行链。

交付：

`INTENT_UNIFICATION_IMPLEMENTATION_PREFLIGHT.md`

只列真实差异，不重复描述已有能力。

## Phase 1：Intent 文档语义完善

完成：

- 模板占位识别。
- 部分填写支持。
- Snapshot 过滤。
- Prompt 有效内容过滤。
- 章节引用校验。
- 相关测试。

## Phase 2：战略冲突治理

完成：

- 三类冲突分类。
- Scribe Prompt 调整。
- 服务端分类判定。
- Approval Gate 调整。
- Intent Decision 绑定精度。
- Owner Review UI 展示。

这是 P0。

## Phase 3：行为载体闭环

完成：

- Principle Statement 战略行为表达。
- V1 Contract 兼容。
- Artificer / Evaluator 回归。
- Cognitive Activation 验收。
- RuleCode Activation 验收。

不重构现有执行架构。

## Phase 4：产品体验

完成：

- Intent 管理入口回归。
- 部分填写体验。
- 模板状态提示。
- 冲突解释。
- Owner 决策流程。
- 页面响应式与错误反馈。

## Phase 5：真实端到端验收

完成：

- 自动化测试。
- 完整内部化链路。
- 浏览器验收。
- Cognitive Principle 真实宿主测试。
- RuleCode 真实宿主测试。
- 生产数据隔离核查。
- 最终审计报告。

所有阶段必须端到端完成。

不能以单元测试通过替代真实宿主验收。

---

# 13. Definition of Done

| 验收项目 | 完成标准 |
|---|---|
| 唯一 Intent 来源 | 不存在第二套战略文档 |
| 唯一开关 | 复用 intent_engineering |
| 模板识别 | 模板占位不构成真实 Intent |
| 部分填写 | 可以正常使用有效章节 |
| Snapshot | 同一候选链版本一致 |
| Retry | Stage A 重试不会静默换版本 |
| Dreamer | 能够使用双锚点 |
| Philosopher | 能够审视战略与核心原则 |
| Scribe | 正确生成可执行 Principle Statement |
| Contract | V1/V2 兼容 |
| 战略取舍 | 不发生错误硬阻断 |
| Owner 边界 | 正确升级或阻断 |
| Core Principles | 不被 Owner Intent 覆盖 |
| Owner Decision | 决策绑定正确 |
| Approval | 服务端门禁不可绕过 |
| Cognitive | 实际激活正确原则 |
| RuleCode | 真实执行符合 Intent |
| Examiner | 能够获得行为验证证据 |
| UI | Intent 管理入口正常 |
| Browser | 全流程验收通过 |
| CI | 全部通过 |
| Security | 不削弱既有权限与安全边界 |
| Complexity | 无不必要的新服务和数据库 |

---

# 14. 最终工程原则

本次技术实现有四个最重要的要求：

**第一，战略意图不能停留在 Prompt。**

它必须参与原则形成，最终成为正式行为原则的一部分。

**第二，IntentContract 不能成为新的治理中心。**

它负责记录战略来源和行为契约，审批仍归现有 Owner Approval，执行仍归现有 Activation 和 RuleHost。

**第三，不能让模型替 Owner 决策。**

模型可以识别、质疑、分析、提出建议，但不能修改 Owner 的战略意图，也不能自行解除战略边界。

**第四，必须验证真实行为。**

不能因为 IntentSnapshot、IntentContract V2、Scribe Artifact 都成功写入数据库，就宣称战略意图已经完成内化。

真正的完成标准是：

```text
Owner 表达长期意图
       |
       v
PD 理解战略方向
       |
       v
PD 将其转化为行为原则
       |
       v
Owner 审批
       |
       v
宿主实际遵循
       |
       v
Examiner 获得真实行为证据
```

**最终目标：让 PD 不只是帮助 Agent 解决眼前的问题，而是让 Agent 在持续行动中逐渐形成与 Owner 长期目标一致的行为方式。**

---

# 15. Owner Amendment 2026-11-15 — 可执行实现契约

本节是本轮整改的规范性补充，与第 1–14 章冲突时**以本节为准**。它把"文档说了但代码没做"的部分固化为可验证的实现契约。

## 15.1 唯一权威关系

| 文档 | 地位 |
|---|---|
| `SPEC-PD-INTENT-UNIFICATION-001 v2.0` | 端到端主规范（产品语义、治理规则、验收标准） |
| `TECH-PD-INTENT-UNIFICATION-001.md`（本文） | 实现规范：函数、数据结构、执行位置、测试方法 |
| `TECH-PD-STRATEGIC-INTENT-ANCHORING-001.md` v1.1 | Stage A / Snapshot / IntentContract 的既有详细设计，作为本文的下位实现细节；冲突时以本文为准 |

明确不存在的概念（禁止实现者凭文档想象补建）：

- 不存在 `FormationIntentBinding`；
- 不存在独立 Formation ID 绑定流程；
- 不存在 `StrategicIntentService` / `IntentSnapshotService` / `StrategicContextService` / `IntentContractStore` / `StrategicApprovalService`。

Stage A 的唯一快照持久化位置是任务记录：

```text
TaskRecord.diagnosticJson → pi_metadata.intentSnapshot
```

`IntentSnapshot` 保存的是**当时实际捕获的章节正文**（服务端读取 INTENT.md 后由 `parseIntentDocSections` 解析），不是模型生成的内容。

## 15.2 V2 的真实结构（以源码为准）

```ts
// packages/principles-core/src/runtime/internalization/intent-contract.ts
export interface IntentContractV2 extends IntentContractV1 {
  readonly schemaVersion: 2;
  readonly strategicIntent?: IntentContractStrategicIntent;   // contentHash / capturedAt / intentVersionId? / relevantSections?
  readonly strategicAssessment: IntentContractStrategicAssessment; // relevance / rationale / conflictStatus / conflicts?
  readonly corePrincipleRefs?: readonly string[];
}
```

- V1 五字段（`ownerIntent` / `targetBehavior` / `forbiddenBehavior` / `evidenceSource` / `validationExpectation`）保持原名、原语义、原非空约束。
- V2 不存在 `source` / `formationId` / `painRefs` / `diagnosisRefs` / `principleIntent` / `validation` 这些字段。
- `isValidIntentContractV2()` 先执行 `isValidIntentContractV1()`，再检查 V2 的三个组。

## 15.3 下游边界

| 阶段 | 消费的契约 | 说明 |
|---|---|---|
| Artificer | **V1** | 依据 V1 五字段生成 RuleCode |
| Evaluator | **V1** | 依据 `targetBehavior` / `forbiddenBehavior` / `validationExpectation` 检查行为一致性；**本次不扩展为消费 V2** |
| Scribe | V1（模型）+ V2（服务端组装） | 模型只产 V1 与候选 `conflicts` / `corePrincipleRefs`；V2 的战略字段全部由 `assembleIntentContractV2()` 派生 |
| Approval Gate | V2 | 审批门禁负责验证战略字段与冲突可豁免性 |

**修订一条既有表述：**

原文"Evaluator 发现战略不一致"应读作：Evaluator 依据**已经包含战略行为要求的 V1 行为契约**检查行为一致性；V2 战略字段的合法性由服务端审批门禁负责验证。不得据此扩展 Evaluator 直接消费 V2。

V2 是战略追溯与审批依据，不是 RuleCode 的直接执行载体。

## 15.4 两个降级状态的区分

| 状态 | 含义 | 触发条件 |
|---|---|---|
| `not_configured` | **没有可用的 Owner Intent** | 无快照；或无任何 authored 章节（模板-only / 全空） |
| `insufficient_evidence` | **有 Intent，但诊断证据不足以支撑战略判断** | 有 authored 章节且存在 `strategicIntent`，但 Stage A 未给出可用 `intentTension`，或模型声明的章节引用全部被服务端拒绝 |

二者不可互换。模板-only 必须是 `not_configured`，不得因为模型自报 `intentTension` 而升级为 `relevant`。

## 15.5 契约与哈希的准确语义

- `strategicIntent.contentHash` = Stage A 捕获时刻的 INTENT.md 内容哈希（服务端计算）。
- `intentVersionId` 可选：仅当版本存储的最新版本 hash 与 `contentHash` 相等时填写；**不得**通过 `contentHash` 反查版本（`SqliteIntentDocVersionStore` 没有该索引）。
- `contract_digest` / `IntentDecisionRecord.contractDigest` 实际绑定的是**完整 Artifact Digest**（`computeArtifactDigest()` 对 artifact 快照的计算结果），不是单独的"契约摘要"。文档与代码注释不得声称存在 contract-only digest。

## 15.6 冲突阻断的对外表达

阻断必须让 Owner 知道"是什么冲突"和"下一步做什么"：

| 冲突类型 | block code | reason 必含 | nextAction |
|---|---|---|---|
| Core Principle | `strategic_conflict_unconfirmed` | `core_principle:<id>`，并说明 Owner Intent 不能豁免系统核心原则 | 修改候选使两个锚点同时成立，重新形成候选后再次提交审批 |
| Owner Boundary（`non_negotiables`） | `strategic_conflict_unconfirmed` | `owner_intent:non_negotiables` | 修改候选使其符合该边界；或先修改 INTENT.md 并基于新版本重新形成候选 |
| Owner Boundary（`stop_escalation`） | `strategic_conflict_unconfirmed` | `owner_intent:stop_escalation` | 按该章节升级给 Owner；`confirm_drift` 不是升级 |
| 普通取舍未覆盖 | `strategic_conflict_unconfirmed` | `owner_intent:<section>` 缺失的覆盖 | 针对这些章节记录一条绑定当前 Candidate / Hash / Digest 的 `confirm_drift` |

UI 必须区分"已确认且可豁免"与"已确认且不可豁免"，不能把后者显示成"尚未确认"。

## 15.7 Feature Flag 的完整消费者清单

`intent_engineering` 关闭时必须同时关闭以下全部链路（`feature-flag-lifecycle.ts` 的 `consumers` 必须如实列出）：

| 消费者 | 位置 | flag off 行为 |
|---|---|---|
| OpenClaw Prompt Hook | `openclaw-plugin/src/hooks/prompt.ts` | 不读文件、不注入 `<intent_doc>` |
| 插件安全读取 | `openclaw-plugin/src/core/intent-doc-reader.ts` (`safeReadIntentDoc`) | 首先返回 `flag_disabled`，无 fs 访问 |
| Reader 适配器 | `openclaw-plugin/src/core/intent-doc-reader-adapter.ts` | 透传 `flag_disabled` |
| Stage A（战略锚定） | `principles-core/.../diag-rootcause-runner.ts` | 不注入、不捕获、不保留模型 `intentTension` |
| Scribe（V2 组装） | `principles-core/.../scribe-runner.ts` | 不生成新的战略锚定 |
| Console Intent 页面 | `pd-console/src/server/models/IntentPageModel.ts` / Intent 页面 | 展示为未启用，不触发战略链路 |
| CLI 入口 | `pd-cli` 的 `intent` 命令族与诊断触发入口 | 不读取 INTENT.md |

关闭不等于删除：`pi_metadata.intentSnapshot` 保留，重新开启后同一任务复用原快照。

## 15.8 Prompt Hook 的章节过滤

`buildIntentFrictionBlock()` 不能无条件注入原始 INTENT.md：

1. 先 `parseIntentDocSections(raw)`；
2. 用 `classifyIntentSectionContent()` 逐节判定；
3. 只保留 `authored` 章节，用 `assembleIntentDoc()` 重组；
4. 无任何 authored 章节 → 返回空字符串（不注入），Prompt Hook 记录 `intent_doc_template_only`。

Prompt Hook（`prompt.ts`）与 Reader 适配器（`intent-doc-reader-adapter.ts`）必须使用同一套识别函数，不得各写一份。

## 15.9 Examiner 与其它边界

- Examiner 作为后续行为验证能力，本次**不重构**，也不虚构尚不存在的数据接线。
- RuleHost、Cognitive Activation、Artificer 生成链路本次不重构。
- 不新增数据库表，不新增 Owner Decision 类型，不新增冲突状态机，不新增第二个 Feature Flag。

## 15.10 历史兼容

| 对象 | 规则 |
|---|---|
| 历史 V1 产物 | 审批门禁走 `claim.kind === 'none'` 兼容路径，行为不变 |
| 历史 Approval | 不追溯撤销 |
| 历史 Intent Decision | 原样保留，不回填、不伪造字段 |
| 历史 Snapshot | 不重写；用确定性规则重新识别有效章节 |
| 历史 `confirm_drift` | 不自动成为 Core Principle / Owner Boundary 的豁免依据 |
| 历史 V2 产物 | 缺失 `placeholder` 标记时按规则重新识别，不默认信任模板正文 |

## 15.11 本轮整改的验收矩阵

| 层 | 必测场景 | 证据形式 |
|---|---|---|
| Intent 文档识别 | 中文模板 / 英文模板 / 空白 / TODO / 模板+答案 / 单章节 / 多章节部分填写 / 自定义内容 / 超长 / 恶意 XML / 历史快照 / `missing+placeholder` 非法组合 | 单元测试 |
| Stage A | 无快照+伪造 `intentTension` / 模板-only / 部分有效 / 全部无效引用 / 部分有效部分无效 / confirmed 引用 missing / confirmed 引用 placeholder / hash 不一致 / 快照损坏 / flag off + 历史快照 / flag 重开恢复 / Owner 改 INTENT 后重试 | 单元 + 集成 |
| IntentContract V2 | V1 五字段保留 / V2 服务端组装 / `relevantSections` 只来自有效章节 / relevance 用服务端派生值 / `conflictStatus` 与 conflicts 一致 / 无效章节无法 confirmed / 无快照无伪造 strategicIntent / corePrincipleRefs 合法性 | 单元 |
| Approval Gate | 见 §6.2.1 六项 + Core/Boundary/partial 三类阻断 + 历史 V1 兼容 + 历史 Approval 不撤销 | 集成（读模型与写模型同源） |
| 真实宿主 | flag on 全链路 / flag off / 模板-only / 部分填写 / 快照重试 / Owner 改 Intent / 伪造冲突 / Core Principle 冲突 | 真实宿主 + 真实浏览器 |

不得用"CI 全绿"替代业务链路验收，也不得用 Prompt 修改成功替代服务端确定性校验。

---

**END OF TECHNICAL DESIGN**