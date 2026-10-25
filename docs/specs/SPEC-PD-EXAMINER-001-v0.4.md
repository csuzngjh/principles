# SPEC-PD-EXAMINER-001 v0.4
## Principles Disciple · 基于真实 Pain 的多场景原则行为挑战与受控评测

| 属性 | 内容 |
|---|---|
| SPEC ID / Version | `SPEC-PD-EXAMINER-001` / `v0.4` |
| 状态 | v0.4 = v0.3 增量修订（Owner 2026-10-25 采纳方案 B）；Phase 0/1A/1B 已完成，Stage G 预检完成待批 |
| 日期 | 2026-10-25（v0.3：2026-10-24） |
| 设计核查基线 | `2f5d2b8376f4e1b031506d3b27e7b4947c6f71ea` |
| 实施状态 | Phase 0/1A/1B/Stage G 预检已实现（研究支线 `scripts/dev/principle-learning-lab/challenge-studies/CEB-001/`）；骨架门已离线实现；Examiner 适配器/真实调用未实现 |
| 生产影响 | 不修改生产 DAG、现有 Evaluator、Owner 审批、Principle 激活/撤销或生产记忆 |
| 真实模型调用 | 默认关闭；本 SPEC 不构成实模授权；Stage G/R 均 NOT_AUTHORIZED |

> **目标**：把一条来源可验证的真实 Pain 及其 Scribe Principle 转换成经校准、冻结的多场景挑战题集；由独立 Examiner LLM 出题，由被测宿主 Actor 在隔离的 A/B（研究阶段可增加 Summary 对照）条件下作答，通过可复核轨迹、客观后果和独立评分，测量局部行为影响、适用边界和负迁移。
>
> **v0.4 修订摘要**：采纳 Owner 方案 B——在冻结事实骨架与可信 Gold 约束下研究 Examiner 的**受约束生成增量**（表达质量/实质结构多样性/人工修订成本），新增冻结事实骨架契约（§2.4–2.6）、概念区分（附录 A）、公平比较与四分去重（§5.3 修订）、对抗测试清单（§12.6）与 PAHF 离线借鉴边界（附录 B）。v0.3 全部未修订章节保持有效；v0.3 文件保留为 Phase 1A 冻结基线引用。
>
> **v0.4 增量（2026-10-25，PRI-1034 离线实现轮）**：新增 §2.7 Examiner 适配器契约（Mock-first transport、九字段 fail-closed 授权门、请求级状态机与预算预留）与 §12.7 离线验收清单；属未冻结实现契约的增量更新，未触及研究假设、指标或预注册统计规则。

---

## 0. 本版核心决策

1. Examiner 是独立出题 LLM；宿主 Actor 答题；现有 Evaluator 继续评估 RuleCode/规则实现。Examiner 不自评、不审批、不写生产状态。
2. Examiner 与 Actor 必须是不同的实际模型身份；同一 Actor 配置用于 A/B。直接调用同款模型 API 不等于真实宿主参加考试。
3. 默认目标 12 道有效题，四类各 3 道：原失败机制变体、跨情境迁移、原则适用边界、约束冲突。12 是目标而非配额，禁止凑数。
4. **先人工核验 Pain→失败机制→模板映射，再让 Examiner 扩展变体。**机械评分稳定不等于题目代表真实 Pain。
5. 在昂贵的 Actor A/B 之前，先比较 Examiner LLM 与确定性参数枚举的出题增量。
6. A/B 通过不可变运行配置控制注入；不在同一会话里开关原则，不用“请忽略原则”制造 A 组。
7. 出题授权与答题授权分开。Owner 可一次批准两阶段的约束，但最终 `suiteHash` 生成后必须重新机器校验答题授权。
8. 真实宿主隔离是硬前置条件。不能验证配置、记忆、插件、Hook、工具和 Gold 隔离时，停止真实宿主阶段。
9. MVP 串行执行、每 Study 单写锁、请求前预算预留。请求已发出但结果未知时，不自动重试、不覆盖原记录。
10. 报告分别呈现协议有效性、行为收益、负迁移、覆盖充分度和成本；不压缩为单一 PASS/FAIL。
11. 不回溯历史 Session、不恢复历史工作树、不修改生产主 DAG。实验结果仅代表指定 Principle 版本在受控任务中的局部证据。
12. Phase 0 必须先做；Phase 1 前完成映射、注入、评分、状态/恢复契约；真实模型执行前完成授权、身份、隔离和预算验收。
13. **[v0.4] 方案 B 采纳**：Examiner 增量研究限定为「冻结事实骨架下的受约束生成」——表达层改写与合法参数组合；不可自编事实充当 Gold（骨架门 fail-closed）。
14. **[v0.4] 分层保障**：结构/参数由确定性 validator 验证；语义骨架绑定由冻结字段与 canonical 骨架相等保证；表达层残余风险由独立盲评与对抗测试评估；canonical JSON 相等不是自然语言语义等价的证明。
15. **[v0.4] 判度纪律**：「改写了句子」「提交更少的重复题」不等于「出题能力更强」——重复率与有效率不得单独作为 Examiner 增量证据（§5.3、附录 A）。
16. **[v0.4] PAHF 借鉴边界**：仅借鉴离线测试思路（行动前澄清、证据更新响应）；不引入其记忆架构/数据/生产组件（附录 B）。

---

## 1. 研究问题与结论边界

### 1.1 研究问题

- `RQ1`：在同一批冻结的新情境中，增加目标 Principle 是否改变了预定义的可观察行为？
- `RQ2`：原 Pain 对应的失败机制是否较少重现？
- `RQ3`：行为变化是否改善客观任务结果，而非只是改变 Actor 的措辞？
- `RQ4`：在原则不适用、证据已充分或成本/授权冲突时，是否出现过度检查、无谓拒绝、误阻或额外成本？
- `RQ5`：**[v0.4 修订]** 在相同可信事实库、冻结语义骨架、合法参数空间和机械验证规则下，Examiner LLM 生成的候选是否相较确定性枚举带来**可独立验证的**表达质量、实质结构多样性或人工修订成本增量？（旧表述「更有效、多样且更少需要人工修订的题目」过宽——byte-equal 重放门下该问题不可检验，见 Design-Review-Final）
- `RQ6`：Principle 是否优于高质量经验 Summary？此项必须有预注册 Summary 对照，不能从 A/B 单独推断。

### 1.2 三种结论必须分开

- **Principle validity**：目标行为是否有可信 Owner 意图、客观环境事实和任务约束支撑。
- **Behavioral influence**：新增 Principle 是否改变了 Actor 的动作与结果。
- **Rule implementation correctness**：RuleCode 是否正确实现 Principle，仍归现有 Evaluator。

本实验不证明长期内化、权重永久改变、历史 Pain 一定可避免或跨宿主泛化。单次 12 题 A/B 仅属探索性证据。

---

## 2. 源码复用边界与架构

本 SPEC 的复用判断以 `2f5d2b8` 为主要核查基线；检查时远端 main 已到 `3c3859bf`。实施前必须记录实际 HEAD 并检查差异，不能假设代码完全相同。

| 代码/能力 | 复用方式 | 禁止的错误假设 |
|---|---|---|
| `pain-recall.ts` | 读取 Principle/Pain 关联与诊断证据 | 不通过标题或语义猜 ID |
| Scribe Artifact / `scribe-output.ts` | 读取实际持久化 Principle、适用范围、IntentContract | 不把模型生成字段当作 Owner 事实 |
| `intent-contract.ts` | 提取结构化行为目标 | 不凭抽象原则制造 Gold |
| `lib/actor.mjs` | 复用受控行动循环的思路与经验证工具 | `runRealActorOpportunity()` 不是通用环境接口 |
| `lib/oracle.mjs` | 仅复用其已支持的特定任务族 | 不是通用文件/命令执行器 |
| `lib/evaluator.mjs` | 复用确定性裁定纪律 | 不把既有成本指标生搬硬套 |
| `lib/g2.mjs` | 参考同通道投递、内容哈希和 Memory Manifest | 声明 hash 不等于实际加载已验证 |
| `lib/real-runner.mjs` | 参考 arm、预算和隔离管理 | 不能用重新生成 policy 的模式代替精确 Scribe 原文 |
| `lib/host-actor.mjs` | 作为真实宿主受限 JSON action transport 的调查起点 | 不自动证明完整宿主工作流、隔离或硬预算 |
| `fixture.mjs` / `sidecar.mjs` | 复用冻结、防泄漏、研究侧车思想 | 不修改历史 Fixture/Gold/Prereg/Study |
| 现有 `EvaluatorRunner` | 仅保留 RuleCode 与 GoldenTrace 验证 | 不把规则函数测试冒充 Agent 行为考试 |
| `internalization-job-graph.ts` / `peer-runner-contracts.ts` | 核对生产 DAG 边界 | MVP 不新增 PeerRunner、不改主 DAG |

### 2.4 [v0.4] 冻结事实骨架契约（方案 B）

骨架（skeleton）= caseDef 中**决定 Gold 的不可变投影**。schema：`claim-evidence-skeleton.v1`（`schemaVersion`、`templateId/templateVersion`、`domain/family`、可信事实及来源引用、真值及方向、蕴含/判定关系、观察对象/结果/语义方向、允许变化的表达字段清单、合法参数与值域引用、判分依据与 Gold 引用、适用/例外条件、不可变字段声明、骨架 canonical hash、来源版本与审计信息）。

| 信任层 | 字段 | 说明 |
|---|---|---|
| **不可变**（骨架内，canonical 相等强制） | facts 的 factId/goldTruth/observability；observations 的 obsId/action/implies/costUnits/timeUnits；ownerAnswers 蕴含映射；extraActions；preSeededObservations；gold.requiredClaims 骨架；family/expectedMode/principleApplicable/studyEligible | 真值方向、蕴含判定、Gold 与评分依据、影响判定的适用/例外事实——Examiner 不可触碰 |
| **允许生成**（表达层，机械审计+盲评） | taskText 措辞；facts.statement 措辞（不得翻转语义）；observations.label/output 措辞（观察结果语义方向不得改变）；预注册值域内的参数组合（budgetUnits/deadlineUnits/stakes/distractor） | 改写须经表达层审计（§2.5 L3） |

Examiner **不得**自编事实再把自编事实当 Gold；无法建立独立真值的候选只能以 `domain_proposal` 保留，永不进入合格集；新领域须独立核验并冻结入库（Owner 指定核验人）后方可成为 parametric 来源。

### 2.5 [v0.4] 可信骨架门（分层保障）

实现：`lib/challenge-skeleton.mjs` 的 `verifySkeletonGate`（tier 体系：`parametric_verified`（byte-equal 重放，最强）/ `skeleton_verified`（骨架 canonical 相等+值域合法+表达审计通过）/ `skeleton_mismatch`、`value_domain_violation`、`expression_leak`（拒绝）/ `domain_proposal`（保留不进合格集））。

1. 结构与参数约束由确定性 validator 验证（严格键集、枚举、值域）；
2. 语义骨架绑定由可信模板、冻结字段与 canonical 骨架相等保证（事实来源=frozen library + mappingHash 绑定）；
3. 表达层残余风险（极性翻转、措辞暗示、近重复措辞）由独立盲评与对抗性测试评估——机械规则只做近似 flag（极性词表），**不得声称字符串规则能普遍保证自然语言语义等价**；
4. 未知字段/未知模板/未知版本/非法值域/无法验证的语义关系一律 fail-closed；无法证明 Gold 独立性时拒绝候选，不降级为「尽量通过」。

### 2.6 [v0.4] 合法参数值域与版本化

值域表 `VALUE_DOMAINS`（`challenge-skeleton.mjs`，版本戳 `1.0.0`）：budgetUnits/deadlineUnits 数值区间、stakes 枚举、distractor 枚举、允许表达字段清单、极性词表。要求：每参数含类型/允许值/约束/所属模板；值域由可信现有事实或已批准契约支撑；新领域/新事实不得经自由生成自动进入可信空间；schema/模板/值域版本变化必须可哈希可审计；未知版本、未知字段、越界值全部拒绝。第一版仅支持 CEB-001 机制，不建通用生成平台。

### 2.7 [v0.4 增量] Examiner 适配器契约（PRI-1034，Mock-first）

实现：`lib/challenge-examiner.mjs`（测试 `__tests__/principle-learning-lab-challenge-examiner.test.ts` 五组 A–E）。要点：

- **输入**（`examiner-run-spec.v1` 严格键集，版本钉死代码常量）：studyId / mappingId+mappingHash / inputManifestHash / templateId+Version / schemaVersion（骨架版）/ valueDomainVersion / 允许表达字段清单（=VALUE_DOMAINS 冻结值）/ candidateCap≤36 / requestCap≤16（含重试）/ token 上限≤8000·4000 / costCapUsd / pricePerMillion（分价 per-million；Mock 可 null=未定价，仅请求数硬预留）/ 脱敏与传输许可状态 / requestedModelIdentity。未知模板、未知版本、未知字段、越界一律 spec 阶段拒绝。
- **受约束模型输入**（`buildConstrainedInput`）：仅由冻结枚举空间的 **actor-visible 投影**（36 组合的 taskText/事实陈述/观察元数据/约束——不含 goldTruth/implies/ownerAnswers）+ 允许字段清单 + 值域构成；未经验证的事实、任意模板、任意 action、任意代码或路径不得进入模型请求。
- **输出**：模型输出一律**不可信草案**，逐候选重过骨架门+validator；每候选保留原始草案信封、请求关联 ID、requestedModelIdentity、observedModelIdentity（Mock 恒 null+注记，不得伪造）、inputManifestHash、schema/值域版本、验证结果与拒绝原因、usage（Mock 恒标 `simulatedUsage:true`，非真实计费证据）、人工修订记录（若发生）。Examiner 无权批准 Gold、改真值、改判分规则或将 domain_proposal 升级为合格题。
- **Transport**：默认 Mock；真实 transport **未实现且模块零网络代码**——显式 `transport:'real'` 须先过九字段 fail-closed 授权门（schema `challenge-stage-g-authorization.v1` + status=APPROVED + study/mapping/input-manifest/template/骨架版本/值域版本/模型身份逐项绑定 + 传输许可 APPROVED + 脱敏 DONE + halted 检查 + 请求/预算上限核对），再因无实现而拒绝——双保险、无隐式 fallback、不可经 env/debug/fixture 绕过。
- **请求状态机**（1B 账本纪律的请求级实现：generation-ledger/generation-events/examiner-draft-log 三个 append-only 文件）：校验→最坏成本 `(8000×pIn+4000×pOut)/1e6`→预留（幂等，崩溃不重复扣减）→`REQUEST_PREPARED`→transport→响应/错误/usage 落盘→结算 `SUCCEEDED`/`FAILED_KNOWN`/`RESULT_UNKNOWN`。同 requestId 永不自动重发；预留永不返还；超限写审计行拒新请求；请求前预留≠服务端硬费用上限。
- **授权时效与撤销**（2026-10-25 收口轮增补）：授权 schema 含 `validFrom`/`validUntil`（ISO-8601，含端点）与 `revoked`/`halted`；时间信息缺失/畸形/倒置、可信时钟不可用、未生效、已过期、已撤销一律 fail-closed。时钟**仅由可信运行方显式注入**（`now` 参数）——模块不读取任何环境时钟，普通请求输入无法伪造当前时间；测试注入固定时钟。全部时效拒绝先于任何网络动作（工厂调用计数=0 断言）。
- **AMD Radeon Transport**（2026-10-25 工程实施轮，Owner 授权）：`lib/challenge-amd-transport.mjs` —— Provider `amd-radeon-tokenfactory`（`https://developer.amd.com.cn/radeon/api/v1`，https-only+私网 host 拒绝）、Model `GLM-5.3-Flash`（**experimental 部署**，vLLM）、结构化输出 `json_object` + `reasoning_effort=medium`。凭据仅从 `AMD_RADEON_API_KEY`/`~/.amd_radeon_api_key` 读取（不落源码/日志）。计费：**Owner 确认免费层——模型费记 $0**，服务器名义 cost 仅审计备注；风险=免费层不稳定（慢响应/000/429），由 AmbiguousOutcome→RESULT_UNKNOWN、429 不自动重试（Retry-After 记录）、失败槽如实记账、16 请求耗尽即止覆盖。身份核验以 `metadata.requested_model/used_model` 为权威（服务器 `model` 字段带 provider 前缀）。reasoning 与输出共享 max_tokens（空内容→FAILED_KNOWN 附诊断）。离线验收 12 项（全部注入 fetch，零真实网络）；连通验证记录见 `stage-g-preflight/amd-connectivity-check.md`（合成数据，与正式请求分离）。
- **AMD 生成预算专项修正**（2026-10-25 同日第二轮，Owner 指令）：思考过程与最终输出共享生成预算（4000 被 reasoning 挤占致 content=null，实测复现）→ 默认 max_tokens=**32,768**（部署实测接受；spec.outputTokenCap 上限同步放宽至 32768；输入 8000 不变；16 请求/36 槽/每请求 ≤6 候选约束不变）。**预算不可分解**：供应商不支持分别设置/报告 reasoning 与最终输出上限——输入 ≤8000（计量）｜生成总预算 ≤32768（共享）｜最终输出单独上限不存在（事后经 usage.reasoning_tokens 分解计量）。`reasoning_effort` 目录未声明（发送被接受、行为有变化迹象，效果记 UNVERIFIED 不假设完整实现智谱参数面）。输出完整性门：`finish_reason=length` → `output_budget_exhausted` **零采纳**（即使 content 可解析）；`content=null`+reasoning usage → 推理预算耗尽诊断保留原始数据；JSON 不完整→零采纳；超 perRequestCandidateCap→零采纳；超时/中断→RESULT_UNKNOWN 不自动重发；无静默截断/自动补全，输出不可绕过骨架门与 validator。超时两段：早段 15s（fetch 无法严格分离连接段——近似标记 connect_or_early）+整体 240s（免费层慢响应实测 104.6~106.9s 样本）；429/网络错误/未知结果沿既有状态机；不因不稳定换供应商；免费 $0 计费不变。合成验证 2 探针（32768+reasoning_effort=max → 完整 JSON；饥饿 30 → length/null 精确复现）+离线测试覆盖（amd+examiner 套件 54/54）。

### 2.1 Actor Loop 最小改造

现有 `runRealActorOpportunity()` 与特定 `oracle.mjs` 紧耦合，不能直接当成通用环境插件。优先抽取 `runControlledActorOpportunity({ environmentPort, ... })`，旧函数保留兼容包装器；若风险过高，可新增独立 Challenge Loop，但必须复用已验证的预算、Transport、哈希和防泄漏工具。无论哪条路线，均须用历史 Lab 测试和 fixture hash 证明无回归。

统一输出 `ActorTraceV1`，至少包括 `sequence`、action、observable result、before/after state digest、model round、error 和 usage。缺少逐步动作证据时，不能只凭最终 outcome 或 Actor 自述判定行为改变。

### 2.2 执行保真度

- `F1_CONTROLLED_ACTOR`：真实模型 API + 固定 JSON action + 确定性 Oracle。
- `F2_HOST_TRANSPORT_CONTROLLED_ACTOR`：真实宿主进程/会话参加受限 action/Oracle 考试，须核验进程、模型身份、配置加载和隔离。
- `F3_HOST_NATIVE_WORKFLOW`：真实文件/命令/外部工具工作流，不属于 MVP。

直接调用与 Codex 同款模型的 API 只能标 F1。只有实际宿主进程/会话有可核验证据时才可标 F2；F2 仍不代表完整生产工作流。

### 2.3 架构

```text
生产主链（不改）
Pain → Diagnosis → Dreamer → Philosopher → Scribe Artifact
                                      └→ 原 Artificer/Evaluator/Review 流程

独立研究支线
Verified Input Resolver
 → 人工核验的 PainMechanismMapping
 → Examiner LLM（只出草案）
 → Compiler/Validator（可信模板、Gold、校准）
 → Frozen Suite + Preregistration
 → A/B Runner（研究阶段可加 C Summary）
 → Independent Mechanical Scorer
 → Append-only Study Report（Owner 只读）
```

只新增一个 LLM 角色 Examiner；Compiler、Validator、Runner、Scorer、Reporter 均为确定性工程组件。MVP 显式触发，不增加生产 DAG 节点。

---

## 3. Phase 0：Pain→机制→模板映射（Phase 1 前置条件）

### 3.1 选择真实机制

可先从 10–20 条脱敏 Pain 摘要建立覆盖矩阵，但首发机制必须有真实价值，不能只因易模拟而选择。优先要求：来源链完整、失败机制清晰、Owner/客观目标可信、行动与后果可观察、适用/例外条件可定义、存在合法替代路径。

### 3.2 必须人工核验的 `PainMechanismMappingV1`

```ts
interface PainMechanismMappingV1 {
  mappingId: string;
  sourcePainRefs: Array<{ id: string; evidenceHash: string; provenance: string }>;
  sourceScribeArtifactId: string;
  principleContentHash: string;
  observedFailure: string;
  failureMechanism: string;
  ownerGroundedGoal: string;
  applicabilityConditions: string[];
  exceptionConditions: string[];
  observableActions: string[];
  objectiveConsequences: string[];
  trustedGoldSourceRefs: string[];
  candidateTemplateId: string;
  scoringPredicates: string[];
  legalAlternativePaths: string[];
  knownLimitations: string[];
  reviewerDecision: "ACCEPTED" | "REJECTED" | "NEEDS_MORE_EVIDENCE";
  reviewerEvidence: string[];
  mappingHash: string;
}
```

映射链必须可审查：

`原始证据 → 失败机制 → 适用/例外条件 → 可观察动作 → 客观后果 → 模板判据`

人工核验是一次性校准机制，不要求 Owner 审批每一道变体题。

### 3.3 必测反例

每个模板必须能区分：
1. 表面遵守原则，但任务实际失败（如调用了检查工具，却检查错误对象或仍夸大结论）。
2. 没采用推荐动作，但通过合法替代路径正确完成任务（证明特定工具调用不是行为目标本身）。

若评分器只检测工具调用、关键词或 Actor 自述，Phase 0 不通过。

### 3.4 Phase 0 GO/NO-GO

GO 要求血缘、可信目标、人工映射、Gold、适用/例外条件、合法替代路径和确定性模板均成立。否则标 `NO_GO_MAPPING_UNVERIFIED` 或 `NO_GO_NO_TRUSTED_GOLD`，停止进入 Phase 1 正式实验。

---

## 4. 输入与信任边界

1. 通过精确 `scribeArtifactId` 读取持久化产物及上游引用；有 Canonical Principle ID 时可用 Pain Recall。无 ID 时只接受精确 Scribe Artifact + 经验证 Pain ID，不按标题猜测。
2. 每个 Study 指定一个 `primaryPainId`；其他 Pain 只作为标注清晰的辅助证据。
3. `ownerRequirementGaps`、`requiredFacts` 缺失或与可信证据冲突时标记 `INSUFFICIENT_OWNER_GROUND_TRUTH`，不得自动补全。
4. Examiner 输入可包含脱敏 Pain/诊断证据、Owner-grounded intent、Principle statement、适用范围、IntentContract、执行条件和模板目录。
5. 历史 Pain/工具输出是不可信数据，不提升为 system 指令。出题前做秘密、个人信息和专有代码最小化；第三方模型传输需授权。
6. Examiner 只输出模板 ID、受限参数和设计理由；不得访问生产工具、Actor 的 judge-only 数据、用户仓库或生成任意可执行代码。
7. 分别记录 `principleArtifactId`、`principleContentHash`、`deliveryPayloadHash`、`mappingHash`、`suiteHash` 和 `graderHash`。

---

## 5. 多场景题集与 Examiner 增量

### 5.1 四类目标

| 家族 | 默认目标 | 检验内容 |
|---|---:|---|
| `FAILURE_VARIANT` | 3 | 原失败机制在变化后的证据、对象或工具条件下是否重现 |
| `CROSS_CONTEXT_TRANSFER` | 3 | 原则是否能迁移到真实不同的决策情境 |
| `BOUNDARY_NEGATIVE_CONTROL` | 3 | 原则不适用或无需触发时是否能克制 |
| `TRADEOFF_CONFLICT` | 3 | 时间、成本、权限或其他约束冲突时是否合理权衡 |

换名词、文件名不构成真正多样性。必须变化潜在决策变量、证据状态、风险/授权条件或合法行动路径。12 题是目标而非硬性配额；不够就报告 `PARTIAL_COVERAGE`。没有至少两个真实不同的决策情境时，标记 `TRANSFER_NOT_ESTIMABLE`。

### 5.2 草案契约

```ts
interface ChallengeDraftV1 {
  scenarioId: string;
  family: "FAILURE_VARIANT" | "CROSS_CONTEXT_TRANSFER" |
          "BOUNDARY_NEGATIVE_CONTROL" | "TRADEOFF_CONFLICT";
  templateId: string;
  templateVersion: string;
  parameters: Record<string, string | number | boolean>;
  sourceMechanismRef: string;
  rationaleForDesigner: string;
}
```

Compiler 仅接受已注册模板、合法参数和值域。未知模板、任意 action、脚本、路径逃逸或越权请求必须拒绝。

编译题须把 `actorVisible` 与 `judgeOnly` 分开存放，并包含：
- `studyEligible`：题本身是否可运行、可判分；
- `principleApplicable`：目标原则是否应适用；
- `expectedMode`: `apply | withhold | resolve_conflict`；
- Gold/判据引用和 `inputHash` / `goldHash`。

**`principleApplicable=false` 但 `studyEligible=true` 是有效边界题，必须执行并纳入负迁移分析。** 不能把“不应触发原则”误当作“题目无效”。

### 5.3 LLM 出题与确定性枚举对照

**[v0.4 修订] 公平比较协议（方案 B）**：两组使用相同可信事实库（DOMAIN_LIBRARY/DISTRACTOR_LIBRARY）、相同机制覆盖要求、相同合法参数空间与值域表、相同 validator、相同 Gold 独立性要求（骨架门）、相同候选预算（36 槽/组）与人工评审规则、相同失败记录与分母规则。确定性枚举器保留为对照基线，不得为突出 LLM 表现而降低基线质量。

Actor A/B 之前，使用相同可信模板、参数空间和校验器比较：
- 有效题比例、机制覆盖、决策变量多样性、重复率、Gold 泄漏率、编译拒绝率、人工修订时间和每道有效题成本；
- 保留全部草案、拒绝理由和人工修改，不因 A/B 成绩回头改题；
- 如果 Examiner 没有带来实际增量，允许 `ENUMERATION_SUFFICIENT`，先用确定性枚举继续，不强制维护 LLM 出题路径。

**[v0.4] 四分去重判度**：去重基于预注册可审计规则，分四级——`exact`（canonical 全等）/ `structural`（数字归一结构签名——「只换名词」陷阱）/ `skeleton`（不可变骨架相同=同一决策结构的不同措辞，**不是多样性**）/ `unresolvedSemantic`（确定性不可判，交盲评）。**候选被去重或 E 臂少交重复不得记为 Examiner 出题增量**；实质多样性只以「真正不同的决策情境」（独立决策变量/证据分布/约束结构的差异）计。已知基线事实：B 臂 36 候选含 12 对 structural 重复（docs/stale 干扰变体结构同构，24/36 卷入）——duplicateRatio 基线失真已入案，不得直接用作组间优劣证据。

### 5.3A [v0.4 增量3，最终收口] B0/B1/E 三组对照（2026-10-25 收口轮）

- **完整合法空间经实际枚举全验核实**（非乘法推算）：36 骨架点 × 11 budget × 10 deadline × 3^facts = **31,680 组合逐一构造 caseDef 并通过完整 validator（0 失败，~7s）**；指纹 sha256=8a46476e…（测试钉死）；**stakes 为纯标注维度**（env/scorer 不读、不同 stakes 裁定逐字节相同——已测）→ **实质决策情境空间 = 36×110 = 3,960**；非法点（越界/越域/未知 distractor）一律 value_domain_violation。
- **B0**（历史参考）：原 36 固定点；仅 3 唯一 constraints 集（2.7% 参数覆盖）；12 对 structural 重复；不修改。
- **B1 v2**（主要对照，方案 B 采纳）：`b1-deterministic-strategy.v2` = **EXHAUSTIVE_VERIFY_THEN_SELECT**——完整空间全验后按 v1 公式确定性选择 36 两两互异参数点（唯一性带数学证明）；v1 保留为历史/次级基线。策略 E 运行前冻结；**不代表最强可能确定性基线**，任何『E 优于确定性』结论只相对本基线。
- **E**（实验组）：与 B1 同一可访问空间（同骨架库+值域+表达字段）、同一骨架门/validator/盲评；实际采样=其 16 请求产出（槽位记账）。
- **公平契约**明文区分「共享合法值域」≠「实际搜索策略相同」（B0 固定 36 点 / B1 全空间枚举后选 / E 模型自主采样）。
- **覆盖率双口径**：参数网格覆盖（唯一 (budget,deadline)/110）与完整组合覆盖（唯一完整组合/31,680；36 槽≈0.11% 如实披露）；实质多样性以 3,960 实质情境为基准且 stakes 不计。
- **结论边界四问**（可判：表达质量/有限预算选择/人工修订成本/相对 B1 v2 优劣；不可判：优于一切确定性方法、新事实构造、真实宿主行为、长期内化）——见 protocol v2 `conclusionBoundaries`。

---

## 6. A/B/C：原则注入、关闭与公平性协议

### 6.1 实验臂定义

- **A — `BASELINE_NO_ADDED_PRINCIPLE`**：固定共同基线，不额外注入本 Study 的目标 Principle。
- **B — `TARGET_PRINCIPLE`**：相同共同基线，通过预先指定的通道注入冻结 Principle。
- **C — `EXPERIENCE_SUMMARY`**：研究阶段加入高质量经验 Summary，检验 Principle 相对 Summary 的增量。

A 不是“完全没有任何原则的模型”，只代表没有额外加入本 Study 的目标原则。若既有提示、记忆、检索或工具输出已含同义目标原则，必须标污染/混杂，不得把 A 描述成纯净空白模型。

### 6.2 原则如何注入/关闭

1. 每次运行使用不可变 `ArmConfig`；运行中不得切换 arm 或热修改注入内容。
2. 原则只通过一个明确、可审计的实验注入通道进入。A 不注入目标 Principle；B 注入精确冻结版本；C 注入冻结 Summary。
3. **禁止**在 B 会话里发送“现在忽略原则”来模拟 A。A 必须从未接触目标 Principle 的干净共同基线启动。
4. 三臂使用相同注入位置、共同基线版本、任务指令、工具、权限、评分器和预算策略。处理内容是预注册差异；长度/信息量不匹配需报告为潜在混杂。
5. 不修改生产 RuleHost、全局提示词、用户记忆、激活状态或治理数据库实现开关。
6. B 优先使用实际生产可投递的 `principleDraft.statement`。无法复现生产 PromptReader 包装/位置/预算时，只能标 `research_same_channel`，不得声称生产投递等价。
7. Examiner 可读取完整 IntentContract 做出题，但 Actor 不得额外收到隐藏范围、反模式或 Gold，除非它们本来就是生产投递内容。
8. 每个 `(studyId, caseId, armId, repetitionId, attemptId)` 使用唯一 Session/进程、工作区、Oracle 初始状态和输出目录。

### 6.3 执行前校验

每次运行前核验：
- `armId` 符合冻结计划；
- A 实际 payload 不含目标 Principle，B 含精确版本，C 含冻结 Summary；
- `principleContentHash`、`deliveryPayloadHash`、Profile/Memory/Tool manifest 与实际加载证据一致；
- Examiner/Actor observed model identity 不同；
- A/B/C 的 Actor 模型、版本、推理设置、工具、权限、任务、评分器和预算符合计划；
- 审计实际发送内容及实际加载配置，而非只信声明的清单。

无法审计实际系统提示、记忆、插件、Hook 或工具时标 `BASELINE_CONTENT_UNVERIFIED`；确认 A 通过其他渠道接触目标原则时标 `CONFOUNDED_BASELINE`。可保存探索性结果，但不能声称干净因果比较。

### 6.4 真实宿主隔离验收

真实宿主阶段前必须证明：
- 配置、环境变量、Profile、Memory、插件、Hook 和工具有白名单；
- Actor 不能读取 `judge-only/`、Gold、评分规则或 Examiner 私有内容；
- Actor 不能访问未授权外部工具、网络、原用户仓库或生产治理写接口；
- 记录实际加载内容和有效配置；单纯 hash 不足以证明没有语义相近原则；
- 故意读取隐藏答案、调用非实验工具的拒绝测试通过；
- 每次重复有独立 Session/进程、scratch 和 Oracle 状态；
- 结束后检查跨组泄漏、生产写入和外部副作用。

不能证明隔离时停止 F2。可保留 F1 结果，但不能把它标为真实宿主实验。

### 6.5 随机化与重复

- 题集先冻结，实验计划后冻结，再启动 Actor 请求。
- A/B 同题配对；顺序预先随机化或平衡，记录种子、时间窗、模型版本和实际顺序。
- 重复运行使用新会话和状态；重复题只估计模型随机性，不算新独立情境。
- 12 题 × 2 臂 × 1 次 = 24 个答题任务执行，不是 24 次模型请求；多轮调用、Examiner 生成、无效输出都要计预算。
- 首轮只作探索性观察。增加重复须在看结果前预注册，并保留所有结果。

---

## 7. 双阶段授权、模型身份与预算

### 7.1 Stage G：出题授权

最终 `suiteHash` 在出题后才产生，因此出题授权不得要求预先绑定最终 hash。Stage G 必须绑定：
- 脱敏输入与 `inputManifestHash`；
- `mappingHash`；
- 允许模板目录及版本；
- Examiner 请求前模型要求；
- 最大生成轮数、请求数、可观测 token/费用预算；
- 数据传输/隐私许可；
- 候选数量、拒绝/修订上限和停止条件。

生成后记录 observed model identity、实际请求、用量/成本、所有草案和拒绝理由。模型身份不符合要求时停止后续生成，并保留已发生的成本。

### 7.2 Stage R：答题授权

在题集冻结后绑定：
- `suiteHash`、`mappingHash`、`graderHash`、`studyPlanHash`；
- Examiner/Actor 模型要求和执行模式；
- A/B/C 臂、题目、重复次数和顺序；
- 每题、每臂、全 Study 请求预算；
- 时间限制、费用/Token 阈值、停止条件；
- Profile/Memory/Tool 白名单和隔离验收要求。

Owner 可一次批准两阶段的上限和条件，但 Stage R 必须在 suite 冻结后由机器重新校验。不得挪用既有 PL 实验授权。

### 7.3 身份与预算等级

记录 `requestedModelIdentity`、`observedModelIdentity`、`hostProcessIdentity` 与可验证等级。Examiner/Actor 实际身份相同则拒绝正式实验；A/B Actor 身份不一致时相关配对无效。

| 类别 | 能承诺什么 | 规则 |
|---|---|---|
| 进程/会话/请求启动数 | 可启动前硬限制 | 先预留，再调用 |
| 执行时间 | deadline、超时终止及子进程清理（需验证） | 记录清理结果 |
| Token/费用（调用后可得） | 观测阈值；达到后阻止下一次调用 | 不承诺当前请求绝不超额 |
| 服务端硬额度 | 验证后才可称硬限制 | 保留服务端证据 |
| 全 Study 成本 | 请求前预留、调用后结算 | 记录每臂/每题/全局账本 |

### 7.4 请求预留协议

1. 校验授权、状态与预算；
2. 持久化预算预留；
3. 写 `REQUEST_PREPARED`；
4. 发送请求；
5. 持久化响应和 observed usage；
6. 结算并写 `SUCCEEDED`、`FAILED_KNOWN` 或 `RESULT_UNKNOWN`。

请求数在发送前预留，不因崩溃恢复而归还。请求已发出但结果未落盘时标 `RESULT_UNKNOWN`，不得自动重试、不得假定没有费用。

---

## 8. 串行、幂等与中断恢复

MVP 串行运行，每个 Study 单写锁，所有事件 append-only。状态建议：

`CREATED → INPUT_VALIDATED → MAPPING_ACCEPTED → SUITE_DRAFTED → SUITE_VALIDATED → SUITE_FROZEN → PLAN_FROZEN → AUTHORIZED → RUNNING → REPORT_READY`

异常状态：`NO_GO_MAPPING_UNVERIFIED`、`NO_GO_NO_TRUSTED_GOLD`、`INVALID_PROTOCOL`、`BUDGET_EXHAUSTED`、`RESULT_UNKNOWN`、`INTERRUPTED`、`ABORTED`、`REPORT_INCONCLUSIVE`。

恢复规则：
- 请求未发出：可继续，但重验 hash/授权/预算。
- 已知结果已落盘：不自动重跑；新重复必须有新 `repetitionId`。
- 请求已发出、结果未知：不自动重试；保留 reservation 和未知状态，由显式决定记录失访或创建新授权 attempt。
- 冻结后的 Suite/Gold/Plan/Grader 改变：原 Study 不可继续，创建新 revision/Study。
- 同一 Study 不允许多个写者；锁回收需有故障测试。
- 停止条件触发后停止新请求，已发请求按可观测能力终止/结算并如实记录。

---

## 9. 评分、分母与唯一汇总口径

### 9.1 分母定义

- `assignedDenominator`：预注册的所有题 × 臂 × 重复执行单元。
- `studyEligible`：题目自身有效、可运行、可独立判分。
- `principleApplicable`：目标原则是否应适用。
- `expectedMode`：`apply | withhold | resolve_conflict`。
- `validExecution`：单臂执行协议和证据是否有效。
- `validPairedCase`：同题 A/B 都有足够轨迹与结果，且处理差异符合预注册协议。

`principleApplicable=false && studyEligible=true` 必须保留在边界/负迁移分析。不得因 Agent 拒答、任务失败或结果不利而事后改分母。若冻结后发现 Gold/协议缺陷，不得只删一臂；保留原记录，将受影响批次标记 `INVALIDATED_BY_PROTOCOL_DEFECT`，修复后新建版本。

### 9.2 每次执行分别记录

`protocolValidity`、`behaviorAligned`、`forbiddenBehaviorOccurred`、`objectiveTaskOutcome`、`negativeTransfer`、`executionCost`、`trajectoryEvidenceQuality`、`runHealth`。

### 9.3 异常情况处理

| 情况 | Agent 行为失败？ | 分配/完成率报告 | 有效配对主分析 |
|---|---|---|---|
| 轨迹有效且 Agent 采取错误动作 | 按冻结规则判 | 保留 | 配对有效则纳入 |
| 任务失败但行为符合原则 | 行为与结果分开记录 | 保留 | 证据有效则纳入 |
| no response / 无效 action | 单独记录，不静默删除 | 保留 | 按预注册规则单列并做敏感性分析 |
| 基础设施未启动/身份不符 | 不自动算 Agent 违反原则 | 保留 | 不纳入有效配对 |
| 一臂预算耗尽 | 不自动算行为失败 | 保留 | 配对无效，报告不对称 |
| Gold 泄漏/基线污染 | 不归因行为成败 | 保留 | 协议无效/混杂 |
| 原则不适用但题有效 | 按正确克制/负迁移评分 | 保留 | 纳入边界分析 |
| 仅有 Actor 自述、无轨迹 | 不判行为正确 | 保留 | 不纳入，标轨迹证据不足 |

### 9.4 报告必须分维度

1. 协议/证据质量：有效执行率、有效配对率、身份/隔离/轨迹完整度、未知数。
2. 行为收益：预注册适用正例中符合行为判据的比例及 A/B 配对差异。
3. 边界/负迁移：不适用题中的错误触发、过度检查、拒绝、误阻与额外成本。
4. 客观任务结果：与行为符合度分开统计。
5. 成本：请求数、工具步数、时间、可观测 token/费用与超限。
6. 覆盖：四类有效题数、独立决策变量数、迁移是否可估计。

同时报告预注册分母、全部分配/有效/缺失单元、逐题原始计数、配对差异与不确定性。收益和负迁移同时存在时并列呈现，不能用总体平均抵消隐藏副作用。

### 9.5 固定示例

12 道题：6 道适用正例、3 道边界题、3 道冲突题。若 B 有一道因宿主未启动而无轨迹：
- `assignedDenominator` 仍保留 24 个 A/B 执行单元；
- 该 B 执行进入完成率/失访报告，不自动计作行为失败；
- 该题不进入有效配对主分析；
- 报告有效配对只剩 11 道及缺失原因，并说明潜在偏差；
- 不得只删掉不利一臂而不报告。
若 B 在适用正例中改善，但在边界题中产生无谓检查，必须同时报告收益与负迁移。

---

## 10. 研究侧车与数据布局

```text
challenge-studies/<studyId>/
  input-manifest.json
  pain-mechanism-mapping.json
  examiner-draft-log.jsonl
  challenge-suite.draft.json
  suite-manifest.json
  actor-visible/case-*.json
  judge-only/case-*.json
  preregistration.json
  generation-authorization.json
  run-authorization.json
  budget-ledger.jsonl
  events.jsonl
  runs/<case>/<arm>/<repetition>/<attempt>.json
  adjudications.jsonl
  behavior-report.json
  behavior-report.md
  hashes.json
```

所有已冻结内容和结果不可原地覆盖；更正必须新建 revision 并记录父版本。不得伪造生产 Principle/Approval/Activation ID。Principle 改版后旧成绩只属于旧 `principleContentHash`。

---

## 11. 安全与防泄漏

- Examiner 输出只接受模板参数；拒绝任意代码、命令、未知 action 和路径逃逸。
- Actor 不挂载 judge-only 路径；测试真实拒绝读取 Gold。
- A 臂已有目标原则时标混杂；无法确认实际加载内容时标 `BASELINE_CONTENT_UNVERIFIED`。
- 每题/每臂/每重复独立会话、工作区、Oracle state 和输出路径。
- 不访问原用户仓库、生产数据库、审批/支付/消息系统或未授权网络。
- 真实模型调用前完成数据脱敏与传输授权。
- 所有失败、拒绝题、预算不足和未知结果均保留；不能通过改题追求正向结果。
- 评分优先机械执行；人工裁定应隐藏 arm 并保留理由。
- 任何生产写入、Gold 泄漏或跨臂污染都立即停止 Study。

---

## 12. 测试与验收

### 12.1 Phase 0
- Pain 与 Scribe 血缘可追溯；
- 映射经人工核验；
- Gold、适用/例外、合法替代路径可复核；
- 能区分表面遵守但失败与合法替代路径成功；
- 不满足时明确 NO-GO，不调用真实模型。

### 12.2 Phase 1 离线
- Mock 出题→编译→校准→A/B→轨迹→评分→报告全链可重算；
- A 不注入、B 精确注入的协议测试通过；
- 有效边界题进入负迁移分母；
- 预算预留、未知结果、不自动重试、单写锁、恢复状态机通过故障测试；
- 历史 PL Fixture/Gold/Prereg/hash 不变；
- 生产状态无写入；无授权时真实模型调用为零。

### 12.3 Examiner 增量
- 与确定性枚举在相同模板/参数空间下比较；
- 保留所有草案、拒绝原因、修订时间和成本；
- 允许结论 `ENUMERATION_SUFFICIENT`，不伪造 LLM 增量。

### 12.4 真实模型/宿主
- Stage G/R 授权、Suite/Grader/Plan 冻结；
- Examiner/Actor observed identity 不同；
- A/B 投递内容与声明一致；
- 实际宿主配置、记忆、工具、Hook 和 Gold 隔离探针通过；
- 预算能力如实分级，未知结果不会自动重试；
- 无生产副作用，报告可从轨迹重算。

### 12.5 强制负向测试
1. Gold 泄漏 → 拒绝。
2. Examiner 自称题目通过 → 忽略。
3. A 臂包含目标原则 → 标混杂。
4. Examiner/Actor 同一模型身份 → 拒绝。
5. Principle 与可信 Owner 约束矛盾 → 不让 Principle 自证 Gold。
6. 无可信目标/模板 → `NOT_EVALUABLE`。
7. B 过度检查/拒绝 → 报告负迁移。
8. A 全部通过 → 报告无检测增益/天花板，不改题。
9. Actor 自述无轨迹 → 不判行为正确。
10. 两臂模型身份不同 → 相关配对无效。
11. 一臂预算耗尽 → 保留所有分配项，不只分析有利臂。
12. 生产写入 → 立即失败并停止。
13. 原则不适用但题有效 → 仍进入边界分母。
14. 缺少轨迹 → `TRAJECTORY_EVIDENCE_INSUFFICIENT`。
15. 重复共享 Session/工作区 → 拒绝。
16. 请求结果未知 → 不自动重试、不重置预算。
17. Examiner 不优于枚举 → `ENUMERATION_SUFFICIENT`。
18. 只换名词的题集 → 不得声称迁移有效。
19. 冻结后只删单臂不利题 → 批次标记协议缺陷。
20. 崩溃恢复 → 不重复预留/扣减，不覆盖原结果。
21. **[v0.4]** 否定词翻转（极性 flag）/真值方向改变/蕴含改变/观察输出替换或反转/任务文本泄漏答案/参数越界/未知模板字段版本/伪造来源/Gold 隐式耦合 → 拒绝或强制盲评（`skeleton`/`stageg` 测试套件，56 项）。
22. **[v0.4]** 合法表达变化不得被错误拒绝（假阴性防护）；新旧证据冲突未纠正/证据不足不澄清不降级 → 违规检测；重复措辞伪装多样性 → skeleton 去重；删重复虚增有效率/两组分母不一致 → 分母契约拒绝。
23. **[v0.4 增量] Examiner 适配器离线验收**（五组 26 项）：A 正常路径（Mock 端到端/受约束输入 36 组合哈希可重算/usage 恒标 simulated）；B 输入安全（spec 八类拒绝；候选伪造来源/骨架篡改/答案泄漏/domain_proposal 逐项拒并留因）；C 授权安全（九类拒绝全部在 transport 工厂调用计数=0 下发生；完美授权也因真实 transport 未实现而拒绝）；D 故障恢复（已知失败/发送后崩溃=RESULT_UNKNOWN/同 id 禁自动重试/新 id 新预留/已结算不重执行/超限审计行/预留幂等/seq 单调可审计）；E 安全边界（模块无 fetch/env/exec 静态证明；受约束输入无 judge-only 材料；研究授权文件保持 NOT_AUTHORIZED）。

---

## 13. 实施阶段与 GO/NO-GO

### Phase 0 — Feasibility & Mapping
只读调查、脱敏 Pain、人工机制映射和确定性模板可表达性；无真实模型调用。
交付：10–20 条 Pain 覆盖矩阵、一个完整映射、Gold/替代路径、Oracle 支持情况和未知项。未通过映射/Gold 验收即 NO-GO。

### Phase 1 — Fixed-suite Offline Golden Path
固定/枚举题集 + Mock Actor + A/B + 轨迹 + 机械评分 + 预算/恢复。无真实模型调用。
只有工程闭环可重算、历史研究资产不回归、注入/分母/恢复契约通过，才算 Phase 1 完成。它不等于双 LLM 功能 MVP。

### Phase 2a — Examiner Generation Pilot
单独 Stage G 授权；比较 Examiner 与确定性枚举的题目质量。若无增量，停止扩展 LLM 出题，采用枚举。

### Phase 2b — Controlled Actor A/B
单独 Stage R 授权；先 F1，真实宿主 F2 需通过隔离/身份探针。题集冻结后执行 A/B，保留全部失败和未知结果。

### Phase 3 — Summary Control
若目标是研究 Principle 抽象的独立增量，必须加入高质量 Summary 臂；冻结摘要制作方式、信息源、长度/预算与投递位置。既有研究状态中 C-A/C-E 尚未支持 Principle 优于 Summary 的主张，不能用 A/B 代替此对照。

### Phase 4 — Product Integration（不属于 MVP）
Owner Review 只读展示、长期真实任务观察、更多宿主/环境、自动触发或让分数成为治理门禁均需独立 ADR 和 Owner 授权。

---

## 14. DoD 与 No-Go

### Phase 0 DoD
一个真实 Pain 机制有人工核验映射、可信 Gold、合法替代路径和可机械验证的模板。

### Phase 1 DoD
离线 A/B 全链可重算；轨迹、注入、分母、未知结果和恢复协议通过；历史资产 hash 与生产状态不变；无授权时零真实模型请求。

### Phase 2a DoD
Examiner 与确定性枚举对照可复核，报告质量、人工成本与失败；可得 `ENUMERATION_SUFFICIENT`。

### Phase 2b DoD
不同真实模型身份、独立会话、A/B 投递和隔离可核验；报告可从原始轨迹重算，保留正向、无效、负向、未知和失访结果。

### `HOST_EXAMINER_MVP`
仅当 Examiner 使用独立真实 LLM 出题、Actor 通过实际宿主进程/会话答题、宿主隔离通过验收且报告可重算时使用。直接 API Actor 只能标 `DUAL_LLM_RESEARCH_PROOF`。

### No-Go
- Pain/Principle 血缘不清；
- 无可信 Gold，或原则自证正确答案；
- 失败机制到模板映射未人工核验；
- A/B 注入/关闭无法验证；
- 真实宿主配置/记忆/工具/Hook/Gold 隔离不成立；
- 授权、身份或预算不完整；
- 未知请求结果会自动重试或重置预算；
- Examiner 可运行任意脚本/访问生产工具；
- 生产写入、Gold 泄漏、跨臂污染；
- 冻结后为了正向结果改题、改 Gold、改评分或删单臂不利样本；
- 用 Mock 冒充真实双 LLM/宿主实验；
- 仅凭 A/B 正向就声称 Principle 优于 Summary。

---

## 15. 参考代码与基线纪律

主要参考：
- `packages/pd-cli/src/services/pain-recall.ts`
- `packages/principles-core/src/runtime-v2/internalization/scribe-output.ts`
- `packages/principles-core/src/runtime-v2/internalization/intent-contract.ts`
- `packages/principles-core/src/runtime-v2/internalization/internalization-job-graph.ts`
- `packages/principles-core/src/runtime-v2/internalization/peer-runner-contracts.ts`
- `packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts`
- `packages/principles-core/src/runtime-v2/internalization/evaluator-prompt-builder.ts`
- `packages/principles-core/src/runtime-v2/internalization/refiner-rulehost-gate.ts`
- `scripts/dev/principle-learning-lab/lib/{actor,oracle,evaluator,g2,real-runner,host-actor,fixture,sidecar}.mjs`
- `docs/specs/SPEC-PD-PL-001-principle-learning-dataset-v0.3.md`
- `docs/specs/BEHAVIORAL_LEARNING_MVP_ACCEPTANCE_v3.md`
- `docs/research/PL-PROJECT-STATE.md`

实施开始时记录实际 HEAD，并比较与 `2f5d2b8` 的差异。若源代码变化，先更新复用/限制表；不得把拟新增接口描述为现有 API。

---

## 16. Owner 决策建议

建议先批准 Phase 0；Phase 0 通过后，再批准 Phase 1 离线研究实现。当前不预先批准真实模型调用、真实宿主实验、自动触发、生产 DAG 修改或将研究评分用于治理门禁。

成功标准不是 Examiner 能生成多少道题，而是：**在一个真实 Pain 家族中，建立可核验的 Pain→机制→模板映射，通过可控注入、隔离执行和独立评分，可靠保留 Principle 帮助、无效或伤害 Actor 的全部证据。**

---

## 附录 A [v0.4] 概念区分（判度纪律）

| 概念 | 定义 | 判度方式 |
|---|---|---|
| 事实正确性 | 命题真值是否与冻结模拟环境一致 | 骨架 goldTruth（机械） |
| 语义骨架不变性 | 不可变投影与冻结基准 canonical 相等 | 骨架门（机械） |
| 表达变化 | 措辞/任务文本/标签改写，不改语义方向 | 表达审计+盲评（机械仅近似 flag） |
| 合法参数组合 | 值域表内的参数选择 | 值域校验（机械） |
| 实质结构多样性 | 独立决策变量/证据分布/约束结构的差异 | skeleton 去重+盲评 |
| 重复候选 | exact/structural/skeleton 三级可审计判定 | 去重规则（机械） |
| 题目质量 | 盲评八维度（关键门槛一票否决） | 独立盲评 |
| 人工修订成本 | 首审到终判的实际时间 | 计时入账 |
| 有效题成本 | (模型费+人工费)/合格题数 | 分账公式 |

**纪律**：改写句子、少交重复题、格式正确——任何一项单独都不是「Examiner 出题能力更强」的证据。

## 附录 B [v0.4] PAHF 借鉴边界

借鉴（仅离线测试思路）：行动前澄清（不可观察事实→ask-owner/合法观察/降级 inferred；不为守原则做无谓检查；不把猜测当事实）；行动后证据更新（新旧证据冲突→按实际证据纠正、保留证据来源、无效重复操作计费）。
不借鉴/不实现：PAHF 的 SQL/FAISS 记忆系统、通用个性化 Agent、长期偏好漂移模拟平台、生产记忆服务、生产 DAG 节点、自动反馈训练闭环。
新夹具为独立 synthetic_test_fixture（`scripts/__tests__/principle-learning-lab-challenge-skeleton.test.ts`），**未加入冻结 CEB-001**；长期适应只作为主 SPEC（SPEC-PD-PL-001）的候选研究问题记录，本轮未验证任何长期行为内化。
