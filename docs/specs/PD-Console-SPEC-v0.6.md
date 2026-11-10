# SPEC-PD-RULE-ASSOCIATION-005 v0.6：Diagnostician Output V2 Only 正式修订版

- **版本**：v0.6（正式修订版）
- **日期**：2026-11-09
- **状态**：`ACTIVE`（实施工单 PRI-1146）
- **取代关系**：基于 v0.5（`PD-Console-SPEC-v0.5.md`）修订；v0.5 保留为历史设计记录。本版取代 v0.5 §5.1 版本策略与 `SPEC-PD-RULE-ASSOCIATION-005-shadow-implementation.md` 的「默认生产保持 V1」范围声明。v0.5 中未被本版明文修改的条款（§2 事实、§3 不变量、§6 身份解析、§7 例外处理、§9 质量门槛、§12 回滚边界、§17-§23 补充）继续按原文有效。
- **Owner 决策依据**：2026-11-06 Owner 决策「Diagnostician Output 采用 V2 Only / Clean Break」（Linear PRI-1146 描述原文）。该决策只覆盖**输出契约版本策略**；本版不改变任何 Owner 治理授权（OD-01/02/03/04 仍为待决）。

## 1. 执行摘要

V2（`diagnostician-output-v2`）成为 PD Diagnostician 的**唯一生产输出契约**：

- 生产生成、验证、提交、身份关联与下游消费全部使用 V2；
- `DiagnosticianOutputV1` 类型、Schema、Registry 注册、Alias、Fallback、生产分支与公共导出**全部退役**；
- 不建设 V1 历史兼容、回填或迁移机制；Owner 已授权清理本机旧 V1 诊断数据并从空白状态重新初始化；
- Rule Recommendation 必须携带可追溯的 `principleAssociation`；关联解析遵守 v0.5 §6（`source_declared_relation` 仅只读 shadow），Structural Validation 与 Semantic Evaluation 严格分离；
- Owner 审批、RuleCode 发布、Shadow/Live 与激活门禁**不因本版改变**。

## 2. 被本版废止的 v0.5 / 旧范围条款

以下旧要求与 Owner 的 V2 Only 决策冲突，自本版起**废止**：

1. v0.5 §5.1：「V1 输出继续可读取、可提交；缺少关联字段时一律按 legacy_unlinked 处理」——废止。V1 输出不可读、不可提交、不可作为任何生产路径的合法输入。
2. v0.5 §5.1：「新启用的诊断生成路径使用 V2」（隐含 V1 仍在生产运行）——废止。**所有**诊断生成路径使用 V2，无 V1 保留路径。
3. v0.5 §5.1：「旧宿主或旧模型输出 V1 时，流程仍然兼容」——废止。V1 输出在生产路径上必须显式失败（fail-loud），不得兼容降级。
4. shadow-implementation 正文「保持所有默认生产诊断生成/校验为 V1」——废止。V2 是默认且唯一。
5. 「V2 仅 opt-in shadow Schema、不切换默认生产 prompt」的旧限制——废止。V2 Only 即默认生产契约。
6. 「为本机旧 V1 数据建设历史兼容读取」的任何义务——废止（Owner 已授权本机清理，见 §8）。

**不受影响**：Evaluator、Artificer、Signal Classification、Dreamer、Philosopher、Scribe、Rollout Reviewer、Correction Observer、Reuse Evaluation、Learning Lab 等其他 Stage 的独立版本化契约，以及 `DiagRootCauseOutputV1` / `DiagDistillerOutputV1`（Stage A/B 契约，非 Diagnostician 最终输出）。

## 3. 唯一 Schema 与唯一 Registry（规范性）

1. 唯一生产输出 Schema 为 `DiagnosticianOutputV2Schema`（`packages/principles-core/src/runtime/diagnostician-output.ts`），根对象 `additionalProperties:false`，`schemaVersion` 字面量 `diagnostician-output-v2`，`recommendations` 非空。
2. Registry（`output-schema-registry.ts`）唯一映射：`diagnostician-output` → V2 Schema；`diagnostician-output-v1` **必须不可解析**（适配器按既有契约 fail-loud `Unknown outputSchemaRef`）。Alias 表只删除 Diagnostician 一对；其他 Stage 的 neutral↔versioned alias 全部保留。
3. `DiagnosticianOutputV1Schema`、`DiagnosticianOutputV1` 类型、V1 专属 Recommendation 类型从源码与全部公共导出（`principles-core` 双 barrel）删除。
4. 所有真实生产入口（split pipeline Stage C、pd-cli、宿主）只接受中性 ref `diagnostician-output`。

## 4. Recommendation 局部身份映射（规范性）

1. 每条 recommendation 必须有 `recommendationRef`：同一 Artifact 内唯一、由模型输出的局部字符串引用；**不得**使用数据库 Candidate UUID，不允许跨 Artifact 引用。
2. `kind='rule'` 的 recommendation 必须携带 `principleAssociation`（linked / unresolved 联合类型，结构按 v0.5 §5.2 原文有效）；`linked.target` 只允许 `recommendation_ref`（指向同 Artifact 内唯一 `kind='principle'` 条目）或 `canonical_principle`（当次可信上下文中的 canonical principleId）。非 rule 种类不得携带 rule association。
3. Committer 在单事务内写入 artifact（完整 V2 + 可信上下文回执 envelope）、commits 与逐条 `principle_candidates`（`source_recommendation_json` 保存含 `recommendationRef`/`principleAssociation` 的原始结构化 recommendation）。recommendationRef → candidateId 的映射必须可由同 artifact_id 下的 `source_recommendation_json` **确定性、唯一**重建；重复提交不得产生重复 Candidate（沿用 UNIQUE(run_id) / idempotency_key 幂等）。
4. 不新增数据库表（Phase 0 审计已证明现有持久化满足映射重建）。

## 5. 可信上下文证据（规范性；实现 v0.5 §18）

1. **来源**：可信 canonical Principle 集合只能来自 PD 系统权威（Principle Ledger / 已验证读模型），在**模型调用前**由系统读取；绝不采纳模型自行返回或声称的 Principle 身份。运行时适配器不消费 `contextItems`，因此可信集合必须嵌入 prompt 消息本体，并在 receipt 中逐条记录。
2. **回执**：诊断 Artifact envelope 的 `trustedContextReceipt` 扩展为联合形态：
   - `available`：记录 taskId、runId、contextHash、outputSchemaRef、prompt/schema 版本、messageDigest/systemPromptDigest、前驱 Artifact 摘要、**当次实际暴露给模型的 canonical principleId 集合**、每条 Principle 的语义内容摘要（固定、版本化、确定性算法：sha256 + 规范化字段序）、evidenceRef → 可信来源与读取范围映射；
   - `unavailable`（typed）：带 reason 与 nextAction。**若系统无法恢复当次真正暴露给模型的集合，必须返回 unavailable，禁止用当前 Ledger 最新状态替代历史上下文，禁止猜测。**
3. **不变性**：receipt 与 Artifact 同体持久化（`artifacts.content_json` / `pi_artifacts.contentJson`），重启后可完整恢复并按摘要重新验证；不得把可信上下文写入公开日志或复制不必要的私人对话正文。
4. **消费**：关联校验（canonical_principle 目标）只信 receipt 的当次暴露集合 + 当前 Ledger 资格检查（目标存在、状态 ∈ candidate/probation/active、task/run 归属一致）。

## 6. Source Declared Relation 与身份解析（规范性；v0.5 §6 继续有效）

1. 身份解析继续**复用** `PrincipleTreeLedgerAdapter` / `candidate-identity.ts` 共享链，不建第二套 Resolver / Ledger。
2. 解析结果 basis 在既有三值（`derived_candidate` / `principle_reuse` / `owner_rule_binding`）之外新增 `source_declared_relation`：
   - **系统来源声明，不是 Owner binding**。在 OD-01/02/03 获批前：只允许 Shadow / 只读解析；不得生成可被生产激活边界接受的 Owner Identity Receipt；不得自动写入 `ruleCandidateBindings`；不得自动启动 Scribe；不得绕过既有 Owner 绑定与审批要求。
   - 在类型/接口层显式区分「只读关系解析」与「生产身份授权」（如 `authorizesGeneration:false` 标记），防止下游把 shadow resolved 当作治理授权。
3. `recommendation_ref` 目标的解析：同 Artifact 内定位唯一 principle Candidate → 验证 Candidate/Task/Run/Artifact 血缘一致 → 沿既有 `derivedFromPainIds`/`reuseEvidence` 解析 canonical principleId → 递归解析带循环检测与深度上限 → 关键边界重读当前身份（防 stale receipt）。多目标/重复/悬空/冲突/循环/目标未形成身份 → 结构化 unresolved，**不得取第一个**；Owner revoke 不使旧关系复活；Ledger 不可用返回 `ledger_unavailable`，不伪成功。
4. 语义评估状态：结构通过时 `semanticCorrectness` 保持 `not_evaluated`，除非未来 Owner 批准独立语义评估机制；结构通过不得推导为语义通过（v0.5 §19 反例条款有效）。

## 7. Structural Validation 与 Semantic Evaluation 分离（规范性）

1. Default Validator 升级为 V2：schema 合法性（TypeBox）与关联合法性（recommendationRef 唯一、目标存在且类型正确、无跨 Artifact 引用、evidenceRefs 出自可信输入、canonical 目标在当次可信上下文、与 violatedPrinciples 一致）分开报告；`semanticCorrectness='not_evaluated'` 不得标记为验证成功的一部分。
2. 关联结构不合法时：诊断 Artifact 与 Candidate 可保留供审计（基础 schema 通过时），但关联判为 unresolved，不进入 Scribe；不得静默删除失败关系后显示为成功。
3. Repair：Structured Output Repair 使用同一 V2 Schema；repair 失败即任务失败（含 taskId、runId、错误类型、nextAction），**不回退 V1**。

## 7A. Owner 治理边界（规范性）

1. 不自动批准 Rule；不自动激活 Principle 或 Rule；不绕过 Owner binding；不扩大 OD-01/02/03 授权；不改变现有 Live/Shadow 权限与 RuleCode 审批/激活边界。
2. Rule Candidate 正常进入既有 Owner 审批流程；Shadow 解析结果只在只读面（Console 展示、审计）可见，unresolved 原因必须可见。

## 8. 本机数据重置策略（Owner 已授权）

1. 范围仅限 Owner 本机开发/测试工作区中的旧 Diagnostician V1 工件、旧诊断 Candidate 关联数据与可重建的本地 Principle 工作数据（`.tmp/**` 数据库副本、本地 workspace 的 state.db 中 V1 诊断数据等）。
2. 执行前输出清理清单（路径、数据类型、数量），确认归属后才清理；清理后从空白状态重新初始化并完整运行 V2 诊断闭环验证。
3. 不触碰：远端数据库、生产数据、其他宿主/其他用户的治理证据、源代码、测试数据、构建工具。无法确认归属的数据一律不删除（fail-closed，不扩大范围）。
4. 不编写 V1 兼容读取、迁移或回填逻辑。

## 9. 生产 dist 验收标准（硬门禁）

从最新构建产物启动隔离环境、连接真实生产组件（不得以 Mock Runner/Registry/Committer 冒充），至少覆盖：

1. 正常 V2 诊断：Artifact 持久化、Candidate 创建、重启恢复；
2. Rule 关联同次 Principle Candidate：recommendationRef 映射正确、身份可解析、未获授权时保持 Shadow；
3. Rule 关联已有 Canonical Principle：可信上下文、Evidence、Canonical ID、Ledger 资格校验；
4. 错误关联（不存在的 Principle / 错误证据 / 悬空引用）被拒绝；
5. 语义错误（结构合法但语义无关）不得被当作关联成功（`not_evaluated` 保持）；
6. Owner 审批：Rule 进入既有审批流程，不自动批准/激活；
7. V1 负向：真实 dist 对旧 ref 与 V1 输出必须显式失败；
8. 空白数据初始化后完整 V2 诊断闭环。

记录 production dist 构建 SHA、Runtime Adapter、Provider/Model、Schema Ref、Task/Run/Artifact/Candidate ID、关联解析结果、Owner 审批状态与实际失败记录。

## 10. V1 退役清单（完成定义）

- [ ] `DiagnosticianOutputV1` 类型 / `DiagnosticianOutputV1Schema` / V1 专属 Recommendation 类型删除；
- [ ] Registry V1 映射与 Alias 对删除（仅 Diagnostician）；
- [ ] V1 Prompt / Runner / Validator / Committer / Bridge / 转换分支删除；
- [ ] V1 公共导出（双 barrel）删除；
- [ ] V1 兼容测试与无用 Fixture 删除；
- [ ] 负向测试证明：V1 schema 不存在、类型不导出、`diagnostician-output-v1` 不可解析、V1 输出无法通过生产 Validator / Committer / Bridge / Rule Candidate Binding、无隐式 fallback、全部生产入口使用 V2；
- [ ] 构建产物（dist）与依赖图核验（不以 grep 结果单独作为证明）；
- [ ] 活跃文档不再指导 V1 生产运行（ADR/CHANGELOG 历史事实保留）。

## 11. 失败与回滚策略

1. **运行期失败**：V2 校验失败 / repair 失败 / 可信上下文不可用 → fail-loud（结构化 reason + nextAction），任务进入既有 retry/failed 状态机；无 V1 降级路径。
2. **代码回滚**：本变更为单一 PR；回滚 = revert 该 PR（恢复 V1 双轨态）。合并后如需运行期止血，优先使用既有控制（capability 开关 / disabled runner 路径），**不重新引入 V1 兼容读取**。
3. **数据回滚**：本机清理后如需恢复，依赖既有备份（清理清单要求先备份后删除）；不回填 V1 语义。
4. **不变量**：回滚不得把 V2 工件伪装成 V1，不得删除 Owner 治理 revision；已生产的 V2 Artifact 保持不可变。

## 12. 与 PRI-1139（B 类切换）的关系

PRI-1139 已完成 Registry 键中性化与 `current` token 语义；本版在其上只做两件事：把 `diagnostician-output` 的解析目标从 V1 Schema 换为 V2 Schema，并删除 Diagnostician 的 versioned alias 对。其他 Stage 的中性键与 alias 语义不受本版影响。

## 13. 验收交付清单

- Phase 0 现实审计报告（`docs/implementation-reports/PRI-1146-PHASE0-REALITY-AUDIT-20261109.md`）；
- 本 SPEC + v0.5/shadow-implementation 废止标注；
- 生产调用方逐项迁移清单与代码证据；
- V1 退役证据（含负向测试与 dist 核验）；
- 本机数据清理与空白初始化报告；
- production dist 端到端测试报告；
- PR 保持 OPEN，等待 Owner 最终评审；不自行合并或部署。
