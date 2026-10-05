# PRI-917 — Semantic Reuse Adjudication — SPEC v0.3.3

> **Status:** Approved for implementation (Owner directive, R6 sprint 2026-09-30)
> **Date:** 2026-09-30
> **Parent:**
> - PRI-917 Reuse Before Create（主 SPEC `docs/specs/PRI-917-reuse-before-create-v0.1.md`，现内容 v0.2.1；PR #1900 已合并，baseline `0939eac0`）
> - Reality Audit：`docs/audit/PRI-917-v03-reality-audit-implementation-plan.md`（F1-F4 裁定已吸收）
> - R5 验证：`docs/audit/PD_R5_PRINCIPLE_REUSE_VALIDATION_2026-09-30.md`（本修订的直接证据来源）
>
> **Revision v0.3 (2026-09-29):** 初稿——提出 Semantic Reuse Judge 层（新 agent `reuseJudge`）。
>
> **Revision v0.3.1 (2026-09-29):** Owner 裁定：Semantic Reuse Judge **不再是新 agent**，改为 **Semantic Reuse Evaluation Capability**（`reuseEvaluation` config 段 + 既有 `PDRuntimeAdapter` 接入）；Owner decision boundary、`reuseEvidence[]` 唯一权威保留；禁止 `BehaviorUnderstandingProvider` 类 speculative 抽象。
>
> **Revision v0.3.2 (2026-09-29):** Owner Review 修改（总体架构不变）：① evaluation 输出字段 `decision` → **`recommendation`**（proposal/recommendation 语义），消除与 Owner Decision 的字面混淆；② 新增 **T7：Proposal output cannot mutate ledger/evidence**；③ `reuseEvaluation` 是**专属命名 config 段**，不引入通用 capability registry/框架。**当时裁定：evaluation 只存在于 Owner 决策面，intake 自动路径不接 evaluation。**
>
> **Revision v0.3.3 (2026-09-30, 本次):** **Owner 指令推翻 v0.3.2 的自动路径边界裁定**（R6 冲刺，Linear PRI-938）。R5 Reality Audit 实证：v0.3.2 的"自动路径不接 evaluation"使生产路径（pain record / diagnose / pain-retry → intake）在 Owner 被咨询前直接写 ledger——双宿主三次复现重复创建，Duplicate Prevention Rate = 0/4 = 0%，`reuseEvidence` 全程为 0。语义评估引擎本身 3/3 判断正确，问题纯属性能未接入（Connection Before Creation）。
>
> 本修订新增 **Reuse Review Gate（自动路径）**：intake 自动路径接入既有 reuse-evaluation capability。**Evaluation 只产生 recommendation；recommendation=reuse 时候选被挂起（review_required）等待 Owner；机器不能 reuse、不能 create decision。** 其余全部边界（Owner 唯一决策者、`reuseEvidence[]` 唯一权威、T7 机械隔离、专属 config 段）原样保留。
>
> **Persistence route:** 不变——`Principle.reuseEvidence[]` 是唯一权威（主 SPEC §12）。

---

## 1. Problem

### Current State（v0.3.2 交付后、R5 实测）

PRI-917 全链已合并（#1900/#1902/#1904），语义评估在 `pd candidate review` 只读面工作正常。但生产自动路径是：

```
Pain
 ↓
Candidate
 ↓
Automatic intake（无任何复用检查）
 ↓
Ledger write（直接创建）
```

Owner 只在激活环节被咨询；candidate review 的复用裁决面在默认流程中结构性不可达。

### Observed Limitation（R5 证据）

- OpenClaw 重放 pain → 自动创建 `c58af13a`，与既有 `d03f6c64` 语义近重复，复用门全程未运行；
- Codex 重放沟通 pain → 自动创建 `0e0fb4b8`，与既有 `9a97c7db` 语义同类（真配对词法仅 0.176 分）；
- Codex 重放边界 pain → 自动创建 `2760da8a`，与 OpenClaw 既有 `d03f6c64` 跨宿主重复；
- Owner `--decide reuse` 对历史低置信候选被 CLI admission 预检拦截（`confidence_below_threshold:0.35<0.5`）——两头堵。

### Root Cause

**不是评估能力缺失，是设计边界**：v0.3.2 明确裁定"自动路径不接 evaluation，无 Owner 在场维持创建"（§3 边界说明/§6/§9/§16）。该裁定在"LLM 建议不得自动压制学习"上是正确的，但把"机器不能决策"错误地Implementation成了"机器完全不设门"——重复创建成为唯一生产路径。

---

## 2. Decision（v0.3.3）

**推翻 v0.3.2 的自动路径边界，接入 Reuse Review Gate**：

```
Pain
 ↓
Candidate
 ↓
Reuse Review Gate（自动 intake 内，4d 既有席位）
        |
        +---- 无可信复用候选（lexical shortlist 空）
        |          ↓
        |       Normal Create（不调用 LLM，成本不变）
        |
        +---- 有候选 → reuse-evaluation（capability，LLM）
                   |
                   +-- recommendation=reuse（高可信重复）
                   |          ↓
                   |    review_required：挂起候选，不写 Principle，
                   |    零 evidence 写入，等待 Owner
                   |
                   +-- recommendation=create / uncertain
                   |          ↓
                   |       Normal Create（学习不受阻）
                   |
                   +-- evaluation 失败（timeout/无效输出/异常）
                              ↓
                           Normal Create（降级可观测，学习不中断）
```

Owner 随后经既有 `pd candidate review --decide reuse|create` 完成裁决：

```
review_required candidate
        ↓
Owner review（proposal + recommendation 展示）
        ↓
   +--------+--------+
   |                 |
 reuse            create
   |                 |
reuseEvidence++   New Principle（正常 intake 写账）
```

### Rules（v0.3.3 §2.1）

1. **Rule 1** — 只有 `recommendation=reuse`（且 selectedPrincipleId 落在 shortlist 内）才挂起进 review。
2. **Rule 2** — `evaluation=create`：继续正常创建。
3. **Rule 3** — `evaluation=uncertain`：第一阶段保持创建行为（future consideration：Owner 可配置 uncertain 也挂起，本期不做）。
4. **Rule 4** — evaluation 失败（任何形态）：降级创建，不能阻塞学习。
5. **Rule 5** — lexical shortlist 为空：不调用 LLM（成本控制，Case A 原样）。

---

## 3. Final Architecture

```
                 Pain
                   |
                   v

          Candidate Intake（自动路径：bridge / diagnose / pain-retry）

                   |

                   v
        ┌──────────────────────────────────────────────┐
        │ CandidateIntakeService.intake() — 4d gate    │
        │                                              │
        │  shortlist（确定性，不变）                     │
        │      ↓ Top-K                                 │
        │  proposalNeedsDecision?                      │
        │      ├─ no ──→ CREATE（原样）                 │
        │      └─ yes                                  │
        │          ↓                                   │
        │  reuseRecommendation hook（v0.3.3 新增注入）  │
        │  = 既有 reuse-evaluation capability          │
        │      ├─ reuse ──→ refused:reuse_pending_owner│
        │      │            （挂起，零写入）            │
        │      ├─ create/uncertain ──→ CREATE          │
        │      └─ unavailable/throw ──→ CREATE         │
        └──────────────────────────────────────────────┘
                   |
                   v
        （reuse 分支：等待 Owner）
        pd candidate review --decide reuse|create
        （既有 reuseDecision 注入 → intake gate → appendReuseEvidence）
                   |
                   v
          reuseEvidence[]（唯一权威持久化，不变）
```

命名边界（v0.3.2 继续）：evaluation 的一切输出词汇都用 **recommendation** 语义——**"decision" 一词在整条链路中只属于 Owner**。

自动路径接线说明（v0.3.3）：

- hook 注入点 = `CandidateIntakeServiceOptions.reuseRecommendation`，与 Owner 专用的 `reuseDecision` **分离**：自动路径只注入前者（评估建议），绝不注入后者（裁决）。
- 挂起 = intake 返回 `refused { reason: 'reuse_pending_owner', reuseProposal, reuseRecommendation }`：不写 ledger、不写 evidence、candidate 保持 pending。挂起本身不持久化评估结果（T7 继续成立）——Owner 重新 review 时评估面会新鲜重算。
- 三个自动构造点（`pain-signal-runtime-factory` / `diagnose` / `pain-retry`）统一注入；`pd candidate review --decide` 与 `pd candidate intake` 手动路径行为不变（不注入 recommendation hook）。
- 消费者义务：bridge / diagnose / pain-retry 对 `reason === 'reuse_pending_owner'` 必须 (a) 跳过 dreamer 播种，(b) 跳过 consumed 标记，(c) 上报 review_required 处置（rc-9：降级/等待必须可观测）。

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

输出（`reuse-evaluation-output-v1`，不变）：

```typescript
{
  recommendation: "reuse" | "create" | "uncertain",  // 建议语义，NOT a decision
  selectedPrincipleId?: string,   // recommendation=reuse 时必填；uncertain 时必须缺省
  rationale: string,
  confidence: number              // 0..1
}
```

运行时校验器（rc-1/2/3）负责：交叉规则（`uncertain ⇒ selectedPrincipleId 缺省`；`reuse ⇒ selectedPrincipleId 存在`）；**封闭字段集（T7）**——输出含 schema 之外任何字段一律拒绝。

**禁止（v0.3.3 重申 + 精化）**：写 evidence、修改 Ledger、自动产生 reuseDecision、替 Owner 决定。**v0.3.3 澄清**："自动阻止 Principle 创建"的禁令针对 **LLM 输出直接产生阻止效力**；Reuse Review Gate 的挂起是**系统门控策略**对 LLM 建议的响应，最终处置权仍在 Owner（挂起不是丢弃，候选与建议完整保留给 Owner）——这与 §5 的权威边界一致。

### 4.3 reuse-recommendation hook（v0.3.3 新增，接线层）

职责：把 `reuseEvaluation` config + `PDRuntimeAdapter` 组装为 `CandidateIntakeService` 可注入的建议函数。单一实现位于 core（`principle-reuse/reuse-recommendation-hook.ts`），三个自动构造点共用。

行为：config `reuseEvaluation.enabled=false` → 不注入（完全旧行为，回滚开关）；profile 解析失败 / 非 pi-ai 运行时 → 返回 `unavailable`（降级创建）；runner 任何失败 → `unavailable`。**hook 永不 throw 到 intake 主流程之外**（Rule 4）。

---

## 5. LLM Authority Boundary（不变）

✅ Allowed：比较语义、判断覆盖关系、解释为什么相似、输出 recommendation。

❌ Forbidden：直接写 reuseEvidence、直接修改 Ledger、自动产生 reuseDecision、替 Owner 做决定。

保持：**Recommendation ≠ Decision**（INV-R04）。Owner decision boundary 原样保留——`--decide` 仍是唯一决策入口，evaluation 的 recommendation 无自动效力（T4）。v0.3.3 的挂起是系统行为，不是 LLM 决策：LLM 说"疑似重复"，系统说"那你等着，Owner 来判"。

---

## 6. Governance Flow

**Case A** 没有可信候选：shortlist → no credible candidate → 既有 CREATE 路径，无需 Owner reuse decision，不调用 LLM。（不变）

**Case B** Owner 决策面存在候选：shortlist → reuse-evaluation → recommendation（语义增强展示）→ Owner / AI Owner 明确裁决 → reuse OR create。（不变）

**Case C（v0.3.3 新增）自动路径存在候选**：shortlist → reuse-evaluation → recommendation=reuse → **挂起（review_required）**，候选保持 pending，等待 Owner 经 Case B 面裁决；recommendation 为 create/uncertain/失败 → CREATE（Rule 2/3/4）。自动路径**永不**出现"未经 Owner 的 reuse"，也**永不**出现"评估失败阻塞学习"。

---

## 7. LLM Integration Constraint（不变）

必须复用：`PDRuntimeAdapter`、`OUTPUT_SCHEMA_REGISTRY`、`structured-output-repair`、runtimeProfile。

禁止新增：new OpenAI client、new inference abstraction、new vector database、embedding service、new agent framework、`BehaviorUnderstandingProvider` 等 speculative 能力 provider 抽象（P7）。

---

## 8. Capability Registration（不变）

本能力不注册为 agent。`reuseEvaluation` 专属 config 段，不建通用 capability registry。存量 config 零迁移：无 `reuseEvaluation` 段时取全默认（enabled=true）。

v0.3.3 无新 config 字段：自动路径与 review 面共用同一段（enabled / runtimeProfile / timeoutMs）。`enabled=false` 时自动路径不注入 hook、review 面不跑评估——**回滚 = 完全恢复 v0.3.2 行为**。

---

## 9. Failure Semantics

### 自动路径（v0.3.3 重写）

| 失败形态 | 行为 | 可观测性 |
| --- | --- | --- |
| LLM timeout / invalid JSON / schema failure / repair 失败 | hook 返回 unavailable → 降级 CREATE（Rule 4） | 创建结果本身可见；无 reuse_gate_triggered 事件（挂起未发生） |
| recommendation=reuse 但 selectedPrincipleId 不在 shortlist（幻觉防线） | 视为 unavailable → CREATE | 同上 |
| recommendation=reuse 且 id 合法 | 挂起：refused `reuse_pending_owner` | telemetry `reuse_gate_triggered` + 候选保持 pending + 调用方上报 review_required |
| 挂起候选被重复 intake（重试/重放） | gate 重新评估重新挂起（幂等倾向；Owner 已裁决则走 2b 重放短路，不再询问） | 同上 |

**v0.3.2 的"intake 不接 evaluation 故不存在 LLM 失败静默 CREATE 通道"论断由本表取代**：LLM 失败现在会经过自动路径，但失败 → CREATE 与 v0.3.2 的"不在路径上 → CREATE"行为完全一致，且 Rule 4 禁止把失败升级为阻塞。

### Owner 决策面（不变，F2 裁定：可观测降级）

review 只读路径 evaluation 失败时 `judgeStatus: "unavailable"` + 结构化 reason，lexical proposal 照常展示，Owner 知情后仍可显式 `--decide`。禁止把 evaluation 失败伪装成"评估过、语义不相似"（rc-9）。

**v0.3.3 连带修复（R5 F4 两头堵）**：`pd candidate review --decide reuse` 的 PRI-442 admission 预检对 **reuse 裁决放行**。理由：admission 置信度门保护的是"低质量新原则进入 ledger"，而 reuse 裁决不创建任何新原则、只向既有已激活 Principle append 一条可审计证据——复发证据本身即价值证明。`--decide create` 的预检保持不变（低置信候选仍不得经 CLI 绕过 admission 创建）。

---

## 10. Persistence（不变 + T7 机械背书）

唯一权威：`Principle.reuseEvidence[]`，格式不变（painId / candidateId / decision:"reuse" / actor / reason / decidedAt / decisionId?）。

不新增：table、relation entity、database、SSOT、decision log。挂起状态**不持久化**（candidate 的既有 pending 状态即承载），评估结果不落盘（T7）。

---

## 11. Testing Requirements

v0.3.2 的 T1-T7 全部保留并继续有效。v0.3.3 新增：

| ID | 场景 | 期望 |
|---|---|---|
| **T8** | 高置信重复（R5 场景重放：候选 claim 与 shortlist 既有原则同经验，TestDouble 返回 reuse） | intake 返回 `refused/reuse_pending_owner` + 原始建议；**零 ledger 写入、零 evidence 写入、candidate 保持 pending** |
| **T9** | 真正新问题（recommendation=create / uncertain） | 正常 CREATE，行为与 not_configured 完全一致 |
| **T10** | evaluation 失败（timeout / throw / 幻觉 id） | 降级 CREATE，学习不中断；无挂起无事件 |
| **T11** | `reuseEvaluation.enabled=false` | hook 不注入，`reuseCheck:'not_configured'`，逐字节恢复 v0.3.2 行为 |
| **T12** | 挂起候选的消费者义务（bridge） | 不播种 dreamer、不标记 consumed、发 `reuse_gate_triggered`（payload 仅 candidateId/selectedPrincipleId/confidence/recommendation） |
| **T13** | 挂起 → Owner `--decide reuse` 闭环 | 走既有 reuseDecision gate → appendReuseEvidence +1 → candidate consumed；INV-R05/07/08 全部保持 |
| **T14** | review `--decide reuse` 绕过 admission 预检（低置信候选 + reuse 裁决） | 裁决到达 gate，evidence 落地；`--decide create` 对同一候选仍被预检拒绝 |
| **T15** | 生产形状候选（挂在 diag_router 子任务）的 lineage 解析 | Owner reuse 裁决经 router→顶层任务链（inputRef）解析出 pain_diagnoses 行，evidence 正确落地（R6 回放发现的粒度错位修复） |

R5 Reality Replay（Phase 6，真实 workspace、真实 LLM、非 mock）：OpenClaw 重放 c58af13a 场景（历史重复 3824d083）→ 期望 review_required；Codex 重放 0e0fb4b8 场景（已有 9a97c7db）→ 期望阻止重复；全新问题 → 期望正常 create 不误拦。

---

## 12. Telemetry

- v0.3.2 事件保留：`reuse_evaluation_recommended` / `reuse_evaluation_unavailable`（仍仅由 `pd candidate review` 发出）。
- **v0.3.3 新增 `reuse_gate_triggered`**（先入 `telemetry-event.ts` Literal 枚举，`check:telemetry-events --strict` 强制）：由自动路径挂起时发出（bridge 持 emitter；CLI 路径以结构化 JSON 输出承载同等信息）。payload 仅含 candidateId / selectedPrincipleId / confidence / recommendation——**telemetry 不是第二个 decision log，绝不成为决策源**。
- 自动路径降级 CREATE 不发新事件（Rule 4：失败不阻塞、不假装成功；创建结果即观测面）。

---

## 13. Non Goals

1. Embedding Retrieval——当前问题不是召回瓶颈（词法召回弱是 F3，另行立单）。
2. Vector Database——不引入长期索引。
3. Automatic AI Owner Approval——AI Owner 机制另行设计。
4. Global LLM Gateway Refactor——重复调用代码不属于 PRI-917。
5. CJK_STOP_TERMS Cleanup——独立 cleanup issue。
6. 任何 speculative 能力抽象——provider 接缝（P7）、通用 capability registry/框架。
7. ~~reuseJudge agent 注册~~（v0.3.1 撤销）。
8. **（v0.3.3 新增）跨宿主资产共享 / workspace asset sharing**——R5 F1，另行 SPEC。
9. **（v0.3.3 新增）Console UI 的 review_required 队列展示**——CLI 面先行，Console 后续。
10. **（v0.3.3 新增）`pd candidate internalize` / backfill 运维工具的 gate 接入**——它们服务历史数据修复，不属于自动 intake 生产路径；已知边界，记录于 PR。

---

## 14. Implementation Plan（v0.3.3）

基准：origin/main `d76bc1dc`（#1906 之后）。全部在既有机制上。

### R6-P1 — core：gate 挂起形态 + hook 构建器

- `candidate-intake-service.ts`：`LedgerRefusalReason` += `reuse_pending_owner`；`CandidateIntakeServiceOptions` += `reuseRecommendation?`；refused 结果携带 `reuseRecommendation` 建议与既有 `reuseProposal`；4d gate 在 `proposalNeedsDecision` 时先跑建议钩子（reuse 且 id 在 shortlist 内 → 挂起；其余 → 原行为）。`reuseDecision` 同步契约与 2b 重放短路零改动（T5/T6 继承）。
- 新建 hook 构建器 `createReuseRecommendationHook`（位于 `pain-signal-runtime-factory.ts`，紧邻它复用的 `resolveRuntimeConfigForProfile`——同模块避免循环导入，三处共用单一实现）：`{ effectiveConfig, workspaceDir, stateDir }` → enabled 检查 → profile 解析 → pi-ai adapter（复用 `PiAiRuntimeAdapter` 构造路径）→ `ReuseEvaluationRunner`。任何失败 → `unavailable`，永不 throw。
- `pain-signal-runtime-factory.ts`：构造 intake service 时注入 hook。
- `telemetry-event.ts`：+ `reuse_gate_triggered`。

### R6-P2 — bridge：挂起候选的消费者义务

- `pain-signal-bridge.ts`：intake 结果 `refused/reuse_pending_owner` → 跳过 dreamer 播种、跳过 consumed 标记、发 `reuse_gate_triggered`、outcome 上报 `reuse_review_required` + nextAction 指向 `pd candidate review`。

### R6-P3 — CLI：接线 + admission 预检放行 reuse

- `diagnose.ts` / `pain-retry.ts`：注入 hook；`reuse_pending_owner` 分支——不标记 consumed、上报 review_required。
- `candidate.ts`：review `--decide reuse` 跳过 admission 预检（§9 连带修复）；`candidate intake` 命令的 reuse_pending_owner 上报分支。

### R6-P4 — Tests（T8-T15）+ SPEC 入库 + changeset

### R6-P5 — Reality Replay 连带修复（真实 workspace 回放暴露，全部 fail-closed 发现、零脏写入）

1. **lineage 粒度错位（T15）**：生产候选挂在 `diag_router-*` 子任务，而 `pain_diagnoses` 行记在顶层 `diagnosis_*` 任务——`#resolveReusePainId` 按候选自身 taskId 查永远失败，任何新鲜 reuse 裁决 fail-closed（PR3B 测试用同一 taskId 播种两表，从未暴露）。修复：无直接行时沿 router 任务 `inputRef`（父链接，真实记录字段）走到顶层 diagnostician 任务再查。
2. **park-only 误报 failed**：bridge 结果 shaper 把"admitted 但零入账"一律报 `failed`——挂起是 BY DESIGN 不写账，全挂起批次改报 `degraded` + `reuse_review_required:<ids>` 消息。
3. **遥测直通道**：`mapBridgeTelemetryToStoreEvent` 原本只透传持久化降级事件，`reuse_gate_triggered` 会被丢弃——加入 passthrough 集合（自带事件类型，非降级映射）。

### R6-P6 — PR 评审判定修复（Owner 评审 4×P2，全部属实，2026-10-05）

1. **回滚开关对长驻 bridge 不生效**：bridge 缓存键不含 `reuseEvaluation` 状态，长驻宿主（OpenClaw 插件 / Codex worker，均跨周期复用缓存且无 dispose）翻转开关后仍用旧 hook——T11 在两个方向上都退化为"需重启进程"。修复：hook 构建上移至 `createPainSignalBridge`、其存在性入缓存键（与 pdp/pfp 同一纪律）；`invalidatePainSignalBridge` 改按 workspace+kind 前缀清除以覆盖新键分量。
2. **混合批次隐藏挂起候选**：`reuse_review_required` 降级分支原先要求零入账（全挂起）；一入账一挂起的混合批次报 plain succeeded。修复：shaper fresh 路径在 partial_admission 与 success 分支追加 parkedNote 并降级 degraded；Codex worker 报告新增 `reuseReviewRequiredCandidateIds`；OpenClaw 插件在含挂起候选的 degraded 结果上打 `PAIN_SERVICE_REUSE_REVIEW_REQUIRED` 日志（按挂起处置 gate，保持 flag-off 日志流逐字节不变）。
3. **重放把等待裁决误报为 intake 失败**：父任务在管线完成时即 `succeeded`（与候选挂起无关），重放走 `buildExistingResult` 仅查账本——全挂起重放从 `review_required` 翻成 `failed`。修复：existing 路径把"仍 pending 且无账本条目的 principle 候选"（挂起的持久承载，§11）作为 parked 集传入 shaper，全挂起重放报同一 `review_required` 语义；混合重放追加 parkedNote 并降级 degraded；`candidateOutcomes` 在重放路径携带挂起子集（decision 用既有 admission-unknown 值 `needs_evidence`，不虚构 admission 结果）。
4. **CLI 不显示挂起、仍建议 internalize**：diagnose/pain-retry 的文本渲染与顶层 nextAction 不识别 `review_required`，并对挂起候选输出 `pd candidate internalize`（诱导绕过裁决）。修复：两个命令的渲染循环增加 `review_required` 分支；顶层 nextAction 从 internalize 列表剔除挂起候选并给出 `pd candidate review --decide` 指引；pain-retry 死信 JSON 在成功与未成功两分支都携带挂起指引。

---

## 15. Complexity Delta（v0.3.3）

新增 YES：

```
reuseRecommendation hook 注入位（1 个既有 options 字段，非新抽象）
reuse-recommendation-hook.ts（1 个接线模块，单一实现三处共用）
reuse_pending_owner 拒绝理由（1 个既有 refused union 的枚举值）
telemetry 事件 1 个（reuse_gate_triggered，先入枚举）
bridge/CLI 挂起分支（3 处消费者义务）
review --decide reuse 的 admission 预检放行（1 个条件）
```

保持 NO：

```
新 agent 身份 / 通用 capability registry / 新 database / 新 SSOT / 新状态文件 / decision log
关系实体 / 向量库 / embedding 管线 / 新 runtime 设施 / 新推理抽象
reuseDecision 契约变更 / intake gate 既有三形态语义变更 / 2b 重放短路变更
挂起状态持久化（不落盘，pending 即承载）
```

持久化面零变化：`Principle.reuseEvidence[]` 唯一权威。

---

## 16. Owner Decision

### OD-PRI917-04 — Semantic Reuse Evaluation Capability（v0.3 → v0.3.1 → v0.3.2）

- **Date:** 2026-09-29 · **Decided by:** Owner
- **Decision:** 批准语义复用评估层，capability 形态；Owner decision boundary 与 `reuseEvidence[]` 唯一权威保留；当时裁定 evaluation 只存在于 Owner 决策面，自动路径不接。

### OD-PRI917-05 — Reuse Review Gate：自动路径接入评估（v0.3.3）

- **Date:** 2026-09-30 · **Decided by:** Owner（R6 冲刺指令，Linear PRI-938）
- **Decision:** 推翻 v0.3.2"自动路径不接 evaluation"的边界。自动 intake 接入 Reuse Review Gate：evaluation 只产生 recommendation；recommendation=reuse 时候选挂起（review_required）等 Owner 经既有 `--decide` 裁决；create/uncertain/失败降级创建；`reuseEvaluation.enabled=false` 完全恢复旧行为。机器不能 reuse、不能 create decision。LLM 权限边界（§5）与数据边界（§10）原样保留。
- **Reasoning:** R5 Reality Audit（`docs/audit/PD_R5_PRINCIPLE_REUSE_VALIDATION_2026-09-30.md`）实证 DPR=0/4、reuseEvidence=0、双宿主三次重复创建；评估引擎 3/3 正确，缺的是连接不是能力。"机器不能决策"的正确实现是"机器只能拦下来问"，不是"机器不设门"。
- **Effect:** 自动路径新增一个前置建议环节与一个挂起处置；重复候选从"静默入账"变为"等待 Owner"；学习路径在无重复/评估失败时完全不变。部署注意：已装 runtime 与 Companion worker 升级前，挂起候选对旧代码消费者不可见（pending 状态天然安全，无自动消费方）。
- **Status:** Approved — R6 sprint 实施。

---

## Stop Condition

v0.3.3 实施 = R6 sprint（PR 待 Owner review，不自动合并）。成功标准：T8-T14 全绿 + Reality Replay 证明重复候选不再自动入账 + DPR 从 0% 开始产生真实改善。
