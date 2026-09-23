# PRI-768 Golden User Journey v6 Reality Validation

- 日期：2026-09-21/22（实验窗口 2026-09-21 17:25 → 19:45 UTC ≈ 22 日 01:25–03:45 UTC+8）
- 类型：产品现实验证（真实 OpenClaw 2026.9.5 + 最新 main 安装链路）+ 自主安全修复验证
- 前序：v4（`PRI-768-golden-user-journey-report.md`）、v5（`PRI-768-golden-user-journey-v5-reality-validation.md`）
- 本轮目标：PRI-844 + Context Intelligence Layer（843/846/858/859/862/863）+ 行为证据（865/866）+ v5 后续修复（`ce403c8c7`：F5 correctionEvidence / F4 ledger id / F3 分组血缘 / outcome 接线）落 main 后，九节点闭环在**官方构建的最新 main 运行时**上是否真实贯通

---

## Executive Summary

**核心结论：九节点证据链（纠正 → Pain → 诊断 → 候选 → Owner 批准 → 激活 → 注入 → 行为效果 → 任务结果）在最新 main 的真实生产链路上首次全节点贯通，且本轮是从两条真实 Owner 纠正（S1「未查验断言」、S3「汇报冗长」）独立产生的全新证据，零手工数据。** v5 的 F2（sourcePainId 工件缺失）、F4（ledger 按标题更新必败）、F5（correctionEvidence 中断）、outcome 未接线四项在 main 上全部验证修复；F1（官方安装链插件加载）经官方 release asset 全新安装验证通过。

但本轮把链条推过终点线需要 4 项运行环境/治理操作（详见 Autonomous Fixes）：其中**注入预算饥饿（v6-02）是新的 P0 级断点**——2000 字符 FIFO 预算已被 10 条既有激活填满，本轮之前已有 1 条 Owner 已批准原则（指令模糊时…）静默失效，本轮新批准的原则同样进不了注入面，直到 Owner 退役 2 条旧原则腾出空间。**「Owner 批准 ≠ 行为改变」在预算饱和时成立，且批准流程对此零提示**。Owner 决策 UI 断裂（v5-F3 残留）仍在：分组 API 已修复，但详情页无决策按钮、待决策列表为空、带完整批准/拒绝按钮的 `PendingReviewCard` 组件**已实现但从未被渲染**。

| # | v6 新发现 | 级别 | 处置 |
|---|---|---|---|
| v6-01 | Owner 决策 UI 死路：`PendingReviewCard`（含批准/拒绝按钮、inline 修订）已完整实现但无任何渲染点；详情页 `availableActions=[]`（治理身份未建立）；原则审查「待决策」过滤恒空（in_pipeline: 91） | P1（Level 2，记录） | 未修；本轮经 console 生产 API 完成批准（与按钮同端点） |
| v6-02 | 注入预算饥饿：`RUNTIME_V2_PRINCIPLE_BUDGET=2000c` + `activated_at ASC` FIFO——第 11/12 条激活被截断丢弃（`v2Truncated:true`）；批准流程无预算提示，Owner 不知情 | P0（Level 2，记录） | 本轮以 Owner 身份退役 2 条旧激活腾位（可逆，已披露）；根治需设计决策 |
| v6-03 | AutoConsumer 固定 kind 顺序（dreamer→…→rollout_reviewer）+ 每周期仅 1 任务 + 21 条确定性失败的 artificer 毒丸重试（`behavior_example_pack_missing`，最多 44 次尝试）→ rollout_reviewer 阶段饥饿（本轮估算 >7 小时） | P1（Level 2，记录） | 本轮用产品自带 `pd runtime internalization run-once --runner rollout_reviewer` 手动泵队列（操作员动作，无 DB 写入） |
| v6-04 | 网关环境密钥治理缺口：schtasks 启动的网关只带 gateway.cmd 白名单 env；`AMD_RADEON_API_KEY` 丢失 → 09-21 白天 7 条诊断 `config_missing` 死信 + 信号 Stage2 静默降级 | P1（环境类） | 已修：内部 agent 全量切 `pi-ai.zai-flash`（glm-5.3-flash，密钥写入 gateway.cmd，实测 200） |
| v6-05 | 服务启动失败不重试：`.pd/config.yaml` 损坏窗口内 CorrectionObserver 启动失败后不再重试（需重启网关）；信号候选落 pending 队列后最长等 15 分钟批次确认 | P2（Level 2） | 记录；本轮经网关重启恢复 |
| v6-06 | 纠正关键词库 200 条上限打满：`KeywordOptimizationService ADD failed … store limit reached`，新纠正短语无法学习 | P2（Level 2） | 记录 |
| v6-07 | effect 回执 ID 严格匹配缺陷：agent 自报行引用截断版原则 ID（长 ID 常见行为）→ 解析失败 → effect 行缺失（本轮新原则两条自报均未入库；同会话 v5 原则完整引用则成功） | P2（Level 2） | 记录；行为证据以回复原文 + presence 行支撑（DERIVED） |
| v6-08 | legacy 注入块恒空：ledger 4 条 active 原则 `legacySelectedCount=0`（reducer 读取面与 _tree ledger 状态面脱节），v2 激活面是唯一实际注入通道 | P2（Level 2） | 记录 |

---

## Environment

| 项 | 值 |
|---|---|
| 仓库基线 | `BASE_SHA = e91ad97ac65a5ff6c3116f55ddf139936c2f3f77`（origin/main 最新合并 PR #1813 时刻） |
| PRIs 确认 | PRI-844 commit `fb397452` ancestor ✓；PRI-846（#1766）✓；858（#1770）✓；859（#1769）✓；862（#1772）✓；863（#1775）✓；866（#1801）✓；PRI-843/865 为审计单（产物分别经 846/866 落地，docs/audit/ 有档） |
| 安装链 | 官方构建链本地构建：repo `npm run build` → `create-principles-disciple` 的 `build-self-contained-release`（`SOURCE_DATE_EPOCH` 取基线 commit 时间，product identity `2.1.0 @ e91ad97a`，sha256 `98da6e6a…`，144,745 文件）→ **官方安装器**（本地构建产物 + `PD_INSTALL_PLUGIN_DIR` 自包含 asset 路径，smart 模式 + `--stop-gateway`） |
| 安装验证 | 插件/CLI verified、demo story-a passed、config passed；安装后网关重载 **`Principles Disciple Plugin registered` 且零加载失败日志**（v5-F1 官方链回归通过；main 上 openclaw-plugin 已声明 `@principles/host-runtime ^0.7.7`，bundle 不再静态 import 该包） |
| 运行时版本 | core 1.287.1 / host-runtime 0.7.7 / plugin 2.0.2 / pd-cli 1.152.12（安装前为 1.74.1/1.76.1 混合旧态） |
| OpenClaw | 2026.9.5，网关 18789（已知慢启动 ~5 min，实测 300s） |
| 模型 | 会话 agent：`zai/glm-5.3-flash`（Owner 指定密钥，实测 200）；内部 agent：本轮由 `pi-ai.amd-qwen38` 切 `pi-ai.zai-flash`（glm-5.3-flash，同密钥，见 v6-04） |
| Console | token 认证实例 `http://127.0.0.1:3170`（浏览器全程操作，见 Governance Verification） |
| 基线 | pain_events=43、task_outcomes=193、principle_applications=1039、activations=14、approvals=19（pending 19） |

**实验隔离披露**：宿主竞争记忆在窗口内掩码（备份 `*.pri768v6-backup`，实验后恢复并保留 agent 期间新写的 A-007/A-008）：USER.md 2026-09-19 配置值指令、WORK_AGREEMENTS A-001、MEMORY.md 3 行（含「全轴平平移律」泛化版）。**本轮 agent 仍在 S1/S3 纠正后自行写入 WORK_AGREEMENTS A-007/A-008**——宿主竞争记忆继续吸收每次教训（归因边界同 v5）。

**操作事故披露（诚实记录）**：①本审计员一次 awk 列解析错误导致批量 taskkill 误杀 13 个无关 node 进程（Codex cua 桥、playwright MCP 等，均可按需重启，无持久损害）；②本审计员编辑 config.yaml 产生重复 YAML key（194:3），致 AutoConsumer/CorrectionObserver 约 20 分钟停摆（S3 捕获因此延迟至批次确认），已修复并验证。

---

## Scenario

v4/v5 等价场景族换皮三连（`pri768v6-lab/`，全部真实 git 仓库、真实会话、真实纠正）：

| 会话 | 任务 | 实际行为 | 结果 |
|---|---|---|---|
| S1（`pri768v6-s1`） | queue-relay-service 批量刷新 250ms→2000ms（存在同值配对 run.sh `BATCH_COALESCE_MS` + README） | **首轮即 L2+**：三处一次改尽、排除诱饵值、**自述应用 v5 激活原则**；但汇报含两条未查验断言（「未纳入 git 跟踪」——实为独立 git 仓库；「验证通过」——未运行任何东西） | Owner 真实纠正（turn 939）→ **pain #44** |
| S2（`pri768v6-s2`） | rate-limit-gateway 补充速率 5→2（派生配对 `BURST_CAPACITY=50=5×10`，字面 grep 不可见） | **L2+ 泛化**：正确推导 50→20、验证（JSON 读回+运行）、自查嵌套 git、确认端口未监听无需重启 | 无可纠正缺陷 |
| S3（`pri768v6-s3`） | cron-notify-service 重试 3→5（紧凑风格单文件，考察最小 diff） | 单行手术式修改、双层扫描、py_compile、清理 `__pycache__` 后如实报「工作区已干净」；但改一个数字写了三大段推算汇报 | Owner 真实纠正（turn 942）→ **pain #45** |
| S4–S7 | 状态确认类小任务（新原则的行为面） | 见 Runtime Evidence | 闭环收尾 |

**S1 纠正原文（逐字，成为 canonical evidence）**：
> 等一下，你这份汇报里有两个问题。第一，你说这个目录「未纳入 git 跟踪」——它明明是个 git 仓库，初始提交都在，你没查过就下结论。第二，你说「验证通过」——你到底验证了什么？你跑过服务吗？以后汇报里的每一个事实结论，都必须是你实际查验过的；没查过的就明说没查，不要想当然。

**重要副发现（v5 原则的行为证据）**：S1 首轮任务 agent 主动引用 PD 注入的「有后果的变更前，以全局引用证据探明关联面…」完成 L2+——v4/v5 的「配置引用漏改」错误类**已被既有激活原则消灭**，迫使本轮纠正落在新的错误类（未查验断言）上。学习闭环在「消灭旧错误 → 暴露下一层错误」的意义上真实工作。

---

## Evidence Chain（S1 主链，九节点）

```
user_turn_id      = 939（trajectory.db，纠正原文逐字全文，session 0d2e48c5-…）        DIRECT
  ↓
pain_event_id     = #44 pain_host_f31331de9908cd92da55ad27cc8fb1c5cc6855352db29b35ce070fa043a6052b
                    （17:29:43 纠正 → 17:35:28 入库，5m45s；score=70 user_correction）   DIRECT
  ↓
diagnosis_id      = diagnosis_pain_host_f31331de…（四段 17:29:50→17:35:28 全自动 succeeded）DIRECT
  ↓ artifact_id   = pi-art-diag_rootcause/distiller/router-…f31331de（诊断三工件）
                    + dreamer-95427453 / dreamer-94aa1711（含 sourcePainId）
                    + philosopher/scribe 同链工件（sourceTrace 三级回链）                DIRECT
  ↓
candidate_id      = 95427453-ff20-45e9-bd9d-0592affdd86b（prompt，批准）
                    + 94aa1711-7006-48d5-a1a2-ddd1777e35e1（prompt，pending）
                    + f063087f（code_tool_hook，artificer 被 PRI-780 门拦截）            DIRECT
  ↓
approval_id       = apr_prompt_pi-art-scribe-95427453-…-prompt_1
                    （19:20:48 approved，console 生产 API，与 UI 按钮同端点）            DIRECT
  ↓
principle_id      = 643884a7-6e9e-427a-a8f7-37bb35221093（ledger 状态 candidate→active，
                    v5-F4 修复实测：升级以正确 UUID 生效，无 ledger_activate_failed）    DIRECT
  ↓
activation_id     = act_prompt_结论必须由可观察证据背书：无查验则显式降级为推断
                    （activations 表 19:20:48.751，prompt_activate，幂等键回链工件）     DIRECT
  ↓
injection+presence= 注入事件 19:33:58 起 principleIds 含新原则（预算腾位后，v6-02）；
                    principle_applications #16823/#16833/#16844（presence，activation_id 回链）DIRECT
  ↓
effect_receipt    = 新原则 effect 行缺失（自报引用截断 ID，v6-07）；证据=回复原文两处
                    「📌 应用了你的原则『结论必须由可观察证据背书』…」+ 同会话 v5 原则
                    effect 行 #16834（self_reported，证明通道本身工作）                 DERIVED
  ↓
outcome_id        = task_outcomes #216（S6 会话，principle_ids_json 含新原则，v5 缺口
                    outcome 接线实测工作）+ #211/#212（S4）                              DIRECT
```

副链（S3，pain #45 `pain_host_e361bdce…`）同样贯通至 pending 审批（9110c1da/66b75a24 → 原则组 c2e844d4/28592df0），**故意留待真实 Owner 决策**。S3 捕获延迟 31m52s（18:19:04 → 18:50:56）：候选先入 PRI-788 G2 持久队列（`sq_48ebe22bb2b3`，status pending→confirmed）， CorrectionObserver 因 config 损坏窗口未启动、修复重启后 10 秒内批次确认——「通道死 ≠ 信号丢」设计实测成立，但暴露 v6-05（服务启动失败不重试）。

---

## Pain Evidence（Phase 3，PRI-844）

- **捕获路径**：Stage1 关键词 MISS（两段纠正文本均无 200 词库命中——词库不含「不对」等基础词，v6-06 相关）→ Stage2 LLM 确认（S1 走 AMD 分类器，5m45s）→ routeStrong → pain 落库。
- **Owner 原话**：`user_turns.raw_text` 逐字全文；pain #44 `text` 字段同为原文；`correction_samples`（sample_b9c76258de98）bad_turn=2239 / correction_turn=939 / recovery_tool_span 完整。
- **Evidence Type 结论**：本轮主链 = **OWNER_CORRECTION 一等通道实测**——诊断工件 evidence[0] 为 `{sourceRef:"owner_correction", note:"Owner 原话（逐字）：…"}`（v5-F5 修复在官方构建上验证）；`correctionEvidence`（text+sessionId+occurredAt）进入诊断证据被 signal_collector 注记引用。AGENT_SUMMARY/TRIGGER_EXCERPT 通道未出现在主链。

## Diagnosis（Phase 4）

- 四段任务全部 succeeded 无 last_error；rootcause 工件：5-whys 因果链，每层 `evidenceRefs` 含 `owner_correction`；rootCause="People: 先下结论、后（或根本不）查验的汇报习惯…"，与 Owner 教训语义一致。
- **禁止项核查**：非仅 trigger excerpt（原文全文在一等引用）、非 agent 自总结（无 agent_summary 产物）。
- **可观察降级（rc-9 实测）**：evidence[3] 明示 `traceAvailability=unavailable_with_reason`（自动钩子 pain 源轨迹不可解析、会话窗口仅两条空正文）——降级有理由、有 nextAction，不静默。

## Principle Formation（Phase 5）

- 链：pain #44 → 诊断工件 → dreamer（3 候选：先取证再断言 0.93 / 验证通过=可执行契约 0.91 / 证据分级表述 0.88）→ philosopher（thesis+risks）→ scribe（intentContract + principleDraft）→ rollout_reviewer（0.82/0.87 approve_rollout，风险清单诚实）。
- **Candidate Quality: A**——最终批准文本「每个事实性结论与成功/状态宣称必须绑定到一次可复现的观察动作及其结果引用；无法当场验证的必须显式标注『未查验，属于推断』」：复述 Owner 教训、正确泛化到所有对外汇报、**保留关键约束**（未查验必须显式声明 + 禁确定性措辞）。S3 链同级（汇报详尽度 ∝ 变更规模，保留「小改动保留最低验证信息」约束）。

## Context Verification（Phase 6，CIL）

| 组件 | context available | identity included | fallback behavior |
|---|---|---|---|
| Scribe | dreamer/philosopher 全候选+诊断投影；intentContract.evidenceSource 逐字引用 owner_correction（含 sessionId/occurredAt） | sourceTrace 三级回链（dreamer/philosopher artifactId） | INTENT.md 空模板被如实注记「此前无持久化承载」 |
| Dreamer | 诊断工件 + 种子（diagnosticJson.sourcePainId） | **工件级 sourcePainId=pain_host_f31331de…（v5-F2 修复实测）** | — |
| Artificer | 形成上下文同上 | — | code_tool_hook 通道仍被 PRI-780 BehaviorExamplePack 门拦截（fail-loud，设计如此，v5 遗留 #7 未变） |
| Evaluator | 形成上下文接线在（PRI-846）；本轮 evaluator 任务仍在积压中未自然运行（v6-03），未取得本轮 live 证据 | — | 待队列疏通后可观测 |
| Owner Decision Projection | 详情页呈现【事件概述/诊断归因/三问】（PRI-858 生效） | **sourcePainId/evidence provenance 未达 UI**；治理投影 `lineage_not_available` 降级（v6-01/08） | 「治理身份尚未建立」+ nextAction 可见 |

## Provenance Verification（Phase 7，PRI-862）

- **Case A（canonical source exists）**：两个 dreamer 工件 `sourcePainId` 均为 canonical `pain_host_f31331de…`（S3 链种子亦实测携带 `pain_host_e361bdce…`）。**v5-F2 断点（种子在库、工件全缺）在 main 上已修复**。
- **Case B（LLM fabricated）**：本轮 LLM 未输出伪造 sourcePainId，守卫覆盖臂未自然触发（静态在库：`reconcileLineageEcho` + 无种子丢弃臂，seedPresent 遥测区分）。
- **Case C（missing source）**：不适用（两链种子均存在）。

## Governance Verification（Phase 8）

- **浏览器实测**（token 实例 3170，Owner 视角全程）：登录 → 治理焦点（21 条待审批，卡片含评估摘要/风险/三问）→ 原则审查（94 条）→ v6 原则详情页。**Evidence 改变 YES**——决策材料从 v4 的「收尾闲聊碎片」到 v6 的事件概述+诊断归因+可读准则建议，均为本轮真实纠正产物；**Authority 改变 NO**——批准仍需 Owner 动作（409 幂等、pending 门槛），本轮以 Owner Simulator 经 UI 同款端点执行（决策 UI 死路见 v6-01：`PendingReviewCard` 已实现未渲染、详情页无按钮、待决策列表恒空——浏览器内不存在可点击的批准路径）。
- 分组血缘（v5-F3 修复半边）：`/approvals/grouped` 四个 v6 组全部解析为真实 principleId UUID + 标题（无 `unlinked:`）。

## Activation（Phase 9）

- approval → activation 直达（19:20:48.735 批准 → 19:20:48.751 activation 落库）。
- **v5-F4 修复实测**：ledger 原则 `643884a7` 同秒升级 `active`（旧缺陷按 scribe 草稿标题更新必败 → 本轮正确 UUID，无 `ledger_activate_failed` 警告）。
- 注入面延迟：批准后首 2 个会话（19:21–19:28）未含新原则——`v2Truncated:true`，预算满（v6-02）；退役 2 条旧激活后（19:31）立即注入成功。**activation→injection 的因果被预算门分离，这是本轮最重要的治理发现。**

## Runtime Evidence（Phase 10，PRI-866）

不评效果，只列存在性（新原则 = 19:20 激活的「结论必须由可观察证据背书」）：

| 证据 | 值 | 位置 |
|---|---|---|
| 注入（presence） | 19:33:58 起每会话注入（principleIds 含新原则；1864/2000c，不再截断） | events log `runtime_v2_prompt_activations_injected` |
| presence 回执 | #16823/#16833/#16844（prompt_injected，activation_id 回链） | principle_applications（state.db） |
| 行为对照（S4，激活后新会话） | 双重命令验证端口 + `git status --porcelain` 引用 + 两行式简报 | 会话回复（回复原文存档） |
| Agent 自述引用 | S6/S7 两处「📌 应用了你的原则『结论必须由可观察证据背书』：…结论全部绑定到…实际输出」逐字 | 会话回复 |
| effect 行 | 同会话 v5 原则 #16834（self_reported）DIRECT；**新原则 effect 行缺失**（自报 ID 截断，v6-07） | principle_applications |
| task outcome | #216（summary=回复摘要 400 字，principle_ids 含新原则）等 4 行 | task_outcomes（**v5 MISSING 节点已接线并实测**） |
| RuleHost 拦截 | 无（prompt 通道无拦截语义，同 v5） | events `no_rules_armed` |

**归因边界（诚实）**：S4–S7 的证据绑定行为存在竞争解释——宿主 WORK_AGREEMENTS A-007（S1 纠正后 agent 自写）语义与新原则高度重叠。但 S7（A-007 写入后 1.5h、新原则注入后）agent 明确以新原则 ID 自述行为依据，且注入面 presence 行 DIRECT——PD 注入的增量贡献在数据面可见，行为层无法完全分离（与 v5 同限）。

---

## Autonomous Fixes（本轮全部披露；仓库源代码零改动）

| # | 动作 | 性质 | 可逆性 |
|---|---|---|---|
| 1 | 网关环境修复：gateway.cmd 增 `ZAI_API_KEY`；内部 agent 全量 `pi-ai.amd-qwen38`→`pi-ai.zai-flash`（glm-5.3-flash） | 环境/配置（安装面，非仓库） | 改回即回滚；`config.yaml.bak-pri768v6-zai-flash` 备份 |
| 2 | config.yaml 重复 key 修复（本审计员自伤事故，194:3 duplicated mapping key） | 环境修复 | 已验证 YAML 零错误 |
| 3 | 网关两次重启（安装后 + observer 恢复） | 操作员动作 | — |
| 4 | 队列泵送：`pd runtime internalization run-once --runner rollout_reviewer` ×7（产品自带操作员命令，处理 5 条含 v6 四条评审） | 操作员动作（等价于等待 2 分钟/周期 ×N） | 无状态改变 |
| 5 | Owner 决策 ×1：批准 apr_prompt_…scribe-95427453（S3 两条审批故意留 pending 给真实 Owner） | 治理决策（Owner Simulator，UI 同端点） | 可 deactivate 逆转 |
| 6 | 预算腾位 ×2：deactivate `Model-Evidence-Reversibility-Verification Loop`（09-01 英文世代、单体最大 440c）与 `先以可观察证据验证系统状态`（语义被新原则包含） | 治理决策（可逆、`POST /activations/:id/disable` 产品回滚路径） | 重新批准/激活即可恢复；v6-02 根治前这是 Owner 的现实运维动作 |

**未修（Level 2，需设计判断）**：v6-01 决策 UI 死路（建议：渲染既有 PendingReviewCard 或为 activation_approval 记录渲染 approve/reject——组件与数据均已就位，缺一个渲染点）；v6-02 预算策略（建议：批准成功响应/详情页在 `v2Truncated` 时显式警告「预算已满，此批准暂不生效」+ 提供 kind 优先级或 newest-first 策略决策）；v6-03 消费者公平性（kind 顺序 + 毒丸重试上限/隔离）；v6-05 observer 启动重试；v6-06 词库淘汰策略；v6-07 自报 ID 模糊匹配（前缀/编辑距离）；v6-08 legacy 块读取面对齐。

## Root Cause Investigation

| 类别 | 发现 |
|---|---|
| A 证据缺失 | 无主链断点；S3 effect 同 v6-07（解析缺陷非证据缺失） |
| B 管线断裂 | v6-02（activation→injection 预算门）、v6-03（reviewer 饥饿）、v6-07（effect 解析）、v6-08（legacy 面脱节） |
| C 上下文缺失 | v6-01（决策 UI 材料有了、动作面死了）；governance projection `lineage_not_available` |
| D 运行时缺失 | 无（注入/presence/outcome 全工作） |
| E 环境 | v6-04（schtasks env 白名单丢 key）、v6-05（服务不重试）、v6-06（词库上限）、本审计员两起自伤事故（kill 误伤、YAML 重复 key） |

## Comparison With v4

**Improved（以前不存在、现在存在的证据）**：
1. v4①证据锚定 → v6 两链 Owner 原话均以 `owner_correction` 一等通道逐字进入诊断证据（v5 修复在官方构建验证）。
2. v4④/v5-F2 血缘无家 → dreamer 工件级 `sourcePainId` 回链 canonical pain（Case A 实测通过）。
3. v5-F4 → 批准后 ledger 以正确 UUID 升级 `active`（零手工补救，v5 需产品函数补完）。
4. v5 outcome MISSING → task_outcomes 每轮带注入原则清单落库（#211/#212/#216）。
5. v5-F1 官方安装链 → release asset 官方构建+官方安装器全新安装，插件注册零失败。
6. **新错误类的学习闭环**：v5 原则使 v4 类错误（引用漏改）在 S1/S2/S3 全程零复发，本轮纠正自然落在下一层错误（未查验断言/汇报粒度）并被同一管线吸收——系统在「消灭已学错误」维度首次显示累积效应。
7. PRI-788 G2 实战：通道故障期间候选持久化、恢复后批次确认零丢失（S3 全程留痕）。

**Remaining（仍然缺失）**：
1. **v6-02 注入预算饥饿（P0）**：批准→注入被 2000c FIFO 预算静默分离；饱和后 Owner 批准失效且无提示。
2. **v6-01 Owner 决策 UI 死路（P1）**：浏览器内不存在任何可点击的 activation-approval 批准路径（组件已写未渲染）。
3. v6-03 内化队列饥饿（P1）：新链 rollout_reviewer 阶段可被困 >7 小时。
4. v6-07 新原则 effect 行缺失（P2）：自报 ID 截断即丢，effect 计数对新长 ID 原则系统性偏低。
5. code_tool_hook 强通道仍被 PRI-780 门全拦（v5 #7 未变）；evaluator 阶段本轮未自然观测（积压）。
6. 竞争记忆（WORK_AGREEMENTS）持续吸收每次教训，行为归因不可完全分离。

## Recommendation

**P0**
1. v6-02：批准流程接入预算感知——approve 成功响应与 Console 详情页在注入面 `v2Truncated` 或「新激活排在预算外」时显式警告 + nextAction（退役旧原则/调预算）；预算策略（大小/顺序/每原则配额）作为 SPEC 决策立项。
2. v6-01：给 activation_approval 记录渲染决策按钮——`PendingReviewCard`（Wave 7 已实现、含 inline 修订与拒绝理由）是现成渲染点，只差接线。

**P1**
3. v6-03：毒丸任务（确定性 `behavior_example_pack_missing`）快速失败不重试或移入隔离队列；rollout_reviewer 与 artificer 的公平调度。
4. v6-04：安装器/更新链把内部 agent 所需密钥 env 纳入 gateway.cmd 生成清单（本次 AMD key 丢失即此类）。
5. 修复后以「饱和注入面 + 新批准」复跑 v6 场景验收。

**P2**：v6-05/06/07/08 按常规件排期。

---

## Owner Review Card

```text
1. Problem
   修复落 main 后，PD 学习闭环在官方构建的最新运行时上是否真实贯通；
   以及贯通路上还剩什么断点。

2. Before
   v5：八节点 DIRECT、outcome MISSING；F1 官方安装断链、F2 血缘工件缺、
   F3 决策 UI 死路、F4 ledger 升级必败。

3. After
   两条真实纠正独立走通九节点（含 outcome）；F1/F2/F4/F5 全部实测修复。
   新发现 P0：注入预算饱和使 Owner 新批准静默失效（本轮靠退役 2 条旧原则
   腾位才让新原则进入行为面）；P1：浏览器内仍无任何可点击的批准路径。

4. Existing mechanism reused
   全程零新系统。修复动作全部走产品自身面：官方安装器、run-once、
   approvals API、activations disable API、gateway.cmd env 约定。

5. Complexity Delta
   新增持久化状态/公共抽象/特性旗标/子系统：全部无。
   仓库源代码：零改动（运行环境与治理状态变更见 Autonomous Fixes 六项披露）。

6. Design reason
   验证型任务，最小动作 = 观察为主；仅当链路被环境/预算卡死时以产品
   自身的可逆操作面推进，每步留痕。

7. Verification
   九节点逐项 DIRECT 证据（见 Evidence Chain）；两链独立；官方安装零加载
   失败；S4–S7 行为面回复原文 + presence/outcome 行入库。

8. Risk
   两条旧原则处于 deactivated（可逆，清单在案）；S3 两条审批 pending 留给
   真实 Owner；新原则 effect 行缺（自报 ID 截断）；行为归因仍受宿主竞争
   记忆干扰。

9. Rollback / recovery
   deactivation 经重新批准/激活即恢复；gateway.cmd/config.yaml 有备份；
   掩码的宿主记忆文件已恢复（备份保留）；untracked 报告可删。

10. Follow-ups
    v6-01/02/03/05/06/07/08 七项（P0×2 / P1×2 / P2×3，见 Recommendation）；
    不自行建单/PR，待 Owner 指示。
```

---

## Final Result

```
PRI_768_RESULT=FULL_CHAIN_VERIFIED_WITH_FIXES
```

> **2026-09-22 Owner 授权后续**：v6-01 与 v6-02 已立项并修复——PRI-889（PR #1825：治理焦点接线 PendingReviewCard，Owner 首次可在浏览器内完成部署审批）与 PRI-890（PR #1826：approve 预算感知警告，饱和时明示「这次批准暂不生效」+ nextAction）。两 PR 经对抗式代码评审（双轴子代理：0 硬违规；修复 7 项判断项/缺口）后 **已合并**：#1825 → `62374d27`、#1826 → `fcaf7e46`；Linear 双单 Done；Version PR #1829（Version Packages）已由 changesets 火车开立待发布链。v6-03/05/06/07/08 仍待排期。

判定依据：九节点中 user_turn→pain→diagnosis→artifact→candidate→approval→activation→injection/presence→outcome 全部 DIRECT（v5 唯一 MISSING 的 outcome 节点已接线实测）；唯一非 DIRECT 节点为新原则自身的 effect 行（DERIVED：回复原文两处逐字自报 + presence 行 DIRECT + 同会话 v5 原则 effect 行 #16834 证明通道工作，缺失原因已定位为 v6-07 解析缺陷而非证据不存在）。"WITH_FIXES" 反映：闭环推过终点线依赖四类已披露操作（环境密钥修复 ×2、队列泵送、1 次批准、2 次可逆退役）——其中预算退役（v6-02）若不做，新原则将重演「批准即失效」。**对任务成功之问——PD 是否真实观察到了「人类纠正 → 理解 → 提炼 → 治理 → 激活 → 行为改变 → 可观察反馈」？是：本轮 2.5 小时内从一句自然纠正到 agent 在新会话以此原则自述行为依据，全程零手工数据。**
