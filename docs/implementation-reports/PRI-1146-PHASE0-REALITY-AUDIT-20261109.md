# PRI-1146 Phase 0 现实审计报告（2026-11-09）

> 任务：Diagnostician Output V2 Only —— 唯一生产契约切换与 V1 彻底退役。
> 本报告基于当前 `origin/main` 真实代码逐文件核实；2026-11-06 Linear 评论中的旧审计仅作线索，以下每一条均已在最新 main 上重新验证。

## 0. 审计基线与方法

| 项 | 值 |
|---|---|
| main HEAD | `13011bf92f8e1e08ccbffdc2380f8f1006b27c9c`（2026-11-09 fetch） |
| PR #2425（PRI-1139 B 类写入侧切换） | MERGED 2026-11-08，merge commit `8da2cdc8e` |
| PR #2391（PRI-1136 runtime-v2 → runtime 改名） | MERGED 2026-11-06，merge commit `d36724c60` |
| 实施工作树 | `ai/PRI-1146-diagnostician-output-v2-only`（base = main HEAD，READY） |
| 方法 | `rg` 全仓检索（`DiagnosticianOutputV1` / `diagnostician-output-v1` / `DiagnosticianRecommendation` / `diagnostician-output` / `principleAssociation` / `recommendationRef`）+ 生产链逐文件阅读 + 新构建 dist 实测 |

全仓 `DiagnosticianOutputV1|diagnostician-output-v1` 命中 372 处、72 个文件；其中非测试生产源码 30 个文件（分布见 §4）。

## 1. 核心事实：生产诊断链只有一条（Split Pipeline）

- 特性旗标 `diagnostician_split_pipeline`（category=quiet，enabled=true，`feature-flag-contract.ts:265`）在 PRI-638 后不再选择实现：**split pipeline 是仓库中唯一的 Diagnostician 实现**，monolithic DiagnosticianRunner 已不存在（`diagnostician-capability.ts:15`「there is one: SplitDiagnosticianRunner」；`pain-signal-runtime-factory.ts` 只构造 `SplitDiagnosticianRunner`）。
- 生产链路：`PainSignalBridge.onPainDetected` → `SplitDiagnosticianRunner`（A rootcause → B distiller → C router）→ `SqliteDiagnosticianCommitter`（artifacts + commits + principle_candidates 单事务）+ `pi_artifacts` 双写 → bridge `onDiagnosisComplete` → `AdmissionGate` → `CandidateIntakeService` → Principle Ledger / Dreamer。
- 运行时适配器 `PiAiRuntimeAdapter` 完全忽略 `StartRunInput.contextItems`（`pi-ai-runtime-adapter.ts:682-699` 仅用 `inputPayload` + `systemPrompt` 构造 Context）。**可信上下文只能通过 prompt 消息本体注入**，不能靠 contextItems。
- 结构化输出三路回退（tool_call → response_format → repair）全部用 `resolveOutputSchema(outputSchemaRef)` 从 Registry 解析同一 schema（`pi-ai-runtime-adapter.ts:730-761`）；未知 ref fail-loud（`output_invalid`）。**Registry 切 V2 后，适配器校验与 repair 自动跟随，无需改适配器代码**。

## 2. 逐组件审计表

| 组件 | 位置（main 行号） | 现状 | V1 删除影响 | V2 接入缺口 |
|---|---|---|---|---|
| Router Prompt Builder | `runtime/diagnostician/router-prompt-builder.ts:126,170` | 默认 schema=`DiagnosticianOutputV1Schema`；指令写明「MUST match DiagnosticianOutputV1Schema」；无 recommendationRef / principleAssociation 要求 | 直接切换 | 需重写输出要求（recommendationRef 唯一、rule 必带 association、unresolved 语义、禁止编造 candidateId） |
| Diagnostician Runner（Stage C） | `runtime/internalization/diag-router-runner.ts:273-281,297` | `validateOutput` 用 V1 schema；`succeedTask` 类型 `DiagnosticianOutputV1` | 直接切换 | 需 V2 校验 + 可信上下文证据生成 + receipt available 形态 |
| 输出 Schema Registry | `runtime/adapter/output-schema-registry.ts:44,84` | `diagnostician-output` → **V1 schema**；alias 表 `CONTRACT_REF_PAIRS` 含 `['diagnostician-output','diagnostician-output-v1']` 双向映射 | 删 alias 对后 `diagnostician-output-v1` 无法解析（预期） | 主键映射换 `DiagnosticianOutputV2Schema`；只删 Diagnostician 这一对，其他 Stage alias 不动 |
| Runtime Adapter | `runtime/adapter/pi-ai-runtime-adapter.ts:730` | 经 Registry 解析（当前解析到 V1）；注释提及 V1 仅文档性 | 无代码影响 | 无缺口（跟随 Registry） |
| Default Validator | `runtime/runner/default-validator.ts:31-32,61,191` | 输入输出类型 V1、schema 校验 V1 | 直接切换 | 需 V2 类型 + schema + recommendationRef 唯一性 + rule association 结构校验（Schema Validity 与 Association Validity 分开报告） |
| Diagnostician Committer | `runtime/store/commit/diagnostician-committer.ts:16,43,98` | 校验 V1；`source_recommendation_json=JSON.stringify(rec)`（天然携带 V2 字段）；事务=artifacts+commits+principle_candidates；UNIQUE(run_id/idempotency_key) 幂等 | 校验换 V2；插入逻辑不变（字段已有 recommendation_kind 等列） | 需保证 recommendationRef→candidate 映射可确定性重建（已可：同 artifact 下按 source_recommendation_json.recommendationRef 检索） |
| Pain Signal Bridge | `runtime/pain-signal-bridge.ts:7-8,455,498,534-538,806-828,1190,1704` | 5 处 `Value.Check(V1Schema)`：候选来源解析(538)、resume 解析(811)、历史重建(1704)；`buildExistingResult` 校验失败**静默 continue（G6）**且额外检查 `output.valid` | 全部换 V2；1704 的静默跳过需改为结构化跳过原因 | V2 下 recommendations 带 ref/association，但 bridge 只消费 confidence/evidence/rootCause/diagnosisId——语义兼容 |
| Split Runner 缓存命中校验 | `runtime/internalization/split-diagnostician-runner.ts:81,90,183,226,248` | 用 `DefaultDiagnosticianValidator` 同一权威校验缓存 | 跟随 validator 切换 | 无独立缺口 |
| Candidate Intake | `runtime/candidate-intake-service.ts:230-311` | duck-typed 提取（description→text 归一化），兼容任意 rec 形状 | 无硬依赖（V2 rec 仍带 description） | 注释/文档更新；无需结构变更 |
| Admission Gate | `runtime/admission-gate.ts:1,102` | 仅类型引用；消费 `output.confidence` 与 `output.evidence.length` | 类型切换 | V2 保留同名字段，无语义缺口 |
| Rule Candidate Binding 校验 | `runtime/principle-tree/rule-candidate-binding.ts:3,96-98` | `isRuleCandidateMaterial` 对 candidate.sourceRecommendationJson / run.outputPayload / artifact.contentJson 三处做 `Value.Check(V1Schema)` | 换 V2 schema | 这是 Rule→Principle 消费的关键闸门 |
| Principle Identity Resolver | `runtime/adapter/principle-tree-ledger-adapter.ts:85-120`；`runtime/internalization/candidate-identity.ts` | basis 仅 `derived_candidate|principle_reuse|owner_rule_binding`（`types/rule-candidate-binding.ts:16`）；rule 只读 ruleCandidateBindings（Owner binding） | 不删（非 V1 专属） | 需新增 `source_declared_relation` 只读解析（shadow 级），fail-closed；不建第二套 resolver |
| Association 校验（已有 V2 消费者） | `runtime/diagnostician-association-validation.ts:22-53`；`runtime/diagnostician-association-shadow.ts:25-87` | 仅消费 V2 schema 的只读结构校验与 shadow 提案；`semanticCorrectness:'not_evaluated'` | 无 V1 依赖 | 需接通可信上下文来源（现要求调用方传入 context） |
| Router Context Receipt | `runtime/internalization/router-context-evidence.ts:6-25` | `RouterContextReceiptSchema.canonicalPrinciples` 只有 `status:'unavailable'` 一种形态（G1 的 schema 化表现）；receipt 版本字面量 `router-context-v1`（该 v1 是 receipt 自身版本，与 Diagnostician Output V1 无关，保留） | 无 | 需扩展 `available` 形态（含当次暴露的 principleId 集合 + 内容摘要 + 证据映射），并保持 unavailable typed |
| Public Exports | `runtime/index.ts:127,208-215`；`src/index.ts:139-146,179-184` | 导出 V1 schema/类型（6 个 schema + 6 个类型）；**无任何 V2 导出** | V1 导出删除 | V2 schema/类型导出替换；下游包不得再依赖 V1 |
| 测试替身/夹具 | `runtime/adapter/test-double-runtime-adapter.ts`（默认产出 V1 形状）；`runtime/adapter/split-pipeline-fixtures.ts:87`（MOCK_ROUTER_OUTPUTS: V1） | 测试基础设施（生产不引用） | 同步换 V2 形状 | — |
| pd-cli | `src/commands/diagnose.ts:237`（仅注释） | 无类型依赖 | 无 | — |
| pd-console | `src/ui/utils/agent-metadata.ts:150,158`（文档字符串）；`scripts/e2e-seed.ts:572,585`（构造 V1 字面量） | 展示文案 + e2e 种子 | 文案更新、种子换 V2 | — |
| 脚本 | `scripts/eval-diag-quality.ts:15,598`；`scripts/export-comparison-corpus.ts:4,251` | 评估/导出脚本用 V1 schema 校验 | 换 V2 | — |

## 3. Registry 与 Alias 现状

| Registry Ref | 当前解析 | 目标 |
|---|---|---|
| `diagnostician-output` | `DiagnosticianOutputV1Schema` | `DiagnosticianOutputV2Schema` |
| `diagnostician-output-v1` | 经 alias → `diagnostician-output` → V1 | **不可解析（fail-loud `Unknown outputSchemaRef`）** |
| `diag-rootcause-output` / `diag-distiller-output` / 其他 11 个 | 各自中性键 + 版本 alias 双向表 | 不动（独立契约） |

Alias 表机制：`CONTRACT_REF_PAIRS` 每对生成双向 alias（`output-schema-registry.ts:99-103`）；`resolveOutputSchema` 先直查 Registry 再查 alias（116-122）。删除 `['diagnostician-output','diagnostician-output-v1']` 这一对即同时消灭两个方向的 V1 解析。

## 4. V1 引用全量分类（372 处 / 72 文件）

- **A. 生产调用方（30 个非测试源码文件）**：核心 12 个（committer 12 处、bridge 12 处、diag-router-runner 11 处、default-validator 6 处、router-prompt-builder 6 处、output-schema-registry 6 处、split-runner 4 处、evidence-chain-contract 3 处、diagnostician-validator 3 处、rule-candidate-binding 3 处、runtime/index 3 处、diagnostician-output 3 处）+ 外围 18 个（candidate-intake-service、test-double-runtime-adapter、synthetic-baseline、pain-diagnosis-store、runner-result、formation-context、admission-gate、split-pipeline-fixtures、pi-ai-runtime-adapter（注释）、src/index、runtime-state-manager（注释）、router-context-evidence（注释）、artifact-summary（注释）、agent-metadata、e2e-seed、eval-diag-quality、export-comparison-corpus、diagnose.ts（注释））。
- **B. 测试与 Fixture（41 个文件）**：core runtime `__tests__`（diagnostician-output-schema、output-schema-ref-alias、default-validator、pain-signal-bridge-*、diag-router-runner、diag-chain-e2e、split-diagnostician-runner-retry、candidate-round-binding-real-wiring、mainline-product-path、attack-e2e-pipeline-smoke、synthetic-baseline、recovery-ledger-authority、pain-diagnosis-persistence、pain-outcome-convergence、evidence-chain-intent-tension、pri638-characterization、split-continuation-real-wiring、admission-gate、association-validation、diag-runner-harness、progressive-disclosure-spike-fixtures、rule-binding-revision-concurrency、rule-source-correction-recovery、diag-router-intent-tension、reuse-decision-flow、adapter __tests__ ×7（json-extractor、output-repair-contract、pi-ai-runtime-adapter、pi12-ac6-oneshot-real-llm、schema-prompt-adapter×2、structured-output-repair、test-double-runtime-adapter）、router-prompt-builder.test、store/diagnostician-committer.test）；pd-cli tests ×5；pd-console tests ×4；codex-adapter tests ×1。
- **C. 开发/评估脚本**：`scripts/eval-diag-quality.ts`（4 处）、`scripts/export-comparison-corpus.ts`（3 处）、`pd-console/scripts/e2e-seed.ts`（3 处）。
- **D. 历史文档**：`docs/plans/2026-06-diagnostician-split/spike-distiller-prompt.ts`（历史 spike，随本票清理与否在 Phase 5 裁量）+ 各 ADR/CHANGELOG 历史事实（保留）。
- **E. 无关契约**：`DiagRootCauseOutputV1` / `DiagDistillerOutputV1` / `DreamerOutputV1` / `EvaluatorOutputV1` / `SignalClassificationOutputV2` 等均为独立 Stage 契约，**不属于本票删除范围**。

## 5. 六个已知缺口（2026-11-06 审计）重核结果

| 缺口 | 2026-11-06 结论 | 本次重核（main 13011bf92） |
|---|---|---|
| G1 无 canonical Principle 允许集合 | `diag-router-runner.ts` contextItems=[]、receipt 写死 unavailable | **属实**。`diag-router-runner.ts:264` contextItems=[]；`:329-333` 硬编码 unavailable；`router-context-evidence.ts:20-24` schema 只有 unavailable 形态。且适配器忽略 contextItems，注入必须走 prompt 本体 |
| G2 Rule 身份只读 Owner binding | adapter 只读 ruleCandidateBindings | **属实**。`principle-tree-ledger-adapter.ts:95-101` |
| G3 无系统来源身份事实 | CandidateIdentityBasis 无系统来源 | **属实**。`types/rule-candidate-binding.ts:16` 仅 3 值 |
| G4 语义正确性未评估 | semanticCorrectness='not_evaluated' | **属实**。`diagnostician-association-validation.ts:18,52`（本票保持 not_evaluated，不伪造） |
| G5 V1 schema 过宽（V2 可通过 V1 校验） | 实测合法 V2 同时通过 V1 | **已用本工作树新构建 dist 复测属实**：`Value.Check(DiagnosticianOutputV1Schema, v2Sample) === true`；V1 根对象无 `additionalProperties:false`，任意未知字段也通过。⇒ 仅换 Registry 不换各消费点校验 = 静默假迁移 |
| G6 历史候选静默跳过 | bridge:1704 continue 无记录 | **属实**。`pain-signal-bridge.ts:1703-1704` `continue` 且无 telemetry/reviewFailures 记录（违反 rc-9）。本票以本机数据重置消除历史 V1 负载，同时把该循环改为结构化跳过记录 |

## 6. 关联与身份机制现状

- 身份解析权威：`PrincipleTreeLedgerAdapter.resolveCandidatePrincipleIdentity`（同步 CAS 锁内解析）+ `resolveArtifactCandidateIdentity`（artifact→dreamer→candidate 链）。现有 basis：`derived_candidate` / `principle_reuse` / `owner_rule_binding`。
- Owner 决定容器：Ledger `ruleCandidateBindings`（revision 历史，`bind`/`revoke`）。v0.5 SPEC §7.4 提议的 `suppress_source_relation`/`restore_source_relation` 属**拟议公共写入契约，尚未实现，本轮不实现**。
- Shadow 链已存在：`validateDiagnosticianAssociations`（结构校验）→ `proposeShadowAssociations`（只读提案，`authorizesGeneration:false`）。二者是当前仅有的 V2 消费者，均未被生产 runner 调用。
- Console：`RuleCandidateBindingPanel` / binding models 消费 candidate 身份与 Owner binding 队列；V2 Only 不改变其读模型（association 状态展示走 shadow/只读路径）。

## 7. 数据持久化现状（不新增表）

| 存储 | 内容 | V2 关系 |
|---|---|---|
| `artifacts` 表 | `content_json` = 完整输出 + `trustedContextReceipt` envelope | V2 原文 + receipt 全部落在此处；重启恢复读取此表 |
| `commits` 表 | commit_id/run_id/idempotency_key | 幂等权威，不动 |
| `principle_candidates` 表 | `source_recommendation_json` = 单条 rec 的 JSON（含 recommendationRef/principleAssociation） | recommendationRef→candidateId 映射来源：同 artifact_id 下检索该 JSON 的 recommendationRef 字段（确定性、唯一） |
| `pi_artifacts` 表 | 双写（PRI-667），下游 internalization runner 的前驱读取来源 | contentJson 同 envelope |
| Principle Ledger（JSON 文件） | principles/ruleCandidateBindings/reuseEvidence | 可信上下文来源 + 身份权威，不动结构 |

## 8. 风险与处理方案

| 风险 | 处理 |
|---|---|
| R1 只换 Registry 不换消费点 ⇒ G5 静默假迁移 | 逐点切换 + 负向测试（V1 输出必须在 validator/committer/bridge/binding 四处显式失败） |
| R2 模型输出 V2 失败率上升（弱模型） | Prompt 明确 schemaVersion/recommendationRef/association 要求；repair 用同一 V2 schema；失败 fail-loud 带 taskId/runId/nextAction，不回退 V1 |
| R3 可信上下文来源误用「当前 Ledger」冒充历史输入 | receipt 记录当次暴露集合+逐条内容摘要；重启校验摘要；无法恢复 ⇒ typed unavailable，禁止猜测 |
| R4 语义正确性被伪装成已验证 | `semanticCorrectness` 保持 `not_evaluated`；结构通过不产生 Owner binding、不写 ruleCandidateBindings、不启 Scribe（OD-01/02/03 未批） |
| R5 删除 alias 影响其他 Stage | 只删 `CONTRACT_REF_PAIRS` 中 Diagnostician 一对；`output-schema-ref-alias.test.ts` 同步改并保留其他 Stage 断言 |
| R6 本机旧 V1 数据导致 resume/重建路径永远失败 | Owner 已授权本机清理：仅限本机开发/测试工作区（.tmp dbcopy、本地 workspace state.db 中诊断 V1 工件），清理后空白重初始化；远端/生产数据不触碰 |
| R7 测试面广（41 文件） | 分类迁移：真实链路测试改 V2 夹具；纯 V1 兼容测试删除；负向测试新增 |

## 9. 结论（实施顺序）

1. SPEC 升级（V2 Only 正式版）→ 2. Schema/Registry/导出 → 3. Prompt/Runner/Validator/Committer → 4. 可信上下文 + receipt available 形态 + association 校验接通 → 5. 下游消费（bridge/intake/binding/identity/scripts/console 文案）→ 6. V1 退役 + 负向测试 → 7. 本机数据重置 → 8. 测试矩阵 + production dist E2E → 9. CI/PR。

关键不变量：不自动批准、不自动激活、不绕过 Owner binding；`source_declared_relation` 只读 shadow；OD-01/02/03 保持待决。
