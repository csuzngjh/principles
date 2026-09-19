# PRI-862 CIL-006 Source Pain Provenance Guard Audit

> 只读架构调查。回答唯一问题：**sourcePainId 是否应该像 sourcePrincipleId 一样增加
> provenance validation guard？** 四道门逐一过闸：Source Exists → Consumer Exists →
> Trust Boundary Broken → Measured Impact。
> 本报告不伴随任何代码/配置/数据库/PR/Linear 修改。

## Executive Summary

**应该加 guard，但问题的真实形状比 CIL-006 原表述更宽。** 本次审计在当前
origin/main 上实测出同一根断链的两个臂：

1. **编造臂（guard 缺失）**：`sourcePainId` 是 LLM 自由字符串（`dreamer-output.ts:57,83`
   `Type.Optional(Type.String())`）。pi-ai 适配器在三条输出路径全部剥离该字段
   （`pi-ai-runtime-adapter.ts:879,1123,1204`，含 repair 环后的终剥离），但
   **L2AgentLoopAdapter（`l2_dreamer` flag 开 + dreamer 任务）和
   OpenClawCliRuntimeAdapter（`runtimeKind: 'openclaw-cli'`）对 lineage 字段零处理**
   （三个非 pi-ai 适配器文件 grep `sourcePainId|LINEAGE_FIELDS` 零命中）。runner 侧
   `postFetchTransform` 只 reconcile `taskId`（`dreamer-runner.ts:335-346`，注释自证
   "dreamer is the chain head, so the only runner-owned lineage is taskId" —— 这正是
   盲区：task seed 里的 `sourcePainId` 同样是 runner-owned 权威）。prompt 侧对
   principleId 有显式反编造规则，对 painId 没有，且 few-shot 示例（:91）本身就在
   **教模型编造** `"sourcePainId":"pain-null-crash"`。
2. **丢失臂（权威有而无人接）**：真实 pain id 权威存在于 dreamer 任务自身
   `diagnostic_json.sourcePainId`（`intake-to-internalization-bridge.ts:248`，CLI 侧由
   PRI-435 反编造解析器供给，`pd-cli/commands/candidate.ts:129-197` "ERR-004: resolved
   from canonical chain, never invented"）。但 `resolveFormationContext` 抬升
   provenance 时**只读工件内容**（`formation-context.ts:350,796`），从不看任务 seed；
   pi-ai 路径剥离后又无人回注 ⇒ 默认运行时下 `provenance.sourcePainId` 结构性恒为
   null。PRI-841 真实数据集 2/2 家族实测：工件无字段、provenance=null。
3. **消费面已经变成 Owner 可见面**：PRI-858 合入后，`owner-decision-review.ts:404` 把
   `provenance.sourcePainId` 投影进决策证据，`OwnerDecisionCard.tsx:166-169` 直接渲染
   给 Owner。**治理卡片上的一行自由文本，上游却没有任何一道闸。**

- `PRI_862_RESULT=SPEC_REQUIRED`
- 推荐方案 A（task-seed 权威 reconcile + few-shot/prompt 修正，复用现成
  `reconcileLineageEcho`/`injectRunnerLineageIfAbsent`，runner 级修复对适配器不对称
  免疫）；方案 B（删除字段）与 C（新 registry）均不成立（论证见 Options）。
- VERIFIED=14 · INFERRED=3 · UNKNOWN(NOT VERIFIED/NOT MEASURED)=3

## Baseline

```text
local HEAD      = 47946c16 (main, 落后；已 git fetch)
origin/main     = 0909c7f31e52f43ea851f63cb888bb752d432a46
证据读取方式    = git show origin/main:<file> / git grep origin/main（全部结论以
                  origin/main 为准，未使用本地旧树）
PRI-858         = merged 407e9056 (#1770) → owner-decision-review.ts 已含 formationEvidence
PRI-859         = merged dabbf387 (#1769)
```

## sourcePainId Lifecycle

| 阶段 | 事实 | 状态 | 证据（origin/main） |
|---|---|---|---|
| 生产（真值） | bridge seed 把 `sourcePainId` 写入 dreamer 任务 `diagnostic_json` 顶层 | VERIFIED | `intake-to-internalization-bridge.ts:248`；`:278` 注释"for callers that already have a painId in scope"；输入可选字段 `:39,284,293,323` |
| 生产（CLI 真值解析） | pd-cli 有显式**反编造解析器**：从诊断任务链 diagnosticJson 解析，"never invented"，解析失败返回 null | VERIFIED | `pd-cli/commands/candidate.ts:129-197`（:141 ERR-004 注释, :192 `Object.hasOwn`, :195 空串→null），:338 起调用后 seed |
| 生产（观测真值） | `pain_events` 表（含 `canonical_pain_id`）是宿主观测pain的落盘权威 | VERIFIED | `trajectory-schema.ts:91`；`production-pain-evidence.ts` INSERT；本机 `D:/Code/principles/trajectory.db` 实测 26 行（只读） |
| LLM 面 | prompt few-shot 示例含编造值 `"sourcePainId":"pain-null-crash"`；约束仅 "sourcePainId is an optional string"；无 principleId 式反编造规则 | VERIFIED | `dreamer-prompt-builder.ts:91,106`；对照 `:95-105` principleId 规则"…Do NOT invent placeholder values…If unsure, simply omit" |
| 校验面 | schema 接受任意字符串（无 enum/格式/FK） | VERIFIED | `dreamer-output.ts:57` `readonly sourcePainId?: string`；`:83` `Type.Optional(Type.String())` |
| 适配器面（pi-ai） | 三条输出路径（free-form / tool_call / JSON-parse）统一 `stripLineageFields`（字段清单含 sourcePainId）；**repair 环 `preserveLineageFields` 虽回注，但终剥离发生在其后**（:879 对已 repair 的 parsedOutput 执行），无漏网 | VERIFIED | `pi-ai-runtime-adapter.ts:879,1123,1204`（ERR-008 family/PRI-272 注释:872-877）；`structured-output-repair.ts:352-355`；`output-repair-contract.ts:117-138` `LINEAGE_FIELDS` 含 `'sourcePainId'` |
| 适配器面（L2 / OCRA） | 生产接线按 runtimeKind 分派：pi-ai→(l2_dreamer?L2AgentLoop:PiAi)，openclaw-cli→OCRA。**L2AgentLoopAdapter 与 OCRA 全文无任何 lineage 字段处理**（不剥离、不校验） | VERIFIED | `internalization-consumer-cycle.ts:455-556`（含 :501 L2 分支、:546 OCRA 分支）、`pd-cli/services/runtime-adapter-resolver.ts:272-352` 同构；三适配器文件 `git grep 'sourcePainId\|LINEAGE_FIELDS'` 零命中；与 `docs/audit/agent-pipeline-audit-2026-09-15/VERIFICATION-B.md` NEW-5 一致（本次以代码复核，非引文档） |
| runner 面 | `postFetchTransform`：`reconcileLineageEcho` **只含 taskId**；随后 `stripFabricatedCorePrincipleIds`。**无 sourcePainId 回注、无校验** | VERIFIED | `dreamer-runner.ts:333-346`；task 记录在 execute 内可读（`:131 getTask`），seed 真值在射程内 |
| 抬升面 | resolver 只从**工件 content** 读 `sourcePainId` 抬进 `FormationProvenance`；不查 task seed、不查 pain_events | VERIFIED | `formation-context.ts:350` `readString(dreamerContent,'sourcePainId')`；`:796` provenance passthrough；类型 `:139,277` `string \| null` |
| 消费面 | 见 Consumer Impact | VERIFIED | 下表 |

## Canonical Source Analysis

真值有三层，且互相之间没有闸：

1. **任务 seed**（`diagnostic_json.sourcePainId`）— 由 CLI 侧 PRI-435 解析器从诊断链
   解析、或宿主编排显式传入；`candidate.ts:141` 已把它确立为"never invented"的
   canonical chain 产物。**这是 dreamer runner 同任务内可及的权威**
   （`dreamer-runner.ts:131`）。
2. **`pain_events` 表**（trajectory.db）— 观测事件的最终落盘权威。消费侧已有
   **membership 校验先例**：`behavior-example-pack-assembler.ts:110-113`
   `getPainEventByCanonicalId(input.sourcePainId)` 未命中即 ERR-069 fail-loud 抛错。
3. **工件 contentJson 里的 LLM 字符串** — 目前**唯一**被 `resolveFormationContext`
   采信的来源（`formation-context.ts:350`）。

结构旁证：`pi_artifacts` 表有独立的 `source_principle_id` 列（本机 schema 实测），
pain 血缘却只活在 contentJson 自由文本里——principle 血缘有 schema 位、pain 血缘没有，
与两条链的 guard 不对称同构。

Inference: 三层真值中，被信任的恰是最弱的一层（LLM 字符串），而被信任纪律保护的两层
（seed、pain_events）在生成侧无人引用。

## sourcePrincipleId Comparison

| 维度 | sourcePrincipleId | sourcePainId |
|---|---|---|
| prompt 反编造规则 | 有（"Do NOT invent placeholder values…omit"，`dreamer-prompt-builder.ts:95-105`） | **无**（仅 "optional string" :106） |
| few-shot 示范 | 示范遵守规则 | **示范编造**（:91 `"pain-null-crash"`） |
| schema | 有 registry 成员格式约束意识（见下行 guard） | `Type.Optional(Type.String())` 任意串 |
| 生成侧 guard | `stripFabricatedCorePrincipleIds`（`strip-fabricated-ids.ts:25-26`：非 `isCorePrincipleId` 成员即 `Reflect.deleteProperty`；注释明言"format-only regex would accept T-99"→用**成员校验**） | **无**（dreamer reconcile 只含 taskId，`dreamer-runner.ts:340-342`） |
| 消费侧 guard | — | 有先例：assembler membership + ERR-069 fail-loud（`behavior-example-pack-assembler.ts:110-113`） |
| 工件表列 | `pi_artifacts.source_principle_id`（schema 位） | 无对应列（仅 contentJson） |

**同一仓库、同一风险类（LLM 编血缘 id）、一处三重设防、一处三重裸奔** —— 这不是
设计选择的差异记录（全仓无注释声明"painId 故意不校验"），CIL-006 原判断在
origin/main 上仍然成立，且因 PRI-858 合入而**影响面升级**。

## Consumer Impact

| 消费者 | 用法 | 污染/失真后果 | 状态 |
|---|---|---|---|
| `owner-decision-review.ts:404` → `OwnerDecisionCard.tsx:166-169` | 决策卡直接渲染 `formationEvidence.sourcePainId` 给 Owner | Owner 在审批界面看到编造/为空的 pain 溯源；PRI-846 mismatch 裁决语境下 Owner 被要求判断"原则忠于 pain 吗"而 pain id 本身不可信 | VERIFIED |
| `formation-context.ts:796` → evaluator prompt（`evaluator-prompt-builder.ts:261` 明示"sourcePainId when present"） | 喂给模型当血缘证据 | 编造 id 在下游 prompt 间自我强化（hallucination laundering） | VERIFIED |
| `behavior-example-pack-assembler.ts:55,110` | 以 `canonical_pain_id` 查 pain_events，**未命中即抛**（输入由 Owner 标注流供给） | 若上游把编造 id 传入该入口 ⇒ 运行期 ERR-069 硬失败（fail-loud 是正确姿态，但成本转嫁到消费点） | VERIFIED |
| `reflection-context.ts:66-92` | 从 `principle.derivedFromPainIds`（DB-backed）解析，**不读工件字符串** | 不受影响——它走的是另一条已设防的 DB 血缘 | VERIFIED |
| `full-trace-contract.ts:80,168` / `goldenTrace.sourcePainId`（`openclaw-promotion-checks.ts:111`） | 契约字段/可选透传 | 边缘，未逐链核 | UNKNOWN（全集未穷举） |

## Risk Assessment — 四道门

### Gate 1 · Source Exists — **PASS（VERIFIED）**
权威 pain id 至少两处现成：任务 seed（`bridge:248`，且 `candidate.ts` 证明生产方
确实供给）与 `pain_events.canonical_pain_id`。无需新增采集。

### Gate 2 · Consumer Exists — **PASS（VERIFIED）**
resolver→Owner 卡/evaluator prompt/assembler 三处真实读者（上表），非理论消费者。

### Gate 3 · Trust Boundary Broken — **PASS（VERIFIED，按运行时分臂）**
- **openclaw-cli 运行时、或 l2_dreamer=on 的 pi-ai 运行时**：LLM 字符串不剥离 +
  runner 不 reconcile + schema 任意串 + resolver 原样采信 ⇒ 编造值可达 Owner 卡。
  机制链每一环均有 file:line（Lifecycle 表）。**Broken=VERIFIED。**
- **默认 pi-ai 运行时（l2_dreamer off）**：剥离有效 ⇒ 编造不可达；但剥离后无人从
  seed 回注 ⇒ provenance 恒 null，**同一断链的另一失效模式（数据丢失而非污染）**。
  注意 `injectRunnerLineageIfAbsent` 已支持该字段（测试
  `peer-runner-lineage-injection.test.ts:84` 就是拿 `'sourcePainId'` 测的），
  生产却无人调用——helper 是现成的，缺的只是一根线。

### Gate 4 · Measured Impact — **NOT MEASURED（如实标出，不猜比例）**
- 编造发生率：本机无生产态（`.pd/state.db` tasks 表 0 行实测；trajectory.db 26 行
  pain 但无对应 internalization 工件）；PRI-841 数据集 2/2 家族工件**无** sourcePainId、
  provenance=null（该两例为 pi-ai 路径，只证明丢失臂、不证明编造发生）。
- 生产 workspace 不可访问 ⇒ 编造频率 UNKNOWN。
- **发生率未知不改变 Gate 1-3 的机制成立**；`lineage_echo_corrected` 事件已为
  taskId 提供同类污染率测量先例，SPEC 落地后 painId 臂可自动可测（rc-9）。

## Options

| 方案 | 内容 | 判定 |
|---|---|---|
| **A. task-seed provenance guard** | dreamer `postFetchTransform` 扩 `reconcileLineageEcho`：seed 存在时以 `diagnostic_json.sourcePainId` 为 authoritativeValue（同时封编臂——覆盖 LLM 值；和丢臂——absent 即回注）；seed 不存在时保持可观测降级（notes/事件），**不**静默采信 LLM 值；配套删 few-shot 编造示例 + 补 principleId 同级 prompt 规则。**runner 级修复，对三个适配器的不对称天然免疫。** 复用现成 helper，零新抽象/零 schema/零 flag | **推荐**。与 sourcePrincipleId 同构（成员/权威校验），与 PRI-541 echo 门同机制，消费者语义不变（null 仍是合法降级） |
| B. 删除 sourcePainId | 从 schema/resolver/UI 移除 | **不成立**：三处真实消费者（含已上线的 Owner 卡与 fail-loud assembler 入参），删除回退 PRI-858/846 能力面，且 seed 真值仍在生产——是断链不是死码 |
| C. 新 provenance registry | 建独立 pain 血缘登记子系统 | **默认否决**（P4/P7）：真值已有两个权威（seed、pain_events），registry 是第三个源；A 不需要它 |

Inference: A 的 expected size 与 PRI-858 的 evidence 接线同量级（1 个 core 文件 +
1 个 prompt 文件 + 测试），因为全部机制（reconcile、inject helper、事件、null 降级
类型）均已存在。
Inference: OCRA 对**其余** lineage 字段（sourceTaskId/sourceRunIds/…）的不对称
（VERIFICATION-B NEW-5，P3，"需 Owner 裁决"）不因本 SPEC 关闭——单独跟项，不捆绑。

## Recommendation

1. **SPEC_REQUIRED**：立项「dreamer sourcePainId provenance guard（task-seed 权威
   reconcile）」，范围 = 编臂 + 丢臂 + prompt/few-shot 修正；方案 A。
2. SPEC 硬约束：seed 缺失时的语义要显式裁定（保留 LLM 值=否；strip+note=倾向）；
   不改 `FormationProvenance` 类型（string|null 已兼容）；guard 事件复用
   `lineage_echo_corrected` 使发生率首次可测。
3. 与 CIL-005（dreamer 诊断单通路 fragility）同链，排期宜前后脚（同一
   `intake→dreamer` seed 数据）。
4. 本报告不进入开发；OCRA 全域剥离对称性（NEW-5）留作 Owner 裁决跟项。

## Findings 计数与证据分级摘要

- VERIFIED（14）：L1 seed 写入 · L2 CLI 反编造解析器 · L3 pain_events 落盘 ·
  L4 few-shot 编造示范+无规则 · L5 schema 任意串 · L6 pi-ai 三路剥离 ·
  L7 repair 环剥离次序无漏网 · L8 L2/OCRA 零处理（代码复核） ·
  L9 runner 只 reconcile taskId · L10 resolver 只读工件 content ·
  L11 Owner 卡渲染 sourcePainId · L12 assembler membership+ERR-069 先例 ·
  L13 principleId 三重设防对照 · L14 本机 DB 空态/数据集 2/2 null 实测
- INFERRED（3）：三层真值信任倒挂 · 方案 A 体量与先例同量级 · NEW-5 不随本 SPEC 关闭
- UNKNOWN（3）：生产编造发生率 NOT MEASURED · sourcePainId 消费者全集未穷举 ·
  seed 缺失时应 strip 还是保留（留 SPEC 裁定，本报告仅给倾向）

---

```text
Final Result

PRI_862_RESULT=SPEC_REQUIRED
VERIFIED_COUNT=14
INFERRED_COUNT=3
UNKNOWN_COUNT=3
```
