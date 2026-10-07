# PD 提示词容量与生效反馈修复 — Reality Audit（2026-10-07）

基线：origin/main `f330acb3b2cf771ba073032398257265545dfb75`（与 SPEC 快照一致，本地无漂移）。
任务 worktree：`adhoc-20261007-prompt-capacity-0b0891`（writer=zcode，READY 三级验证通过，零 PRIMARY 泄漏）。
SPEC 快照数字仅作测试设计参考；本文以当前代码为准（行号引用当前源码）。

## 1. 有效路由的真实决定机制

| 入口 | 路由 | 依据 |
| --- | --- | --- |
| OpenClaw（flag `abstraction_layer_v1` 默认 OFF） | flag OFF → plugin-local 列表路径（`trimToBudget` 计费 `- [id] text` 行，轮转键=会话 user_turn 序数）；flag ON → 共享路径 | `openclaw-plugin/src/index.ts:388-391`、`hooks/prompt.ts:668-676` |
| Codex | 恒为共享路径（无 flag 分支，无轮转键 → `legacy_fifo_prefix_v1`） | `codex-adapter/src/pd-hook.ts:263-271`、`host-runtime/src/index.ts:265-268` |
| Console 预测 | **仅按工作区 flag 选路，无宿主身份** → Codex 工作区（flag OFF）被错投影为列表路由 | `host-runtime/src/prompt-injection-projection.ts:125-127`（AC-01 缺陷实锤） |

宿主事实来源（现有权威，复用不新建）：
- `.pd/host-tool-semantics/<hostKind>.json` 自声明——OpenClaw（`internalization-auto-consumer-service.ts:66`）与 Codex（`codex-adapter/src/worker/workspace-worker.ts:274`）启动时各自写入；
- `trajectory.db pain_events.host_kind` 行为证据（`host-runtime/src/host-liveness-contract.ts:68-96` 已实现两源并集的先例 `resolvePromotionHostLiveness`）。

## 2. 成本与超长事实

- 预算常量 `RUNTIME_V2_PRINCIPLE_BUDGET = 2000`（UTF-16 `string.length`），两路由共用但**计费范围不同**：列表=选择行（不含包装/自报脚注）；共享=完整 directive 渲染（含包装与自报脚注，`active-principle-prompt.ts:171-185`）。
- 共享路径 `oversizedActivationIds` 非空且 `truncated=false` 的产生点：`active-principle-prompt.ts:191-194`（单条装不下→oversized，不置 truncated）。列表路径同构：`prompt-activation-reader-contract.ts:196-200,220-223`。
- 消费缺口：Console 两个模型均未消费 `oversizedActivationIds`/`droppedActivationIds`；激活列表页无任何容量状态；诊断 ID 上限 16（`MAX_INJECTION_DIAGNOSTIC_IDS`/`MAX_SHARED_DIAGNOSTIC_IDS`），缺失 ID ≠ 正常。
- pending 候选预检 `candidateFitsPromptBudget`（`ApprovalsGroupedConsoleModel.ts:159-187`）：固定 36 字符 UUID 当作 id 最坏值——**错误**：真实 id 可为 title 派生（`resolvePrincipleFromArtifact` 已返回真实 `principleId`），且只按列表行计费，共享路由下失真。R-A2 修正：用真实解析身份 + 路由对应 serializer。

## 3. 写入者与事务能力

live prompt 激活唯一物理写点：`activation-dispatcher.ts:446 recordActivation` → `sqlite-activation-state-store.ts:73-106`（INSERT OR REPLACE on `idempotency_key = artifactId::channel`，应用层 FK 检查，独立 BEGIN IMMEDIATE）。

生产 approve→activate 编排入口（全部经 `ApprovalCompletionService`）：Console `ApprovalsConsoleModel.approve`（:128-218，失败回滚 approval→pending）、CLI `handleActivationApprove`（runtime-activation.ts:1291-1550，同样回滚）。dispatch 命令与 auto-consumer 自 PRI-811 起仅入队审批。demo/dogfood/baseline 为开发面。

替换能力现状：**prompt 通道无替换流**（新工件=新 idempotency key → 双活双注入）；code_tool_hook 有事务内 supersede 先例（`sqlite-activation-safety-store.ts:339-420`，含 append-only `activation_decisions` 行 + 停用旧激活，单事务）。事务原语：`db.exec('BEGIN IMMEDIATE')` 与 `db.transaction()` 均在用；无通用事务包装 API。

审批编辑（Story A）：pending 审批可换工件指针（`approvals.edit`，lineage 由 `isArtifactRevisionOf` 校验：same taskId ∨ lineage 含原工件 ∨ 同非空 sourcePrincipleId）——只重指向，不处理已 live 激活。`pi_artifacts` 唯一键 `(source_task_id, artifact_kind)` → 新版本工件必须新 taskId，upsert 同键会覆盖旧工件（B2 防覆盖要点）。工件验证翻转=internalization 管线 `updateValidationStatus('validated')`；内容合同= `DefaultScribeValidator`（B2 复用，不绕过）。

## 4. 最小缺口结论（Connection Before Creation）

1. 路由事实解析器缺失 → 新增 host-runtime `resolveEffectiveInjectionRoute`（复用声明+pain_events 两源并集先例）；投影/预检/状态页共用。
2. 共享结果合同已有 `oversized/dropped` 字段但投影与 Console 未透传 → 扩展现有 `PromptInjectionProjection`/`PromptInjectionBudgetStatus`（派生字段，兼容增量）。
3. pending 预检的 UUID 假设与单一路由计费 → 改真实身份 + 路由化成本。
4. 写入前预检门不存在（现状=激活后警告） → host-runtime `checkPromptActivationDeliverability` 单一实现，Console/CLI 两入口在治理写入前调用（R-B2 表）。
5. prompt 替换缺失 → dispatcher 增 `supersedeActivationId` 通道 + state store 单事务 `replacePromptActivation`（复用 dispatcher 全部身份/幂等/审批校验，不旁路）；Console 增 propose-revision 修改入口（新工件→复用验证→入队审批→既有 approve 触发替换）。
6. 测量入口缺失 → 复用注入事件（`runtime_v2_prompt_activations_injected` + `principle_applications`）+ 真实 hook 路径的脚本化对照。

## 5. 保护测试现状

`host-runtime/tests/prompt-injection-projection.test.ts`、`active-principle-prompt-fair-rotation.test.ts`；console `governance-approve-activation.test.ts`（含 PRI-890/PR-1894 文案契约）、`approvals-nextaction.test.ts`；cli 两个 flag-wiring 测试；core dispatcher/reader-contract 测试。改动后须保持可观察期望（fixture 将显式声明宿主——显式化输入而非降低期望）。

## 6. Error Context Pass 1

命中 EP-01/EP-02/EP-04（HIGH）：失败必带结构化 reason+nextAction（rc-9）；生产入口集成证据而非孤立 helper 测试；CLI 真实 parser 测试（cli-7）、--json 单一结果（cli-1）、失败不 mutate（cli-5）。已纳入各阶段验收。

## 7. 未确认事项（实现中核验）

- `.feature` 契约：`openclaw-shared-host-runtime-parity.feature`、`codex-owner-loop.feature`（改投影前读）。
- demo-story-a-runner / proven-channel-baseline 是否需要宿主声明种子（预检门波及面）。
- 真实工作区声明覆盖率（生产影响评估；pain_events 兜底）。
