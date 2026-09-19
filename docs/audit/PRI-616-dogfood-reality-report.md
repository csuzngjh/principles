# PRI-616 Dogfood Reality Report

> 任务：观察 PD 在真实使用环境中的运行情况，收集第一批 dogfood 数据。
> 本报告为**观察交付物**：未修改任何代码、未创建 PR、未新增数据结构/埋点/Runtime；对 state.db 全程只读（两个独立观察者分别只读打开，零写入）。
> 结论一句话：**PD 已经真实住进 Agent 的日常工作，但"从错误里长出新规矩"的主路目前只走通过一次，且最近已经停摆。**

---

# Executive Summary

**PD 是否进入真实使用阶段？ PARTIAL**

大白话：PD 不再是实验室样品。过去 18 天里，它真实记录了 26 个 Pain（其中 7 个来自真实使用中的用户纠错）、把原则注入了 543 个以上的真实会话（618+ 次），人类 Owner 真的在 Console 里批准过、拒绝过、叫停过。今天的外卖实测（3 个真实小任务）里，Agent 两次主动"报出"自己为什么这么做——引用的正是 PD 注入的原则。**产品确实在被使用。**

但主干链条是另一回事：26 个 Pain 里只有 **1 个**走完了"纠错 → 诊断 → 原则候选 → Owner 批准 → 激活 → 注入 → 验证 → 撤销"的全程（且其中唯一一次真实拦截发生在受控验证场景，不是自然发生的）；**09-17 之后整条加工管线停摆**（最新 4 个真实 Pain 长出的 9 个候选全部停在"待审/未加工"门口）；"行为是否真的变好了"只有 Agent 自己的口头自述，没有任何独立证据。

比喻：PD 像一套已经入住的房子——水电（注入）天天在用，但"投诉 → 立规矩"的办事窗口最近关门了，而且没有人统计过立了规矩之后住户是不是真的 fewer 犯错。

---

# Environment

| 项 | 值 | 备注 |
|---|---|---|
| PD | CLI 1.74.1 (bundled-1.74)；插件升级史终值 1.245.2（09-16） | 两套版本号并存，口径未闭合（见 Reality Gaps） |
| Host | OpenClaw 2026.9.4（gateway loopback 127.0.0.1:18789，运行中） | 6 个 agent（main/dreamer/philosopher/scribe/artificer/evaluator）共用工作区 D:\.openclaw\workspace |
| Model | 内部 agents 走 glm-5.3 @ bigmodel（pi-ai.glm，reasoning high）；观察者通道 qwen3.8-27b @ 本地 8080（pi-ai.ninfer） | 另配 13+ 备用 profile |
| 数据窗口 | 2026-09-01 12:26Z（建库）→ 2026-09-18（注入仍在实时发生） | 管线活动止于 09-17 04:58Z |
| 观察方式 | **18 天回溯数据（真实使用残留）+ 单日主动 dogfood（2026-09-18T16:12–16:36Z，3 个真实任务走真实入口）** | 任务建议 ≥7 天前瞻观察；本次为首个切片，**未满 7 天，如实声明**。今日 dogfood 用户由 AI 按 Owner 指令扮演（走真实入口），历史数据反映真实人类 Owner 的使用 |
| 数据源 | state.db（只读）、`pd` CLI 只读子命令（pain list / trace / principles stats）、workspace 配置与日志文件 | 全部断言可按附录查询清单复核 |

---

# Usage Snapshot

| Metric | Count | 说明 |
|---|---|---|
| Sessions（被注入过原则的去重会话） | 543+（其中 UUID 形态真实宿主会话 392 个） | principle_applications.session_id |
| Pipeline Tasks / Runs | 437 / 652 | 全部为 PD 内部加工任务（诊断/dreamer/scribe/…），非用户行为本身 |
| Pain Events | **26** | user_correction 7、manual 17、tool_failure 1、user_empathy 1；分布在 09-01→09-17 共 11 天 |
| Principles（ledger） | candidate 48 / active 2（共 50） | principle_training_state.json `_tree.principles` |
| 候选（principle_candidates） | 63（consumed 50 / pending 13） | recommendation_kind：principle 23 / rule 22 / implementation 9 / prompt 8 / defer 1 |
| Approvals | 6（approved 3 / rejected 2 / **pending 1**） | 全部发生在 09-15 一天内；1 项 high-risk 至今挂起 3 天 |
| Activations | 4（今日仍活跃 1） | prompt 激活 2、code_tool_hook shadow 1、live 1（验证后已撤销） |
| Observed Reuse（原则注入/生效记录） | **625（观察持续增长中）** | prompt_injected(presence) 556+、self_reported(effect) 61+、rule_blocked 1 |

---

# Real Cases

## Case 1 — 唯一走完全链的真实纠错（pain_host_cffdcb9f…）

- **Task**：Owner 在真实使用中纠错 Agent（09-15T00:18Z，user_correction，score 70 severe）。
- **Agent Behavior**：（pain 所指的被纠正行为，详情在 pain 原文中，state.db 不存原文——见缺口）。
- **Owner Feedback**：真实自然语言纠错，被 PD 捕获为 user_correction pain。
- **Pain**：PRESENT（`pd pain list` 可见，host=openclaw）。
- **Principle**：PRESENT ×2 —— 诊断管线（diagnostician → rootcause → distiller → router，run 耗时 151s）产出原则候选 f1c85fcb / 7638bb5d，落入 ledger 为「基线锚定与不可劣化护栏」等 2 条。
- **Activation**：PRESENT ×3 —— prompt 激活（09-15 13:22，19 分钟后 Owner 主动停用）；code rule shadow 激活（观测窗 shadow_summary：observed 340 / matched 3 / wouldBlock 3，10 项 safety gate 全过）；code rule live 激活（09-17 07:45 Owner 经 Console 授权提升，**2 分钟后发生 1 次真实拦截**，07:54 Owner 验证完成后主动撤销）。
- **Follow-up Observation**：12 次注入记录在案（含真实会话与验证会话）；3 条 activation_decisions 全部带 console_token + Owner 中文授权语。**这是 PD 闭环存在的直接证明——但注意：那次拦截发生在程控验证 fixture 会话（D:/pd-labs 下的演练文件），尚无对自然真实会话的 code 通道拦截记录。**

## Case 2 — 最新真实纠错，链停在候选（pain_host_85731899…，09-17T04:58Z）

- **Task**：Owner 真实纠错（user_correction，score 70 severe）。
- **Pain / 诊断 / 候选**：全 PRESENT（诊断 138s 跑完，产出 3 个候选：principle/rule/prompt 各 1）。
- **Principle**：ledger 落了 3 条，全部 status=candidate。
- **Activation**：**MISSING**。Approval：**MISSING**。注入：**MISSING**。
- **Follow-up**：这就是"停摆"的活标本——链走到 Owner 门口就停了，而且没有催办机制，Owner 侧也没有明显入口知道"有 3 条新规矩等你裁"。

## Case 3 — Owner 手工录入的 Pain（manual_1789398236238_04iyw2k7，09-14 HUD 覆盖事故）

- **Task**：月饼 MV cron 循环 HUD 覆盖事故后，Owner 手工补录 pain（score 80 severe）。
- **Pain / 诊断（重试 3 次后成功，pain→task 延迟 54 分钟）/ 候选**：全 PRESENT。
- **Principle / Activation**：ledger 2 条 candidate 态；Approval/Activation **MISSING**。
- **Follow-up**：说明 manual 通道也能进管线，但同样停在审批前。

## Case 4 — 注入量最大的原则不是从 Pain 长出来的（Model-Evidence-Reversibility-Verification Loop）

- **Task**：09-01 建库当天由种子 ledger T-01 经 dreamer→philosopher→scribe→evaluator(修复 2 轮)→rollout_reviewer 产出，09-01 15:44Z 激活，至今活跃。
- **Behavior 证据**：556 次 presence 注入覆盖 543 个会话（多数会话恰好 1 次）+ 61 条 self_reported effect（Agent 用中文自述"我这次先跑了再报"之类的行为依据）。
- **今日 dogfood 直接观测**：今天 3 个任务里，Agent 有 2 次在回复末尾主动标注「📌 应用了你的原则『Model-Evidence-Reversibility-Verification Loop』」，且归因内容与当轮行为真实对应（一次是"不直接宣称脚本可用，先实际运行核对退出码"；一次是"用 TEMP 演示目录验证、跑完即清理"）。第二次同类任务明确沿用了第一次的防御风格——**Candidate Evidence：注入的原则与可观察的行为改变同时出现**。
- **Follow-up**：注意该原则**不在 ledger 50 条清单内**——它的身份/存放机制与 pain 长出来的原则不同源（见缺口）；且"行为改变是否因为注入"仍无法排除"模型本来就这么做"。

## Case 5 — 今天的主动 dogfood 会话（pri616-dogfood-t1/t2/t3）

- **Task**：3 个真实小任务（版本差异调研 / 写目录统计脚本 / 写目录对比脚本），全部经 `openclaw agent` 真实入口完成，产物落在 D:\pd-labs\pri616-dogfood\ 并经 AI 用户亲手验证可用。
- **Agent Behavior**：三战三捷，零纠正需求（行为都在预期内，按"行为正常不硬纠"纪律未发纠正语）。
- **Owner Feedback**：无（无需纠正本身就是数据：注入第 18 天，Agent 基础行为纪律稳定）。
- **Pain**：**零新增**（最后一条 pain 停在 09-17T04:58Z）。
- **Principle**：无新候选；但账本今日新增注入 5+ 行，其中 pri616-dogfood-t1 1 行 presence + t2/t3 的 2 条 self_reported effect（**今日首次出现 effect 行**）。
- **Activation**：无需（既有激活持续生效）。
- **Follow-up Observation**：① PD 的"存在感"对用户可见的只有那两行原则归因——安静、不吵、落点准确（用户直感原话："今晚 PD 最像'存在'的瞬间，是它让我明白这智能体为什么不急着说完成"）；② **暴露一个观测盲区**：会话中途 gateway 被一次来历不明的 CLI stop 打停（16:21:20Z，疑似与同机活跃的 mooncake cron 循环有关，无法定论），计划任务 9 分钟后自愈；期间客户端连续拿到 3 次纯报错（"报错却悄悄做完了"），而**PD 对这次基础设施中断零记录**——没有 pain、没有 evidence。

---

# Evidence Chain Status

| Chain | Status | 证据要点 |
|---|---|---|
| Pain→Principle | **PARTIAL** | 26 pain → 39 诊断任务 → 23 诊断工件 → 63 候选；但最近 4 个真实 pain 的 9 个候选全部停在 candidate 态 |
| Principle→Approval | **PARTIAL** | 仅 Case 1 的 1 个 pain 走到批准（6 项审批全属它）；且 3 项批准 note 自述为 AI-as-Owner 受托代批 |
| Approval→Activation | **WORKING（仅此一段）** | 4 次激活齐全，含 shadow→live→验证后撤销的完整安全演练；Owner 经 Console 真实授权 |
| Activation→Turn（注入） | **WORKING** | 625 行注入、543+ 会话、持续 18 天、今日仍在发生（观察期间 618→625） |
| Turn→Behavior | **WEAK / Candidate** | 61 条 effect 全是 Agent 自述 + 今日 2 条可见归因与行为吻合；无独立观测 |
| Behavior→Outcome | **MISSING** | 零结果数据；ledger 两条 active 原则的 valueScore/adherenceRate 从未回填（全为 0）；唯一一次拦截发生在受控 fixture |

---

# Reality Gaps

## Data Gap（缺数据）
1. **Pain 原文不入库**：`pain_diagnosis_persistence: enabled: false` → pain_diagnoses 表恒空；"用户到底说了什么"在 state.db 完全不存在，只有哈希 id 渗透引用。回溯审计只能靠 CLI 视图，无法 SQL 复核。
2. Pain 主存储文件不可定位（26 条 canonical pain 由 Runtime v2 bridge 提供，D:/.openclaw 下找不到承载文件）。
3. `logs/daily-stats.json` 仅有 2 天文件且**所有计数器为 0**——统计管道没在计数。
4. approvals.decided_by 全为泛化 'operator'，无 Owner 身份字段（身份只存在于 activation_decisions）。
5. 注入记录无"被阅读"证明：625 行里 tool_name 617 行为 null；digest 仅 self_reported 有。

## Product Gap（用户无法完成流程）
1. **管线自 09-17 04:58Z 停摆**：12 dreamer + 12 artificer 任务 pending、33 retry_wait、307/320 工件 validation pending、13 候选未消费——最新的错误经验正在过保质期。
2. **审批无催办**：1 项 high-risk 审批挂起 3 天无人知道；最近 9 个候选没有任何"等你裁决"的用户可见入口信号。
3. **基础设施中断是观测盲区**：gateway 停机窗口内的工具失败不产生任何 pain/evidence（今天实测复现）；且停机期间用户体验为"纯报错、不知任务其实已完成"。
4. 版本口径分裂：CLI 1.74.1 vs 插件升级史 1.245.2，Owner 无法回答"我装的是什么版本"。

## Evidence Gap（无法证明）
1. Turn→Behavior：effect 只有 Agent 自述，无独立行为观测。
2. Behavior→Outcome：完全空白。今天 dogfood 的"行为一致 + 主动归因"是迄今最好的 Candidate Evidence，但仍无法排除"模型本来就会这么做"。

## Capability Gap（真缺能力）
- 未发现。全链机制已被 Case 1 完整证明存在且可运行——当前缺的是**流量、持续运转和独立证据**，不是缺机器。

---

# Recommendation

**Continue Observation。**

理由：真实使用信号明确存在且在增长（注入 18 天不间断、今日仍有 effect 首证），全链能力已被证明一次；现在下"有效/无效"的结论为时过早，下"方向错误"的结论更无依据。本次未满 7 天前瞻观察，建议以本报告为基线继续观察。

但有三件**观察中撞见的阻塞事实**需要 Owner 知悉（不属于本任务动手范围）：
1. 管线停摆 + 9 个候选积压 + 1 项 high-risk 审批挂起 3 天——错误经验在过期；
2. gateway 停机观测盲区 + daily-stats 全零——证据采集面有洞；
3. Pain 原文不入库——日后想做任何有效性回溯都没有原料。

**给 Owner 的简单选择**：
- **A. 继续观察**：什么都不动，过 5-7 天用同一套查询再看一次（本报告附录即查询清单）；
- **B. 先通阻塞再观察**：先安排一次 Console 审批清理（把积压候选裁掉/批准）+ 排查 09-17 后管线停摆原因，然后继续观察。

（倾向：B。因为"观察有效"的前提是管线活着——现在链路尾部堵住，继续观察只会积累更多停在门口的候选，观察不到新链路。）

---

# Owner Review Card

1. **Observation Period**：2026-09-01 → 09-18（18 天回溯）+ 2026-09-18T16:12–16:36Z 单日主动 dogfood。**未达任务建议的 7 天前瞻观察，如实声明**；建议以本报告为基线继续。
2. **Environment**：PD 1.74.1（CLI）/ 1.245.2（插件升级史）· OpenClaw 2026.9.4 · glm-5.3 @ bigmodel + 本地 qwen3.8 观察通道 · 单 workspace 单机回环部署。
3. **Usage Facts**：26 pain（7 真实纠错）/ 63 候选 / 6 审批（含 2 拒绝 1 挂起）/ 4 激活 / 625 注入覆盖 543+ 会话 / Owner 真实治理动作 4 次（停用×2、提升×1、撤销×1）。
4. **Real Cases**：5 个（1 个全链闭环、2 个停在审批前、1 个非 pain 来源的高频注入原则、1 个今日实测含盲区事故）。
5. **Evidence Chain**：Pain→Principle PARTIAL；Approval→Activation WORKING；Activation→Turn WORKING；Turn→Behavior WEAK（自述级）；Behavior→Outcome MISSING。
6. **User Value Signals**：有。Owner 主动批准/拒绝/叫停/提升（带中文授权语）、18 天注入持续到达真实会话、今日 Agent 两度主动引用原则且行为吻合、Owner 运维轨迹密集（15 次升级、8 份配置备份）。无价值量化数据（全为 0）。
7. **Evidence Gaps**：Pain 原文未持久化；行为改变无独立观测；结果数据为零；统计管道未计数；审批无催办入口。
8. **Recommended Next Step**：Continue Observation；建议 Owner 先做一次积压裁决 + 停摆排查（选择 B），否则观察只能看到更多"停在门口"的候选。
9. **What NOT to Build**：不要建 Effectiveness Score / Behavior Ranking / Learning System（数据远不足以支撑，且违反本任务 Non-Goals）；不要为新遥测立新系统（先修已有 daily-stats 不计数）；不要为"防 gateway 停机"新建子系统（先如实记录该盲区，交 Owner 定级）。

---

# Completion Criteria（任务五问）

1. **是否有人真实使用 PD？** 是。18 天持续：26 个 pain 来自真实使用与 Owner 手工录入；Owner 在 Console 做过 4 次治理动作；注入持续到达 543+ 真实会话。
2. **是否产生真实 Pain？** 是。26 条，其中 7 条 user_correction 为真实宿主纠错（09-15→09-17 连续三天都有），另有 1 条 tool_failure、1 条 user_empathy、17 条 Owner 手工。
3. **是否形成真实 Principle？** 部分。63 个候选、ledger 50 条（48 候选 2 激活）；真正走完批准并激活的原则来自 1 个 pain；另有 1 条高频注入原则非 pain 来源。
4. **是否出现重复使用？** 是。注入连续 18 天未断（观察期间仍在涨 618→625）；pain 录入跨 11 天；Owner 升级/调配置 15+8 次；今天 AI dogfood 用户三次会话中 Agent 行为风格延续。
5. **最大证据缺口是什么？** **Behavior→Outcome 完全空白**（没有任何独立证据表明原则注入后行为真的变好、错误真的变少），其次是 Pain 原文未持久化导致回溯不可行。

---

## 附录：复核查询清单

- 库：`new DatabaseSync('D:/.openclaw/workspace/.pd/state.db', { readOnly: true })`（node ≥22.5）
- 分组：`tasks GROUP BY task_kind,status`；`runs GROUP BY runtime_kind,execution_status`；`principle_candidates GROUP BY status,recommendation_kind`；`principle_applications GROUP BY kind,level` / 按天 `substr(created_at,1,10)`
- 漏斗：approvals / activations / activation_decisions / activation_control_states / activation_evidence_snapshots 全表（行数 1-6，直接看）
- Pain：`pd pain list --json --limit 40`（count=26）；`pd trace show --pain-id <id>`（Case 1/2/3 已验）
- Ledger：`D:/.openclaw/workspace/.state/principle_training_state.json` → `_tree.principles`（50 条，candidate 48 / active 2）
- 环境：workspace `config.yaml`（模型/开关/`pain_diagnosis_persistence: enabled:false` 在 121-123 行）、`update-history.json`（15 条）、`logs/events_*.jsonl`（4 条 governance_action）、`logs/daily-stats.json`（全零）
- 观察临时脚本：`C:\Users\Administrator\AppData\Local\Temp\pri616_db_snapshot.mjs`（表计数快照，可重跑对比）

*报告生成：2026-09-18（UTC），PRI-616 Reality Observer。观察结束，停止行动，等待 Owner Review。*
