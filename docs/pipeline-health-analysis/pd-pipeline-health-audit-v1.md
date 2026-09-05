# PD Pipeline Health Audit v1.0

> 审计日期：2026-09-05 ｜ 审计人：AI（首席架构师 + 产品负责人 + 系统验证工程师角色，受 Owner 委托）
> 性质：**只读审计**——未修改任何生产代码、未创建 PR、未做任何治理决策；实验全部在一次性隔离 workspace（`D:\pd-audit-v1\*`）中进行，live 数据仅做只读取证。
> 方法：代码调用链重绘（非文档）+ live 安装只读 SQL 取证 + 三个主动实验（冷启动 / 学习效果 / 故障恢复）+ 既有一线实验证据（PRI-653 lab 两轮报告）复核。
> 环境基线：源码 `origin/main@13401a6de`（PR #1515 合并）；安装已按 Owner 指令于审计开始前更新至 npm 最新 `principles-disciple@1.230.0` / `create-principles-disciple@1.132.2`（经 console `/apply-full` 通道，见 §1.2 更新事故记录）。

---

## Executive Summary

**一句话结论：PD 已经是一个"管道机制真实可跑、治理面完整、但在'最后一公里'（激活 → 行为改变）从未兑现，且分发给新用户的入口当前是坏的"的系统。最终裁定：PARTIAL。**

支撑这个结论的四组核心事实（全部有证据，详见各节）：

1. **分发层当前断裂（P0）**：正式的自包含平台资产通道无货——npm 安装包不含 `_release/` 平台资产、GitHub Release v1.228.x–v1.230.0 全部零资产、tarball 缺 `codex-adapter` 组件。**今天一个新用户执行 `npx create-principles-disciple` 会直接失败**（`self_contained_asset_identity_invalid`），legacy 通道也会因缺失捆绑组件失败。唯一可用更新通道是已安装用户的 console `/apply-full`，而它对 canonical 布局存在"console 自身占用被更新目录"的自锁缺陷 + `/apply` 路径守卫矛盾。
2. **生产安装（旗舰实例）上的自动 Pain 检测产出为零**：196 个会话、1237 次工具调用，`pain_events` 共 10 条且 **100% source=manual**——全部来自 Owner 手动 `/pd-pain`。共享 host-runtime 检测路径被 `abstraction_layer_v1=false` 关闭，旧路径零产出。"Agent 真实行为 → 自动 Pain"这一产品前提**在生产上没有成立**。
3. **管道本体（收到 pain 之后）真实且质量在快速收敛**：PRI-653 lab 两轮（09-04/09-05）+ 本审计冷启动实验（发货版 1.230.0、真实 LLM）均证明 pain→diagnosis→principle/rule→对抗验证→修复循环→Owner 决策面全链可跑、失败可观测、无低质产物被放行；#1512 的三项修复（PRI-667/668/670）经双腿对照实证有效。
4. **"错误 → 未来行为改变"从未被证明**：lab 两轮 0 次 activation（分别卡在 PRI-667 数据路径 bug 和 PRI-683 pi-ai ~300s 内层帽）；生产安装历史仅 1 次 prompt 通道激活（09-01），有 83 次注入回执（含 3 次 Agent **自报告**行为改变）但无外部验证的行为差异度量；rule（code_tool_hook）通道在生产上 **0 次激活、0 次 gate_blocks**，且本审计实证其**双重结构性不可达**：宿主声明 writer 未接线（evaluator CLI 门必拒）+ 121 工件 0 rule（规则生成面从未开火）。

配套发现：live 安装 17/19 evaluator 任务以 `input_invalid` 失败（PRI-667 指纹，1.229.0 未含修复）；一次 LLM 抖动即造成链路永久损失且 CLI 无重入口（PRI-674 在发货版原样复现）；版本可观测性分裂（`pd --version` 报 1.76.1/全零 commit，实际 1.230.0）；Owner 收件箱不列出已达 needs_human_review 的任务（PRI-629 族断层在 1.230.0 复现）。完整新发现清单见 §4.4 表（N-1～N-7）。

---

## 1. Current Reality Snapshot

### 1.1 演进时间线（Phase 0）

近两周 PR 合并序列（`git log origin/main --merges`）与关键问题-根因-修复-验证链：

| 阶段 | 时间 | 问题 | 根因 | 修复 | 验证状态 |
|---|---|---|---|---|---|
| PRI-634 PR A（#1484，09-02） | 修复轮重放闭环 | 评估器无法引用 Evaluator 重放证据 | validator 收敛不足 | validator 收敛 + 按引用读重放证据 + prompt v3 | CI + 真实门 FAIL→Repair→PASS 回归 |
| PRI-634 B/C（#1486，09-03） | 管道闭合夹具 | 缺可复用场景资产 | 无 lab 夹具 | pipeline-closure-lab（4 场景 + GROUND_TRUTH/FORENSICS） | 夹具在 634C/653 三轮复用 |
| PRI-634-F（#1492，09-04 08:09） | 对抗重放/RuleCode 可靠性 | LLM 生成 RuleCode 语义漂移 | 生成质量 + 门禁语义 | adversarial replay runtime-owned 剥离等 | PR #1495 评审四 blocker 全修；lab 实证对抗门真实拦截 |
| PRI-672（#1511，09-05） | Release Manager 采纳 | 分发无权威面 | npm 直发无事务/回滚 | authority 面 + 第七分发组件 + flag 门控 | 本审计实证：**资产通道无货，见 §6.4** |
| PRI-655（#1514，09-05 08:29） | 消费循环调度韧性 | 单周期 rejected 即死循环 | 循环缺 catch | 双站点 catch + 链存活测试 | CI 级验证（Level D）；**未进 npm 1.230.0**（发布于 08:29 前 01:00） |
| PRI-653 lab R1（#1504，09-05 00:56） | 进化实验室首跑 | 无一线实验能力 | — | lab 双层架构（夹具/取证） | 9 轮真实会话 + 全链实录；0 activation |
| PRI-653 lab R2（#1512+#1515，09-05 11:27） | 双腿回归 | PRI-667/668/670 | 见下行 | #1512 三修复 | **全部实证有效**；新断点 PRI-674/675/683 |

lab 两轮定位的活跃断点（截至本审计仍开）：

| 断点 | 层 | 一句话 | 影响 |
|---|---|---|---|
| PRI-667（已修，#1512） | validation | progressive_evaluator 下 evaluator stage2 读不到 diagnostician 证据 | live 09-03/09-04 的 17 条 evaluator `input_invalid` 失败同指纹 |
| PRI-668（已修，#1512） | validation | forbidden-pattern 把字符串字面量误判为 global 访问 | 修复轮永不收敛 |
| PRI-670（已修，#1512） | runtime | profile `timeoutMs` 未接通，300s 硬顶 | artificer/evaluator/诊断必死 |
| **PRI-683（P1，开）** | runtime/基础设施 | pi-ai 请求层 ~300s 内层帽（大 payload 恒死，profile timeout 不覆盖） | **activation 通路当前唯一堵点**（修复轮 16/16 全灭） |
| **PRI-674（P1，开）** | 治理/恢复面 | failed 诊断家族无 CLI 重入口；恢复顺序错误 | 一次 LLM 抖动 = 一条链永久损失（本审计发货版复现，§4.3） |
| PRI-675（P2，开） | 输出契约 | prompt 通道 dreamer 校验稳定失败 | prompt 链不稳 |

### 1.2 安装状态与"代码新、安装旧"核对（本审计的前置动作）

按 Owner 指令，审计开始前将本机安装从 **1.229.0 更新到 1.230.0**（npm 最新）。更新过程本身成为第一批审计证据——三条链路两种失败一种成功：

| 通道 | 结果 | 失败点（Problem/Evidence） |
|---|---|---|
| `npx create-principles-disciple@1.132.2`（正式自包含通道） | **失败** | `self_contained_asset_identity_invalid`：npm 包内无 `_release/asset.json` 平台资产；GitHub Release v1.230.0/v1.229.0/v1.228.3 **全部 0 资产** |
| 同上 + `PD_ALLOW_LEGACY_NPM_INSTALL=1`（legacy 恢复通道） | **失败** | ① npx 缓存中 pd-cli 解析不到 `@principles/core`（file: 依赖未物化）→ `compatibility_scan_failed`；② 从解压树重试：tarball **不含 `codex-adapter/`**，运行时依赖解析硬失败（备份/回滚正确执行） |
| console `/apply-full`（已装用户通道） | **成功**（1.229.0→1.230.0） | 但需绕过两个缺陷：`/apply` 的 targetDir 守卫与 canonical 布局矛盾（必拒）；`/apply-full` 在 console 自身运行于被更新树时 EPERM 自锁（真实错误信息被 `file_locked` 泛化吞掉）。本审计从仓库源码树启动 console 才完成更新 |

**版本口径分裂（P1 可观测性缺陷）**：更新后 `pd --version` 仍报 `Principles Disciple 1.76.1 (000000000000)`；扩展目录 package.json=1.76.1、openclaw.plugin.json=1.198.1、canonical `~/.pd/runtime` plugin=1.230.0 / core=1.277.2 / pd-cli=1.147.5。**操作者没有任何一个可信的单一版本权威**。`update-history.json` 记录了 09-02 失败、09-03→1.227.0、09-04→1.229.0、本审计 3 次失败 + 1 次成功（1.230.0）。

其它安装事实：OpenClaw 本体 2026.9.1（比 lab R2 又新）；Codex 主机标记缺失（`~/.pd/codex/` 无 hooks）——codex-adapter 作为分发组件存在但本机未装；源码 HEAD（1d911a98e）落后 origin/main（13401a6de）5 个 PR；主 checkout 工作树有并发会话污染（UU 冲突文件 + package.json 被砸，未修复、未触碰，按 git-4 纪律保留原状）。

### 1.3 Runtime 状态快照（live 只读取证，2026-09-05 12:00 前后）

`D:\.openclaw\workspace`（生产 workspace）：

- **state.db**：152 tasks（dreamer 18✓/philosopher 19✓/scribe 20✓/artificer 28✓+1✗/diagnostician 家族 9-10✓ 各 1✗；**evaluator 17 failed vs 2 succeeded**；rollout_reviewer 2✓+2 needs_human_review+1 pending）；121 pi_artifacts、31 candidates、193 runs、**approvals=0 行、activations=1 行**、86 receipts、dead_letter=0、pain_diagnoses=0（flag 默认 OFF）。
- **evaluator 失败详情**：17 条全部 `input_invalid`、attempt_count=1（fail-fast 终态），最近两条为 09-05 03:36/03:38Z（1.229.0 时代，PRI-667 指纹）。
- **needs_human_review**：2 条 rollout_reviewer 自 09-01 挂起（Owner 决策积压）+1 条 pending。
- **trajectory.db**：196 sessions、1237 tool_calls、**pain_events=10 且全部 manual**、gate_blocks=0、task_outcomes=0、principle_events=117。
- **唯一 activation**：`act_prompt_Model-Evidence-Reversibility-Verification Loop`（prompt 通道，09-01 激活，未停用）；对应 receipt：83×prompt_injected + 3×self_reported，最新注入 09-05 01:49Z——**注入面持续工作**。
- **有效 flags**（user_config 源）：full_chain ✓、auto_consumer ✓、progressive_evaluator ✓、repair_loop ✓、rulecode_context_v2 ✓、**abstraction_layer_v1 ✗**（共享 host-runtime 检测路径关闭）、release_manager_shadow ✗。
- 网关 OpenClaw 2026.9.1 运行中；state.db 有活跃写入（12:01 WAL）。

**PD Current Reality Snapshot 结论**：生产实例上，管道"中段"大量运转（152 任务、121 工件），但（a）入口靠人工，（b）evaluator 曾是坟场（修复已在 1.230.0 就位但存量失败任务无重入口），（c）出口几乎关闭（1 激活 / 121 工件 ≈ 0.8%），（d）rule 执行面从未工作过（gate_blocks=0）。

---

## 2. Pipeline Architecture（代码调用链重绘）

真实数据流（文件级证据，全部来自当前代码而非文档）：

```
真实 Agent 行为（OpenClaw hook）
  ├─ after_tool_call（openclaw-plugin/src/index.ts:501，10s 超时 fail-open）
  │    ├─ [共享路径] host-runtime/production-pain-evidence.ts:308 → trajectory.db pain_events
  │    │    （ gated by abstraction_layer_v1 — live 上关闭 ）
  │    └─ [旧路径] openclaw-plugin/src/hooks/pain.ts:316 → classify→record→triage→gate
  │         └─ 失败 → dead_letter_pains（可 pd pain retry 重放）
  ├─ /pd-pain 手动（commands/pain.ts:301）→ ingressDecisionForPluginPain → recordPain
  └─ CLI：pd pain record（--session 必须命中 trajectory.db sessions 表）
        ↓
Pain Admission（core/runtime-v2/evidence-triage/triage-policy.ts:134）
  risky+score≥70 / 连错≥4 / rulehost_block+unsafe → admit
        ↓
PainSignalBridge.submitPainSignal（pain-signal-bridge.ts:408）
  → tasks 表建 diagnostician 任务（diagnostic_json 携 provenance+evidence≤8 条）
        ↓
Diagnostician = split 3-stage（rootcause→distiller→router，各 600s，总帽 1h）
        ↓ onDiagnosisComplete:706 → evaluateCandidateAdmissions → CandidateIntakeService
        → 每 admitted candidate 播种 dreamer 任务（dreamer-<candidateId>-<channel>）
        ↓
Dreamer → Philosopher → Scribe → Artificer（BasePeerRunner 生命周期：
  lease → LLM（pi-ai 适配器）→ validateOutput → succeedTask（持久化 pi_artifacts））
  Artificer 产出 ArtificerRuleOutput（implementationCode+goldenTrace+evidenceRefs）
        ↓
Evaluator（evaluator-runner.ts，2915 行）：approve|needs_revision|reject
  + 对抗重放（production-gate-deps.ts:133：静态检查→node:vm 编译 1s→沙箱重放；
    缺 gateDeps 的 code 工件=显式任务失败）
  + needs_revision → 修复循环（artificer-repair-<evalTaskId>-r<N>，flag 默认 ON）
        ↓
RolloutReviewer（rollout-reviewer-runner.ts:153）
  approve_rollout → ActivationDispatcher（低风险通道自动激活；code_tool_hook 高风险
  → approvals 队列）；needs_revision → reopen scribe/artificer；预算耗尽 →
  needs_human_review（持久化+读回验证）
        ↓
Owner Approval（console /api/v1/approvals → ApprovalCompletionService →
  dispatcher 独立复核 approval 记录后才激活）
        ↓
Activation（activation-dispatcher.ts:167，幂等键 artifactId::channel；
  RuleHostWriter 阴影优先 code_tool_hook_shadow_activate + activation_control_states）
        ↓
RuleHost / 注入（未来会话）
  ├─ prompt 通道：host-runtime/active-principle-prompt.ts:31（只读 state.db →
  │  12 条 L1 硬帽预算内渲染）+ alignInjectedPrinciples（receipts）
  └─ code_tool_hook 通道：production-rulehost-gate.ts:115（before_tool_call 每次：
     activations⋈pi_artifacts，MAX_ACTIVE_RULES=32，vm 批量 2.5s 帽，kill switch）
```

**生产调度**：网关加载插件时启动 `InternalizationAutoConsumerService`（30s 首延迟 + 120s 周期）→ `runInternalizationConsumerCycle`（host-runtime/internalization-consumer-cycle.ts:224）：flag 门 → 快照 → wakeOnce per runner → run（lease 在 run 内获取，多调度器收敛于 lease_conflict）→ finally 恢复清扫 + 5 条/周期 reconciliation。CLI `run-once` 是同一执行器的单发形态。

### Pipeline Health Matrix

| Stage | Purpose | Input | Output | Storage | Authority | Failure Mode | Verification Evidence | Risk |
|---|---|---|---|---|---|---|---|---|
| Pain 检测（自动） | 从工具调用识别失败 | tool call 结果 | pain_events 行 | trajectory.db（4 写者，canonical_pain_id 去重） | 内容派生 id（production-pain-evidence.ts:161） | hook fail-open 10s；**live 零产出** | live：0/10 自动；lab：真实会话可捕 | **H（生产未成立）** |
| Pain 录入（手动/CLI） | Owner 纠正入口 | 纠正文本+session | 同上+diagnostician 任务 | trajectory.db+state.db | PainToPrincipleService（唯一写侧编排） | unbound→admission 拒绝 | live 10/10；lab+本审计 expA 均 PASS | L |
| Admission/Triage | 证据门槛 | evidence≥1 真实条目 | admit/refuse | —（决策事件） | triage-policy（纯函数） | 拒绝可观测 | lab：implementation 候选正确 MVP-disabled | L |
| Diagnostician | 根因 | evidence+provenance | 诊断工件+candidates | tasks/artifacts/principle_candidates | PainSignalBridge | max_attempts→failed，**无 CLI 重入口（PRI-674）** | lab+expA 全通（476s/630s） | M |
| Dreamer→Scribe | 原则/规则生成 | candidate+behavior 证据包 | pi_artifacts（principle/rule） | state.db pi_artifacts（唯一 RuleCode 源，PRI-436） | 各 runner | 校验失败→retry→failed | lab R2+expA 全通；PRI-675 prompt 链不稳 | M |
| Artificer(RuleCode) | 可执行规则 | scribe 工件+example pack | rule 工件+goldenTrace | pi_artifacts | artificer-runner | **PRI-683 修复轮 300s 帽** | lab R2：初版过、修复轮 16/16 死 | **H（激活堵点）** |
| Evaluator+对抗重放 | 语义+执行验证 | rule 工件 | verdict+重放证据 | runs+telemetry | evaluator-runner（gateDeps 必需） | needs_revision→修复循环；PRI-667 曾死（已修） | lab R2 双腿实证；live 17 失败=修复前版本 | M |
| RolloutReviewer | 终审 | evaluator 装配工件 | verdict/决策点 | tasks+approvals | rollout-reviewer-runner | 预算耗尽→needs_human_review | lab 两轮 Owner 决策面走通 | L |
| Owner Approval | 人的权威 | approval 行 | decision | approvals（+edit 审计列） | ApprovalCompletionService | **live approvals 恒空（链死在上游）** | live 09-01 有 1 次完整批准 | M |
| Activation | 可逆上线 | approval+工件 | activations 行+通道写入 | activations+control_states+decisions（append-only 触发器保护） | ActivationDispatcher（幂等键） | 阴影优先；kill switch | live 1 次（prompt）；lab 0 次 | M |
| RuleHost/注入 | 改变未来行为 | activations⋈artifacts | 注入文本/拦截 | principle_applications（90 天保留） | active-principle-prompt / production-rulehost-gate | 预算截断；32 规则帽 | live 83 receipts（prompt）；**rule 通道 0 次执行** | **H（价值未兑现）** |

---

## 3. Data Lineage Analysis

### 3.1 血缘链（字段级）

`canonical_pain_id`（内容派生 sha256）→ `tasks.input_ref=painId` + `diagnostic_json{sourcePainId, provenance, evidence≤8}` → `principle_candidates{artifact_id, task_id}`（FK）→ dreamer 任务（candidateId + **可选** sourcePainId）→ `pi_artifacts{source_task_id, source_principle_id?, source_rule_id?, lineage_artifact_ids[], content_json.goldenTrace{sourcePainId?, sourceCandidateId?, cases[].sourceRefs}}` → `activations{artifact_id, idempotency_key}` → 注入/执行 → `principle_applications{principle_id, activation_id, rule_id}`。

血缘校验存在且真实：mainline-contract（EP-07 同源规则）、chain-integrity-read-model（rc-6 悬挂检测）、pain-chain-read-model（missingLinks）、CandidateLineage 祖先行走（损坏→显式 corruption 错误）。

### 3.2 RuleHost 五问审计（信息丢失点）

**"这条规则为什么产生/防止什么错误/何时触发/为什么相信/如何验证？"——在执行面上当前无法回答。** 具体丢失点（file:line 证据）：

1. **`painReasonSummary` 生产链零生产者**：三个消费面（RuleHostWriter 审批 triggerReason、receipt 元数据、gate-block 文案）读它，但只有 demo 代码写它——生产链上被拦/被注入的规则**说不出起源于哪次错误**（rule-host-writer.ts:325 回退通用串）。
2. **Scribe 原则工件不带 pain 关联**（scribe-output.ts:109 只有 title/statement/rationale）。
3. **Dreamer 输出丢弃 pain 证据**（dreamer-output.ts:23——原因/证据只留在任务 diagnosticJson，不进下游工件内容）。
4. **注入面丢弃 rationale**（prompt-activation-reader-contract.ts:86 只取 text||statement；"为什么相信它"永不注入）。
5. **执行面元数据只有 name/version/ruleId/coversCondition**（rule-host.ts:117；goldenTrace/evidenceRefs 在激活门用完即弃，不进拦截消息）。
6. **goldenTrace 的 pain 引用全部 Optional**（golden-trace.ts:39-52）——规则可以零 pain 溯源通过校验并激活。
7. 促销探针可把缺失 painId 字符串化为字面 `"undefined"`（openclaw-promotion-checks.ts:111）。
8. principleId 兜底链终点可以是**标题文本**（low-risk-writers.ts:7-35）。
9. 治理观察证据**破坏性过期**（≤7 天/≤32 轮后 NULL 化，governance-observation-store.ts:442）——pain 行还在、会话证据没了。
10. 反例（保全良好的）：evidenceRefs 逐字复制 BehaviorExamplePack→工件（v2 在激活门强制）；diagnosticJson 证据+provenance 重入校验；dead-letter 保留全量 payload；receipts 三键齐全。

**结论**：血缘"骨架"完整且被校验，但"语义血肉"（为什么/相信什么/如何验证）在 pain→注入的旅程中逐级蒸发——**这是产品价值（可信的行为改变）与实现之间最实质的语义鸿沟**。

---

## 4. Experimental Validation

（本审计主动实验，全部在 `D:\pd-audit-v1\*` 一次性隔离 workspace；LLM=bai glm-5.3-flash 真实调用；另有既有一线证据 = PRI-653 lab 两轮报告，双计数标注。）

### 4.1 Experiment A：Cold Start（发货版冷启动）

**设定**：全新 workspace（零历史）、发货版 pd-cli 1.147.5（runtime 1.230.0）、播种一条模拟真实会话证据（S001"发明字段"形态——lab 实证 3/3 可复现的真实失败），Owner 纠正记录 pain。

**过程实录**：
1. 首次 `pd pain record`（配置缺 `version`/`features` 必填段）：CLI **静默回退默认 runtime**（openai/OPENAI_API_KEY）→ 诊断 3 次尝试秒级烧尽，报错仅 `Max attempts exceeded`——**冷启动配置契约不自愈、失败不可诊断**（Finding A-1）。
2. 修正 profile 键名（须全限定 `pi-ai.<name>`，报错信息准确）后重录：**pain→诊断（476s）→ 3 candidates admitted（1 rule + 2 prompt 通道）+ 1 implementation 候选被正确 MVP-disabled → dreamer×3 ✓（约 1-3 分钟/个）→ philosopher×3 ✓ → scribe×3 ✓ → artificer（首轮 transient→retried 退避，符合 ERR-067）……**
3. 【实验终点状态见 4.4 补记】

**冷启动判定**：链路机制在发货版上可跑（与 lab R2 的 1512-leg 一致）；但一个新用户从 `npx` 安装起就撞 §1.2 的分发断裂，且首次配置错误以"烧尽重试"而非"指引修复"收场。**冷启动 = 机制 PASS / 旅程 FAIL**。

### 4.2 Experiment B：Learning Effect（学习效果）

**实际执行路径**（预先声明的成功标准：注入面持续出现该原则 + rule 通道拦截同型错误 + Level A 活体行为差异；第三项本轮不可行，见下）：

1. **注入载体在发货版上实证工作**：用生产入口 `buildActivePrinciplePromptContext`（host-runtime/active-principle-prompt.ts，正是插件 before_prompt_build 调用的函数）渲染 live workspace，得到 1372 字符的 `## 【ACTIVE BEHAVIOR DIRECTIVES】` 注入块：authority 框架（owner/system_policy）+ 指令正文（"MANDATORY: Always begin with a model of the relevant system, ground every inference in observable evidence, prefer reversible actions..."）+ **自报告机制**（要求 Agent 在指令实际改变行为时附一行 `📌 应用了你的原则「id」`）。
2. **行为改变的原始观察存在**：live `principle_applications` 有 **3 条 `self_reported` 回执**——Agent 在真实会话中自称该指令改变了当轮行为。这是目前全系统**唯一的**行为改变证据形态：自报告、未外部验证。
3. **注入文本确认信息丢失**：指令正文不含起源 pain、不含"为什么相信它"、不含验证方式（§3.2 的 1/4/5 号丢失点在产物上肉眼可见）。
4. **rule 通道（可验证拦截面）无法在本轮验证**，原因链本身是发现：
   - expA 的 15 个工件全部为 `principle` 类——**默认 flag 组合下 artificer 不产 RuleCode**（`code_rule_capability` 需显式开启/路由命中）；
   - live 上 `code_rule_capability=true` **已开启**，但 121 个工件仍然 **0 个 rule**——旗舰生产实例上规则生成面从未开火（gate_blocks=0 的结构性解释）；
   - evaluator 的 CLI 门要求 `.pd/host-tool-semantics/` 宿主声明，而 **live 与 expA 都没有该目录**——`saveHostToolDeclaration` 在发货插件 bundle 中**零调用**（声明 writer 未接线；live 甚至今天已用 1.230.0 插件重启过网关）。**"门先于生产者上线"的契约缺口实锤**：任何 workspace 上 CLI 驱动的 evaluator 都会先被 `host_tool_declaration_missing` 拒绝，直到某个未接线的 writer 存在为止（本审计手工播种声明 JSON 后 gate 才放行）。
5. **rule 链治理面走通**（expA）：evaluator **approved**（含对抗重放真实执行）→ rollout_reviewer needs_revision → 终态 **needs_human_review**（Owner 决策点）。但 **Owner 收件箱（`/api/v1/governance/owner-decisions`）列表为空**——NHR 任务未通过 capability 派生，直接 POST resolve 又被 reviewKey 校验拒绝。**PRI-629"待审断层"在发货版复现**：链到了人的面前，人却看不见它。

**B 判定**：注入载体 + 自报告闭环 = 机制存在且工作（弱证据）；可验证的拦截面（rule 通道）在生产上结构性哑火；**Level A（外部验证的行为差异）= 0**。生成 Rule 不算成功、行为改变才算——按此标准，**PD 尚未交付学习效果**。

### 4.3 Experiment C：Failure Recovery（故障恢复）

**设定**：独立 workspace（expC），provider baseUrl 指向死端口（`127.0.0.1:9`），录 pain。

**结果（Problem/Evidence/Impact/Recommendation）**：
- **P**：一次 LLM 故障后诊断链永久死亡，CLI 无任何重入口。
- **E**：3 次尝试 135s 烧尽→failed（failureCategory=`runtime_timeout`——连接错误被误归类，taxonomy 小缺陷）；随后 ① `pd task list` **能看到**该 failed 任务；② `pd pain retry` 却报 `task_not_found`（只认 pending/retry_wait）；③ `pd runtime recovery failed-tasks` 报 "No failed internalization tasks found"（按 isPeerRunnerKind 过滤，看不见 diagnostician 家族）；④ `pd diagnose run -t` 被 lease 守卫拒绝（"is failed, expected pending/retry_wait"，报错准确但无 nextAction 指向可用出口）。修复 provider 后重试依然 `task_not_found`（状态门控，与 runtime 无关）。**PRI-674 在发货版 1.230.0 完整复现**。
- **I**：live 上 17 条 evaluator 失败与 2 条 needs_human_review 同样被困（Console"失败任务页 Recover"= core `recoverFailedTask(force)` 是唯一出口，CLI 面全盲）。
- **R**：修 PRI-674（三面统一收 failed 家族 + 修复恢复顺序）；failureCategory 区分 connection/timeout。

### 4.4 实验终态补记（expA 全记录）

```
expA（发货版 1.230.0 + 真 LLM，一次性隔离 workspace）
 ├─ [配置事故链] 首次 record：config 缺 version/features → 静默默认 runtime → 3 尝试烧尽（冷启动摩擦 Finding A-1）
 ├─ rule 通道 66c1f9ad：诊断✓(476s, 3 candidates admitted) → dreamer✓ → philosopher✓ → scribe✓
 │   → artificer：Bai 600s×1 挂死（PRI-683 家族）→ 切本地 27B → 第 2 次尝试✓
 │   → evaluator✓ approved（对抗重放真实执行；解锁需手工播种宿主声明——writer 未接线）
 │   → rollout_reviewer：needs_revision → needs_human_review（Owner 决策点）
 │   → Owner 收件箱列表为空 + resolve 缺 reviewKey 被拒（PRI-629 断层复现）→ 未达 activation
 ├─ prompt 通道 9183af63：… → artificer 3×超时 failed（慢模型/大 payload 家族，lab 断点④同款）
 └─ prompt 通道 abf4c3fc：… → artificer 仍在第 3 次尝试（审计截止时未决）
工件：15×principle（1 validated）、0×rule；激活：0
```

**与 lab R2 结论交叉一致**：一条链可达治理面、prompt 链死于 artificer 超时家族、0 activation。两个独立环境（worktree 构建 vs npm 发货版）同构失败 = 断点是产品性的，不是环境性的。

**本轮新增、此前未被登记的发现**（建议建 issue）：
| # | 发现 | 级别 |
|---|---|---|
| N-1 | 宿主声明 writer 未接线：`saveHostToolDeclaration` 无任何生产调用方，evaluator CLI 门在所有真实 workspace 上必拒 | P1 |
| N-2 | live `code_rule_capability=true` 但 121 工件 0 rule——规则生成面在生产从未开火（结合 N-1，rule 通道双重不可达） | P1 |
| N-3 | Owner 收件箱不列出已达 NHR 的 rollout 任务且 resolve 无入口（PRI-629 族在 1.230.0 复现） | P1 |
| N-4 | lease TTL（5min）< LLM 实际时长（8min 级）→ 长调用中途 lease_stuck 误报/潜在双执行窗口 | P2 |
| N-5 | split 诊断器写 candidate.sourceTaskId=`diag_router-*`，mainline-contract 断言应=父任务 → 管道自产链被自己的完整性模型判 ERROR（生产者/校验器必有一错） | P2 |
| N-6 | failureCategory 将 connection 错误归为 runtime_timeout | P3 |
| N-7 | 冷启动配置契约：缺 version/features 时静默回退默认 runtime 并烧尽重试，无指向性 nextAction | P2 |

---

## 5. Evidence Assessment（证据金字塔）

| Level | 定义 | PD 现状 | 证据 |
|---|---|---|---|
| **A** 真实用户行为改变 | 活体 Agent 因 PD 而改变行为 | **0** | 无任何双任务对照实验；rule 通道生产 0 拦截 |
| **B** 真实 Agent 会话闭环 | 真会话→pain→…→激活→注入 | **1/4 段（含弱证据）** | live：真会话→手动 pain ✓→链多数死→1 次 prompt 激活 ✓→83 注入回执 ✓（其中 **3 条 self_reported**：Agent 自称指令改变了当轮行为——唯一的行为改变证据形态，自报告未验证）；**外部验证的行为差异 = 0** |
| **C** Pipeline Lab 验证 | 隔离环境全链真实 LLM | **强** | lab R1+R2（真实会话 15 轮、双腿对照、对抗门真实拦截、Owner 决策面两轮走通）+ 本审计 expA（发货版冷启动） |
| **D** Integration 测试 | 真存储+桩 LLM | **强** | cross-package-acceptance（pain→激活→停用→恢复全链）、#1514 韧性测试 |
| **E** Unit 测试 | 单元 | **强** | CI 32/32 全绿（近三个 PR） |

**要点**：E/D/C 层非常厚实且诚实（lab 报告连阴性对照和环境事故都留痕）；但 **A/B 层空心**。PD 的证据结构是"倒金字塔"——越接近用户价值的层越薄。CI 全绿与"用户获得价值"之间隔着：PRI-683（激活堵点）+ 分发断裂 + 自动检测未成立三道墙。

---

## 6. Reliability & Risk Analysis

### 6.1 Silent Failure（静默失败）
- 扫描结论：**管道内部静默失败罕见**（fail-loud 纪律真实——dead-letter、needs_human_review、degradation 事件、telemetry 全注册）。剩余三处：
  - a) `/apply-full` 把 EPERM 真因泛化为 `file_locked`+"重启电脑"（update.ts:1137-1154）；
  - b) hook after_tool_call 10s fail-open（设计取舍，无补偿队列——漏检即丢）；
  - c) 自动检测在 live 零产出这件事**本身没有任何告警面**（196 会话 0 自动 pain，无人知道）。

### 6.2 Semantic Drift（语义漂移）
- `painReasonSummary` 读写不对称（§3.2-1）；failureCategory 把 connection 归为 timeout（§4.3）；`derivedFromPainIds` 字段名装的是 candidateId（pain-chain-read-model.ts:140）；四套工具词汇表无权威（PRI-634-F ABC 审计结论，painReasonSummary 休眠槽 3 消费者 0 生产者）。

### 6.3 Authority Drift（多真相源）
- 版本权威分裂（§1.2：pd/--version、extensions stamp、plugin.json、runtime 组件、update-history 五套口径互相矛盾）；
- 更新入口三通道（installer 自包含/legacy/console apply-full）语义不一致，仅一条能用；
- 数据层权威纪律**良好**（state.db/trajectory.db/ledger 单写者清晰，approvals/decisions append-only 触发器保护）。

### 6.4 Contract Gap（形式合法、运行不可执行）
- **分发契约**：安装器要求自包含资产但发布链不产出资产（v1.230.0 Release 零资产+npm 包无 `_release/`）→ `npx` 新装必败——**形式上 1.132.2 已发布，实际上不可安装**；
- console `/apply` 守卫拒绝 canonical 布局 pluginDir（update.ts:114-126 vs installed-layout 解析）；
- tarball 缺 codex-adapter 但安装器硬性要求；
- 主 checkout package.json 工作树被砸 + run-once UU 冲突（多 agent 治理事故，git-2/4 违规现场，待 Owner 处置）。

### 6.5 Complexity Drift（复杂度漂移）
- 引用 2026-09 复杂度普查（repo docs/audit/pd-complexity-debt-census-2026-09.md）：Wave1 死代码已清（净删 ~2800 行）、双路径 flag 11→7；仍存：Gate A 残留（flag-off 分支三读点）、ReleaseManager 17 文件 STAGED、hidden CLI 20 个、Console 双呈现。**方向是收敛的，但 RM"已采纳未供资产"是目前最大的新债**（authority 面先于供给面落地）。
- 无人消费数据：`principle_training_state.json` 的 implementations/ 资产对执行路径 write-only（PRI-436 后 RuleHost 只读 SQLite）；evolution/samples hidden 组是两处 core 导出的唯一消费者。

---

## 7. Maturity Evaluation

| Level | 判据 | 达成 | 证据 |
|---|---|---|---|
| L0 理念 | — | ✅（历史） | — |
| L1 功能存在 | 各阶段有实现 | ✅ | §2 全链 file:line |
| L2 Pipeline 跑通 | 端到端真实执行 | ✅ | lab R2 1512-leg 全治理面首通 + expA 冷启动；**含真实 LLM 与真实 Owner 决策** |
| L3 稳定运行 | 生产持续低故障 | **部分** | 消费循环/租约/幂等稳健（#1514、lease_conflict 收敛）；但 evaluator 坟场（修复前）、PRI-674 无重入、PRI-683 300s 帽、分发断裂 |
| L4 真实用户价值验证 | A/B 层证据 | **❌** | 0 Level A；B 层仅 1 次激活+注入回执、无行为差异度量 |
| L5 自我演进 | 系统自改 | ❌ | 无（也非当前 MVP 目标） |

**当前等级：L2+（坚实），L3 半程，L4 未入门。** 从 L2+ 到 L4 的路径不缺架构，缺三件事：PRI-683 修复、一次完整 Pain→Activation→Behavior 证据（PRI-676）、以及把自动检测在生产上打开并证明。

---

## 8. Recommended Evolution Roadmap

**P0（不解决则产品主张不成立）**
1. **修分发**：发布链产出平台资产（或临时回退 npm 自包含捆绑），恢复 `npx` 新装可用；console `/apply` 守卫与 `/apply-full` 自锁同批修。*为什么现在：新用户入口已断；收益=产品可被获得；不做风险=一切价值无从交付；不影响 MVP 范围（是 MVP 的前提）。*
2. **修 PRI-683（pi-ai 300s 内层帽）**：activation 通路唯一堵点。*修后一次重跑（lab 估 ~1h）即可首次获得 Pain→Activation→Behavior 全链证据。*
3. **版本权威统一**：`pd --version`/health 单一口径读 canonical 布局；扩展目录 stamp 停用或同步。

**P1（应该尽快）**
4. PRI-674 恢复面统一（failed 家族三面可见 + 恢复顺序修正）。
5. **接线宿主声明 writer（N-1）并打通规则生成面（N-2）**：`saveHostToolDeclaration` 接入插件启动路径；排查 live 上 `code_rule_capability=true` 却 0 rule 工件的生成/路由断点——不修这两处，rule 通道（唯一可外部验证的学习面）永远无法交付证据。
6. **修 Owner 收件箱断层（N-3）**：NHR 任务必须可列出、可裁决，否则"Owner 决策点"名存实亡。
7. **自动 Pain 检测生产化验证**：在 live 打开 `abstraction_layer_v1`（或明确退役旧路径），建立"检测率"观测（sessions vs auto pains），否则"自动治理"主张无生产证据。
8. PRI-676（lab AC3）：活体双任务行为对照——Level A 证据的既定通道。
9. live 存量清理：2 条 needs_human_review 决策、17+1 条 failed evaluator（用 Console Recover 重放，顺便实证恢复面）。

**P2（长期探索）**
8. §3.2 语义血缘补全（painReasonSummary 生产者、rationale 注入、执行面 why/verify 元数据）——让 RuleHost 能回答五问。
9. 治理观察证据的非破坏性归档（替代 7 天 NULL 化）。
10. RuleCode 生成质量（PRI-634 主线继续）；S002/S003 夹具按"规格欠约束+惯例诱导"形态扩充（lab 校准结论）。

---

## Final Owner Decision

**问题："如果明天一个新用户安装 PD，他犯了一次真实错误，PD 是否能够帮助他的 Agent 未来避免这个错误？"**

## 裁定：**PARTIAL**

**支持证据（能的部分）**：
- 错误一旦成为 pain（无论手动还是实验播种），到"可裁决的行为改进提案"的闭环真实、可复现、可取证：诊断语义精准（lab："agent 用间接信号替代权威证据源"0.88）、多通道提案、真实对抗验证两轮拦截、无低质产物被放行、Owner 决策面完整（lab 两轮真实 reject 留痕）。
- 注入面在唯一一次生产激活上持续工作（83 回执横跨多会话）。
- 失败语义可观测（本审计复现的每个失败都有 reason/nextAction 或可定位的日志）。

**反证（不能的部分）**：
1. **明天新用户根本装不上**（npx 必败，三通道两断一锁）；
2. 就算装上，生产形态下错误**不会自动**变成 pain（自动检测零产出，全靠 Owner 手动上报）；
3. 就算 pain 进了链，rule 通道双重结构性不可达（宿主声明 writer 未接线 → evaluator CLI 门必拒；生产 121 工件 0 rule → 规则生成面从未开火），lab 实证的修复轮 300s 帽（PRI-683）也还开着；生产历史 121 工件仅 1 激活（0.8%）且是 prompt 通道；
4. **从未有任何外部验证的证据表明 Agent 行为因此改变**（Level A=0；仅有的 3 条行为改变证据全部是 Agent 自报告；rule 通道生产 0 拦截）；
5. 一次 LLM 抖动会永久损失一条链且 CLI 无法恢复（PRI-674 发货版复现）；
6. 链即便到达 Owner 决策点，收件箱也可能看不见它（N-3 复现）。

**到 YES 的最短路径**（依序）：修分发 → 修 PRI-683 → lab AC3 一次完整 Pain→Activation→Behavior 重跑 → 生产打开并观测自动检测 → 用双任务对照交付第一份 Level A 证据。架构不需要重写；需要的是把已建成的机器的"进气口"和"最后一节传动轴"接上。

---

## 附：审计过程产物索引

- 实验工作区：`D:\pd-audit-v1\{expA,expC}`（一次性）；证据快照 `D:\pd-audit-v1\snapshots\pre-update\state.db`
- 更新事故记录：`D:\.openclaw\workspace\.pd\update-history.json`（本审计 3 失败 + 1 成功在案）
- live 只读取证脚本：`D:\pd-audit-v1\query-state.cjs`；链路驱动 `D:\pd-audit-v1\run-chain.sh`
- 既有一线证据：`docs/pipeline-evolution/reports/{first-run-report.md, 2026-09-05-round2-report.md}`（PRI-685 worktree）
