# Governance Runtime Map — PD 治理通道与原则生命周期代码审计

> Date: 2026-08-23
> Audit base: commit `868662fb` (origin/main)
> Scope: `packages/principles-core` · `packages/openclaw-plugin` · `packages/host-runtime` · `packages/codex-adapter` · `packages/pd-cli` · `packages/pd-console`
> Method: **只读真实生产代码取证,不从文档反推**。所有引用已在审计基线 commit 上抽查复核。
> Reference style: 以 **文件路径 + 符号名** 为耐久锚点(如 `handleBeforeToolCall`);不绑定行号——代码重构后按符号检索重新核对,而非信任行号快照。
> Purpose: 为 GEO 第二阶段("PD 不是 Prompt 系统,而是 Agent Governance Runtime")提供代码事实底座。对外文案只能引用本文确认过的事实。

---

## 0. TL;DR

1. PD 影响 Agent 行为的**运行时通道**有三条:`prompt`(上下文注入,软治理)、`code_tool_hook`/RuleHost(工具调用拦截,**可 block/可改写参数**,硬治理)、Codex 宿主钩子(transcript 注入 + PreToolUse deny)。`defer_archive` 是台账通道,无运行时行为。
2. **硬治理是真实存在的**:live 规则可以通过 `before_tool_call` 钩子返回 `{ block: true }`(OpenClaw)或 `permissionDecision: 'deny'`(Codex)阻止工具执行,也可以 `auto_correct` 改写工具参数。但硬治理**默认 shadow 起步**,必须 Owner 显式 promote 才 live;且所有通道**fail-open**(PD 自身故障绝不阻塞宿主)。
3. 原则生命周期闭环(证据 → 诊断 → 提案 → 审批 → 激活 → 运行时应用 → 后续观察 → 可回滚)**每一步都有生产代码入口**,不是文档构想。
4. 因此对外可以说 "PD applies governance through multiple channels, including runtime tool-call enforcement" —— 但不可以说 "PD automatically blocks anything"(block 需要 Owner promote 到 live 的规则显式决定)。

---

## Q1: PD 如何影响 Agent 行为?(通道分类)

### 通道 1 — Prompt Channel(上下文注入)| 软治理

把 Owner 已激活的原则渲染成指令块,注入宿主系统提示词。

| 环节 | 代码位置 |
|---|---|
| 钩子入口(OpenClaw `before_prompt_build`) | `packages/openclaw-plugin/src/index.ts` → `packages/openclaw-plugin/src/hooks/prompt.ts`(`handleBeforePromptBuild`) |
| 读取激活原则(V2,`activations` 表 `channel='prompt'` 且未停用) | `packages/openclaw-plugin/src/core/runtime-v2-prompt-activation-reader.ts`;查询契约 `packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts` |
| 原则 → 指令文本(`<directive id=…>` / `MANDATORY: …`) | `packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts`(`renderPrinciplesToDirectives`) |
| 注入点(写入 `prependSystemContext`,置于最前以获最高注意力) | `packages/openclaw-plugin/src/hooks/prompt.ts`(`prependSystemContext += directiveText`;返回 `{ prependSystemContext, prependContext, appendSystemContext }`) |
| 预算与去重(V2 预算 2000 字符;跨块去重压制遥测) | `prompt-activation-reader-contract.ts`(`trimToBudget`);`prompt.ts`(跨块压制) |
| 共享 host-runtime 路径(`abstraction_layer_v1`,默认关) | `packages/host-runtime/src/active-principle-prompt.ts` |

分类:**Prompt Channel / Soft Governance**。只影响认知,不能阻止任何动作;所有错误路径 fail-open。

### 通道 2 — Runtime Hook Channel(`code_tool_hook` / RuleHost)| 硬治理

加载激活的规则代码,在工具调用发生时执行并合并决策:block(阻止)/ requireApproval(转审批)/ auto_correct(改写参数)。

| 环节 | 代码位置 |
|---|---|
| 拦截入口(OpenClaw `before_tool_call`,仅 write/bash/agent 类工具) | `packages/openclaw-plugin/src/hooks/gate.ts`(`handleBeforeToolCall`) |
| **block 返回宿主级执行阻止** | `packages/openclaw-plugin/src/hooks/gate-block-helper.ts`(`return { block: true, blockReason }`) |
| auto_correct 改写工具参数(宿主只合并 `params`) | `gate.ts` |
| 规则加载(SQL:`activations WHERE channel='code_tool_hook' AND deactivated_at IS NULL`) | `packages/openclaw-plugin/src/core/rule-host.ts` |
| shadow(只观察)vs live(可执行)两态 | `rule-host.ts`(shadow 注释:观察模式,**不会 block / 不会 requireApproval**) |
| 决策合并(任一规则 block 即短路) | `packages/principles-core/src/runtime-v2/internalization/rule-host-evaluator.ts` |
| 规则沙箱执行(`node:vm`,超时约束) | `packages/openclaw-plugin/src/core/rule-implementation-runtime.ts` |
| 共享生产门(`abstraction_layer_v1`,默认关;deny 决策) | `packages/host-runtime/src/production-rulehost-gate.ts`(deny 决策分支);deny→block 映射 `packages/openclaw-plugin/src/host-runtime/openclaw-host-runtime.ts` |
| shadow → live 只能由 Owner promote | `packages/principles-core/src/runtime-v2/activation/writers/rule-host-writer.ts`(writer 只写 shadow;live 由 `pd activation promote` 原子改写) |

分类:**Tool Enforcement Channel / Hard Governance**——但仅对 **live** 激活生效;shadow 激活是观察性的软通道。

### 通道 3 — Codex Host Channel | 软 + 硬(同一条管道)

| 环节 | 代码位置 |
|---|---|
| 钩子进程入口(Codex 每事件 spawn `pd-hook.js`;flag `host.codex` 关则 `{}`+exit 0) | `packages/codex-adapter/src/pd-hook.ts` |
| **软**:transcript 注入(`UserPromptSubmit.additionalContext`) | `packages/codex-adapter/src/codec/output-encoder.ts`;内容来自同一 `buildActivePrinciplePromptContext`;生产验证 `tests/pd-hook.production.test.ts` |
| **硬**:PreToolUse deny(阻止执行) | `output-encoder.ts`(`permissionDecision: 'deny'`,仅 `before_tool_call` 允许) |
| 安装器挂钩(matcher `Bash\|apply_patch`;`additionalContextLimit: 10000`) | `packages/create-principles-disciple/src/installers/codex-host-installer.ts` |

### 通道 4 — `defer_archive`(台账)| 无运行时行为

- Writer 只写一条激活台账:`action: 'defer_archive'`, `targetRef: 'ledger://<principleId>#archived'`(`packages/principles-core/src/runtime-v2/activation/low-risk-writers.ts`)。
- 没有任何运行时 reader 消费它(prompt reader 只查 `channel='prompt'`,RuleHost 只查 `channel='code_tool_hook'`)。
- 它属于低风险通道(`LOW_RISK_CHANNELS`,`activation-types.ts`),可不经审批自动激活(`activation-dispatcher.ts`)。

### 其他影响面(静态/观察性)

| 机制 | 性质 | 代码位置 |
|---|---|---|
| 工作区模板物化(AGENTS.md/PRINCIPLES.md 等,仅缺失时拷贝,永不覆盖) | 软·静态 | `packages/openclaw-plugin/src/core/init.ts` |
| Skills 物化(pd-cli-operator 等 5 个技能模板) | 软·静态 | `packages/openclaw-plugin/templates/langs/{en,zh}/skills/` |
| after_tool_call 痛点证据观察(**observe-only**,不允许决策) | 观察性 | `packages/host-runtime/src/index.ts`;`production-pain-evidence.ts` |
| Principle Receipts(原则回执台账/自报)| 默认关 | flags `principle_receipt_*`(`feature-flag-contract.ts`) |

---

## Q2: Soft vs Hard Governance 分界

**Soft(认知影响)**:prompt 指令注入、Codex transcript 注入、工作区模板/skills 物化。Agent"读到"原则,但没有任何动作被强制。
**Hard(执行影响)**:live RuleCode 规则在工具调用点返回 block / deny / 改写 params。Agent的动作可以被阻止或修正。

三条设计事实(对外表述必须遵守):

1. **Shadow-first**:硬治理通道激活时先进入 shadow(观察模式),只有 Owner 通过 `pd activation promote` 显式提升才 live(`rule-host-writer.ts`;`rulecode_owner_live_decision` core flag)。
2. **Fail-open by design**:RuleHost "never throw"(`rule-host.ts`);生产门所有降级路径返回 allow(`production-rulehost-gate.ts`);Codex 钩子任何失败输出 `{}`+exit 0(`pd-hook.ts`)。PD 自身故障不会拖垮宿主。
3. **高风险通道强制审批**:`code_tool_hook` 不在低风险通道表内,激活必须过 Owner 审批队列(`activation-dispatcher.ts`)。

---

## Q3: 原则生命周期(每步对应生产代码)

```
Behavior Evidence → Reflection → Principle Proposal → Owner Approval
→ Activation → Runtime Application → Future Observation
(+ Rollback,任何激活可逆)
```

| 阶段 | 生产入口(file:line) | 包 | 持久化 |
|---|---|---|---|
| 1. 行为证据(Pain) | CLI `pd pain record`(`pd-cli/src/commands/pain-record.ts`);宿主自动观察(`openclaw-plugin/src/hooks/pain.ts`);Owner 手动 pain(`pain.ts`) | cli / plugin | `trajectory.db` `pain_events`;失败兜底 `dead_letter_pains`(`pd pain retry` 可重放) |
| 2. 反思/诊断(LLM) | 分诊管线 `diag_rootcause → diag_distiller → diag_router`(`principles-core/src/runtime-v2/internalization/internalization-job-graph.ts`);手动 `pd diagnose run`(`pd-cli/src/commands/diagnose.ts`) | core | `state.db` tasks/runs |
| 3. 原则提案 | 内化链 `dreamer → philosopher → scribe → …`(`internalization-job-graph.ts`);philosopher 产出 `principleCandidate`(`internalization/philosopher-runner.ts`);goldenTrace 由真实失败轨迹构建(`activation/golden-trace-candidate-builder.ts`) | core | `principle_candidates` 表;台账 `principle_training_state.json` |
| 4. Owner 审批 | Console API `POST /api/v1/approvals/:id/approve|reject|edit`(`pd-console/src/server/routes/approvals.ts`);CLI `pd activation approve`(`pd-cli/src/commands/runtime-activation.ts`) | console / cli | `approvals` 表(`ApprovalQueue`) |
| 5. 激活 | `ActivationDispatcher.dispatch`(`activation/activation-dispatcher.ts`);低风险通道可自动,code_tool_hook 必经 `needsApproval` 分支入审批队列 | core | `activations` 表;prompt 写 `prompt_activate`,rule 写 `code_tool_hook_shadow_activate` |
| 6. 运行时应用 | prompt:`prompt.ts`;rule:`gate.ts` → `rule-host.ts`;Codex:`pd-hook.ts` | plugin / codex | 见 Q1 各通道 |
| 7. 后续观察 | `pd trace show --pain-id` 全链追溯(`pain-chain-read-model.ts`;`pd-cli/src/commands/trace.ts`);Principle Receipts 台账(默认关,`principle_receipt_*` flags);pruning 观察(`runtime-pruning.ts`) | core / cli | `principle_applications` 表(flag on 时) |
| 8. 回滚(可逆性) | `pd activation deactivate`(幂等,`runtime-activation.ts`;`sqlite-activation-state-store.ts`);审批回退 `ApprovalQueue.resetToPending`;RuleCode 全局暂停表 `global_rulecode_pauses` + 安全断路器 | cli / core | `activations.deactivated_at` |

全链参考实现:`pd demo story-a`(`pd-cli/src/services/demo-story-a-runner.ts`)。

---

## Feature Flag 状态(审计基线)

- **Core / 默认开**:`prompt`、`code_tool_hook`、`defer_archive`、`rulecode_safety_controls`、`rulecode_owner_live_decision`、`host.codex`、`internalization_full_chain`、`internalization_auto_consumer`、`diagnostician_split_pipeline`、`story_a_approval_completion`、`feedback_channel`(`packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts` 等)。
- **Quiet / 默认关**(不得对外宣传为现有能力):`principle_receipt_block_copy` / `principle_receipt_ledger` / `principle_receipt_self_report` / `principle_governance_projection_v2`(见 `feature-flag-contract.ts` Quiet 清单)、`abstraction_layer_v1`(共享生产门路由)、`rulecode_context_v2`、`intent_engineering`、`gfi` 等。

---

## 对外文案的事实边界(GEO 使用)

✅ **可以说**(有代码事实支撑):

- PD 通过多个治理通道影响 Agent:提示词指令注入是其中之一。
- Active principles 可以参与执行决策:live 规则可以在工具调用点 block、要求审批、或改写参数(OpenClaw 与 Codex 均有硬通道)。
- 系统会**无人值守地起草**候选原则与候选规则实现(`internalization_full_chain` core 默认开,审批队列自动填充)。
- 每条原则经 Owner 审批、可回滚、效果可观察(`pd trace`)。
- 硬治理 shadow 起步,Owner 显式 promote 才 live;PD 全通道 fail-open。

❌ **不能说**:

- PD 修改模型权重 / 训练模型。
- PD 自动阻止一切不良行为(block 需要 Owner 提升的 live 规则显式决定)。
- PD 自动生成**即生效**的规则 / 把 PD 定位为规则生成器(候选是惰性草稿:规则通道必经审批队列 `activation-dispatcher.ts`,且不在可自动提升通道表 `activation-types.ts`;shadow→live 仅能 `promoteActivation`)。"不自动生效"与"不自动生成"是两个概念——前者成立,后者不成立(系统确实自动起草)。
- PD 自主学习、自主做价值决定(审批权威在 Owner)。
- PD 是 Prompt 生成器或 Memory 系统(见 `docs/concepts/governance-runtime.md` 与 `pd-comparisons.md`)。
- Principle Receipts 等默认关闭的 quiet 能力(未开 flag 前不得作为现状宣传)。
