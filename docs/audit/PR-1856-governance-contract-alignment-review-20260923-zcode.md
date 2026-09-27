# PD Governance Contract Alignment Review Report

> **审查对象**：PR #1856（OPEN，待 Owner 审）× `docs/specs/PD_CORE_VALUE_PIPELINE_GOVERNANCE_SPEC.md` v0.3 × Phase 3 设计稿 `docs/architecture/principle-identity-reconciliation.md`
> **审查者**：ZCode（独立只读审查；并行有另一审查者，本文档使用带 `-zcode` 后缀的唯一文件名，未触碰任何其他文件）
> **日期**：2026-09-23
> **证据基线**：PR #1856 head = `5029b961`（merge-base `176a9a28` = 当前 main）；全部代码结论直接核对该分支 diff 与文件内容；CI 22 项检查全绿
> **纪律**：未修改任何代码 / schema / 生产数据；本报告不阻塞任何必要修复

---

## Owner Review Card（摘要）

1. **Problem**：PR #1856 是否符合 PD 长期治理契约；治理 SPEC v0.3 是否覆盖真实架构、哪里需要更新。
2. **Before**：激活身份经 `extractPrincipleId()` fail-open 兜底链最终落在 `principleDraft.title`（自然语言标题成为持久身份）；SPEC 对"身份在哪里铸造、由谁携带"没有契约。
3. **After**：本审查确认 #1856 已把激活身份改为"账本 UUID + 成员校验 + 双路径提交前闸门"，符合长期治理模型；SPEC 需要 v0.4 更新（详见 Part 6）。
4. **Existing mechanism reused**：`pi_artifacts.source_principle_id` 既有列、既有账本 adapter、既有任务链 lineage——零 schema 变更。
5. **Complexity Delta**（本审查）：全部 NO（纯只读审查，新增的唯一文件即本报告）。
6. **Design reason**：N/A（无实现）。
7. **Verification**：见下文各 Part 的 file:line 级证据。
8. **Risk**：见 Part 7。
9. **Rollback**：N/A（未改动任何被审查对象）。
10. **Follow-ups**：见 Part 8。

---

## 0. 结论（TL;DR）

**最终裁决：APPROVE WITH SPEC UPDATE。**

三个审查目标的回答：

1. **PR #1856 符合长期治理模型吗？——符合。** 它在激活边界关闭了与 PR #1851 同类的缺陷（"用内容冒充身份/类型"），实现了 fail-closed、reject-not-guess、单一身份铸造权威，且修订版（Owner P1×3 评审后）修的是真实生产链而不是削弱闸门。
2. **当前 SPEC 覆盖真实架构吗？——部分覆盖。** INV-03（Exact Intervention Identity）覆盖了"四段同一性"，但把身份绑定手段写成"revision 或 content digest/hash"，没有定义**身份的铸造权威（minting authority）**。#1856 实际建立的是更强的模型：账本 UUID 是基础身份约束，content digest 只能作补充。SPEC 落后于实现真理。
3. **哪些地方需要更新？**——1 处不变量升级（INV-03）、3 处小更新、3 个建议新增章节、5 组建议移出到 docs/audit（详见 Part 6）。**SPEC 更新不应阻塞 #1856 合并**（Class A 变更按 §30 只需"明确受影响 invariant + Golden Journey 证据"，两者本 PR 均已具备；ADR 草稿落库 + SPEC v0.4 可作为后续 docs PR）。

---

## Part 1 — Identity Flow Review

要求的链路：

```
Candidate → Principle Identity → Artifact → Activation → Execution → Evidence
```

### 当前 SPEC 是否覆盖？

**不充分。** 逐段核对：

- **Candidate → Principle Identity**：SPEC §15「Current Lineage Model」列出了 `Pain → … → Principle → …` 链，但那是**执行血缘地图**，不是身份契约。SPEC 从未回答："一条原则的身份在哪里铸造？谁是唯一合法铸造者？"
- **Principle Identity → Artifact**：SPEC 无任何章节要求"身份必须被生产链前向携带"（forward carriage）。
- **Artifact → Activation / Execution**：INV-03 要求 reviewed=approved=activated=executed 同一身份，方向正确；但绑定手段限定为 "revision 或 content digest/hash"（SPEC:306-312），对 LLM 生成文本这是不稳定的绑定（改一个字=新身份，正是 Phase 3 发现 F1 的根因）。
- **Execution → Evidence**：§16「Exact Execution Identity」列出了应记录字段，但不含 principle identity 字段。

### 缺少什么？

1. **Identity Minting Authority（身份铸造权威）**：身份只在账本 intake 时刻铸造一次（Phase 3 ADR 不变量 I1）；
2. **前向携带义务**（I2）：生产链产物必须携带身份，携带失败必须可观察；
3. **激活边界 fail-closed**（I3）：无已验证身份 ⇒ 拒绝，绝不以文本充当；
4. **展示面与写入面的区分**：宽松解析只允许存在于 display/resolution 面（#1856 在 `low-risk-writers.ts` 中已用文档注释把 `extractPrincipleId` 锁定为 "DISPLAY / RESOLUTION ONLY — never an identity source"）。

### Identity 是否应该成为长期治理对象？

**应该，理由有三：**

1. **它是整个因果证据链的 join key**（见 Part 5）——身份不稳定时，SPEC §5 的最低因果证据标准第 4 条（"reviewed/approved/activated/executed 是同一 intervention revision"）在原理上不可验证；
2. **它是 Principle 复用与进化的前提**——`supersedesPrincipleId`、Selector、同质可比集合都需要稳定 id（ADR §4 评估）；
3. **它已被实现为硬边界**——实现真理已走到意图真理前面，SPEC 不收编就会出现 AGENTS §3.3 定义的"实质性漂移"。

---

## Part 2 — Exact Intervention Identity Review

### `reviewed = approved = activated = executed` 是否足够？

**四段同一性是必要条件，但不是充分表述。** 两个缺口：

1. **基础约束缺失**：SPEC 允许 revision/digest 绑定，但没有说"身份必须是一个由单一权威铸造的稳定标识符"。#1856 给出的答案应被收编：**Principle UUID（账本键）是基础约束；content digest 是补充手段**（用于检测同一身份下的内容漂移），不能作为 LLM 生成文本的主键。
2. **四段之前还有一段**：`candidate → ledger`（intake 铸造）。四段同一性成立的前提是身份在第一段就被正确铸造并携带。PR #1851（kind 边界）+ #1856（identity 边界）合起来才覆盖完整链条。

### Principle UUID 是否成为基础约束？

在 #1856 中已经是，且实现正确：

- `resolveActivationPrincipleId()`（`low-risk-writers.ts`）：只接受 `pi_artifacts.source_principle_id` **列值**，UUID 形态校验 + 小写归一，其余一律 `null` → 拒绝；
- `resolveLedgerActivationId()`（`ledger-identity.ts`）：UUID 形态 ≠ 成员资格——direct 路径必须 `ledger.hasPrinciple()` 通过（`direct_validated`），盖章但账本查无 ⇒ `principle_not_in_ledger` 数据漂移，**永不回落到 lineage 猜测**；
- 未盖章产物走 `candidate_lineage`：dreamer artifact → task seed candidateId → `listForCandidate` **恰好一条**；0 条或 >1 条 ⇒ 拒绝（"refusing to guess"）。

### title/text/derived value 冒充 identity 的风险

**写入/闸门面已封死**（实测核对）：

| 冒充途径 | 状态 |
|---|---|
| `principleDraft.title` 兜底 | 已从身份路径删除；`extractPrincipleId` 保留但文档锁定 display-only |
| contentJson 内 `principleId`/`sourcePrincipleId` | 身份路径不再读 content；仅展示面使用 |
| writer 自行铸造身份 | writer 的 `canActivate` 不再管身份；`activate()` 的 `activationId`/`targetRef` 完全由 dispatcher 解析的 `identity.principleId` 构造（`act_prompt_<uuid>` / `ledger://<uuid>`） |
| 审批队列中的"永不激活"毒丸 | `enqueueForApproval` 在写审批记录**之前**解析身份（`activation-dispatcher.ts:329-337`），身份无效 ⇒ `invalid_artifact`，不入队 |

**残留的一个真实缺口（断言型 vs 推导型身份）**：`direct_validated` 证明的是"这个 UUID 在账本里**存在**"，不是"这个 artifact **派生自**这条原则"。

- 列值的其他写入者仍存在：`dreamer-output.ts:82` 的 schema 允许 LLM 输出携带 `sourcePrincipleId`（`Type.Optional(Type.String())`）并经 `dreamer-runner.ts:285` 持久化到 dreamer artifact 列；`evaluator-runner.ts:3296` 也会写入 resolved 值。
- 攻击面评估：伪造 UUID 无法通过 `hasPrinciple`（造不出新身份）；但如果 LLM 从 prompt 上下文回显了一个**真实**账本 UUID（`template-generator.ts:89` 确实会把 UUID 嵌进模板），且该 artifact 被派发激活，就会**误归因到一条已存在的原则**。
- 建议（follow-up，非阻塞）：要么在 direct 路径叠加 lineage 交叉验证（两者都可解析时必须一致），要么收窄列的可信写入者清单。此点应写进 SPEC 的 Principle Identity Contract（Part 6 New-2）。

另注：`sqlite-activation-safety-store.ts:393` 的"每原则唯一激活"匹配查询仍用 `COALESCE(source_principle_id, json_extract(...), json_extract(...))` 兼容旧行——这是**读侧**对存量数据的兼容，新写入已 UUID-only，可接受，但属于新旧身份空间并存的运营风险（见 Part 7-M3）。

---

## Part 3 — Mutation Authority Review

原则：`One fact → one mutation authority → multiple callers enter through it → no independent competing writer`。

### PR #1851 — `recommendation_kind` 的唯一修改权 ✅

- 写边界统一收敛到 `isPrincipleLedgerEligibleKind()`：`candidate-intake-service.ts:208` 与 `pain-signal-bridge.ts:964,1011` 两处生产入口都经它校验，unknown kind 无法进入 Principle Ledger。
- 这是"验证后的类型才可入账本"的单一闸门，无独立竞争写入者。

### PR #1856 — Principle identity / activation identity 的唯一修改权 ✅（有一个非阻塞的结构性观察）

**身份铸造（mint）**：唯一权威 = 账本 intake（`PrincipleTreeLedgerAdapter`，`runtime-v2/adapter/principle-tree-ledger-adapter.ts`，含 `hasPrinciple:117` / `listForCandidate` / `activatePrinciple`）。

**身份携带（carry/stamp）的写入者清单**（`source_principle_id` 列，生产非测试路径，逐一核对）：

| 写入者 | 性质 | 与权威的关系 |
|---|---|---|
| `ScribeRunner` I2 盖章（`scribe-runner.ts:461,496`，#1856 新增） | 写入时从链路推导 | 经 `listForCandidate` 恰好一条，从账本推导 |
| `backfillScribeIdentity`（`pd-cli/services/rulehost-pipeline-runner.ts`，EP002-R4/Phase A 既有） | scribe 阶段后回填 | 同一推导（seed candidateId → 恰好一条）；有 `identity_conflict` 不覆盖 + 读回验证 |
| `evaluator-runner.ts:3296` | 沿链传递 resolved 值 | 派生 |
| `dreamer-runner.ts:285` | 透传 LLM 输出可选字段 | **断言型**（见 Part 2 缺口） |

**关键判断**：没有竞争**事实**写入者——所有盖章者都是从同一账本、经同一 adapter、同一"恰好一条"语义**推导**，无人能独立铸造身份。激活身份的铸造权更是已完全收归 dispatcher（writer 不再自铸）。

**账本 status 变更（candidate → active）**：`ApprovalsConsoleModel.upgradeLedgerPrinciple`（:263）在激活成功后调用 `ledger.activatePrinciple`——多 caller 进同一 authority 的合法模式，且失败非致命但有 warning（rc-9）。

### Competing writer / bypass path / independent mutation logic

- **Bypass path**：生产派发点已全部接线 `ledgerIdentity`（host-runtime 治理环/消费环、pd-cli runtime-activation ×2、run-once、demo-story-a-runner ×2、rulehost-pipeline-runner、pd-console ApprovalsConsoleModel——逐一核对构造点）。**唯一未接线点**：`pd-cli/scripts/llm-dogfood.ts:314`（开发脚本，回落到 shape-only 严格边界——未盖章产物直接拒绝、无 lineage 解析；非生产路径，见 Part 7-L1）。
- **Independent mutation logic（结构性观察，非阻塞）**：同一套 lineage 推导逻辑现在存在**三份独立实现**——core `ledger-identity.ts`、pd-cli `rulehost-pipeline-runner.resolveLedgerIdentity`、pd-console `principle-id-resolution.ts`。今天语义一致（seed 优先、task-id 拼写兜底、恰好一条），但未来改 seed 格式需要三处同步——这是 SPEC §17 "caller 不得建立平行 mutation logic" 在**推导逻辑**层面的擦边球。建议 follow-up 收敛到 core 模块（#1856 已导出 `resolveLedgerActivationId` 等公共 API，收敛条件成熟）。

---

## Part 4 — Fail Closed Boundary Review

统一判据：`uncertain input → reject / defer`，而不是 `guess`。

### Candidate Boundary（PR #1851）

unknown kind → `isPrincipleLedgerEligibleKind` 拒绝 → 无法进入 Principle Ledger。**fail-closed ✅**（main 上实证）。

### Identity Boundary（PR #1856）

unknown identity 变成文本身份的所有通路已封死（Part 2 表格）。特别值得肯定的两条语义：

- **盖章但账本查无 = 数据漂移**，显式 `principle_not_in_ledger: <id>` + nextAction（`check_pi_artifacts_source_principle_id_against_ledger_or_run_identity_reconciliation`），**不**静默回落 lineage——这是把"拒绝"和"降级解析"分开的正确设计；
- **lineage 歧义（0 或 >1 条）= 拒绝**，reason 里明说 "refusing to guess"。**fail-closed ✅**

### Activation Boundary（PR #1856）

缺身份进 runtime 的通路：

- `enqueueForApproval`：写审批记录（= 第一个预提交状态变更）**之前**闸门（`activation-dispatcher.ts:329-337`）；
- `activateArtifact`：激活提交**之前**闸门（`:408-412`）；
- 拒绝决策带 structured reason + nextAction（cli-6 / rc-9 合规）；
- scribe 盖章 fail-soft 但**可观察**：`scribe_identity_stamp_failed` / `scribe_identity_stamp_skipped` 已注册进 telemetry union（`telemetry-event.ts`，经 `BasePeerRunner.emitEvent` 的 `runnerName_` 前缀机制自动成名——PR 描述里写的无前缀事件名是逻辑名，线上事件名带 `scribe_` 前缀，两者一致，非缺陷）。

**fail-closed ✅**（两层设计正确：软盖章推迟解析 + 硬闸门最终裁决，两层都是 defer/reject，无 guess）。

### 一处已知的不对称（可接受，需知晓）

未接线 `ledgerIdentity` 的调用方回落到 shape-only 边界：盖章产物照常激活（只验形态不验成员），未盖章产物直接拒绝（无 lineage 解析机会）。生产路径已全部接线，此不对称仅剩 llm-dogfood 一处。

---

## Part 5 — Evidence and Causality Review

### Identity 稳定后，是否支持 `Intervention → Runtime Behavior → Outcome Evidence → Attribution`？

**支持，且这是本 PR 最大的长期价值。** 链路各跳的身份现在同源：

```
intake 铸造 UUID
→ scribe artifact.source_principle_id = UUID（I2 盖章）
→ activation.target_ref = ledger://<UUID>、activation_id = act_prompt_<UUID>
→ 注入面 resolved principleId（active-principle-prompt.ts 按 principleId 集合投影）
→ rule 工件携带 sourcePrincipleId（RuleHostWriter 语境）
→ principle_applications 后续新行挂同一 UUID
```

INV-03 的四段同一性第一次变得**机器可验证**，SPEC §16 的执行身份字段第一次有了稳定的锚点。

### Identity 不稳定以前，破坏了什么（引用实测证据）

| 受损面 | 机制 | 证据 |
|---|---|---|
| **effect attribution** | application/effect 行以标题为键，回连不到审批对象；93 条 effect 行 `activation_id IS NULL` 不可归因 | Phase 2/3 审计（`docs/audit/principle-baseline-*`、ADR 草稿 §5.2） |
| **Principle reuse** | 治理面 122 条 UUID 账本 vs 行为面 11 条标题键 live 原则——两个不相交群体；27 条高价值休眠原则 Selector 无法消费 | ADR §1.1/§4 |
| **Resolver** | pd-console `resolveLedgerPrincipleId` 被迫在**激活提交后**做事后 lineage 猜测（非致命 upgrade）；`extractPrincipleId` 标题兜底曾让 `ledger.activatePrinciple` 永远失败（"Cannot update missing principle <title>"） | `ApprovalsConsoleModel.ts:263` 注释史 |
| **causal evidence** | SPEC §5.2 最低因果证据第 4 条（同一 intervention revision）不可判定；标题改一字即新身份，before/after 不可比 | SPEC §5.2 + F1 |

**边界说明**（避免过度声明，INV-10）：身份稳定是因果证明的**必要条件**，不是充分条件。SPEC §5 的 off→on→off 对照、污染排除等标准仍然全部适用——#1856 让这些标准第一次**可执行**，而不是自动满足它们。

---

## Part 6 — SPEC Drift Analysis

> 原则：SPEC 更新**不阻塞** #1856（约束第四条）；以下全部是后续 docs PR 的内容。

### Keep（无需修改）

- INV-01/02/04/05/06/07/08/09/10（#1856 与它们无冲突，且是它的实现依据）；
- §5 Causal Evidence 全节；§6 四条 Golden Journeys；§7 Revocation；§8 Trust Boundary；§9 Owner Governance Boundary；§17 Mutation Authority；§21 Test Truth；§22 G1–G5；§30 Change Classification；§31 十种失败方式；§32 优先级；§37 Final Principle。

### Update（需要更新）

| # | 原章节 | 问题 | 建议修改 |
|---|---|---|---|
| U1 | **INV-03**（:286-313） | 绑定手段限定 "revision 或 content digest/hash"，未承认已实现的更强模型；LLM 文本 digest 天然不稳定 | 升级为：身份 = 单一权威铸造的稳定标识符（Principle = 账本 UUID）；digest 降为补充（同身份内容漂移检测）；明文"任何 title/text/派生值不得在写入或闸门边界充当身份；宽松解析仅限展示面" |
| U2 | **§15 Current Lineage Model**（:967-993） | 链上有 Principle 节点，无"身份铸造"步骤 | 在 `Diagnosis → Principle` 之间标注身份铸造点（intake），并给 `executed` 段补 principle identity 字段 |
| U3 | **§16 Exact Execution Identity**（:997-1015） | 字段清单缺 principle identity | 增加 `source_principle_id / ledger principle id` |
| U4 | **§22 G1**（:1198-1218） | G1 覆盖描述未含"身份铸造/成员校验" | 补充：G1 同时保护 identity minting 与 membership（#1856 dispatcher 双闸是 G1 在 identity 维度的首个真实实例） |
| U5 | **文档头**（:7-8） | "Primary current use: PRI-803" 已过时（PRI-803 时代结束，当前是 Phase 3 身份对齐） | 更新 current-use 指针；版本推进 v0.4 |

### New（建议新增）

1. **INV-11 — Principle Identity Contract**（长期不变量）：I1 身份只在账本 intake 铸造；I2 生产链前向携带义务（携带失败必须可观察、fail-soft）；I3 激活边界 fail-closed（无已验证身份 ⇒ 拒绝）。附"断言型 vs 推导型身份"注意：membership 证明存在性，不证明派生关系；可信盖章者清单应受控。
2. **§Identity Flow**（长期章节）：`Candidate → Principle Identity → Artifact → Activation → Execution → Evidence`，逐跳义务（铸造/携带/校验/仅展示）。
3. **§Activation Identity Boundary**：uncertain input → reject/defer 的统一判据在此维度的具体化；stamped-but-unknown = drift 上浮、永不 lineage 猜测；歧义 = 拒绝。

### Move（建议移出到 docs/audit / Linear）

| 原章节 | 理由 |
|---|---|
| §12 Current Engineering Map 的 stage 清单 | current snapshot，SPEC §28 自己已声明应移出 |
| §13 Effective Topology、§14 Five-Layer Model | 同上（保留一句指针即可） |
| §23 PRI-803 Sprint Contract、§24 Sprint Guardrails、§35 PRI-803 Done | 冲刺专属契约，冲刺已过；移 docs/audit |
| §25 R-19 Sprint Policy | SPEC §8 已有原则版；冲刺政策移 audit（§8 自己也说 R-19 属 current finding） |
| §26 Current Host Choice for PRI-803 | current snapshot |

（§27-§29、§33-§34、§36 是结构建议与长期 Done 定义，可保留。）

---

## Part 7 — Risk Review

### Critical Risks

**无。**（身份边界双路径 fail-closed 已实证；零 schema 变更；回滚 = revert PR；CI 22 项全绿；CodeRabbit 四条处置经复核与代码一致——两条撤回、一条已修（小写归一）、一条不再适用。）

### Medium Risks

- **M1 推导逻辑三处重复**（core / pd-cli / pd-console）：语义今天一致，未来 seed 格式变更需三处同步，漂移即静默身份解析分歧。→ follow-up 收敛到 core 公共 API。
- **M2 断言型身份缺口**：dreamer LLM 输出可持久化 `sourcePrincipleId`（`dreamer-output.ts:82`），membership 校验挡不住"误归因到已存在原则"。→ follow-up：direct 路径叠加 lineage 交叉验证或收窄可信写入者。
- **M3 新旧身份空间并存**：本 PR 明确不做存量回填（non-goals），11 条标题键 live activation、1243 行标题键 application 维持原状；"每原则唯一激活"等不变量查询（safety store COALESCE）需跨两空间匹配；旧行的归因仍然断裂。ADR §6 Phase 1 回填桥（含 OD4 失败阈值）仍待 Owner 启动。
- **M4 SPEC 漂移窗口**：#1856 是 Class A 变更（改变 intervention identity 语义），其权威文本（SPEC INV-03 + ADR）一个未更新、一个还是未跟踪草稿。按 AGENTS §3.3 必须在 PR/文档中显式记录此漂移——本报告即为记录，但收编动作本身待做。

### Low Risks

- **L1** `llm-dogfood.ts:314` dispatcher 未接 `ledgerIdentity`（shape-only 回落）——开发脚本，建议接线或注释声明。
- **L2** PR 描述/changeset 中事件名写的是无前缀逻辑名（`identity_stamp_failed`），线上事件为 `scribe_identity_stamp_*`——纯文档口径，建议 PR body 顺手更正。
- **L3** 覆盖率缺口：`ledger-identity.ts` 8 行、`ApprovalsConsoleModel` 5 行（主要是 catch 降级路径）——可接受，建议后续补。
- **L4** demo-story-a-runner 改为真铸造账本条目（`derivedFromPainIds: [demo-<runId>]`）：演示跑一次多一条账本记录，开发库会积累 demo 条目——与生产行为一致是正确方向，注意 demo 数据清理预期。

---

## Part 8 — Final Verdict

# ✅ APPROVE WITH SPEC UPDATE

**PR #1856 本身达到可合并标准**（最终合并权在 Owner）；SPEC v0.4 收编作为独立后续 docs PR，不阻塞。

### Strengths

1. 与 #1851 构成同类缺陷的**成对封堵**：kind 边界 + identity 边界，同一个 "内容不得冒充身份/类型" 宪法原则的两处落地；
2. 修订版修**链**不修**闸**：Owner P1×3 评审后的版本补上了 scribe 生产链盖章（I2）并把成员校验提前到两个预提交点（I3），而不是放宽边界让测试变绿——第一版"E2E 手工盖章即通过"的教训被正确消化（所有测试手工盖章已移除）；
3. reject-not-guess 语义精确：drift 上浮、歧义拒绝、fail-soft 可观察，全部带 structured reason + nextAction；
4. 复杂度负向（P3/P7 合规）：零 schema、零新实体、复用既有列与 lineage，回滚 = revert；
5. 生产派发点全接线，E2E 与生产走同一身份契约。

### Weaknesses

1. 身份推导逻辑三处并存（M1）；
2. 断言型身份未做派生性验证（M2）;
3. 存量标题键身份未回填，两空间并存（M3，设计上显式延期）。

### Missing Pieces

1. SPEC v0.4：INV-03 升级 + 三个新章节（Part 6）；
2. ADR 草稿（`docs/architecture/principle-identity-reconciliation.md`）目前未跟踪，需随 docs PR 落库；
3. ADR §7 的 OD4（回填失败阈值）/OD5 独立性裁决已由本 PR 事实上回答（OD5=是，独立 PR），OD1-OD3 仍待 Owner 正式裁定。

### Required Follow-up

| # | 事项 | 性质 |
|---|---|---|
| F1 | ADR 落库 + SPEC v0.4（Part 6 清单） | docs PR，不阻塞 #1856 |
| F2 | 存量回填桥（ADR Phase 1）+ OD4 阈值裁决 | Linear 立单，Owner 启动 |
| F3 | 推导逻辑收敛到 core（M1） | Linear 立单 |
| F4 | dreamer 断言型身份收窄/交叉验证（M2） | Linear 立单 |
| F5 | 合并后跑一次真实链路验证（新 candidate → 激活全链 UUID 端到端，mvp-q-2 观察路径） | 合并后动作 |

---

*审查方法声明：全部结论基于 PR head `5029b961` 的 diff 与文件实读（非 PR 描述转述）；SPEC/ADR 逐节核对；生产构造点、列写入者、事件注册逐一 grep 实证。未运行测试套件（CI 22 项全绿采信为环境证据，PR 描述的本地套件结果未独立复跑）。*
