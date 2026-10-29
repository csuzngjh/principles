# SPEC-PD-RULE-ASSOCIATION-005 v0.5

## 规则归属源头关联、确定性身份解析与异常例外处理

> 基于 `PD-Console-SPEC-v0.4.md` 修订，原文件保留。本项独立编号为 `SPEC-PD-RULE-ASSOCIATION-005`，不替代控制台融合 `SPEC-PD-CONSOLE-INTEGRATION-004 v0.2`。本版新增 §17～§23 为规范性补充；与前文存在表述冲突时，以这些节的明确限定为准。实施前应据此统一契约，不能任选宽松解释。
> 本次授权仅为文档完善，所有 Owner 决策仍待书面确认。首轮范围为可信上下文、只读解析和独立评估；自动续接不在首轮实现范围。

- **版本**：v0.5（待审修订稿）
- **日期**：2026-10-30
- **状态**：`READY_FOR_OWNER_REVIEW`
- **替代范围**：替代 v0.3 中”默认展示候选、由 Owner
  搜索并选择规则归属”的主路径；v0.3 的候选浏览能力仅保留为异常处理能力。
- **相关治理规范**：`docs/specs/SPEC-RULECODE-GOVERNANCE-CLOSURE-003-v0.1.md`（Owner
  于 2026-10-25 已同意 A+B 实施）。
- **重要授权边界**：本 SPEC 提议修改已批准规范中”直接 rule 候选必须由
  Owner
  显式绑定”的默认规则。它是治理语义变更，不得仅凭本文件的存在静默上线。Owner
  明确批准本 SPEC 的 OD-01
  后，才可启用自动关联；未批准时只能实施不改变行为的只读观测、契约兼容与异常
  UI 优化。
- **实现范围**：只优化规则候选到正式 Principle
  身份的建立、解析、验证和异常处理；不修改生产代码作为本次文档交付的一部分，不授权合并、部署、安装或生产规则激活。

------------------------------------------------------------------------

## 1. 执行摘要

### 1.1 核心决定

把当前的”每条 Rule Candidate 都要由 Owner
打开界面、搜索原则、人工绑定”改为：

> **在诊断生成时显式声明可验证的原则关联；系统沿候选来源链和现有
> Principle Ledger 自动解析正式
> `principleId`；只有缺少可信关联、关联歧义、证据失效或来源冲突时，才进入
> Owner 例外队列。**

本方案不以语义搜索或 Top-3
推荐作为主方案。它们只能用于解释和处理异常，不能替代源头关系契约。

### 1.2 为什么这是根因修复

当前实现的核心缺口不是 UI
不够聪明，而是规则生成和候选入库时没有保存”这条规则具体落实哪条原则”的结构化关系：

1.  `DiagnosticianRecommendationSchema` 有
    `kind`、`description`、`triggerPattern`、`action` 和
    `abstractedPrinciple`，没有规则到原则的关系契约。
2.  `SqliteDiagnosticianCommitter` 为每条 recommendation 独立生成随机
    `candidateId`。候选共享 artifact/task 来源，但系统没有可靠的
    recommendation-to-recommendation 关联。
3.  `PrincipleTreeLedgerAdapter.resolveCandidatePrincipleIdentity()` 对
    `rule` 只读取 `ruleCandidateBindings`，没有从规则的源 recommendation
    解析关系。
4.  `createRuleCandidateBindingReview()` 的搜索主要是 Principle ID /
    正文子串匹配，按账本遍历顺序取最多 20
    条，不是相关性排序；“无搜索结果”不等于”没有合适原则”。
5.  当前 Owner 显式绑定是有意设置的治理保护，不是应当绕过的 UI
    限制。正确做法是让系统只对有充分来源证据的关联自动解析，并把无法证明的情况交给
    Owner。

### 1.3 成功标准

- 正常的新 Rule Candidate 在生成和入库时保留可校验的源头关系，不需要
  Owner 再搜索或手工绑定。
- 同一诊断内规则关联到原则候选时，系统通过候选来源链解析最终 canonical
  `principleId`，而不是把 `candidateId` 当作 `principleId`。
- 规则明确关联到上下文中已存在的原则时，系统验证目标 ID
  来自可信输入上下文，并且有相应诊断依据。
- 任何缺失、歧义、冲突、过期或不可读情况均 fail
  closed：不自动猜测、不生成伪身份、不进入后续模型调用或发布。
- Owner
  绑定界面只处理异常和旧数据；仍提供完整候选浏览、可解释建议和人工覆盖能力。
- 自动关联不自动批准规则、不改变 shadow/live 状态、不绕过
  Artificer/Evaluator、安全检查或最终激活门禁。
- 历史工件保持不可变；不通过文本相似度批量回填历史关联。

------------------------------------------------------------------------

## 2. 当前实现事实与边界

以下事实来自对仓库 `csuzngjh/principles` 当前 `main`
上实现的只读核对。链接指向对应源码；行号可能随提交变化。

| 已核实事实                                                                                                      | 源码                                                                                                                                                                                                                                                                                                                             | 对设计的约束                                                                        |
|:----------------------------------------------------------------------------------------------------------------|:---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:------------------------------------------------------------------------------------|
| 诊断输出中的 recommendation 没有正式规则归属字段                                                                | [`diagnostician-output.ts`](https://github.com/csuzngjh/principles/blob/main/packages/principles-core/src/runtime-v2/diagnostician-output.ts)                                                                                                                                                                                    | 需要新增版本化关系契约，不能从自由文本推断                                          |
| 提交器为每条 recommendation 分配独立随机 `candidateId`，并保存 `source_recommendation_json`                     | [`diagnostician-committer.ts`](https://github.com/csuzngjh/principles/blob/main/packages/principles-core/src/runtime-v2/store/commit/diagnostician-committer.ts)                                                                                                                                                                 | 新关系应引用 artifact 内的稳定局部 `recommendationRef`，不能要求模型预知数据库 UUID |
| 只有 `recommendation_kind === 'principle'` 才可进入 Principle Ledger                                            | [`candidate-intake-service.ts`](https://github.com/csuzngjh/principles/blob/main/packages/principles-core/src/runtime-v2/candidate-intake-service.ts)                                                                                                                                                                            | 不能将 `rule` 偷换成 `principle`，也不能为填身份而自动创建 Principle                |
| Principle 的 `derivedFromPainIds` 在实际 intake 路径中承担 source Candidate 关联/幂等用途；其历史语义还存在混用 | [`principle-tree-ledger-adapter.ts`](https://github.com/csuzngjh/principles/blob/main/packages/principles-core/src/runtime-v2/adapter/principle-tree-ledger-adapter.ts)                                                                                                                                                          | 不得把 rule 归属塞入 `derivedFromPainIds`                                           |
| Principle reuse 的权威关联保存在 `reuseEvidence[]`，其目标是外层 Principle                                      | [`PRI-917-reuse-before-create-v0.1.md`](https://github.com/csuzngjh/principles/blob/main/docs/specs/PRI-917-reuse-before-create-v0.1.md)                                                                                                                                                                                         | 复用现有身份解析，不复制或污染 reuse 事实                                           |
| 当前 rule 身份解析只接受显式 `ruleCandidateBindings`；绑定记录是 Owner 治理事实                                 | [`rule-candidate-binding.ts`](https://github.com/csuzngjh/principles/blob/main/packages/principles-core/src/runtime-v2/types/rule-candidate-binding.ts)、[`principle-tree-ledger-adapter.ts`](https://github.com/csuzngjh/principles/blob/main/packages/principles-core/src/runtime-v2/adapter/principle-tree-ledger-adapter.ts) | 新的系统关联必须与 Owner 决策分型，不能伪造 Owner 身份或把自动关系写成 Owner 决定   |
| 绑定审阅当前使用 bounded substring search，最多 20 条                                                           | [`principle-tree-ledger.ts`](https://github.com/csuzngjh/principles/blob/main/packages/principles-core/src/principle-tree-ledger.ts)                                                                                                                                                                                             | 搜索只保留为异常处置的辅助工具                                                      |
| 已批准的 RuleCode 治理规范明确要求身份关联、规则审批、shadow/live 决策相互独立                                  | [`SPEC-RULECODE-GOVERNANCE-CLOSURE-003-v0.1.md`](https://github.com/csuzngjh/principles/blob/main/docs/specs/SPEC-RULECODE-GOVERNANCE-CLOSURE-003-v0.1.md)                                                                                                                                                                       | 自动关联不能扩展为自动审批、自动激活或生产授权                                      |

### 2.1 不能混为一谈的身份

- `recommendationRef`：单个诊断 artifact 内的局部引用，不是全局身份。
- `candidateId`：SQLite 中某条诊断候选的身份。
- `principleId`：Principle Ledger 中正式原则记录的 canonical UUID。
- `sourcePrincipleId`：规则工件记录的原则身份引用；必须来自受验证的身份解析结果，不得由模型随意填充。
- `ruleCandidateBindings`：Owner
  对规则归属作出的显式决定历史，不是所有自动关联的通用容器。
- `reuseEvidence[]`：原则复用的关系与决定证据，不得改作 Rule Candidate
  绑定。

------------------------------------------------------------------------

## 3. 目标、非目标与不变量

### 3.1 目标

1.  将规则归属关系前移至诊断输出契约和候选提交链。
2.  以确定性校验代替人工搜索作为正常路径。
3.  统一处理”规则 → 同次诊断的原则候选 → 正式 Principle”的间接关系。
4.  统一处理”规则 → 上下文中已存在的正式 Principle”的直接关系。
5.  保留人工例外处置、覆盖、撤销、审计和历史可追溯能力。
6.  在 Scribe 调用前、Artificer/Evaluator
    执行前及最终规则发布/激活边界复验关系有效性。
7.  提供真实浏览器验收，证明正常流程确实不再需要手工绑定。

### 3.2 非目标

- 不建设通用向量库、知识图谱或独立语义搜索服务。
- 不以 Top-3 推荐替代来源关系契约。
- 不允许模型自由输出一个 `principleId` 后直接作为事实。
- 不自动创建 Principle 来填补 Rule Candidate 身份缺口。
- 不把 Rule Candidate 改为 Principle Candidate。
- 不自动批准规则、跳过代码评审、启用 hook、切换 shadow/live
  或触碰生产安装。
- 不把共享 Pain、同一 task、相似标题、相似文本或同一 artifact
  单独视为足够的归属证据。
- 不回写、改盖章或重解释旧 RuleCode 工件。
- 不新增平行 Principle Ledger 或第二个关系权威。

### 3.3 不可破坏的不变量

1.  **类型不变量**：rule 仍然是 `recommendation_kind='rule'`。
2.  **身份不变量**：只有 Ledger 中经校验的 canonical `principleId`
    可进入规则工件。
3.  **关系不变量**：一条规则最多有一个 canonical Principle
    归属；多目标语义不在本次 MVP 内，必须进入异常队列。
4.  **来源不变量**：系统只能根据可复验的来源契约自动关联，不能从搜索相似度猜测。
5.  **治理不变量**：归属关系 ≠ 规则审批 ≠ shadow/live 决策 ≠ 设计批准。
6.  **历史不变量**：旧工件、旧摘要、旧审批和旧激活记录不可因新解析而被改写。
7.  **失败不变量**：来源不可读、关系无效或冲突时不得降级成”无关系但继续生成”的成功路径。
8.  **幂等不变量**：同一 artifact/recommendation
    的重放不得创建重复关系或重复 revision。
9.  **可撤销不变量**：自动来源关系可以被 Owner
    明确覆盖或抑制；撤销关联不等于停用正在运行的规则。

------------------------------------------------------------------------

## 4. 目标架构与流程

``` text
Diagnostician Context（由系统提供可信原则集合与来源证据）
    ↓
Diagnostician Output V2
    ├─ Principle Recommendation（recommendationRef）
    └─ Rule Recommendation（recommendationRef + principleAssociation）
    ↓
DiagnosticianValidator
    ├─ 校验 schema / ref 唯一性 / 关系目标类型
    └─ 关系不成立时保留诊断候选，但标记为 unresolved，不信任该关联
    ↓
SqliteDiagnosticianCommitter
    ├─ 保存完整 V2 artifact
    ├─ 为各 recommendation 分配 candidateId
    └─ 保存含 recommendationRef / association 的 source_recommendation_json
    ↓
Candidate Association Resolver（唯一共享语义解析入口）
    ├─ target = 同 artifact 的 principle recommendationRef
    │      → 映射到 target candidateId
    │      → 沿 derivedFromPainIds / reuseEvidence 解析 canonical principleId
    ├─ target = 上下文中的 canonical principleId
    │      → 校验可信上下文、诊断依据、目标状态与 digest
    └─ 任何不确定 → exception queue / no Scribe call
    ↓
Scribe Preflight → Scribe → Artificer → Evaluator
    ↓               每个关键边界重验关系和目标版本
Rule Artifact Receipt
    ↓
现有 RuleCode 审批 → shadow → 独立 live 决策
```

### 4.1 两种允许的自动关联来源

**A. 同一诊断中的 Principle Recommendation**

规则的 `principleAssociation.target.recommendationRef` 指向同一 artifact
内的一条 `kind='principle'` recommendation。系统使用提交器已经持久化的
`source_recommendation_json`，在同一 `artifactId`
下找到唯一目标候选，再由共享身份解析器读取：

- `derivedFromPainIds` 中的候选来源关系；或
- `reuseEvidence[]` 中已经裁决的原则复用关系。

只有最终解析到一个合法 canonical `principleId`，规则才算
`resolved`。若原则候选还在等待 reuse/create
决策，则规则等待该候选解析，不得自行创建原则或要求 Owner
再做一次规则绑定。

**B. 可信上下文中的既有 Principle**

规则的 `principleAssociation.target.principleId`
指向系统在本次诊断输入中提供的 canonical Principle 集合，并且该 ID
必须与诊断输出中的某个 `violatedPrinciples[].principleId`
精确一致。系统必须验证该 ID
确实来自可信输入上下文，而不是仅相信模型输出。

若系统不能证明 ID
在本次输入的可信原则集合中，或者诊断没有对该原则的明确引用，则不自动关联，进入例外队列。不能因文本相似或同一个
Pain 自动补齐关系。

------------------------------------------------------------------------

## 5. Diagnostician Output V2 契约

### 5.1 版本策略

新增 `diagnostician-output-v2` 契约及对应 schema/prompt
版本。不得静默改变 `diagnostician-output-v1` 的含义。

- V1 输出继续可读取、可提交；缺少关联字段时一律按 `legacy_unlinked`
  处理，不自动猜测。
- 新启用的诊断生成路径使用 V2。
- 旧宿主或旧模型输出 V1 时，流程仍然兼容，但 Rule Candidate
  进入异常队列，除非已经存在有效 Owner binding。
- 在 V2 通过独立评估和 Owner 对 OD-01 作出明确批准前，自动关联只能运行在
  shadow/read-only 模式。

### 5.2 字段要求

每条 V2 recommendation 增加 artifact 局部引用：

``` ts
recommendationRef: string; // 在同一 DiagnosticianOutputV2 内唯一，不是 candidateId
```

每条 `kind='rule'` recommendation 必须提供
`principleAssociation`，其结构为以下联合类型：

``` ts
type PrincipleAssociation =
  | {
      status: 'linked';
      relation: 'implements';
      target:
        | { type: 'recommendation_ref'; recommendationRef: string }
        | { type: 'canonical_principle'; principleId: string };
      rationale: string;
      evidenceRefs: string[];
    }
  | {
      status: 'unresolved';
      reason:
        | 'no_supported_target'
        | 'ambiguous_target'
        | 'insufficient_evidence'
        | 'principle_not_in_context';
      candidateRecommendationRefs?: string[];
    };
```

契约说明：

- `recommendationRef` 只在一个 artifact
  内有效；不允许模型生成或声称数据库 `candidateId`。
- `target.type='recommendation_ref'` 必须指向同一输出中的唯一
  `kind='principle'` recommendation；不能指向
  rule、prompt、implementation 或 defer。
- `target.type='canonical_principle'` 必须匹配本次可信上下文中的
  Principle ID，并且与 `violatedPrinciples` 中的明确引用一致。
- `evidenceRefs`
  必须引用本次诊断可验证的证据源；不能引用不存在、不可读或由模型臆造的来源。
- 关系目标不允许数组；若一条规则实际需要多条原则，输出
  `ambiguous_target`，进入例外流程。
- `rationale` 用于审计解释，不单独构成关系证明。
- 诊断总体 `confidence` 或模型自报的关系置信度不得单独决定是否自动关联。
- `status='unresolved'`
  是合法诊断结果，不是模型调用失败；它不消耗额外重试预算。

### 5.3 系统侧关系校验

校验器必须区分”输出 schema 合法”与”关系可被信任”：

1.  检查 `recommendationRef` 非空且 artifact 内唯一。
2.  检查目标引用存在、唯一、类型正确、未形成非法引用环。
3.  对 canonical Principle
    目标，检查其存在于本次系统提供的可信上下文集合中，且和
    `violatedPrinciples` 中的 ID 精确一致。
4.  检查 `evidenceRefs`
    可追溯到可信输入证据；证据不可读或不匹配时，不自动关联。
5.  检查目标 Principle 在当前 Ledger 中存在，ID 合法，状态属于
    `candidate` / `probation` / `active`。
6.  检查目标的持久来源 kind 精确为
    `principle`；不得依赖标题、文本字段或默认值推断类型。
7.  对同 artifact 下的 recommendationRef，验证所有映射到的 candidate row
    均属于同一 artifact，且引用唯一。
8.  任何跨来源不一致、目标重复、缺字段或畸形数据，都产生结构化
    unresolved reason，不得选择”第一个匹配项”。

关系结构不合法时，可以保留已通过基础 schema 的诊断 artifact
和候选，以便审计；但必须将关联判为 unresolved，且不得继续到
Scribe。不得把失败关系静默删除后显示为自动关联成功。

------------------------------------------------------------------------

## 6. 持久化、解析权威与身份回执

### 6.1 优先复用现有持久化

本方案优先使用当前已经持久化的：

- artifact 的完整 `contentJson`；
- `principle_candidates.source_recommendation_json`；
- `artifactId`、`taskId`、`sourceRunId`；
- Principle Ledger 的 `derivedFromPainIds`；
- Principle Ledger 的 `reuseEvidence[]`；
- 已有 `ruleCandidateBindings`（仅用于 Owner 显式决定、覆盖和抑制）。

不为同一关系再建立一份平行表或另一个 JSON
权威。只有在实施审计证明现有持久化无法可靠恢复
recommendationRef-to-candidateId 映射时，才可提出最小 schema
迁移；不得先行假定必须增加新表。

### 6.2 共享解析结果

扩展共享身份解析契约，至少能够返回：

``` ts
type CandidateIdentityBasis =
  | 'derived_candidate'
  | 'principle_reuse'
  | 'owner_rule_binding'
  | 'source_declared_relation';

type CandidatePrincipleIdentityResolution =
  | {
      status: 'resolved';
      candidateId: string;
      principleId: string;
      basis: CandidateIdentityBasis;
      checkedAt: string;
      sourceArtifactId?: string;
      sourceRecommendationRef?: string;
      targetCandidateId?: string;
      relationDigest?: string;
      targetPrincipleDigest?: string;
      bindingRevision?: number;
      decisionId?: string;
    }
  | {
      status: 'unresolved';
      reason:
        | 'ledger_unavailable'
        | 'ledger_corrupt'
        | 'candidate_missing'
        | 'candidate_kind_invalid'
        | 'missing'
        | 'ambiguous'
        | 'conflicting_authorities'
        | 'target_missing'
        | 'target_ineligible'
        | 'binding_revoked'
        | 'source_relation_invalid'
        | 'source_relation_stale'
        | 'source_relation_suppressed'
        | 'related_candidate_unresolved';
      nextAction: string;
    };
```

具体实现可按现有代码风格调整字段名，但不得丢失以上语义区分。若现有同步
resolver 无法安全加载候选
artifact，应新增窄的异步共享解析入口并迁移全部生产消费者；禁止某些消费者使用新关系、另一些消费者继续用旧的宽松
ID 逻辑。

### 6.3 解析顺序

对 `candidateKind='rule'`：

1. 读取候选的持久原始 kind；不是精确 `rule` 则拒绝。
2. 加载候选、来源 artifact、run/task/父任务（适用时），验证 lineage 一致。
3. 从该候选持久的 V2 recommendation 读取 `principleAssociation`，重算 `relationDigest`。
4. 读取 `ruleCandidateBindings` 中该候选的最新有效 revision，并严格按下列优先级处理：
   - 最新 revision 为 `bind`：先验证 Owner 决定、目标 Principle 和 revision。若来源关系存在且目标一致，解析 basis 为 `owner_rule_binding`；若目标不同，只有 `overridesSourceRelationDigest` 与当前 `relationDigest` 精确一致时才允许覆盖，否则返回 `conflicting_authorities`。若来源关系已变化或失效，不得沿用旧 override。
   - 最新 revision 为 `revoke`：返回 `binding_revoked`，不自动回退到来源关系。该规则保持 unresolved，直至 Owner 明确重新绑定，或通过 `restore_source_relation` 明确允许当前来源关系恢复。旧 receipt 不得复活已撤销的决定。
   - 最新 revision 为 `suppress_source_relation`：若当前 `relationDigest` 与记录的 `sourceRelationDigest` 一致，返回 `source_relation_suppressed`。该动作只能在没有有效 Owner binding 时执行；如需先撤销 Owner binding，必须先写入 `revoke`，再单独执行 suppress。
   - 最新 revision 为 `restore_source_relation`：仅当当前来源关系存在、有效，且 `relationDigest` 与记录的 `sourceRelationDigest` 精确一致时，才继续解析来源关系；否则返回 `source_relation_stale` 或 `missing`，进入例外队列。该动作恢复的是系统来源关系，不是 Owner binding。
   - 无 Owner revision：验证并解析来源关系；缺少可信来源关系时返回 `missing`。
5. 若来源关系目标是同 artifact 的 Principle Candidate，递归/委托解析该 Principle Candidate 的 canonical identity；必须检测循环并限制解析深度。目标候选未完成 reuse/create 决策时返回 `related_candidate_unresolved`。
6. 校验 canonical Principle 当前存在、状态合格、原始来源类型合法。
7. 生成带有来源 artifact、recommendationRef、relationDigest、目标 Principle digest 和 `checkedAt` 的派生回执。
8. 在 Scribe 前、Artificer/Evaluator 前及最终批准/激活前重新检查关系和目标摘要。

对 `candidateKind='principle'`，继续沿现有 `derivedFromPainIds` / `reuseEvidence[]` 解析；所有匹配必须完整扫描。多个不同目标一律 ambiguous/conflict，不得使用 first-match。

### 6.4 目标版本与新鲜度

- `principleId`
  是稳定身份，但原则正文、状态、版本或关键语义发生变化时，旧关系回执不能被当作永远新鲜。
- `relationDigest` 覆盖来源 artifact、规则 recommendation
  的关系声明、目标引用和证据引用。
- `targetPrincipleDigest` 覆盖目标 Principle
  的身份、状态、版本及用于判断关系的关键内容。
- 在生成/发布关键边界，如果 `relationDigest` 或 `targetPrincipleDigest`
  与当前值不一致，返回 `source_relation_stale`
  并进入例外队列；不能静默把旧回执升级为新版本。
- 纯展示字段变化是否影响 digest，实施时须通过明确的 canonical digest
  函数定义，不能由各消费者自行拼接。

### 6.5 工件回执

新的 Scribe/RuleCode 工件应写入派生 `identityResolution`
回执，至少包含：

``` ts
{
  candidateId: string;
  principleId: string;
  basis: 'source_declared_relation' | 'owner_rule_binding';
  sourceArtifactId?: string;
  sourceRecommendationRef?: string;
  targetCandidateId?: string;
  relationDigest?: string;
  targetPrincipleDigest: string;
  bindingRevision?: number;
  decisionId?: string;
  checkedAt: string;
}
```

此回执是”生成时依据什么解析到该身份”的证据，不是第二权威。消费端必须回到
Ledger 和来源 artifact 复验；不能仅因工件自带 `principleId`
就信任它。回执缺失、伪造、错目标或摘要过期都应 fail closed。

------------------------------------------------------------------------

## 7. Owner 例外处理：从默认路径降为异常路径

### 7.1 正常情况下的 UI

当规则已经通过 `source_declared_relation` 解析：

- 不出现在”待关联”队列。
- 不要求 Owner 打开搜索框或点击绑定。
- 在规则详情中以只读信息显示：目标原则、关联依据、来源诊断、关联版本、当前有效性。
- 明确标记”系统依据来源关系解析”，不得伪称”Owner 已批准”。
- 规则仍需通过既有 RuleCode 审批与 shadow/live 门禁。

### 7.2 仅以下情况进入例外队列

- V1 历史候选或 V2 缺少关系声明；
- `status='unresolved'`；
- recommendationRef 缺失、重复、目标不存在或类型错误；
- 目标 Principle 不在可信上下文中；
- 关联的 Principle Candidate 尚未完成 canonical identity 解析；
- 多个关系来源指向不同 Principle；
- Owner binding 与来源声明冲突；
- 目标 Principle 已归档、废弃、不可读或关键摘要发生变化；
- Ledger、候选库或来源 artifact 不可用；
- 来源关系已被 Owner 明确抑制或撤销。

### 7.3 例外 UI 要求

- 默认只展示例外项；不能为了让界面”有内容”而把所有正常规则都放进人工队列。
- 每项默认展示失败原因、规则短描述与下一步；展开后查看规则正文、触发条件、动作、Pain/诊断证据、来源
  artifact、关联声明、失败原因、候选原则全文/状态/版本及下一步建议。
- 只有在确实存在可解释候选时，才默认推荐最多 3
  个；推荐理由必须说明具体依据。
- 提供完整候选浏览和搜索作为后备，但必须显示搜索范围、是否截断以及”无结果不等于无合适原则”的提示。
- 不允许根据语义相似度直接写入正式关系。
- Owner 可选择：绑定到某个已验证
  Principle、明确抑制来源关系、覆盖一个冲突来源关系，或保持未关联并回到原则形成流程。
- 对自动关联作出的覆盖必须记录 `overridesSourceRelationDigest`
  和理由；对来源关系的抑制必须记录被抑制的 `relationDigest`。不能用普通
  bind 隐式覆盖另一个来源。
- 归属操作与规则批准、生产激活必须使用不同文案、API 和审计事实。
- 撤回/抑制关系不自动停用已运行规则；UI
  必须提供既有停用/紧急暂停入口及明确边界说明。

### 7.4 Owner 决定记录

继续复用当前 Ledger `ruleCandidateBindings` 作为 Owner 决定的权威记录，但明确区分动作：

- `bind`：Owner 显式建立或覆盖关系。若覆盖当前来源关系，必须显式绑定到当前 `relationDigest`。
- `revoke`：撤回当前 Owner binding；不删除历史，并且**不自动回退到来源关系**。该动作产生 `binding_revoked`，防止 Owner 撤回后系统关联意外复活。
- `suppress_source_relation`：Owner 明确拒绝当前来源声明，持久化被抑制的 `sourceRelationDigest`，防止同一关系自动复活。仅当没有有效 Owner binding 时可执行；需要撤销 binding 时必须先 revoke，再 suppress。
- `restore_source_relation`：Owner 明确允许先前被撤销/抑制的来源关系重新参与解析。只对与当前关系 digest 完全一致的关系有效，不恢复 Owner binding，也不接受过期或已变化的关系。

新写入必须使用严格的 TypeScript discriminated union，不得以所有字段可选的单一 interface 弱化校验。语义契约如下：

```ts
type RuleCandidateBindingRevision =
  | {
      revision: number;
      decisionId: string;
      requestId: string;
      action: 'bind';
      principleId: string;
      reason: string;
      decidedAt: string;
      owner: { actorId: string; source: 'authenticated_console' };
      reviewedCandidateDigest: string;
      reviewedPrincipleDigest: string;
      overridesSourceRelationDigest?: string;
    }
  | {
      revision: number;
      decisionId: string;
      requestId: string;
      action: 'revoke';
      principleId: string;
      reason: string;
      decidedAt: string;
      owner: { actorId: string; source: 'authenticated_console' };
      reviewedCandidateDigest: string;
      reviewedPrincipleDigest: string;
    }
  | {
      revision: number;
      decisionId: string;
      requestId: string;
      action: 'suppress_source_relation' | 'restore_source_relation';
      sourceRelationDigest: string;
      reason: string;
      decidedAt: string;
      owner: { actorId: string; source: 'authenticated_console' };
      reviewedCandidateDigest: string;
    };
```

此类型是新写入的语义示例。读取旧 Ledger 时，必须继续按历史 schema 读取既有 `bind` / `revoke` revision（包括原有 `principleId`、`reviewedCandidateDigest`、`reviewedPrincipleDigest` 字段），不得将旧记录误判为损坏，也不得把缺少新字段的旧 revision 解释成 `suppress` 或 `restore`。

- `bind` 覆盖自动来源关系时，服务端必须验证 `overridesSourceRelationDigest` 与当前 `relationDigest` 完全一致。
- `suppress_source_relation` / `restore_source_relation` 必须携带 `sourceRelationDigest`，并执行 `expectedRevision`、幂等键、Owner 身份及当前来源关系 digest 的 CAS 校验。
- `restore_source_relation` 仅在最新状态为 `revoke` 或 `suppress_source_relation` 时允许；它必须针对当前可验证的来源关系，不能清除目标缺失、来源损坏或 digest 不匹配等错误。
- `revoke` 不等于停用规则；`suppress_source_relation` 不等于撤销规则审批；`restore_source_relation` 不等于重新批准或激活规则。
- 所有动作都追加不可变 revision，不覆盖历史。body 不得提供 actor、决定时间或认证来源；这些字段由服务端生成。

所有写入仍由现有 Ledger 单写者、文件锁、CAS/revision、幂等键和摘要校验保护。新增动作不创建平行 authority，不新增第二份绑定事实存储。

------------------------------------------------------------------------

## 8. 生产消费者与执行边界

以下消费者必须统一使用共享身份解析语义，不能只修 Console 读模型：

1.  `packages/principles-core/src/runtime-v2/internalization/scribe-runner.ts`
2.  `packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts`
3.  `packages/principles-core/src/runtime-v2/activation/ledger-identity.ts`
    与 activation dispatcher/最终提交边界
4.  `packages/pd-cli/src/services/rulehost-pipeline-runner.ts`
5.  `packages/pd-console/src/server/models/principle-id-resolution.ts`
6.  `packages/pd-console/src/server/models/artifact-principle-resolver.ts`
7.  `OwnerDecisionConsoleModel`、`ApprovalsGroupedConsoleModel`、`ApprovalsConsoleModel`
    等真实消费身份的读模型
8.  Host runtime 和 CLI run-once 的所有共享 resolver 构造点。

要求：

- 关系 unresolved 时，在首次 Scribe 模型调用之前停住，不消耗模型 attempt，不把“等待身份决定”记录为模型失败或成功。
- 当唯一阻塞原因是 `related_candidate_unresolved`，且目标 Principle Candidate 后续已通过既有 intake/reuse 流程解析为 canonical identity 时，只有在 OD-04 获批后，才可通过现有 runner 的受控恢复机制自动续接一次。恢复请求必须幂等，至少以 `candidateId`、`sourceArtifactId`、`relationDigest` 和目标 `principleId`/digest 组成稳定去重键；同一解析状态最多续接一次。若初始 preflight 已可解析，不额外触发恢复。
- `restore_source_relation` 只有在 OD-04 获批且当前来源关系完整有效时，才可触发同一受控恢复一次；`revoke` 和 `suppress_source_relation` 不触发恢复。`binding_revoked`、`source_relation_suppressed`、`source_relation_stale`、`source_relation_invalid`、`ledger_corrupt`、`ledger_unavailable`、冲突或来源缺失均不得自动恢复。不得新增后台服务或绕过现有 runner、授权和重试预算。
- 在 Artificer/Evaluator
  前和最终发布/批准/激活前重验当前关系与目标摘要。
- 关系校验不得注册全局工具拦截，不得阻断 Console
  登录、原则审阅、规则停用、紧急暂停和恢复入口。
- `rule → prompt` 的既有降级逻辑继续有效，但降级不能产生正式 Principle
  identity，也不能绕过关系校验。
- 对在最终检查之前已经进入的在途操作，不承诺撤销动作能取消所有本地提交。响应必须如实报告
  `inFlightOperationsMayComplete: true`；撤销之后进入最终检查的新请求必须拒绝。
- 自动关联不得创建 activation、approval、shadow 或 live
  状态；不得改变既有规则的状态。

------------------------------------------------------------------------

## 9. 分阶段实施与启用策略

### Phase 0 — Reality audit 与兼容性证明

- 在专用 worktree 中核对当前 main、所有 resolver 构造点和生产消费者。
- 找到并列出 `diagnostician-output-v1` 的所有生产生成者/消费者及 schema
  版本传递链。
- 验证现有 `source_recommendation_json` 能否无损保存 V2 字段并从同一
  artifact 恢复 recommendationRef 映射。
- 不修改生产行为，不回填历史数据。
- 输出文件级差异计划、schema 兼容矩阵和回滚方案。

### Phase 1 — V2 契约、解析器与 shadow 模式

- 新增 V2 schema/prompt 和严格结构校验。
- 保存关系声明；构建共享 resolver、digest 和 identity receipt。
- 对现有 V1 与缺少关系的 V2 候选输出”如果启用自动关联会如何处理”的
  shadow 结果。
- Shadow 结果只记录，不绕过当前 Owner
  binding；不改变生成、审批或激活行为。
- 完成离线正例、负例、冲突、旧数据和重放测试。

### Phase 2 — 独立评估与 Owner 决策

启用自动关联前必须满足：

- 独立标注集至少覆盖 100 个样本，其中不少于 50 个可自动关联样本、不少于
  50 个不应自动关联/歧义/冲突样本；若实际数据不足，继续
  shadow，不得降低门槛。
- 自动关联精确率至少 99%，并且对伪造 ID、跨 artifact 引用、错误
  recommendation kind、未裁决 reuse、目标状态失效等关键负例实现 0
  次误关联。
- 自动关联判定必须可由确定性校验重放；模型自报 confidence
  不作为唯一通过条件。
- 对”文本高度相似但没有可信关系”“同一 Pain 但目标不明确”“模型给出高
  confidence 但引用无效”的反例全部拒绝自动关联。
- Owner 明确批准 OD-01，确认新关系契约可作为身份解析依据，而不是 Owner
  批准或生产授权。

### Phase 3 — 有限自动解析启用

- 仅对 V2 且满足全部确定性关系条件的新候选启用自动解析。
- 若规则因目标 Principle Candidate 尚未完成 reuse/create 决策而阻塞，目标解析完成后仅在 OD-04 获批时调用既有受控恢复机制一次；OD-04 未批准时不得自动续接。
- V1、缺关系、歧义、冲突和不可读情况继续进入例外队列。
- 不自动回填旧工件，不自动迁移旧 RuleCode 的 sourcePrincipleId。
- 监控自动解析精确率、例外率、关系 stale 率和下游阻断率。
- 一旦出现确认的错误自动关联，立即关闭自动解析入口或回退到 shadow
  模式；保留来源证据和审计记录，不删除已形成的数据。

### Phase 4 — UI 收敛

- 正常已解析规则只显示只读归属信息。
- 绑定搜索只对异常队列可见。
- 完成真实浏览器验收后，才可声明”常规规则归属不再需要人工搜索”。
- 未完成真实浏览器验收，不得仅以 TypeScript build、单元测试或 API
  测试宣称完成。

------------------------------------------------------------------------

## 10. 测试与验收矩阵

### 10.1 契约与持久化

| ID  | 场景                                                                | 必须结果                                        |
|:----|:--------------------------------------------------------------------|:------------------------------------------------|
| A01 | V2 所有 recommendation 有唯一 recommendationRef                     | 合法通过；重复/空 ref 不能被信任                |
| A02 | V1 旧输出无关联字段                                                 | 兼容读取；不自动关联；进入 legacy exception     |
| A03 | rule 引用同 artifact 的 principle recommendationRef                 | 映射到唯一 candidateId，后续身份解析准确        |
| A04 | rule 引用不存在/重复/跨 artifact 的 ref                             | unresolved，零自动关联、零 Scribe 调用          |
| A05 | rule 引用 `kind=rule/prompt/implementation/defer` 的目标            | 拒绝关联                                        |
| A06 | canonical principleId 不在可信输入上下文或不匹配 violatedPrinciples | 拒绝自动关联                                    |
| A07 | 关系 evidenceRef 不存在或不在可信来源中                             | 拒绝自动关联                                    |
| A08 | source_recommendation_json / artifact content 损坏                  | typed unavailable/corrupt，不回退猜测           |
| A09 | 重放相同 artifact/commit                                            | 不创建重复候选关系、binding revision 或 receipt |

### 10.2 身份解析与治理

| ID  | 场景                                                          | 必须结果                                                           |
|:----|:--------------------------------------------------------------|:-------------------------------------------------------------------|
| B01 | target principle candidate 已通过新建路径入 Ledger            | 解析到其 canonical principleId                                     |
| B02 | target principle candidate 已通过 Owner reuseEvidence 复用    | 解析到复用目标的 canonical principleId                             |
| B03 | target principle candidate 仍等待 reuse/create 决定           | `related_candidate_unresolved`；不要求再次绑定 rule                |
| B04 | 同一 candidate 的 derived/reuse 关系指向多个目标              | ambiguous/conflict，不使用 first-match                             |
| B05 | Principle archived/deprecated/missing                         | 不解析为可用身份，进入例外队列                                     |
| B06 | Principle digest/version 在生成后变化                         | `source_relation_stale`，最终发布被阻断                            |
| B07 | Owner binding 与 source relation 相同                         | 使用同一目标，保留正确的 Owner 审计事实                            |
| B08 | Owner binding 与 source relation 不同且无显式 override digest | `conflicting_authorities`                                          |
| B09 | Owner 显式覆盖来源关系                                        | 必须有匹配 digest、认证 actor、理由、CAS 和不可变 revision         |
| B10 | Owner suppress source relation                                | 同一 relationDigest 不得再次自动复活                               |
| B11 | Owner revoke binding                                          | 不删除历史；不得让旧 receipt 复活；运行规则状态不被伪称已停用      |
| B12 | Ledger/SQLite/artifact source 不可读                          | fail closed，展示明确 nextAction，不把 unavailable 伪装成 no-match |
| B13 | Owner revoke 当前 binding，但没有显式 restore 来源关系 | `binding_revoked`；不自动回退来源关系，旧 receipt 不得复活 |
| B14 | restore 来源关系时当前 relationDigest 与记录不一致 | 拒绝恢复，返回 stale/unresolved 并进入例外队列 |
| B15 | 对存在有效 Owner binding 的候选直接 suppress 来源关系 | 拒绝操作；必须先 revoke，再单独 suppress |

### 10.3 运行时与安全边界

| ID  | 场景                                       | 必须结果                                      |
|:----|:-------------------------------------------|:----------------------------------------------|
| C01 | source relation 有效                       | Scribe 获得解析回执；不要求人工搜索绑定       |
| C02 | source relation unresolved                 | 首次 Scribe 调用前停止，模型 attempt 不增加   |
| C03 | 模型调用期间关系或目标版本变化             | 后续 Artificer/Evaluator/发布前复验失败并停止 |
| C04 | Owner binding 被 revoke 或来源关系被 suppress 后有新请求到达最终检查 | unresolved/拒绝；不得从旧工件或缓存恢复身份；只有显式 restore 才可重新解析来源关系 |
| C05 | 旧 RuleCode 工件 sourcePrincipleId 为 null | 保持原样，不回填、不覆盖                      |
| C06 | source relation 成功                       | 不自动创建 approval/activation，不自动 live   |
| C07 | rule→prompt 降级                           | 不生成 Principle identity，不绕过类型检查     |
| C08 | 无关联但高文本相似/高模型 confidence       | 不自动关联                                    |
| C09 | 相同 Pain 或同任务有多个 Principle         | 不因共享来源而自动选第一个                    |
| C10 | 所有正常和异常消费者                       | 使用同一解析语义；无宽松旁路                  |
| C11 | 目标 Principle Candidate 从 unresolved 变为 resolved | 仅 OD-04 获批时通过现有 runner 幂等续接一次；不重复消耗重试预算、不批准/激活规则 |

### 10.4 Console 与真实浏览器

必须使用真实浏览器启动实际 Console，使用认证 Owner 会话验证，不能只 mock
API 或直接调用 model。

1.  登录后打开 Governance
    Focus，确认页面正常且未登录请求不能读取受保护数据。
2.  创建/使用一个 V2
    正常关联样本，运行真实诊断和候选提交链；确认规则被自动解析到预期
    canonical Principle。
3.  刷新页面、重新打开详情并重启 Console 后，归属仍一致；详情能显示
    relation basis、source artifact、target Principle 和当前版本。
4.  确认正常规则不出现在人工待绑定队列，Owner 不需要搜索、选择或点击
    bind。
5.  创建无关联、错误 ref、未裁决 reuse、冲突、stale digest、旧 V1
    样本；确认它们进入例外队列，并显示具体原因而非泛化”无结果”。
6.  对异常样本执行 Owner bind、override、suppress、restore、revoke；刷新后核对
    Ledger revision、digest、actor、reason 和 resolver 结果。
7.  确认绑定/覆盖/撤销操作不会批准规则、创建 activation、切换
    shadow/live 或触碰生产安装。
8.  验证浏览器控制台无未处理错误；记录实际 URL、截图、关键 API
    请求/响应、样本 candidateId、artifactId、relationDigest
    和最终解析结果。
9.  至少验证桌面宽屏和窄视口下队列/详情可读；不把向下堆叠的大量候选作为正常主路径。
10. 真实浏览器证据未完成时，验收状态必须为 `NOT_RUN` /
    `UNKNOWN`，不得报告完成。

------------------------------------------------------------------------

## 11. 可观测性与指标

每次关系解析应记录结构化、可重放的事件；不得记录不必要的原始私密对话。

至少记录：

- `candidateId`、`artifactId`、`recommendationRef`；
- `relationDigest`、目标 candidateId 或 principleId；
- resolver basis、resolution status/reason；
- 目标 Principle digest/version；
- 是否进入 exception queue；
- Scribe 是否被阻断、是否消耗模型 attempt；
- Owner override/suppress/restore/revoke 的 `decisionId`、revision、reason；
- 最终规则工件 ID 与其 `identityResolution` 回执；
- 规则审批/activation 仅记录关联 ID，不把它们合并成归属事件。

指标：

- V2 关系字段覆盖率；
- 新 Rule Candidate 自动解析率；
- 自动解析精确率与独立抽检错误率；
- 例外队列率与原因分布；
- stale/conflict/unavailable 比率；
- Owner 每 100 条新规则的人工绑定次数；
- 因 unresolved 产生的模型调用次数（目标为 0）；
- 自动关联错误后的回滚时长；
- 正常规则的 approval/activation 行为是否与改造前保持独立。

**不得以”自动关联率越高越好”为唯一优化目标。**
对无法证明的关系，进入例外队列是正确结果。

------------------------------------------------------------------------

## 12. 兼容、迁移与回滚

### 12.1 兼容

- V1 schema 和旧 artifact 继续可读。
- 不回写历史 artifact 的 `contentJson` 或 `source_recommendation_json`。
- 不批量把相似文本、相同 Pain 或同 task 的旧 Rule Candidate 绑定到原则。
- `ruleCandidateBindings` 历史 revision 不重写；新增 override/suppress
  字段为可选字段。
- 如果实现需要数据库迁移，必须先在 Phase 0 证明现有 JSON
  来源无法满足映射，并给出单独
  migration、旧数据升级、重开数据库、兼容回退测试；默认不新增表。

### 12.2 回滚

- 首选关闭自动关联启用开关并回退至 shadow/Owner exception
  路径，不删除任何关系声明、回执或 Owner 决定。
- 回滚不能把已经生成的新工件伪装成旧身份，也不能删除旧 artifact 或治理
  revision。
- 对已发现的错误关联，保留原始 source artifact，新增 Owner
  suppression/override
  事实，阻止相同关系再次自动生效；必要时使用既有停用/紧急暂停能力单独处理运行中的规则。
- 禁止以回退代码代替规则停用，禁止以撤销关联声称生产规则已停止。
- 若新 schema
  字段被旧版本覆盖时会丢失，禁止直接回退到不兼容构建；必须使用保留字段的兼容构建。

------------------------------------------------------------------------

## 13. 实施文件范围与职责

实施前必须以当前 main
重新核对文件和所有构造点；下列为预期修改面，不是未经审计的绝对清单。

| 区域                                                                           | 责任                                                                                            |
|:-------------------------------------------------------------------------------|:------------------------------------------------------------------------------------------------|
| `runtime-v2/diagnostician-output.ts` 及调用 schema ref 的代码                  | V2 output contract，保留 V1 兼容                                                                |
| `runtime-v2/diagnostician-prompt-builder.ts` 与实际生成入口                    | 将可信 Principle 上下文和关系声明契约传入模型；不要求额外模型调用                               |
| `runtime-v2/runner/default-validator.ts` 及相关验证层                          | 校验 recommendationRef、关系结构和可验证引用                                                    |
| `runtime-v2/store/commit/diagnostician-committer.ts`                           | 保存 V2 原始关系，保持候选 ID 分配和提交幂等                                                    |
| `runtime-v2/types/rule-candidate-binding.ts` / Ledger adapter                  | 扩展解析结果类型，保持 Owner binding 与系统来源关系分离                                         |
| `principle-tree-ledger.ts`                                                     | 只实现 Owner binding/override/suppress 的锁、CAS、摘要与审计写入；不把系统声明伪造成 Owner 决定 |
| `candidate-intake-service.ts` / Principle reuse 入口                           | 让 rule 关系等待目标 Principle Candidate 的真实解析结果，不复制 reuse authority                 |
| `internalization/scribe-runner.ts`、`evaluator-runner.ts`、activation identity | 生成前、验证前、发布前复验身份和 digest                                                         |
| `pd-cli/services/rulehost-pipeline-runner.ts`、host runtime / run-once 构造点  | 接入同一解析语义，禁止旁路                                                                      |
| Console rule binding model / routes / `RuleCandidateBindingPanel.tsx` / i18n   | 正常关联只读展示；异常队列保留 Owner 决策能力                                                   |
| `principle-id-resolution.ts`、`artifact-principle-resolver.ts` 与真实读模型    | 统一显示 resolved / conflict / unavailable / stale 状态                                         |

禁止只改 UI、只改 resolver、只加单元测试而不验证真实生成和提交路径。

------------------------------------------------------------------------

## 14. 需要显式确认的 Owner 决策

### OD-01 — 是否批准”来源关系可作为自动身份解析依据”

**提议**：对于 V2 且满足本 SPEC 全部确定性校验的 source-declared
relation，系统可自动解析 canonical `principleId`，不再要求 Owner
对每条规则显式绑定。Owner 绑定改为异常、覆盖和抑制机制。

**这会修改** `SPEC-RULECODE-GOVERNANCE-CLOSURE-003-v0.1.md` 中”直接 rule
候选由认证 Owner 显式关联既有
Principle”的默认流程，但不修改”身份关联、规则审批、shadow/live
是不同事实”的治理边界。

- 若批准：先 shadow，达到独立评估门槛后才启用自动关联。
- 若不批准：不得启用自动关联；可实施 V2 关系保存、只读 shadow
  解析、异常说明和搜索体验优化，但正常规则仍按当前 Owner binding
  规则处理。
- 不论批准与否：都禁止自动批准规则、自动激活、伪造 Owner
  审计事实或回填旧工件。

### OD-02 — 自动关联的上线质量门槛

确认是否接受第 9 节门槛：至少 100 个独立标注样本、自动关联精确率至少
99%，关键负例 0 次误关联；样本不足时继续 shadow。

### OD-03 — 一条 Rule Candidate 的归属基数

本 MVP 保持”一条规则最多关联一个 canonical
Principle”。若未来需要一条规则正式落实多条原则，应单独定义多对多关系、冲突处理和运行时语义；本次不静默扩展。

------------------------------------------------------------------------

### OD-04 — 关系变为可解析后是否允许一次受控自动恢复

**提议**：当 Rule Candidate 仅因目标 Principle Candidate 尚未完成 reuse/create 决策而阻塞，且目标随后被既有流程解析为 canonical identity 时，系统可使用现有 runner 的受控恢复机制自动续接一次；`restore_source_relation` 在当前关系完整有效时同样可触发一次恢复。该行为不增加重试预算、不创建新后台服务、不绕过认证/治理门禁，也不批准或激活规则。

- 若批准：必须实现稳定幂等键、at-most-once 恢复、真实运行证据和重复事件负控。
- 若不批准：自动关系解析仍可作为只读结果展示，但被阻塞的任务不得因本 SPEC 自动续接，必须留在既有授权恢复流程中。
- `revoke`、`suppress_source_relation`、冲突、stale、来源缺失/损坏和 Ledger 不可用均不允许自动恢复。

------------------------------------------------------------------------

## 15. 最终自评与交付门槛

本 SPEC 相比”Top-3 推荐”方案的实质改进：

1.  把关系产生点从 UI 前移到诊断输出和候选提交。
2.  通过 `recommendationRef` 解决模型生成时无法预知数据库 `candidateId`
    的问题。
3.  通过同 artifact 关系映射与现有 `derivedFromPainIds` /
    `reuseEvidence[]` 解析，避免把 Candidate ID 当作 Principle ID。
4.  通过可信上下文校验、证据引用、目标类型和摘要校验，避免仅凭模型自报
    ID、文本相似或 confidence 自动绑定。
5.  通过独立 resolver、回执和关键边界复验，避免 Console
    看似已关联而真实生成/审批路径仍丢失身份。
6.  将 Owner 搜索降为异常流程，同时保留覆盖、抑制、撤销和完整审计。
7.  明确承认 OD-01 是对已批准治理规范的变更，不暗中改变 Owner 授权语义。
8.  规定 shadow
    阶段、独立评估、回滚条件和真实浏览器验收，避免”测试全绿但生产路径没接通”。

### 自检结论

- **架构方向**：满足”源头建立关系、系统自动解析、异常才找 Owner”的目标。
- **类型与身份**：没有混用 `recommendationRef`、`candidateId` 和
  `principleId`。
- **安全与治理**：自动关联不授予审批或激活权；缺证据、冲突和过期均 fail
  closed。
- **历史兼容**：V1 与旧工件不回填、不改写。
- **状态机自检**：撤销 Owner binding 不会隐式重新启用来源关系；恢复来源关系必须是显式 Owner 决定且 digest 精确匹配。
- **剩余显式决策**：OD-01/02/03/04 必须由 Owner 确认；在 OD-01 获批前，自动关联不得改变当前生产行为；在 OD-04 获批前，不得因身份解析完成而自动续接被阻塞任务。
- **实施状态**：本文件是待审设计 SPEC，不代表代码已实现、CI
  已通过、浏览器已验收或生产已部署。

------------------------------------------------------------------------

## 16. 源码依据

- [Diagnostician output
  schema](https://github.com/csuzngjh/principles/blob/main/packages/principles-core/src/runtime-v2/diagnostician-output.ts)
- [Diagnostician
  committer](https://github.com/csuzngjh/principles/blob/main/packages/principles-core/src/runtime-v2/store/commit/diagnostician-committer.ts)
- [Candidate intake
  service](https://github.com/csuzngjh/principles/blob/main/packages/principles-core/src/runtime-v2/candidate-intake-service.ts)
- [Principle tree
  ledger](https://github.com/csuzngjh/principles/blob/main/packages/principles-core/src/principle-tree-ledger.ts)
- [Rule candidate binding
  types](https://github.com/csuzngjh/principles/blob/main/packages/principles-core/src/runtime-v2/types/rule-candidate-binding.ts)
- [Principle tree ledger
  adapter](https://github.com/csuzngjh/principles/blob/main/packages/principles-core/src/runtime-v2/adapter/principle-tree-ledger-adapter.ts)
- [RuleCode governance closure
  SPEC](https://github.com/csuzngjh/principles/blob/main/docs/specs/SPEC-RULECODE-GOVERNANCE-CLOSURE-003-v0.1.md)
- [Principle reuse
  SPEC](https://github.com/csuzngjh/principles/blob/main/docs/specs/PRI-917-reuse-before-create-v0.1.md)
- [Rule candidate binding Console
  model](https://github.com/csuzngjh/principles/blob/main/packages/pd-console/src/server/models/RuleCandidateBindingConsoleModel.ts)
- [Rule candidate binding
  panel](https://github.com/csuzngjh/principles/blob/main/packages/pd-console/src/ui/pages/focus/RuleCandidateBindingPanel.tsx)


## 17. 本版范围、既有控制台规范与实施准入

本项解决规则身份形成，不承担整体控制台改版。继续继承控制台融合 v0.2 的逐对象决定、阅读版本与写入目标一致、审批与激活结果分离、来源独立降级、权限未知时锁定、真实浏览器与真实缩放验收。身份关联不能解除这些约束，也不能替代 RuleCode 治理规范的独立审批与上线门禁。

当前批准请求分层：

- 本版设计审阅不等于代码授权。OD-01/02/03 均保持待决。
- 首轮实施申请只包含可信上下文证据、V2 来源保存、共享只读解析、shadow 与独立评估；不得因写入 V2 而静默切换当前默认生成路径。
- 自动关联成为实际生成依据，须 OD-01/02/03 获批、读写兼容与消费者接线验证完成、启用控制与回退明确后另行批准启用。
- OD-04 自动续接延后，首轮不实现其调度、持久恢复去重或自动触发。现有合法人工恢复路径保留。未来须给出真实 runner 入口、持久 claim/幂等存储、崩溃窗口、重复投递与恢复测试，不能仅凭稳定字符串承诺 at-most-once。
- 任何例外只阻止受影响对象的生成/提交，不阻止 Console 登录、其他原则阅读、停用或紧急暂停。

## 18. 可信上下文的证据契约

已有 prompt input 的 contextHash/sourceRefs 和诊断 artifact contentJson 是可复用线索，但本版尚未证明它们能完整恢复当次模型可见原则集合。当前 Ledger、模型回传 ID 或单独一个 hash 均不能证明当时输入了什么。

Phase 0 必须固定以下生产链，列出实际文件、字段、读写方和恢复测试：

1. 系统在调用模型前，从可信来源构造诊断输入；记录 task/run、context/schema/prompt 版本。
2. 保留本次实际可见的 canonical principleId 集合、语义版本/内容摘要，以及 evidenceRef 到可信来源及读取范围的映射。保存位置优先复用现有不可变输入/工件记录，不另建关系权威。
3. 将不可变上下文引用和完整性摘要绑定到提交的诊断 artifact；重启后能从该引用恢复同一集合。摘要的 canonical 编码、字段集合、排序及版本必须固定。
4. 校验器检查输出目标与引用均在该快照内，再分别校验当前 Ledger 资格。不可读、错 run、错 contextHash、引用范围不一致一律 typed unavailable/conflict，不退回当前原则列表猜测。
5. 只保存所需范围，不复制完整私人对话或将可信快照写入公开日志。

若既有存储不能满足，提交最小持久契约扩展及兼容/保留期限设计，获批前阻塞依赖此证明的自动关联。不得以“Phase 0 会处理”作为已验证标记。

## 19. 引用有效性与语义归属正确性

确定性校验能证明目标存在、引用合法、版本匹配和来源一致；不能单独证明模型提出的 implements 关系在含义上正确。文中“来源关系有效”分成两个独立维度：

- structuralValidity：可确定性重放的身份/来源/版本检查。
- semanticEvaluation：独立标注对“规则是否落实该原则、是否引入无依据限制”的判断；不是 resolver 从模型 rationale 自证。

新增关键反例：目标确在输入中、violatedPrinciples 引用了它、所有 evidenceRefs 都存在，但规则与目标原则无关或扭曲范围。结构检查可以通过，独立质量评估必须计为错误，不能当作自动关联成功样本。

自动启用后的语义正确性属于经过评估后接受的剩余风险，不得宣称被确定性校验完全消除。Owner 明确接受该风险前维持 shadow；不新增模型复核调用作为隐式补救。人工发现错关联时，依既有停用能力处理运行风险，再以抑制/覆盖记录关系决定。

## 20. 撤销、抑制、恢复的完整约束

最新 revision 用于并发控制；有效权限必须折叠完整动作历史，不能只按最后一条 action 丢弃先前撤销保护。

| 当前状态 | 允许动作 | 结果 |
|---|---|---|
| 有效 Owner binding | revoke；或符合明确覆盖条件的新 bind | revoke 形成持续的 binding_revoked 屏障；不能直接 suppress 来源 |
| revoke 后无 binding | bind；suppress；显式 restore | bind 建立新决定；suppress 不清除 revoke 屏障；restore 必须明确确认解除该屏障 |
| 来源已 suppress | bind；显式 restore | restore 只解除明确指向的抑制记录；若还有 revoke 屏障，必须同时明确确认，否则拒绝 |
| 来源未抑制且无 revoke 屏障 | 正常校验解析；bind；suppress | 不需要 restore，不用无效 restore 产生新权限 |
| 来源变化、失效、不可读 | 核对或针对当前材料显式 bind | 不以 restore 清除数据/版本错误 |

restore 请求除 expectedRevision、sourceRelationDigest 外，必须指明要解除的 suppression decisionId，以及适用时的 revoke decisionId 和明确解除确认；记录中持久保留这些引用。服务端验证它们属于当前 candidate 和仍有效的历史约束。不得通过 revoke→suppress→restore 绕过撤销。

旧 suppress 与当前 relationDigest 不一致时，返回 source_relation_stale 并进入例外；不自动忽略旧抑制而放行新关系。Owner 对当前来源进行新的明确决定后才可继续。重复请求按幂等键返回同一决定，不新增 revision；旧格式记录继续按旧语义读取。

本节新增字段是拟议公共写入契约，不是已存在能力。首轮 shadow 不写这些新动作；实际启用前须完成判别联合、请求校验、CAS、历史折叠、兼容往返和旧构建保留字段测试。

## 21. 语义版本与资格检查分离

将前文 targetPrincipleDigest 的语义收紧为 targetPrincipleSemanticDigest：覆盖 canonical identity、规范性正文和明确适用/例外范围及相关语义版本，不纳入更新时间、展示统计和仅表示生命周期推进的状态。若保留旧字段名，类型文档必须明确相同含义，不能让不同消费者各自解释。

当前 status、存在性和能力资格在每个关键边界独立检查。candidate→probation→active 若仅为合法状态推进且语义未变，不使关系自动 stale；archived/deprecated/missing 仍使当前资格失效。正文/范围改变则 stale，需重新核对，不能静默刷新旧工件回执。

canonical digest 函数应版本化，明确序列化与字段，覆盖“不影响语义的状态推进”“语义内容变化”“不合格状态”三类测试。无需为每次读取时间重写 receipt。批准/激活时的并发一致性须定位现有提交守卫；单次预检或仅允许 in-flight 完成的说明不能掩盖新的检查后写入竞态。

## 22. 质量门槛、页面层级与验收补充

99% 为待 Owner 确认的离线样本准入阈值，不是已证明的生产准确率。精确率分母是系统判定可自动关联的样本；至少报告 TP/FP、自动接受数、拒绝数、例外率、未决数及正负样本覆盖。零接受不能计算成 100% 精确率。

100 个样本（至少 50 正、50 负）只代表最小覆盖要求，不代表对 99% 生产精确率的统计保证。独立标注人按固定准则判断规则目标和范围，不读取 resolver 结论作为答案；有歧义的标注单列，不从分母静默删除。报告样本来源、合成/真实比例与错误案例；关键反例零误接受仍是必要条件。

例外首页每项只显示：发生什么、为何需要你、影响范围、一项可执行下一步。当前决定必需风险与证据摘要直接可见；完整正文、候选浏览、诊断和版本记录按需展开。未解析原则候选等待既有流程时，标为系统等待，不重复要求 Owner 搜索绑定。来源故障与 Owner 决策分组，单源故障不能清空其他可用事项。

新增必须验收场景：

- T01：重启后从不可变上下文重建当次允许集合；当前 Ledger 新增 ID 不能冒充当次可见 ID。
- T02：所有引用合法但语义错误的关系计为评估错误；置信度不改变计分。
- T03：revoke→suppress→restore 未明确解除 revoke 时拒绝；正确指向历史决定且确认后才恢复。
- T04：关系 digest 变化后旧 suppress 不被静默忽略，旧 restore/override 不复活。
- T05：合法状态推进不产生语义 stale；正文变化或目标失格分别返回正确原因。
- T06：首轮目标解析完成/restore 不自动调模型，重启和重复事件也不自动续接。
- T07：例外 UI 可在真实窄屏与键盘流程中定位当前问题，认证隔离测试核对真实请求、决定记录及最终状态。
- T08：自动接受分母为零、样本不足、标签有歧义时不报告达到精确率门槛。

本版为设计补充，以上测试均未运行，状态 NOT_RUN；不得以本文存在或示例通过替代生产路径证据。

## 23. Complexity Delta、启用控制与交付状态

| 维度 | 完整方案判断 | 原因及边界 |
|---|---|---|
| 新耐久事实权威 | NO | 来源 artifact、既有 Ledger 各有归属；receipt 为派生证据 |
| 新持久 schema/state | YES | V2 来源/上下文引用、工件回执、Owner 动作及解除引用；不等于必须新增表 |
| 新子系统/服务/后台进程 | NO | 复用提交、解析、Ledger 和 runner；自动续接延后 |
| 新公共接口/契约 | YES | V2、解析结果、动作判别联合、receipt；须验证所有真实消费者 |
| 新运行时 feature flag | 待 Phase 0 定案 | 不声称已有可用开关；实际启用前固定 SSoT、默认 shadow、生产 loader 和关闭测试；需要新增时按 YES 评审 |
| 新跨包依赖 | 目标 NO，待构造点核查 | 优先已有 core/host/CLI seam，不为复用引入反向依赖 |
| 新宿主特定行为 | 目标 NO | 共享中立解析；各宿主消费路径仍分别验证 |
| 新外部网络/模型调用能力 | NO | 不新增付费调用；已有生成 token 增量与人工标注成本单列测量 |

YES 项的理由：当前字段不能表达可重放的局部关系、来源上下文和明确解除动作；通过版本化共享契约集中隐藏映射和冲突复杂度。较小的首轮采用只读 shadow，不立即引入实际写入动作。验证以兼容 round-trip、真实生成/提交消费者、负例和历史折叠为准；移除自动启用时保留原始 artifact 与审计，不删除治理历史。

不能仅写“关闭开关即可回退”：Phase 0 须明确控制位置、默认值、现有配置能否承载、全部消费者如何遵守；控制未定前只允许开发隔离环境 shadow，不得声称生产可启用或可安全回退。不得复用改变其他治理语义的无关开关。

首轮验收不以“正常规则已无需 Owner 绑定”为结果：shadow 保持当前绑定政策，该目标属于后续启用验收。文中 §10.4 正常自动解析流程在隔离测试显式启用后验证，不是未经批准改生产默认行为。

本版交付：规范修订，未修改生产代码、未运行实施测试、未批准 OD、未发布或安装。v0.4 保留；控制台整体融合工作保持独立。下一步先审阅本版范围与治理取舍，再决定是否授权首轮实施。
