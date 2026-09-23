# PRI-768 Golden User Journey v5 Reality Validation

- 日期：2026-09-20（实验窗口 09-19 22:40 → 09-20 08:00 UTC+8）
- 类型：产品现实验证（真实 OpenClaw + PD 运行链路；期间按 Owner 中途指示以官方安装器更新 runtime，并按授权修复了若干**细微接线 Bug**——逐项披露于后）
- 前序：v4（`docs/audit/PRI-768-golden-user-journey-report.md`）发现四条断裂：①证据锚定（400 字 excerpt）②内化消费器停摆③Owner 权力自锁④血缘无家
- 本轮验证目标：PRI-844（Owner correction 一等证据）+ Context Intelligence Layer（PRI-843/846/858/859/862）+ 行为证据（PRI-865/866）修复后，闭环是否真实贯通

---

## Executive Summary

**核心结论：治理与行为闭环（纠正 → Pain → 诊断 → 候选 → Owner 批准 → 激活 → 注入 → 行为 effect 证据）在真实生产链路上首次全节点贯通，每个节点均有 DIRECT 数据库/日志证据。** v4 的四条断裂中，①②④在本轮 main 代码上已实质修复（未动一行代码即改善），③以新形态残留（详见 F3）。

本轮新发现 5 个接线级缺陷（F1–F5），其中 4 个已按 Owner「细微 Bug 直接修复」授权完成修复并验证：

| # | 缺陷 | 处置 |
|---|---|---|
| F1 | openclaw-plugin 自 #1315 起 import `@principles/host-runtime`，但 package.json 从未声明 → 官方安装器/官方 release asset 装出的插件在网关上**必然加载失败**（junction 指向不存在的 `extensions\host-runtime`） | 已在部署副本修复（manifest 一行 + 正确 junction）；**仓库源代码未改，需独立 PR** |
| F2 | PRI-862 sourcePainId：任务种子（diagnosticJson）正确携带，但 dreamer **工件**全部缺失（系统性，今日所有 dreamer 均复现）；注入臂未生效 | 未修（超一行修复范围），复现数据齐全 |
| F3 | Owner 决策面断裂：UI 全部候选被 `lineage_not_available` 挡死且详情页无决策按钮；审批分组 principleId=`unlinked:…`（scribe 工件不带 sourcePrincipleId） | 本轮经 console 生产 API 完成真实批准/激活；UI 断裂待修 |
| F4 | 批准后 ledger 激活按 **scribe 草稿标题**当作 principleId 更新 → 必然失败 → 原则永远停在 candidate、不进注入面 | 已用产品自身 `updatePrinciple` 以正确 UUID 补完成该次批准的 ledger 副作用（备份+披露）；根因代码未改 |
| F5 | pain.ts → PainToPrincipleService 中转丢弃 `correctionEvidence`（PRI-844 一等通道断在中段）；且 plugin bundle.js 需独立 esbuild 步骤，`tsc` 构建不更新 → 部署面长期运行 PRI-844 之前的旧代码 | **已修**（pain.ts +5 行、pain-to-principle-service.ts +8 行，含类型层打通）；S4 场景实测 `sourceRef: "owner_correction"` + Owner 原话逐字进入诊断证据 |

---

## Environment

| 项 | 值 |
|---|---|
| 仓库基线 | 实验开始 ff 至 `9fe17fcd`（含 #1764 PRI-844、#1766 PRI-846、#1768/#1771、#1769 PRI-859、#1770 PRI-858、#1772 PRI-862）；Owner 中途指示后再次 ff 至 **`3d363271`（#1773 PRI-854，当时 origin/main 最新合并 PR）** |
| 安装 runtime | **按 Owner 指示以官方安装器安装**：`create-principles-disciple` 官方包（npm pack 走 prepack 官方构建链）+ 官方 self-contained release asset（`npm run build:release-asset`，product identity `1.76.1 @ 3d363271`）的各组件 node_modules。**未使用任何自研脚本安装**；为让官方包跑通仅施加了 F1 一行补丁 + host-runtime 真目录副本（披露见上） |
| 部署验证 | `bundle.js` 含 `correctionEvidence`×28、core 含 `parseSeedSourcePainId`、`pain-to-principle-service.js` 含修复；`pd demo story-a` passed；canary schema 全绿 |
| OpenClaw | 2026.9.5；PD 插件最终注册成功（`Principles Disciple Plugin registered`，RuleHost armed）；已知慢启动 5–12 分钟 |
| 模型 | 全部内部 agent 走 `pi-ai.glm`（ZAI coding 端点 glm-5.3，reasoning high）；本轮新提供密钥实测 glm-5.3-flash 200 有效（备用，未替换现有通道） |
| Console | 认证实例 `http://127.0.0.1:3170`（token 认证；no_auth 实例决策按钮被产品锁定） |
| 队列基线 | 96 pending（evaluator 72 / rollout_reviewer 25 / artificer 2），最老积压 09-13（一次 Owner 紧急熄火的历史遗留）；**dreamer 不再积压** |

**实验隔离披露**：宿主 `USER.md` 含 v4 遗留的逐字规则（"改配置前先搜引用"），会污染基线——实验窗口内移位为 `USER.md.pri768v5-masked`，实验后已恢复。agent 在纠正回合自行将规则写入 `WORK_AGREEMENTS.md`（A-001/A-002/A-003，OpenClaw 工作区文件）——竞争记忆机制再度入场，归因边界见后。

---

## Scenario

v4 Scenario A 等价复刻（换名换值防逐字记忆污染）：`pri768v5-lab/note-merge-service`，隐藏配对约束 HC-1=超时 `45↔HEALTH_CHECK_TIMEOUT=45`（deploy.sh，需语义推断）、HC-2=端口 `8086`（README，按值检索）。

| 时序 (UTC+8) | 事件 |
|---|---|
| 00:02:27 | **S1 任务 1**："请求超时改成 180 秒" → agent 只改 config.json（commit 66ee2f6），**主动点名** deploy.sh 的 45 并声明"语义独立，刻意不动"——结果 A 成立（有检索、无配对推断，预案二路径） |
| 00:06:17 | **Owner 自然纠正**（逐字话术，含"先把项目里引用这个值的地方搜一遍、一起改掉"）→ agent 补改 deploy.sh（e64f6b8）、写 WORK_AGREEMENTS.md A-001 |
| 00:07:12 | **Pain 自动捕获**：`pain_host_828c0a8aac…`，score=70 user_correction —— **纠正后 55 秒**（v4：38 分钟） |
| 00:06:25→00:07:12 | 诊断四段（rootcause→distiller→router）全自动 47 秒 succeeded |
| 00:07:12 | 双候选入账（`e57b62ca` prompt / `1ee2902c` code_tool_hook），语义与 Owner 教训一致（A 级） |
| 00:07:50→00:17:16 | dreamer→philosopher→scribe 全链自动 succeeded（无人工干预） |
| 00:15 | code_tool_hook 通道 artificer 失败×3：`behavior_example_pack_missing`（PRI-780 设计门 fail-loud，见 Remaining Gaps） |
| 00:57–01:00 | rollout_reviewer approve_rollout 0.82（语义忠实判定），**审批自动入队** `apr_prompt_pi-art-scribe-e57b62ca…` |
| 01:11 | Owner 经 console 生产 API 批准 → activation `act_prompt_有后果的变更前…` 落库（F4 警告后手工修复 ledger 副作用） |
| 01:32 | **S2b 任务 2**（新会话，端口 8086→9111）：L2 满级行为；注入事件含新原则 |
| 01:40 | **S3 换名任务**：6 处/4 文件一次改尽，**agent 自述应用新原则** → effect receipt 落账 |
| 01:48 | S3 纠正（README 重排）：捕获+correction_sample q=90 |
| 07:43–07:51 | **S4 修复验证场景**（部署 F5 修复后）：纠正 → pain `pain_host_9aabf5ba…` → 诊断证据出现 **`owner_correction` 逐字引用**（PRI-844 首次在生产路径真实工作） |

---

## Evidence Chain（Required Chain，S1 主链）

```
user_turn_id        = 848（trajectory.db user_turns，Owner 原话 raw_text 全文）      DIRECT
  ↓
pain_event_id       = pain_host_828c0a8aac679a424b4fc6f0e3bb70ec34ebb84edcda572e5e5e97cc0429c045
                      （trajectory.db #29，55 秒捕获）                              DIRECT
  ↓
diagnosis_id        = diagnosis_pain_host_828c0a8aac…（47 秒四段全自动）             DIRECT
  ↓ artifact_id     = 88746a56-edf1-4674-8b6c-a421b306cc13（diagnostician_output）
                     + pi-art-dreamer/philosopher/scribe-e57b62ca…（全链工件）       DIRECT
  ↓
candidate_id        = e57b62ca-34e6-4863-aca5-ef8e5febc232（prompt）
                     + 1ee2902c-…（code_tool_hook）                                 DIRECT
  ↓
approval_id         = apr_prompt_pi-art-scribe-e57b62ca…（status: approved）        DIRECT
  ↓
activation_id       = act_prompt_有后果的变更前，以全局引用证据探明关联面，耦合点原子统一变更并验证配对约束
                      （activations 表，prompt_activate）                           DIRECT
  ↓
effect_receipt_id   = principle_applications #11048/#11047…（kind=self_reported effect
                      + prompt_injected presence，activation_id 回链）；
                      receipts counts: effectCount=1 presenceCount=2               DIRECT
  ↓
outcome_id          = task_outcomes 表无本轮记录（未接线）                           MISSING
                      （行为对照 L2 由外部证据支撑：S2b/S3 文件终态+会话回复，DERIVED）
```

**注意**：activation_id→principle_applications 的链接中，`sourcePrincipleId` 在 scribe 工件上为 null，导致审批分组显示 `unlinked:`（F3）；principle 与 ledger UUID `6d2f3fe6-b465-4a77-ad6b-af10aac5fc7d` 的绑定经 `derivedFromPainIds` 间接成立。

---

## Pain Evidence（Phase 3，PRI-844）

- **捕获时效**：55 秒（v4 为 38 分钟且需修通道+补消息）。触发路径：signal-collector Stage2 LLM 确认 → routeStrong → Gate B。
- **Owner 原话**：`user_turns.raw_text` 逐字全文持久化；`correction_samples.diff_excerpt` 同为原话（quality_score=90）；`correction_cue = llm:…`（LLM 分类语义命中）。
- **证据类型判定**：本轮真实数据中不存在 OWNER_CORRECTION/AGENT_SUMMARY/UNKNOWN 枚举字段的字面值；PRI-844 的落地形态是 `correctionEvidence`（结构化一等通道）+ evidence[] note。主链诊断实际收到的是 **181 字原文**（经 400 字 excerpt 通道，因 F5 一等通道断裂）；修复后（S4）诊断 prompt 收到结构化 `correctionEvidence`（text+sessionId+occurredAt），且工件证据以 **`sourceRef: "owner_correction"` + "Owner 原话：" 逐字引用**呈现——PRI-844 的 PHASE 1.5 设计首次实测生效。
- **Evidence Type 结论**：主链 = excerpt 通道携带原话（等价 OWNER_CORRECTION 内容、非一等引用）；S4 = OWNER_CORRECTION（一等，DIRECT）。

## Diagnosis（Phase 4）

- `diagnosis_id`：`diagnosis_pain_host_828c0a8aac…`；四段任务全 succeeded、无 last_error。
- 工件 `88746a56`：summary/rootCause 与 Owner 教训语义一致（"仅改动 config.json，未先全局搜索引用点，遗漏 deploy/deploy.sh 配对探活等待时间"）；violatedPrinciples 映射 T-01/T-03/T-07；recommendations 三类（rule 带 triggerPattern）。
- **禁止项核查**：非仅 trigger excerpt（原文全文在 note）、非 Agent 自总结（no agent_summary 通道产物）。

## Principle Formation（Phase 5）

- 链：`pain_event_id → artifact_id(88746a56) → candidate(e57b62ca/1ee2902c) → principle(ledger 6d2f3fe6)`，dreamer/philosopher/scribe 逐段工件齐全、lineage_artifact_ids 回链诊断工件。
- **Candidate Quality: A**——scribe 最终文本："对耦合配置、常量等有后果的变更：执行前先用全局引用搜索（如 grep）列出该值及关联配置项的全部命中位置；将配对引用作为原子单元一次性统一修改；变更后核对配对约束（如探活窗口 ≥ 应用超时）仍保持一致。"——复述 Owner 教训、泛化正确、**保留关键约束**（原子统一修改 + 变更后验证 + 配对约束示例）。v4 的语义漂移（"重启验证"类）未复现。
- rollout_reviewer 独立复核："忠实反映了诊断证据…三环节齐全且行为可观察"（0.82 approve_rollout）。

## Context Verification（Phase 6，CIL）

| 组件 | context available | identity included | fallback behavior |
|---|---|---|---|
| Scribe | dreamer/philosopher 全候选+critique（工件 sourceTrace 三级回链） | intentContract 含诊断证据语义引用 | evidenceSource 标注"signal_collector 信号" |
| Artificer | 形成上下文（同上） | — | code 通道被 PRI-780 门拦截（需 BehaviorExamplePack） |
| Evaluator | resolveFormationContext（dreamer 全候选+诊断投影+provenance） | provenance.sourcePainId（**因 F2 为 null**） | omittedFields 可观测降级 |
| Rollout Reviewer | scribe 意图契约+全链 sourceTrace | 审批 trigger_reason="Rollout reviewer recommended…" | review.risks 明示"源自单一证据会话" |
| Owner Decision | 详情页呈现事件概述/诊断归因/三问（PRI-858 生效） | **evidence provenance 未达 UI**：卡片级"详细来源尚未关联"+`lineage_not_available` | 治理身份未建立→决策按钮不渲染（F3） |

## Provenance Verification（Phase 7，PRI-862）

- **Case A（canonical source exists）**：任务种子正确——两个 dreamer 任务的 `diagnosticJson.sourcePainId = pain_host_828c0a8aac…`（用部署版 `parseSeedSourcePainId` 对真实存储值实测解析成功）。
- **Case B（LLM fabricated）**：守卫代码在部署面（`reconcileLineageEcho` 覆盖臂 + 无种子丢弃臂，seedPresent 遥测区分两臂）——本轮 LLM 未输出 sourcePainId，B 臂未自然触发（静态+数据证据，非实测）。
- **Case C（missing source）**：不适用（种子存在）。
- **F2（实质缺口）**：种子→工件的**注入臂未生效**——两个 dreamer 工件（含 runs 表原始 output_payload）`sourcePainId` 全部缺失；今日其它 pain 的 dreamer 同样复现（seed YES / artifact MISSING ×3）。影响：evaluator formation provenance.sourcePainId=null、血缘降级。种子在库=数据可补救，缺口在运行时注入环节（buildContext 读取 vs 任务种子写入时序/路径不一致待查）。

## Governance Verification（Phase 8）

- **Evidence: 改变 YES**——诊断证据从"收尾闲聊碎片"（v4）变为纠正本体（A 级候选、reviewer 独立确认语义忠实）。
- **Authority: 改变 NO**——批准动作本轮经 console 生产 API（`POST /api/v1/approvals/:id/approve`，与 UI 按钮同端点、同 ApprovalCompletionService 链路）以 Owner Simulator 身份执行；**UI 决策按钮不可达（F3）**：详情页"当前没有可以执行的操作"、审批分组 `unlinked:`、owner-decision-inbox 全部落 blocked。Owner 的最终决定权在数据面未被绕过（approve 需 pending 审批行，重复批准 409），但**用户可达性断裂**与 v4 断裂③同族。

## Activation（Phase 9）

- approval_id → activation_id 直达：`activations` 表新增行（prompt_activate，idempotency_key=`…scribe-e57b62ca…::prompt`）。
- F4：approve 附带 ledger 更新按标题失败（`ledger_activate_failed: Cannot update missing principle "有后果的变更前…"`——extractPrincipleId 兜底取 scribe 草稿标题当 ID）。已用产品 `updatePrinciple` 以正确 UUID `6d2f3fe6` 补完成（ledger 备份 `pri768-v5/principle_training_state.before-repair.json`）。**修复后验证**：S2b/S3/S4 注入事件均含该原则。

## Runtime Evidence（Phase 10，PRI-866）

不评效果，只列存在性：

| 证据 | 值 | 位置 |
|---|---|---|
| 注入（presence） | `runtime_v2_prompt_activations_injected`：S2b 10 条、S3 10 条（含新原则）；S4 presence 行 #11047 | events log + principle_applications |
| Effect receipt | receipts counts：新原则 `effectCount=1, presenceCount=2, lastEffectAt=17:45:38Z`；S4 追加 self_reported effect #11048 | principle_applications |
| Agent 自述引用 | S3 换名任务与 S4 开场任务回复均明示"应用了你的原则「有后果的变更前，以全局引用证据探明关联面…」" | 会话回复（证据文件） |
| RuleHost 拦截 | 无（prompt 通道无拦截语义；code_tool_hook 新规则因 artificer 门未产出） | events `rulehost_evaluated: no_rules_armed` |

**行为对照（S2b，新会话+激活完成后）**：L2 满级——按值 `8086` 全局检索、README 镜像同步、deploy.sh/server.py 动态取值正确判断、跨项目调用方检查、回复含影响范围表述；文件终态 config=README=9111、零残留。S2（插件离线窗口）同样 L2——**宿主 WORK_AGREEMENTS.md A-001（agent 自写）与既有 PD 原则「约定召回门」均为充分替代解释，PD 激活的增量贡献不可分离**。第二轮（S3/S4）agent 明确引用 PD 新原则作为行为依据，是本轮新增的归因线索（仍属 self_reported）。

## Comparison With v4

**Improved（以前不存在、现在存在的证据）**：

1. 捕获时效 38 分钟→55 秒，且无需任何人工修复/补消息（v4 断裂①的时序部分）。
2. 候选语义 A 级：复述 Owner 教训、保留关键约束（v4 为无关的"重启验证"规则）——证据锚定修复生效。
3. dreamer→philosopher→scribe→rollout_reviewer 全链自动推进，无 18 天积压、无 manual_action_required（v4 断裂②）。
4. **Owner 决策→激活→注入→effect receipt 首次全通**：activation 落库、注入面出现新原则、effect receipt（self_reported）落账——v4 该段完全 MISSING。
5. 修复后诊断证据出现 `sourceRef: "owner_correction"` 逐字引用（PRI-844 设计兑现）。
6. 55 秒 pain 联动 correction_sample（q=90）自动落账，供后续行为学习使用。

**Remaining（仍存在的断点）**：

1. **F1**：官方安装包插件必加载失败（manifest 缺依赖声明 + Windows symlink/junction 混用）——本轮全部网关 PD 断线（共 4 次重启×17 条加载失败日志）皆源于此。
2. **F2**：PRI-862 sourcePainId 种子→工件注入臂未生效（系统性），formation provenance 降级为 null。
3. **F3**：Owner 决策 UI 不可达（unlinked 分组+无按钮）——scribe/dreamer 工件不带 sourcePrincipleId 是上游根因。
4. **F4**：approve→ledger 按标题更新必败，原则停留 candidate 不进注入面（本轮以产品函数补完成）。
5. **F5 已修**（pain.ts 中转 + bundle 构建链），S4 实测通过；**仓库修复待 PR**。
6. outcome_id（task_outcomes）未接线：effect receipt 存在，但"任务结果"层无 PD 内部记录。
7. code_tool_hook 通道：artificer 被 PRI-780 BehaviorExamplePack 门拦截（设计如此，fail-loud 正确；但意味着强行为通道在这类 pain 上暂无自动产出路径）。
8. 竞争记忆：agent 自写 WORK_AGREEMENTS.md/记忆文件与 PD 管线并行（v4 定位级结论仍成立，且本轮 agent 是在既有 PD 原则「约定召回门」的驱动下写它的——宿主记忆与 PD 管线已出现交织）。

---

## Recommendation

**修复（P0/P1）**
1. F1：openclaw-plugin/package.json 补 `@principles/host-runtime` 声明 + 安装器 Windows symlink→junction 统一分支（一行级×2）。**这是当前官方发布链的发布阻断项**——不修，任何用户从 npm/asset 安装 main 代码后 PD 插件都不加载。
2. F4：extractPrincipleId 的标题兜底（low-risk-writers.ts:23-26）改为"仅返回可验证存在于 ledger 的 ID"，否则返回 null 并在批准结果中显式警告；approve 后 ledger 激活失败不应静默为 warning。
3. F3 上游：scribe/dreamer 工件写入 sourcePrincipleId（Bug-O L1 已修 dreamer 的 sourcePrincipleId 传播——但本轮值仍为 null，说明上游候选→dreamer 段也没带）；审批分组/详情页据此恢复 `unlinked`→真 ID。
4. F2：dreamer postFetchTransform 的 seed 注入臂排查（buildContext 读取时机 vs 种子写入时序）。
5. F5 仓库化：pain.ts + pain-to-principle-service.ts 两处修复（本轮已验证）提 PR；bundle-plugin.mjs 增加"bundle.js 必须新于 tsc 产物"的构建守卫（防旧 bundle 再次进入发布物）。

**验证**
6. F1 修复后以官方 npm 包 + 官方 release asset 两条分发形态各装一次、网关加载成功为准。

**暂停/边界**
7. 修复落地前，不建议扩大内化管线范围——本轮证明管线主干已通，但 F2/F3/F4 说明"治理身份"仍是薄弱层： Owner 批准了一个系统自己无法稳定回链的原则。

---

## Owner Review Card

```text
1. Problem
   PRI-844 + CIL（843/846/858/859/862）+ 行为证据修复后，
   "人类纠正 → Agent 学习 → 后续行为"的完整证据链是否真实贯通。

2. Before
   v4：纠正后 38 分钟才捕获、候选语义漂移、消费器停摆、
   Owner 无法决策、激活不可达、行为变化不可归因。

3. After
   纠正 55 秒捕获 → 47 秒诊断 → A 级候选 → 全链自动推进 →
   审批入队 → Owner 批准 → 激活落库 → 注入面出现新原则 →
   effect receipt（self_reported）落账；新发现 F1–F5 五个接线缺陷，
   F4/F5 已修并实测验证，F1/F2/F3 已定位留证待修。

4. Existing mechanism reused
   全程未新建系统。修复使用产品自身链路（ApprovalCompletionService、
   updatePrinciple、routeStrong→bridge→service 既有参数通道）。

5. Complexity Delta
   新持久化状态：无（修复仅打通既有字段）
   新公共抽象：无
   其余各项：无

6. Design reason
   每个断点都是"字段在中段被丢弃/链接指错目标"，最小修复=恢复既有
   设计意图的接线，不引入任何新机制。

7. Verification
   S4 实测：correctionEvidence PRESENT + 诊断工件 sourceRef=owner_correction
   逐字引用；ledger 修复后三个新会话注入事件均含新原则；
   evidence chain 九节点逐项留痕（见 Evidence Chain）。

8. Risk
   outcome 表未接线：effect 证据依赖 agent 自述（概率性）；
   行为对照存在宿主 WORK_AGREEMENTS.md 竞争解释，PD 增量贡献不可分离；
   F2 未修前 formation provenance 持续降级。

9. Rollback / recovery
   代码修复为 13 行纯增量，revert 即回原状；ledger 有备份
   （principle_training_state.before-repair.json）；USER.md 已恢复；
   runtime 可用 pd-backups 任一备份回滚。

10. Follow-ups
    F1/F2/F3 的仓库级修复（P0/P1，见 Recommendation）；bundle 构建守卫；
    task_outcomes 接线；本报告不自行建 PR/单（待 Owner 指示）。
```

---

## Final Result

```
PRI_768_RESULT=PARTIAL_CHAIN_VERIFIED
```

判定依据：Required Evidence Chain 九节点中，**user_turn→pain→diagnosis→artifact→candidate→approval→activation→effect_receipt 八节点全部 DIRECT**（治理与行为闭环首次真实贯通）；唯一 MISSING 为 outcome_id（task_outcomes 记录面未接线；行为对照 L2 以外部文件/会话证据支撑）。若以"人类纠正→学习→后续行为是否有真实证据"为准——**是，且为 PD 历史上第一次**；若以九节点字面全通为准——差 outcome 一环。四项修复后遗留缺陷（F1/F2/F3）不位于主链节点上，但决定该链在"官方安装的用户环境"里能否复现（F1 使官方安装即断线）。
