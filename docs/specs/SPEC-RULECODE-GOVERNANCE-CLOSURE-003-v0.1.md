# SPEC-RULECODE-GOVERNANCE-CLOSURE-003 v0.1

- 状态：Owner 已于本会话 2026-10-25 回复“同意”，批准 A+B 工程实施；不构成生产规则审批或激活授权。
- 日期：2026-10-25。
- 工单：PRI-1042；关联复验 PRI-1043、PRI-1044；明确排除 PRI-1045。
- 源码审计基线：28514160413e7e7bbeac2049703ea4acb86f8b7b（产品 2.3.12）。
- 设计形成时的证据边界：只读源码调查和文档；实施证据另记验收报告，不追溯改变历史证据。
- Owner 已批准本文具体设计，连续实现、验证、提交推送；生产规则批准、shadow/live 决策仍独立执行。

## 1. 问题与成功标准

真实规则链可以生成并验证 RuleCode，却没有对应正式 Principle 的合法身份。当前 `sourcePrincipleId=null` 是诚实的未关联状态，不是可以用主 prompt 原则 UUID 填平的数据空洞。验证通过、正式归属、规则批准、shadow/live 生效是四件不同的事。

本轮成功标准：已有正式 principle reuse 的身份能够被生产消费者一致解析；直接 rule 候选能由认证 Owner 显式关联一个既有正式 Principle；关联后通过受控新 Scribe 修订和既有 Artificer/Evaluator 流程形成新工件；旧无身份工件保持原样；所有审批、shadow/live 和安全边界继续成立。无合适原则时保持未关联，交回既有原则形成流程。

本轮不允许：自动创建 Principle、rule 改 kind、凭相同 pain/标题/主 prompt 审批推断归属、复制旧代码跳过正常评审、直接回填历史工件、自动审批/激活、改变工具事实 kind、编译试点或新原则平台。

## 2. Reality Audit：现有能力与断点

以下路径均相对仓库根目录，行号以审计基线为准。

| 现有事实 | 源码证据 | 判断 |
|---|---|---|
| Principle Ledger 只接受精确 principle kind | `packages/principles-core/src/runtime-v2/candidate-intake-service.ts:508–526` | 不可放宽为 rule 自动入账 |
| pain bridge 在 intake 拒绝后保留 kind 路由 | `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts:1371–1468` | 生成链可前进但没有正式身份 |
| principle→prompt，rule→code_tool_hook | `packages/principles-core/src/runtime-v2/internalization/intake-to-internalization-bridge.ts:123–125` | 不是所有 principle 自动形成代码 |
| 无机械证据的 rule 降级 prompt | 同上 `:167–170` | 降级不改变 kind，也不产生身份 |
| Scribe 仅从候选唯一来源解析身份 | `packages/principles-core/src/runtime-v2/internalization/scribe-runner.ts:531–564` | fail-soft 产物不能被当成可发布规则 |
| RuleCode 身份只继承 bearer 的 canonical UUID | `packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts:3102–3125,3597–3683,3836` | 不从模型输出或标题补身份 |
| activation 在治理变更前验证 Ledger 身份 | `packages/principles-core/src/runtime-v2/activation/ledger-identity.ts:121–174`；`activation-dispatcher.ts:204` | UUID-only 边界保留 |
| CLI pipeline 还有独立解析和 backfill | `packages/pd-cli/src/services/rulehost-pipeline-runner.ts:1099–1131,1166–1212` | 必须与 Scribe/activation 一起收口 |
| 已有 principle Owner reuse 写入 reuseEvidence | `candidate-intake-service.ts:744–783`；`packages/pd-cli/src/commands/candidate.ts:866–875` | 只服务 principle reuse，不接受 rule 绑定 |
| reuse 查询已存在但没有接到身份消费者 | `packages/principles-core/src/runtime-v2/adapter/principle-tree-ledger-adapter.ts:113–145` | listForCandidate 只查 derivedFromPainIds；findReuseResolutionForCandidate 另查 reuseEvidence |
| 单一 Ledger codec/mutator/文件锁 | `docs/adr/0017-principle-ledger-single-implementation.md:42–66` | 复用当前权威，不加独立旁路文件 |
| 旧 compiler 形成 LedgerRule | `packages/principles-core/src/principle-tree-ledger.ts:663`；`packages/openclaw-plugin/src/core/principle-compiler/ledger-registrar.ts:33,78` | 它不是当前 PI RuleCode 归属入口，不启用它来绕行 |
| 认证 Owner 上下文已存在 | `packages/pd-console/src/server/routes/owner-decisions.ts:236–240` | 新窄入口复用相同服务端认证来源 |
| Console 第四身份读面也只查 derivedFromPainIds | `packages/pd-console/src/server/models/principle-id-resolution.ts:101–163`（`:151`）；`artifact-principle-resolver.ts:68` → `OwnerDecisionConsoleModel.ts:296` / `ApprovalsGroupedConsoleModel.ts:291` / `ApprovalsConsoleModel.ts:571` | 必须接入共享解析；不能让后台已关联而真实 UI 仍 unlinked |
| 有现成 revision reopen 和级联 | `packages/principles-core/src/runtime-v2/internalization/revision-reopen.ts:56–129`；`internalization-orchestrator.ts:590–646` | 可复用底层，缺新的归属修复入口和预算/目标校验 |
| Scribe 新 run 形成新工件 ID | `scribe-runner.ts:462` | 正常修订可以保留旧工件，而非改历史 |

生产图：

```text
PainSignalBridge → CandidateIntakeService
  principle → 新 Ledger principle 或 Owner reuseEvidence
  rule      → Ledger refused，仍保留 rule kind
     ↓ buildDreamerSeedFromCandidate / computeBridgeDecision
Dreamer → Philosopher → Scribe → Artificer → Evaluator → Rule 工件
                       ↓ stamp                  ↓ inherit
            当前只查 derivedFromPainIds    sourcePrincipleId
                       ↓
     activation dispatcher → 原有规则审批 → shadow → 独立 live 决定
```

四路结论：新 principle 的原候选链已有合法身份；已有 principle reuse 存在持久事实但身份消费者未接通；直接 rule 没有合法归属入口；rule→prompt 降级也不产生正式身份。直接 rule 归属不是单纯接线修复，是新增 Owner 治理语义。

`docs/specs/principle-purification.md:3` 仍标 Draft for Owner Review，不把它伪称已批准规范；当前代码与 ADR-0017 才是已核实实现约束。ADR-0014 的 RuleCode 例外不等于允许任意 rule 自动成为正式原则。

## 3. 方案选择

| 方案 | 收益/成本 | 决定 |
|---|---|---|
| A：只接通已裁决 principle reuse | 无模型成本；不新增归属事实；解决已有 reuse 的断线 | 纳入，但不能宣称解决直接 rule |
| B：认证 Owner 显式将直接 rule 关联既有正式 Principle | 增加一个 Ledger 关系字段、窄接口和受控修订入口；保持类型与审批独立 | 推荐并纳入，待 Owner 确认 |
| C：自动造 principle、偷用主 prompt UUID、放宽激活身份 | 成本看似低，实际伪造 lineage 或污染原则集合 | 禁止 |

B 不复用 `reuseEvidence` 表达不同语义。也不复用 activation_decisions 表达知识归属；该表的 subject/decision 约束属于激活治理。推荐在当前 Ledger 的 `_tree` 内新增独立 `ruleCandidateBindings`，而非新数据库、旁路文件或关系平台。

## 4. A：统一身份解析

新增一个共享语义解析入口 `resolveCandidatePrincipleIdentity(candidateId, candidateKind)`，由当前 Ledger adapter 提供。读取同一次可用 Ledger 快照，不使用跨 workspace 单值缓存。返回：

- `resolved { principleId, basis, candidateId, bindingRevision? }`；basis 为 `derived_candidate | principle_reuse | owner_rule_binding`。
- `unresolved { reason, nextAction }`；reason 为 `ledger_unavailable | candidate_missing | candidate_kind_invalid | missing | ambiguous | conflicting_authorities | target_missing | target_ineligible | binding_revoked`。

A 的规则：principle 候选允许从 derivedFromPainIds 或已有 reuseEvidence 解析；若各来源合并后唯一且相同则成功，多个不同目标一律冲突。必须扫描所有匹配，不调用现有 first-match reuse 查询来假装唯一。rule 候选只接受 B 的显式关系；prompt/implementation/defer 不通过本次新入口增加身份。保留旧历史解析兼容性的范围必须由现有特征测试证明，禁止把旧脏数据当新 rule 的合法 authority。

接入 Scribe、activation resolver、CLI pipeline/backfill，以及 Console 身份读面四处。Console 的 `principle-id-resolution.ts`/`artifact-principle-resolver.ts` 必须调用同一语义 resolver；OwnerDecisionConsoleModel、ApprovalsGroupedConsoleModel、ApprovalsConsoleModel 均用真实读模型路径验证 resolved/conflicting/unavailable/revoked，不能保留一条宽松 direct-ID UI 旁路。backfill 函数不得用于改写旧生产工件；其共享解析可复用，生产修复走第 7 节的新修订入口。每个 direct UUID 仍验证 Ledger 成员，禁止 unknown UUID 回退猜测。

A 不改变 reuse 的终结语义：Owner reuse 后现有 CLI 消费候选并返回；本次不把它自动改成追加规则任务。身份查询接通不等于新授权执行。

## 5. B：唯一持久化权威与数据契约

### 5.1 存储

在 `LedgerTreeStore` 增加可选字段：

```ts
ruleCandidateBindings?: Record<string, {
  candidateId: string;
  revisions: Array<{
    revision: number;                 // 从 1 连续递增
    decisionId: string;               // 服务端 UUID
    requestId: string;                // 客户端幂等键，服务端绑定 actor + workspace
    action: 'bind' | 'revoke';
    principleId: string;              // revoke 也保留其撤回目标
    reason: string;                   // 非空，有界 2000 字符
    decidedAt: string;                // 服务端 UTC ISO 时间
    owner: {
      actorId: string;                // 配置/认证上下文，绝不取 body
      source: 'authenticated_console';
    };
    reviewedCandidateDigest: string;  // 服务端对实际候选/证据/链引用计算
    reviewedPrincipleDigest: string;  // 实际原则正文/版本/状态快照摘要
  }>;
}>;
```

map key 必须等于 candidateId。当前状态由最后一条有效 revision 派生；不另写 activeBinding 布尔或第二张事实表。所有读取验证元素、UUID、action、revision 连续性、requestId 唯一性及摘要格式。字段缺失表示旧版无绑定；字段存在但畸形必须 typed corruption，不视为 missing。

写入仅由 `principle-tree-ledger.ts` 在现有文件锁下执行；codec/types 同步更新。`reuseEvidence`、derivedFromPainIds、candidate recommendationKind、旧 artifact、approval、activation 不因此变更。新增字段不会计为新的 Principle，Principle 数量和其原来源不变。

### 5.2 资格与 provenance

本节候选、目标和当前材料资格门仅用于 bind，不用于阻断已有关系的 revoke。bind 的候选必须存在、持久 kind 精确为 rule、能验证诊断任务/run/artifact 与 pain 的一致链。候选消耗状态本身不能阻止对已生成但无身份链的归属审阅，也不能证明它已获批准。

目标必须是 Ledger 中 UUID 形式、来源可验证为 principle 的正式记录。资格是派生判断：沿其实际候选 ID/来源链读取持久 recommendation kind，要求精确 principle 且来源一致；不能只看字段名或旧标题。`legacyContaminated` 不是当前代码已有字段，本方案也不新增此布尔字段；来源为 rule/prompt/implementation/defer/unknown、来源缺失或冲突均拒绝，不用历史污染数据取得资格。状态从 `runtime-v2/types/principle-enums.ts:10–18` 的 `PRINCIPLE_STATUSES`/`PrincipleStatus` 派生：candidate/probation/active 可关联，archived/deprecated 拒绝。candidate 是已登记但尚待治理的原则身份（当前 adapter 的新建状态），不是“没有身份”；关联不提升其状态、不替代规则审批，也不强迫 Owner 先批准 prompt 才能走代码通道。激活仍执行既有门禁。

Owner 审阅界面显示候选原文、来源 pain、诊断证据、拟约束行为、目标原则全文/版本/状态、已有归属及规则工件。Owner 明确声明“该规则是这条原则在此范围内的一种实现”。系统只校验身份/版本/来源一致性，不把语义判断交给隐式模型裁决。

认证来源沿用 Console token + configured Owner identity。body 不允许 actor/source/time/approved 等权威字段。通用用户消息、“方案批准”文本、主 prompt 审批均不是此关系的认证决策。本文不新增 CLI 写入口；只读 CLI 可展示待关联和 Console 地址。

### 5.3 版本、幂等、冲突与撤回

- bind 请求必须携带 expectedRevision（初次 0）、候选摘要、原则摘要及 requestId。服务端重读、重算，任一不一致返回 409 stale，不写。revoke 只要求认证、当前 binding、expectedRevision、reason 和 requestId；撤回目标与历史审阅摘要从当前被撤回的 binding revision 取得，不要求目标原则或候选目前仍存在、合格或可读。目标/来源已失效可附告警，但不能阻断撤回；承载关系的 Ledger 本身不可读仍必须失败。
- 同 actor/workspace/requestId 且完全相同请求返回原决定；同键不同内容返回 409 idempotency_conflict。
- 已 bind 同目标、同预期版本的重复决定只返回当前事实，不追加 revision；另一个目标必须先明确 revoke，不能静默覆盖。
- revoke 追加 revision，不删除旧关系；重新 bind 必须使用最新 revision 和新审阅摘要。
- 撤回是归属事实的修订，不是运行许可的撤销。已有 active/shadow activation 保持原治理状态；响应必须列出这些工件与现有停用入口，明确 `runtimeDeactivated:false`。Owner 要求停止运行时必须另走现有停用/紧急暂停，不把关联撤回当作已停用。
- 对尚未激活的旧审批待办不伪造 rejected 决定；发布/批准/激活最终检查若读到关系已撤回，返回 binding_revoked，原记录保留，展示不可继续。历史工件的已盖章身份保持原事实，不因后来改绑而静默变为另一个原则。
- 目标原则删除、停用或版本变化后，未来生成/发布重新检查资格；绑定不赋予绕过原则治理的权力。

并发契约：不新增跨 JSON Ledger 与 SQLite 的事务或通用锁平台。每次生成前和发布/批准/激活最终入口重新读取 binding revision/digest，读取失败一律停止；本次操作以该最终校验快照作为归属资格检查的线性化点，并在其操作诊断/结果中记录检查到的 revision、decisionId 和 checkedAt。撤回之前已通过最终校验、正执行本地提交的在途操作可能完成；不得承诺撤回响应是全局发布屏障。撤回响应明确 `inFlightOperationsMayComplete:true`，回读现有待办/activation 列表供 Owner 核对；若列表读取失败标 unavailable 并提供重查入口，不能显示零项。撤回之后才进入最终检查的新请求必须拒绝。模型调用期间撤回的链在最终检查处停止；在途提交最终形成的 activation 仍由既有停用机制处置。本轮接受这一窄语义；若 Owner 要求“撤回返回后绝不再有任何在途提交”，需要另立跨存储治理事务设计，不在本文中暗中承诺。

## 6. 正式入口与控制面

新增认证 Console 路由（此为新接口，不是现有已可用命令）：

- `GET /api/v1/governance/rule-candidate-bindings/:candidateId/review`：只读审阅事实、currentRevision、摘要、合格目标的 bounded search；默认最多 20 条，只按既有过滤/搜索，不新增 embedding。
- `POST /api/v1/governance/rule-candidate-bindings/:candidateId`：按 action 严格验证请求联合类型。bind 为 `{action:'bind', principleId, expectedRevision, expectedCandidateDigest, expectedPrincipleDigest, reason, requestId, resumeOnce:true}`；revoke 为 `{action:'revoke', expectedRevision, reason, requestId, resumeOnce:false}`，目标身份与历史审阅摘要从当前关系取得，不读取目标资格来否决撤回。撤回绝不排队生成。绑定请求明确包含一次固定 profile 的受控续跑授权；服务端在绑定持久化后幂等排队，binding 已存在的重放也恢复同一 cause 的续跑，不要求 Owner 再点一次。
- `POST /api/v1/governance/rule-candidate-bindings/:candidateId/revise-once`：`{expectedBindingRevision, expectedScribeTaskId, expectedTaskRevisionEpoch, requestId}`；作为崩溃/排队失败的恢复入口，重放第 7 节同一窄修订，不新增第二次 Owner 许可停点，不批准规则。

响应区分 `bound | already_bound | revoked | already_revoked | revision_started | revision_already_started` 与明确失败 reason/nextAction。所有 body 为 unknown 严格校验，额外权威字段拒绝；403 认证失败不能写任何状态。

在现有 Governance Focus/候选详情显示“等待正式原则关联”，提供审阅入口。无合适目标时给出“保持未关联，进入既有原则形成流程”，不显示自动转原则按钮。绑定提交前显示固定 profile 一次受控续跑的阶段与成本范围，提交包含 resumeOnce:true；成功后自动续接并显示状态，禁止增加必须再次点击“继续”的硬停点；不合并为“批准并启用”。绑定审阅、RuleCode 工件审批、shadow→live 三种 Owner 决定用不同文案和服务调用，设计批准也不复用其中任何一种。

控制面必须保持可达：新增校验只挂在该候选生成/发布边界，不注册全局工具拦截，不阻断 Console 登录、原则审阅、停用、紧急暂停和恢复入口。

## 7. 旧无身份工件的恢复与新生成停点

### 7.1 新生成

在 Dreamer seed 之后、首次 Scribe 模型调用之前做当前归属 preflight；对于 code_tool_hook 的直接 rule，missing/revoked/conflict/unavailable 均停止该链本轮消费，明确展示 awaiting_owner_binding 或 identity_source_unavailable。沿用现有 task 状态集合和诊断 reason，不扩展状态 enum；不得标 succeeded 或把 await Owner 算技术重试。停止点不触发定时模型重试，不消耗模型 attempt；只在 Owner 操作/明确恢复后重新检查。

Artificer/Evaluator 调用前及最终发布前再次检查当前关系与版本，防止长模型调用期间撤回。它们不自行修复身份。规则证据 preflight/意图契约和普通验证继续执行。

### 7.2 已生成的 null 身份链

实施期真实 SQLite 复验更正：现有 `pi_artifacts` 的 `(source_task_id, artifact_kind)` 唯一键及 upsert 会替换旧 artifactId，单靠新 run ID 不能保存历史。为满足本节已批准的历史不变要求，现有表增加派生 `revision_epoch`（历史默认 0），唯一键改为 `(source_task_id, artifact_kind, revision_epoch)`；不增加第二份工件库。存储从原任务元数据确定 epoch，调用方不能自报；同 epoch 保留原幂等行为，跨 epoch 保留旧行。listBySourceTaskId 保持当前输出投影（只返回最新 epoch），旧工件通过 getArtifactById 及原审批引用继续可读；修订读取再按成功 resultRef 校验本轮工件，缺失时停止而非读旧版。绑定修订复用现有 reopen 状态语义，并用已有 task CAS 同时检查 metadata/status/lease/budget，关闭无条件写入的竞争窗口。

此迁移由正常运行时 schema 初始化执行，代理不直接迁移生产库。开始保存多轮工件后，不承诺旧二进制仍可写入；回退须保留数据库并使用兼容此 schema 的构建，禁止为了恢复旧唯一键删历史。迁移验证必须包括旧格式升级、再次打开、双轮工件及原审批引用均可读。

一次绑定修复预算由现有任务元数据中的 `ruleBindingRevisionCauseId` 保存执行回执；它不是关联权威。不能把既有普通 Owner 修订的 `revisionCount > 0` 直接当作绑定修复预算已耗尽。首次绑定修复递增原累计计数，保留既有 repair/rollout 预算；同 cause 幂等，已有绑定修复回执则不因撤回、重绑或后来普通修订而获得第二次预算。

增加一个窄 orchestration 入口，不声称现有 owner-resolution service 已支持此动作。它验证 candidate→Dreamer→Philosopher→Scribe 的生产依赖、唯一目标、终态与最新 binding，禁止调用者任意传入其他链的 Scribe。

使用现有 `reopenTaskForRevision`，causeId 为 `rule-binding:<candidateId>:<bindingRevision>`。每个 binding revision 最多启动一次受控修订；相同 cause 在任何任务状态下都是真 no-op。检查既有预算，且该修复每候选本轮最多一次新 revision；失败后显示人工处置，不循环授予自己新 revision。明确区分同 epoch 的执行/transport attempt 与新 epoch 的 revision 总预算：沿用 `reopenTaskForRevision` 的正常行为，在新 revision 中将 attemptCount 重置为 0（`revision-reopen.ts:118–125`）；这不是扩大 revision/repair 总预算。预算不足不重置 revisionCount/repair 总预算，不换 task ID 或 binding revision 给本轮修复续命。

Scribe 重新调用现有模型 profile、重新验证正文/意图契约并 stamp；其新 run ID 产生新 artifact。正常 commit/reconciliation 的 revision wave 重新打开 Artificer、Evaluator 和后继，均沿既有 profile/预算运行并重新审阅代码。必须验证 successor context 选择新 Scribe 工件，而非旧 source run；不能只靠 task status 判定新鲜度。

旧 Scribe/RuleCode 工件、其 validation、原 null 和失败证据保留。禁止直接运行 backfill 写旧 sourcePrincipleId，禁止 copy-artifact/copy-code 快路径。新工件 contentJson 加派生 `identityResolution` receipt：`{candidateId,basis,principleId,bindingRevision?,decisionId?}`；它只是指向 Ledger 的证据，不是第二权威。Rule 工件从新 Scribe 确定性继承 receipt，不由模型创作。

关联写成功、reopen 前崩溃：绑定请求幂等重放或现有恢复执行路径重放同一 cause，必要时使用 revise-once 恢复入口；不新增常规 Owner 手工续接要求；reopen 后响应前崩溃：返回同一 epoch，不新增执行。reopen 失败保留绑定事实并返回明确原因，不回滚/伪称已撤回决定。生成失败不撤销 Owner 关系，也不把旧工件提升为新版本。

## 8. 触点与责任

| 修改面 | 责任 |
|---|---|
| `runtime-v2/types/ledger-store.ts`、`principle-tree/ledger-codec.ts`、`principle-tree-ledger.ts` | 字段、严格 codec、锁下 revision mutation；不新建跨存储事务 |
| `adapter/principle-tree-ledger-adapter.ts` | 一次快照的唯一身份解析；不混淆 derived/reuse/binding |
| `internalization/scribe-runner.ts`、`activation/ledger-identity.ts`、`pd-cli/services/rulehost-pipeline-runner.ts` | 接通共享 resolver、当前身份/receipt 复验 |
| `host-runtime/src/internalization-consumer-cycle.ts` 及 CLI run-once 同等构造点 | 注入共享能力、生成前停点、诊断结果可观察 |
| `internalization/evaluator-runner.ts`、activation dispatcher/规则审批最终提交面 | 正常继承 receipt、发布时复验，不降低质量门禁 |
| 现有 revision-reopen/orchestrator 的窄调用方 | Owner binding revise-once、预算/唯一目标/新鲜度保护 |
| Console `principle-id-resolution.ts`、`artifact-principle-resolver.ts` 及三个真实治理读模型 | 同一 resolver 的第四消费面；状态与真实治理事实一致，冲突/不可读/撤回不误链接 |
| Console governance routes/models/focus | 认证审阅、明确动作、显示冲突/等待/恢复入口 |

不新增导出私有 helper 供测试；必要公共接口只有语义 resolver、binding mutation/review 和受控 revise-once。实施前逐一核对 public exports、所有构造点及调用方。

## 9. 成本、失败与回滚

无新逐工具 LLM，无 embedding、轮询模型或独立调度器。A 和 B 审阅/关联/解析均为确定性本地读取/写入。旧工件恢复需要一次 Scribe 与正常下游调用；沿现有 profile、总超时、revision/repair 预算，界面在包含 resumeOnce:true 的绑定提交前展示预期阶段，实际调用数由报告列出。失败和超时均计入验收分母。

回滚优先关闭新写/修订入口或回退代码，不增加独立 runtime flag。已有 binding/revisions 保留审计，不能删除来让旧版 codec 通过。发布前必须验证旧版 codec 对新字段的保存行为；若旧版会丢字段，只能部署保留新 codec 的兼容回退构建，禁止直接降到会覆盖字段的版本。带新 binding receipt 的工件在旧逻辑下不可被误认为已治理，应保持未发布并由现有 code_tool_hook disable/停用机制恢复。已激活规则走既有紧急暂停/停用；不把代码回退当作已撤销治理事实。

## 10. 验收与负控

隔离测试使用独立临时 workspace、Ledger、SQLite 和受控 adapter，不使用生产 pain，不写安装目录或真实 `.pd/`。测试产生的决定明确是测试 fixture，不称真实 Owner 审批。

| ID | 场景与必需观察 |
|---|---|
| AC01 | principle 新建同链解析成功；非 principle 不新增 Ledger Principle；默认 channel 不被悄悄改写 |
| AC02 | 已裁决 principle reuse：四处消费面同 UUID；真实 OwnerDecisionConsoleModel、ApprovalsGroupedConsoleModel、ApprovalsConsoleModel 显示正确关联，并分别负控 conflicting/unavailable/revoked 不误链接；不创建原则、不自动续跑 principle reuse 规则链 |
| AC03 | 同候选 derived 与 reuse 不同目标/重复 reuse 指向两目标：ambiguous/conflict，无发布 |
| AC04 | 直接 rule 无绑定：模型 preflight 停点；零新增模型 attempt/审批/activation；原 kind 不变 |
| AC05 | 认证 Owner bind 合格既有 Principle：candidate/probation/active 均有合法正控；唯一 revision/可信 actor/摘要，Principle 总量与目标状态不变，不产生 prompt 批准或 RuleCode 批准 |
| AC06 | body 伪造 actor/source/time/批准字段、无认证、未知候选/目标、非 rule、污染/失效目标：明确拒绝且零 mutation |
| AC07 | 同 request 重放 no-op；同键不同内容冲突；stale revision/digest 冲突；两个并发目标最多一条成功 |
| AC08 | revoke 后新检查拒绝旧 receipt；绑定后目标 archived/deprecated/删除、候选来源缺失或目标不可读时仍能撤回，保留历史、零新生成；Ledger 本身不可读仍明确失败。并发负控分别覆盖最终检查前/后撤回，在途可完成结果如实披露；既有 active/shadow 不因撤回改变，另走正式停用 |
| AC09 | null 旧工件恢复：新 Scribe run/artifact，旧 hash/identity/content 保持；Artificer/Evaluator 真重跑、新上下文、正常验证 |
| AC10 | resumeOnce:true 绑定后自动幂等排队，无第二次点击停点；相同 cause/崩溃恢复不新增 epoch；新 epoch 正常 attemptCount=0 而 revision/repair 总预算不扩大；预算不足/in-flight/非同链/歧义目标拒绝；失败不自动循环 |
| AC11 | rule→prompt 降级不产生原则、不绕过身份；标题/相同 pain/主 prompt UUID不成为关系 authority |
| AC12 | Ledger 不可读和畸形新字段分别 typed unavailable/corrupt；不回退 missing、不编造身份 |
| AC13 | 旧工件仍 null；手工填任意 UUID、错 bindingRevision、错 decisionId 或过期 receipt 均不能审批/激活 |
| AC14 | 新规则批准独立于 binding；shadow/live 独立于批准；设计批准事实不由任一记录生成 |
| AC15 | Console/CLI 构造点一致；--json 输出严格；控制面登录、停用、紧急暂停可达 |
| AC16 | codec 新字段 round-trip、旧字段无损、并发写保留；兼容回退不丢历史绑定 |
| AC17 | 原质量门禁：系统测试、独立模型验证、intent/BehaviorExamplePack/host contract 全保留，失败样本不移出分母 |

负控必须在修复前运行同一正向断言：已裁决 reuse 在旧 resolver 不可解析；直接 rule 在旧系统不存在绑定入口且保持 null。修复后同时证明“合法一条成功”与“伪造/未关联一条拒绝”，不能以全部拒绝生成通过。对 artifact 新鲜度使用真实产物 ID、run ID、receipt 和实际代码评审执行证据，不能只断言无异常或 source 字符串。

ERR 路由：重点是 Pattern Index 的单一事实/lineage一致性、真实生产消费者验证、fail-soft 空跑负控与并发写/回滚。实施前运行 plan 路由，交付前运行 diff 路由；新增 HIGH 必须处理或逐条解释排除。真实可复用 review finding 按仓库 ERR 流程记录。

## 11. Complexity Delta

| 项目 | 判断 | 说明 |
|---|---|---|
| New durable source of truth | NO（owner/存储权威）；新增事实种类 YES | 复用唯一 Ledger 单写者，不建平行 authority；Owner rule-candidate binding/revoke 是新增持久化治理事实语义，不能借同文件说“没有新事实” |
| New persisted schema/state | YES | ruleCandidateBindings、派生工件 receipt、原任务中的一次修订预算回执，以及原工件表 revision_epoch；现有关系和旧唯一键不能容纳关联事实/不可变历史；round-trip、旧 schema 升级和兼容回退验证 |
| New subsystem/service/background process | NO | 现有 Ledger、Console、revision、消费者内的窄连接 |
| New public abstraction/interface | YES | 候选身份 resolver、认证绑定/审阅/修订接口；隐藏多来源/并发/目标校验，禁止调用方手编事实 |
| New runtime feature flag | NO | 回退入口/兼容构建及既有通道控制已足够 |
| New cross-package dependency | NO | 沿既有 core→host/CLI/Console 导入方向，不新增依赖边 |
| New host/platform-specific behavior | NO | 共享治理语义，认证入口复用现有 Console |
| New external/network capability | NO | 使用既有 Console 本地 API/模型 profile；无新外部服务 |

YES 的必要性：当前没有表达 rule 候选到正式原则之 Owner 决定的权威字段；用 reuseEvidence、activation_decisions 或 derivedFromPainIds 替代会改变原事实含义。新增 schema 和窄接口使下一次归属/撤回变化局部可测试；删除功能时可停止新入口和生成，保留历史只读字段，不需要删除治理数据。

## 12. MVP 与任务边界

- 不做的后果：当前合法验证规则仍不能形成正式可审阅归属，且错误补 UUID 会伪造 lineage。
- 可观察：Console 关联决定、Ledger revision、新 Scribe 工件 receipt、正常规则审批待办；各阶段独立报告。
- 可撤销：撤回关系并保留历史；运行停用是独立现有动作；不自动 live。
- 情绪价值：减少“测试通过却不知道为什么仍不能审阅”的不确定，Owner 明白自己只决定了归属，保有规则批准和生效控制。实施 UI 前读取私有 emotional-value 指南；本文不虚构已读取。

PRI-1043：按当前代码精确复验既有设计事实/声明真实性与边界；不新增 facts kind，不把本 SPEC 或关联决定写成设计已批准。PRI-1044：本方案批准、实现、隔离验收后，才对同一新工件进行 native 核验；不拿旧工件结果替代。PRI-1045：编译试点完全不包含。



PRI-1044 的 same-artifact native 验收逐项关联：同一新 artifactId、codeSHA、输入契约版本、binding decisionId/revision、approvalId、activationId 与 promotion digest，以及实际 native sessionId、toolCallId、Hook 实际加载路径、实际操作结果文件证据。字段必须从实际生产/宿主记录取得并交叉核对，不能手造或按时间邻近推定；缺任一项对应结论记 UNKNOWN。不得重建一条独立测试规则替代目标工件，不把 shell/离线 sandbox 结果写成 native 实测。执行前先核实目标新工件完整身份与授权；运行后报告同一工件关联链，不更换代码 SHA 掩盖失败。

## 13. 授权与交付顺序

1. Owner 已授权推进剩余工程；先确认本草案所述、尚未获得具体设计确认的 A+B 归属语义、认证入口与一次受控修订成本。确认后沿既有工程授权连续实现；等待的是新增设计语义确认，不是否认或重求常规工程推进授权。
2. 在专用 worktree 实现、隔离测试、独立代码/规范复核、完整风险/Complexity Delta、PR/CI。不得触碰主 checkout 无关脏文件。
3. 合并/发布/安装分别取得对应证据；不把源码合并称已更新安装 runtime。
4. 生产绑定哪一个候选到哪一个原则，由认证 Owner 单独作决定；未选择合适原则则保持未关联。既有主 prompt 原则 `ce2b7885-a9ea-4f6e-94da-b0e6c9b85110` 不因同 pain 自动成为目标。
5. 绑定请求的 resumeOnce:true 与已批准设计/现有恢复授权覆盖一次固定 profile 受控重跑，服务端自动幂等续接；无需 Owner 再单独点击启动。新 RuleCode 仍提交原审批，shadow/live 按既有门禁各自执行；受控重跑不包含规则批准或生产生效授权。

正式验收报告分别列：源码/测试、CI/合并、发布/安装、真实绑定、模型修订、规则批准、shadow/live、native 行为结果。任一未做写明 NOT RUN/UNKNOWN，不合并为“已完成闭环”。
