# PRI-917 — Semantic Reuse Adjudication — SPEC v0.3.2

> **Status:** Draft — Owner Review Required
> **Date:** 2026-09-29
> **Parent:**
> - PRI-917 Reuse Before Create（主 SPEC `docs/specs/PRI-917-reuse-before-create-v0.1.md`，现内容 v0.2.1；PR #1900 已合并，baseline `0939eac0`）
> - Reality Audit：`docs/audit/PRI-917-v03-reality-audit-implementation-plan.md`（F1-F4 裁定已吸收）
>
> **Revision v0.3 (2026-09-29):** 初稿——提出 Semantic Reuse Judge 层（新 agent `reuseJudge`）。
>
> **Revision v0.3.1 (2026-09-29):** Owner 裁定：Semantic Reuse Judge **不再是新 agent**，改为 **Semantic Reuse Evaluation Capability**（`reuseEvaluation` config 段 + 既有 `PDRuntimeAdapter` 接入）；Owner decision boundary、`reuseEvidence[]` 唯一权威保留；禁止 `BehaviorUnderstandingProvider` 类 speculative 抽象。
>
> **Revision v0.3.2 (2026-09-29, 本次):** Owner Review 修改（总体架构不变）：
> 1. evaluation 输出字段 `decision` → **`recommendation`**（proposal/recommendation 语义），消除与 Owner Decision 的字面混淆——该字段永远是"能力对 Owner 的建议"，不是裁决；review 展示字段同步（`recommendation/rationale/confidence`）。
> 2. 新增 **T7：Proposal output cannot mutate ledger/evidence**——evaluation 的输出被机械地隔离于持久化之外（未知字段 fail-closed、review 只读路径字节级零写入断言），把 §5 的 Forbidden 变成可执行测试。
> 3. 新增约束：`reuseEvaluation` 是**专属命名 config 段**，**不引入通用 capability registry/框架**——目前只有一个实例，通用注册表是 speculative 抽象（P7）；第二个真实能力出现时再谈。
>
> **Persistence route:** 不变——`Principle.reuseEvidence[]` 是唯一权威（主 SPEC §12）。
> **Implementation:** NOT started（等待本 SPEC Owner 批准）。

---

## 1. Problem

### Current State

PRI-917 已完成并在 main（#1900，baseline `0939eac0`）：

```
Pain
 |
Candidate
 |
reuse-shortlist
 |
Owner Decision
 |
reuseEvidence
```

当前 reuse-shortlist 使用确定性 lexical retrieval（CJK bigram、latin token、字段加权 overlap、确定性排序）。该机制满足：可重复、可解释、低成本。

但它只能回答：

> 哪些 Principle 可能相关？

不能可靠回答：

> 这两个 Principle 是否表达同一个经验？

### Observed Limitation

Reality Audit 证明 lexical retrieval 可以发现大量候选，但语义判断能力有限：

**False Positive** — `证据 / 验证 / 确认 / 能力 / 行为` 等治理语言高度重合，导致两个不同 Principle 因共享 PD 领域语言而被认为相关。

**False Negative** — 真实语义相似的经验（"不要假设系统支持某能力" vs "修改前确认已有实现入口"）词面可能完全不同。

### Root Cause

不是 stop words 不完整、threshold 不合理或 tokenizer bug，而是：

> lexical similarity ≠ semantic equivalence

---

## 2. Decision

新增 **Semantic Reuse Evaluation Capability**（Owner 裁定：能力形态，非 agent）：

```
reuse-shortlist
        ↓
reuse-evaluation (capability, LLM)
        ↓
Owner Decision
        ↓
reuseEvidence
```

---

## 3. Final Architecture

```
                 Pain
                   |
                   v

          Candidate Intake

                   |

                   v

        +----------------------+
        | reuse-shortlist      |
        | deterministic        |
        +----------------------+

                   |

              Top-K

                   |

                   v
        +------------------------------+
        | reuse-evaluation (capability)|
        | LLM recommendation — NOT a   |
        | decision                     |
        +------------------------------+

                   |

        recommendation / rationale / confidence
        （仅作为 Owner 的展示增强 — F1 落点：
          pd candidate review 只读路径）

                   |

                   v

        Owner / AI Owner  ←—— 唯一决策者（boundary 不变）

                   |

          explicit decision
          （既有 reuseDecision 注入 → intake gate）

                   |

                   v

          reuseEvidence[]
          （唯一权威持久化，不变）
```

命名边界（v0.3.2）：evaluation 的一切输出词汇都用 **recommendation** 语义（`recommendation` 字段、"建议/提议"文案）——**"decision" 一词在整条链路中只属于 Owner**。展示层、telemetry、测试断言一律如此。

边界说明（F1，Reality Audit 裁定）：

- evaluation **只存在于 Owner 决策面**（`pd candidate review` 只读路径）。
- intake 自动路径（bridge / diagnose / pain-retry 批处理）**不接 evaluation**：无 Owner 在场时维持现状（gate 未配置 → CREATE）。这满足 §5（LLM 不自动阻止创建）与 §6 Case A/B。
- `reuseDecision` 同步契约零改动；gate（PR2）与 2b 重放短路（Phase 2）零改动——T5/T6 的既有保证全部继承。

---

## 4. Component Responsibilities

### 4.1 reuse-shortlist（不变）

职责：Candidate discovery。输入 candidate + existing principles，输出 `ReuseCandidate`（principleId/score/sharedTerms/reason）。

禁止：直接判断 reuse、写 evidence、修改 Principle。

### 4.2 reuse-evaluation（capability）

职责：Semantic comparison **recommendation**。

输入：

```typescript
{
  candidate: { text, triggerPattern, action },
  candidates: [ { principleId, text, triggerPattern, action } ]  // Top-K ≤ 3
}
```

输出（`reuse-evaluation-output-v1`）：

```typescript
{
  recommendation: "reuse" | "create" | "uncertain",  // 建议语义，NOT a decision
  selectedPrincipleId?: string,   // recommendation=reuse 时必填；uncertain 时必须缺省
  rationale: string,
  confidence: number              // 0..1
}
```

运行时校验器（rc-1/2/3）负责：

- 交叉规则：`uncertain ⇒ selectedPrincipleId 缺省`；`recommendation=reuse ⇒ selectedPrincipleId 必须存在且为合法 UUID 形状`；
- **封闭字段集（T7 的一部分）**：输出含 schema 之外任何字段（如 `reuseEvidence`、`write`、`persist` 类键）一律拒绝——LLM 输出永不携带持久化指令；
- `uncertain` / `recommendation` 只存在于本 proposal 层，**不进入** `ReuseDecision`（intake 契约仍只有 Owner 的 reuse|create）——它的语义由 Owner 消化后表达。

禁止：写 evidence、修改 Ledger、自动产生 reuseDecision、自动阻止 Principle 创建。**该 Forbidden 由 T7 机械验证，不依赖评审纪律。**

---

## 5. LLM Authority Boundary（不变，加 T7 背书）

✅ Allowed：比较语义、判断覆盖关系、解释为什么相似、输出 recommendation。

❌ Forbidden：直接写 reuseEvidence、直接修改 Ledger、自动产生 reuseDecision、自动阻止 Principle 创建。

保持：**Recommendation ≠ Decision**（INV-R04；v0.3.2 措辞从 "Proposal ≠ Decision" 收紧）。Owner decision boundary 原样保留——`--decide` 仍是唯一决策入口，evaluation 的 recommendation 无自动效力（T4）。

---

## 6. Governance Flow（不变）

**Case A** 没有可信候选：shortlist → no credible candidate → 既有 CREATE 路径，无需 Owner reuse decision。

**Case B** 存在候选：shortlist → reuse-evaluation → recommendation（语义增强展示）→ Owner / AI Owner 明确裁决 → reuse OR create。

自动路径（无裁决者在场）不属于 Case B：维持 gate 未配置的既有行为。

---

## 7. LLM Integration Constraint（不变）

必须复用：`PDRuntimeAdapter`、`OUTPUT_SCHEMA_REGISTRY`、`structured-output-repair`、runtimeProfile。

禁止新增：new OpenAI client、new inference abstraction、new vector database、embedding service、new agent framework、**`BehaviorUnderstandingProvider` 等 speculative 能力 provider 抽象（P7）**。

原因：PD 已存在成熟 LLM 调用路径；PRI-917 不负责重构 AI runtime。

---

## 8. Capability Registration

**本能力不注册为 agent。** 不修改 `INTERNAL_AGENT_NAMES`（`config/pd-config-types.ts`）与 `AGENT_IDS`（`agent-spec.ts`）——语义评估不是与 Dreamer/Philosopher 并列的认知职责，而是 reuse 流程的一个评估机制（Owner 裁定）。

**专属 config 段，不建通用 capability registry（v0.3.2 新增约束）：**

- `reuseEvaluation` 是**按名命名的专属段**（TSC interface + defaults，与 `ui`/`principles`/`feedback` 同形态）——它不是某个通用 "capability registry" 的一个条目。
- **禁止**引入按名注册任意能力的通用注册表/框架/`CapabilityProvider` 接缝：当前只有一个真实实例，通用 registry 是 speculative 抽象（P7 / `antipattern-future-extensibility`）。当第二个真实能力出现时，作为独立设计决策再议，不在本 SPEC 预留。
- 同理禁止把本段塞进 `features` flag map——它有结构化字段（runtimeProfile/timeoutMs），不是布尔开关。

接入方式（全部既有机制）：

| 项 | 形态 |
|---|---|
| 配置 | 顶层 config 段 `reuseEvaluation`：`{ enabled: boolean; runtimeProfile?: string; timeoutMs?: number }`——**不是** `internalAgents.agents` 的新条目 |
| Runtime 接入 | `runtimeProfile`（缺省回退 `internalAgents.defaultRuntime`）→ 既有 `runtime-adapter-resolver` / `PDRuntimeAdapter` 构造路径，与 run-once/diagnose 同源 |
| Runner | `reuse-evaluation-runner.ts`——第 12 个同构 runner（startRun(outputSchemaRef) → poll → fetchOutput → runtime 校验器），复用 `structured-output-repair` |
| Schema | `OUTPUT_SCHEMA_REGISTRY` 追加 `'reuse-evaluation-output-v1'` 一行（既有 per-domain registry 的正常扩展，**不是** capability registry），双 adapter 即获校验 |
| 缺省 enabled | `true`（PRI-797 先例：默认启用；profile 未配置时降级为 lexical-only 并以 WARN + `pd config doctor` 显性呈现，绝不静默） |

存量 config.yaml **零迁移**：无 `reuseEvaluation` 段时取全默认。

---

## 9. Failure Semantics

### 自动路径（约束不变）

LLM unavailable（timeout / invalid JSON / schema failure）时 evaluation 根本不在路径上（intake 不接 evaluation）——不存在"LLM 失败 → 静默 CREATE"的新通道。gate 自身的既有 fail-closed（PR2/Phase 2）原样保留。

### Owner 决策面（F2 裁定：可观测降级）

review 只读路径上 evaluation 失败时：

```
judgeStatus: "unavailable" + 结构化 reason
        |
        v
lexical proposal 照常展示，显式标注"本提案未经语义裁定"
        |
        v
Owner 知情后仍可显式 --decide（create 是 Owner 决策，不是静默创建）
```

禁止把 evaluation 失败伪装成"评估过、语义不相似"（rc-9：降级必须可观测）。

---

## 10. Persistence（不变 + T7 机械背书）

唯一权威：`Principle.reuseEvidence[]`，格式不变（painId / candidateId / decision:"reuse" / actor / reason / decidedAt / decisionId?）。

不新增：table、relation entity、database、SSOT、decision log。

**T7 背书**：evaluation 输出是纯内存 proposal，从 fetchOutput 到 Owner 屏幕之间不存在任何通往 ledger/evidence 的写路径；review 只读路径以字节级 ledger 不变断言验证（T7）。

---

## 11. Testing Requirements（T1-T7）

| ID | 场景 | 期望 |
|---|---|---|
| T1 | 语义匹配：不同词汇、同一经验 → evaluation recommendation: reuse | proposal 层输出正确 |
| T2 | Lexical False Positive：共享大量词汇但语义不同 → create | evaluation 修正 lexical 偏置 |
| T3 | LLM 失败（timeout / invalid schema） | review 面降级可观测；**无任何 evidence 写入、无 Principle 创建** |
| T4 | Owner Override：evaluation recommendation: reuse，Owner: create | 遵循 Owner（recommendation 无自动效力） |
| T5 | Deterministic Retrieval Preservation | shortlist 输出不变化（gate 零改动） |
| T6 | Evidence Integrity | reuse 后 evidence append-only；Principle text/version/activation 不变 |
| **T7** | **Proposal output cannot mutate ledger/evidence** | (a) evaluation 输出含未知/持久化类字段 → 校验器拒绝；(b) review 只读路径执行前后 ledger 文件**字节级相同**（无论 evaluation 成功、失败或返回任何内容）；(c) `--decide` 之外的任何路径不存在 evidence 写入调用 |

---

## 12. Telemetry

- 新事件必须先入 `telemetry-event.ts` 的 Literal 枚举（`check:telemetry-events --strict` 在 verify:merge 强制）。
- 事件清单：`reuse_evaluation_recommended`（capability 返回 proposal）、`reuse_evaluation_unavailable`（失败降级，带 reason 类别）。
- 仅由 `pd candidate review` 发出（能力只存在于决策面）；intake 路径零新事件。
- 事件 payload 只含 recommendation/rationale 摘要与 confidence——**不含任何持久化结果**（事件不是第二个 decision log）。

---

## 13. Non Goals

1. Embedding Retrieval——当前问题不是召回瓶颈。
2. Vector Database——不引入长期索引。
3. Automatic AI Owner Approval——AI Owner 机制另行设计。
4. Global LLM Gateway Refactor——重复调用代码不属于 PRI-917。
5. CJK_STOP_TERMS Cleanup——独立 cleanup issue。
6. **任何 speculative 能力抽象**——`BehaviorUnderstandingProvider` 等 provider 接缝（P7）、以及**通用 capability registry/框架**（v0.3.2 新增，见 §8）。
7. ~~reuseJudge agent 注册~~（v0.3.1 撤销——见 §8）。

---

## 14. Implementation Plan（v0.3.2 字段同步）

基准：origin/main `0939eac0`（#1900 已并）。全部在既有机制上，每阶段可独立 verify:merge。

### Phase 3C-1 — reuse-evaluation schema（纯契约，零 I/O）

- 新建 `runtime-v2/principle-reuse/reuse-evaluation-output.ts`：`ReuseEvaluationOutputV1Schema`（§4.2 形状，`recommendation` 字段 + 封闭字段集）+ `validateReuseEvaluationOutput` 运行时校验器（交叉规则 + 未知字段拒绝）。
- `output-schema-registry.ts` 追加 `'reuse-evaluation-output-v1'`。
- barrel 导出 + PRI-775 冻结 fixture 同步（保持 indent=1 格式）。
- 本 SPEC 随本阶段入库 docs/specs/。

### Phase 3C-2 — reuseEvaluation capability config（专属段，非 registry）

- `pd-config-types.ts` 加 `ReuseEvaluationConfig` 段 + defaults（enabled=true / runtimeProfile 缺省回退 defaultRuntime / timeoutMs）。
- config doctor / help 如有配置清单则同步。
- 存量 config 零迁移验证（现有 config 测试套件回归）。

### Phase 3C-3 — reuse-evaluation runner（复用 PDRuntimeAdapter）

- `reuse-evaluation-runner.ts`：同构 runner + `structured-output-repair` 接线 + `validateReuseEvaluationOutput`。
- TestDouble 注入单测五态：成功 / timeout / schema 失败 / repair 后成功 / **输出含未知字段被拒（T7a）**。

### Phase 3C-4 — 接线 review 决策面（F1 落点）

- `handleCandidateReview` 只读路径：shortlist 之后调 evaluation，proposal 条目增强 `recommendation/rationale/confidence` + 顶层 `judgeStatus: 'recommended'|'unavailable'`；失败按 §9 降级。
- `--decide` 路径与 intake 契约零改动。
- telemetry 事件入枚举并由 review 发出（§12）。
- **T7b 断言内建**：review 只读路径测试统一断言执行前后 ledger 字节不变。

### Phase 3C-5 — Tests（T1-T7）

- T1/T2：runner 测试（TestDouble fixture：T1 词面低重叠 recommendation=reuse；T2 高重叠 recommendation=create）。
- T3：runner 失败态 + review 接线测试（`judgeStatus:'unavailable'` 且零写入）。
- T4：review 决策测试——evaluation recommendation=reuse 的 fixture 下 Owner `--decide create` 走既有 create 路径。
- T5：现有 reuse-shortlist 套件 + intake gate 回归（零改动断言）。
- T6：Phase 2 既有测试（INV-R05 / derivedFromPainIds 不动）+ review 决策后 ledger 断言复用。
- T7：runner 未知字段拒绝（T7a）+ review 只读路径 ledger 字节不变（T7b）+ 全模块 grep 级断言（evaluation 模块不 import 任何 ledger 写入器）。

---

## 15. Complexity Delta（v0.3.2）

新增 YES：

```
reuseEvaluation capability config 段（1 个专属命名配置块，非 registry 条目）
reuse-evaluation-output-v1 schema（1 条既有 per-domain registry 记录）
reuse-evaluation runner（1 个同构 runner）
review 只读路径接线（1 段）
telemetry 事件 2 个（先入枚举）
```

保持 NO：

```
新 agent 身份（INTERNAL_AGENT_NAMES / AGENT_IDS 不动）
通用 capability registry / 框架 / CapabilityProvider 接缝（v0.3.2 明确禁止）
新 database / 新 SSOT / 新状态文件 / decision log
关系实体 / 向量库 / embedding 管线
治理系统 / 新 runtime 设施 / 新推理抽象 / BehaviorUnderstandingProvider 类接口
reuseDecision 契约变更 / intake gate 变更
```

持久化面零变化：`Principle.reuseEvidence[]` 唯一权威；evaluation 输出与持久化之间无写路径（T7）。

---

## 16. Owner Decision

### OD-PRI917-04 — Semantic Reuse Evaluation Capability（v0.3 → v0.3.1 → v0.3.2）

- **Date:** 2026-09-29
- **Decided by:** Owner
- **Decision:** 批准为 PRI-917 增加语义复用评估层，**形态为 capability 而非 agent**：不注册 `reuseJudge` 认知角色，以 `reuseEvaluation` 专属 config 段 + `PDRuntimeAdapter` 既有接入方式实现；Owner decision boundary 与 `reuseEvidence[]` 唯一权威保留；禁止 `BehaviorUnderstandingProvider` 等未来抽象。
- **v0.3.2 增补（Owner Review）：** ① evaluation 输出字段采用 recommendation 语义，"decision" 只属于 Owner；② T7 机械验证 proposal 输出不触碰 ledger/evidence；③ `reuseEvaluation` 为专属命名 config 段，明确禁止通用 capability registry/框架。
- **Reasoning:** Lexical retrieval 保留为确定性候选发现；语义等价判断交给既有 LLM 能力。评估是 reuse 流程内的机制，不是认知角色（P7）；字面隔离（recommendation vs decision）防止提议被误读为裁决；T7 把权威边界从纪律变成可执行断言。
- **Effect:** Adds one LLM recommendation stage（review 面展示增强）；governance boundary 不变；无新持久化模型；无 embedding/vector 依赖；intake 自动路径行为不变。
- **Status of this SPEC:** v0.3.2 Draft — 等待 Owner review 后进入 Phase 3C-1。

---

## Stop Condition

本 SPEC 为纯文档修订（v0.3.1 → v0.3.2），**未修改任何源码**。等待 Owner review；批准后按 §14 顺序实施。
