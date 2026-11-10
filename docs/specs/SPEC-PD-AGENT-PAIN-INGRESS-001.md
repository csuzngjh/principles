# SPEC-PD-AGENT-PAIN-INGRESS-001

**Version:** 0.8
**Status:** Development Baseline (anchor-based pain definition; Owner 追加裁定 1–3)
**Type:** Cross-host Agent-assisted Pain Submission
**Scope:** Principles Disciple / MCP / OpenClaw / Codex / WorkBuddy

> 本版是**产品合同的定义性修订**：Pain 的定义、Agent 判断规则、内容结构、严重度语义被整体替换，不是增量叠加。
> 与 V0.6 冲突的旧定义已在正文中明确标注"已删除"，不得继续作为实现或验收依据。

---

## Revision History

### v0.8 — 2026-11-10（Owner 追加裁定 1–3）

> **本轮只落文档，代码尚未修改。** 下表"当前代码事实"是实现前的真实行为，"目标行为"是本版要求实现阶段达到的行为。

| # | 裁定 | 当前代码事实 | 目标行为 | 落点 |
|---|---|---|---|---|
| 1 | `pd pain record` 默认严重度 | 省略 `--score` 时写 `score = 80` → `severe`（`pain-record.ts:125` 与 `:469` 两处；observability 另有 `pain-signal-observability.ts:159/161`、`:221` 三处） | 省略 `--score` → 统一写 `DEFAULT_PAIN_SCORE = 40` → `moderate`，与 MCP 同一把尺子；**四处默认值必须一起改**；`--score` 仅作人工提级通道且无法验明操作者身份 | §6.1、§6.2、§6.4、T07 |
| 2 | WorkBuddy 用户级 Skill | 仓库无 `~/.workbuddy/skills/pd-record-pain/SKILL.md` 源；安装器只投递插件根 Skill，且无旧文件识别/废弃逻辑 | 由安装器统一分发 `pd-pain-signal` 到插件根；识别并废弃旧 `pd-record-pain`；用户改过的副本不静默覆盖 | §5.5、T39 |
| 3 | `diagnostician_async_cli` | quiet、默认关；开启后 `pd pain record` 提交即返回（F45/F46） | **保持默认关**，不随 L3 交付转默认开；等真实取证后再评估 | §6.4、§10、T40 |

#### v0.8 post-review corrections — 2026-11-10

> 版本号仍为 **0.8**。以下是对 V0.8 草案的定点修订，不重写章节、不升版本。每项均以当前源码复核为依据，不接受"上一轮评审结论即事实"。

| # | 原草案问题（经代码复核成立） | 修订落点 |
|---|---|---|
| C1 | §6.3.2 规定"省略 `painType` 时不构造 `painIngress.v1`、改走 legacy 顶层字段"。代码中 `PainIngressReport.painType` 与 `PainToPrincipleInput.painType` 均为必填；legacy 路径跳过 `evaluatePainIngress()` 与 v1 payload 校验，且归一逻辑把缺失类型硬编码回 `user_frustration`（`pain-signal-bridge.ts:389`）。 | §3.1、§6.3；TD §6.3 |
| C2 | §5.6.1 允许 archived/deprecated 原则作为锚点、仅给 warning。代码中 `readTrustedPrinciples()` 只返回 `candidate/probation/active`，archived/deprecated 不进入 trusted 集合。 | §1.4.1；TD §5.6 |
| C3 | §5.5 把 PainId 生成放在 `submitPainCapability()` 内，而 §5.7 要求超时后按 `taskId` 回查；`runWithDeadline()` 只停止等待、不取消底层任务。Handler 超时返回时可能既无 PainId 也无 TaskId。 | §7.4、§8；TD §5.5–5.7、§9 |
| C4 | 默认 `score=80` 被记为两处；实际为四处功能默认（`pain-record.ts:125`、`:469`；`pain-signal-observability.ts:159/161`、`:221`），且 observability 本地 `severityFromScore(number)` 对 `undefined` 返回 `mild`，`pain_events.score` 为 `REAL NOT NULL`。 | §6.1、§6.4；TD §6.4–6.5 |
| C5 | 只读 MCP 的安全结论被沿用给写类工具。`pd_submit_pain` 是写操作，须 `readOnlyHint:false`，且按 `SPEC-PD-AGENT-CAPABILITY-API-001-v0.5.md` §10.2 需 OG-4 单独授权（当前仓库无授权记录）。 | §7.7；TD 安全章节 OG-4 小节 |
| C6 | `origin.kind = owner_manual` + `channel = mcp_agent_assisted` 未被 `parseOrigin()` 白名单接受；Owner 同意提交 ≠ Owner 亲自报告，草案未区分事实作者归属。 | §7.5；TD §6.6 |
| C7 | 草案称 `recordObservability:false` 不影响可见性。实际 false 跳过 trajectory.db `pain_events`，Console 读 trajectory.db 将看不到该 Pain。 | §7.6；TD §7 |

#### v0.8 收口修订 — 2026-11-10

> 版本号仍为 **0.8**。只消除影响实现判断的矛盾，不新增需求、不重写章节。

| # | 收口项 | 修订落点 |
|---|---|---|
| C8 | Pain 判断条件不得被"长期价值 / 复发 / 损失"反向绑架：统一为"明确锚点 + 具体行为 + 显著背离"；D4 只决定注意力优先级 | §1.3、§5.1、§5.3；TD §6.1 |
| C9 | `painId` / `taskId` 生成职责：Handler 在提交与 deadline 之前生成，Core Capability 只使用不覆盖；超时用已知 `taskId` 有界回查，不自动重提交 | §7.4、§8；TD §3、§3.2、§5.5、§5.7 |
| C10 | `painType` 与 provenance 分离：MCP 缺省 `principle_deviation`（CLI 保持 `user_frustration` 不变）；provenance 唯一方案 `agent_reported_owner_approved` | §3.1、§6.3、§7.5；TD §6.3、§6.6 |
| C11 | OG-4 定位为生产交付 Gate：未授权不注册写类 Tool，授权后才注册并 `readOnlyHint:false`；T01 以授权为前置 | §7.7、T01、T43；TD §5.1.1、§10 T01/T43、§16.4 |
| C12 | 取消"长期价值"对提交的隐性限制：Tool 只需说明锚点/行为/背离/必要时影响；四项"不要求" | TD §5.2；SPEC §1.3、§5.1、§5.3 |
| C13 | OG-4 只限制生产交付，不限制开发启动：明确"未授权允许 / 禁止"两栏；开发与非生产端到端验证不等授权 | §7.7、§12 T01/T43；TD §5.1.1、§11.0、§16.4 |
| C14 | `evaluatePainIngress()` 必须先识别 `mcp_agent_assisted` 再走统一提交，不返回 `--session` 重提提示 | §7.5、§12 T44；TD §6.6.4、§6.6.5 |
| C15 | 统一 Origin 表达：`origin.kind=owner_manual` + `origin.channel=mcp_agent_assisted`，不把 Channel 写成 Origin 类型 | §2 |

### v0.7 — 2026-11-10（锚点式 Pain 定义）

Owner 决策（附件裁定，逐条落地）：

| Owner 裁定 | 本版处理 |
|---|---|
| **A** `diagnosis.mode` 保留但只在可证实时出现 | §7、§10；不可证明即不返回该字段，禁止用 `PD_MCP_HOST`/静态配置推断 |
| **B** 宿主原生确认"推荐、非必要前置" | §4.3；业务条件是宿主对话中的明确授权 |
| **C** 默认严重度为中等，取消固定 `score=80`，提级仅限授权人工 | §6；复用 `severityFromScore` 现成映射，不新增枚举 |
| **D** 不伪造"撤销上一轮 P0" | 审查报告 §5 只记录 V0.6 §4.2 条件性要求的真实修改 |

其他变更：

| 变更 | 原因 |
|---|---|
| **Pain = 相对锚点的显著行为背离**；删除"实际负面影响 / 反复发生 / Owner 纠正 / 明确期望未满足 / 值得长期保留"五项必要条件，删除"实际损失或明确冲突即触发" | 旧定义把"任务成败/损失/重复"当成必要条件，会让"能运行但明显背离既有期望"的行为被 Request 型 Agent 直接放过 |
| 新增三类锚点：Owner 明确期望 / 已建立原则或规则 / Agent Instructions 或 Skill | 没有锚点的"问题"只是主观意见；锚点必须可追溯 |
| 新增锚点来源、引用等级、冲突披露、低置信度先澄清 | 防止编造锚点、把道听途说当 Owner 指令 |
| 内容结构改为：锚点 / 锚点来源 / 观察到的行为 / 背离 / 为什么值得记录 / 上下文（六项，不新增五个参数） | 旧模板以"实际影响"为中心，无法表达"没有实际损失但明显背离" |
| 五个定性维度替代数字评分；`score` 不再由 MCP 路径写入 | 避免每条 Agent Pain 都变成 Severe |
| 回执只描述**已持久化事实**；`diagnosis.mode` 可选 | 提交 ≠ 诊断完成 |
| L2/L2b/L3 保留 V0.6 方向，修正 L2b 活动信号与 L2 安全边界 | 见技术方案 §8 |

### v0.6 — 2026-11-10（分层执行：L2 一键执行 + L2b 积压可见 + L3 自动执行）

Owner 拍板 L2 + L3、L2 先做，新增 L2b 为必做项。§9.3 改为分层事实（控制台可查看、可一键执行；自动执行需 L3；"没有消费者"精确为"没有按宿主绑定的消费者"）；§9.3 约束扩到 9 条；新增 §9.5（L2b）；新增 §10.1（L2 回执）；§13 增 T31–T34。

### v0.5 — 2026-11-10（OpenClaw 自动诊断补齐）

新增 flag `openclaw_diagnostician_consumer`（默认开）；复用插件内既有 120s service；每轮最多 1 条；能力门控；禁止挂同步 hook；flag 关闭时回执必须如实。

### v0.4 — 2026-11-10（技术审查修订）

三宿主统一 Unbound 单写入路径；Codex 绑定键改为 `_meta.threadId`（Phase 2 记录）；OpenClaw MCP 通道恒 Unbound；WorkBuddy 未证实；写入 seam 收敛为 `PainToPrincipleService.recordPain`；更正空证据短路位置；不新增证据原因枚举。

---

# 1. 项目目标

## 1.1 背景

PD 已建立 Pain → Diagnostician → Root Cause → Principle Candidate → Admission → Owner Review → Principle Ledger → Runtime Activation 的演化链路。

但现有采集方式有两个问题：

1. **入口太窄**：Agent 只有在工具失败、被 Owner 纠正或已有 Pain 重复时才有理由提交，导致"系统能跑但明显在做错的事"长期无人上报。
2. **定义错了**：把"有实际损失/反复发生/Owner 纠正"当作 Pain 的必要条件，等于默认"没出事就不是问题"。

本 SPEC 建立统一的 Agent-assisted Pain Submission 能力，并把 Pain 的定义改为**相对锚点的行为背离**。

## 1.2 核心设计原则

**P1 一个统一入口**：三宿主共用同一个 MCP Tool，不建各自系统。
**P2 技术身份由宿主提供**：SessionId 等不得由 Agent 填写；拿不到就 Unbound。
**P3 锚点优先**：没有可追溯锚点的"问题"不提交。
**P4 不允许伪造**：不伪造锚点、来源、证据、Owner 原话、诊断结论。
**P5 复用现有生命周期**：PainIngress → PainToPrincipleService → PainSignalBridge → Diagnostician；不建第二条诊断流水线。
**P6 复杂度克制**：不新增审批库、不新增 Worker、不建会话注册中心、不引入 Context Lease。
**P7 不为尚不可用的能力预埋结构**：v1 不消费宿主身份，不定义 `HostContextProvider`，不建 Bound 分支。

## 1.3 Pain 的定义（本版核心）

> **Pain 是 Agent 在真实任务过程中，相对于一个明确锚点所发生的显著行为背离。**

**三个要素同时成立才构成 Pain；D4 只是提议优先级，不是成立门槛**：

| # | 要素 | 判定 |
|---|---|---|
| D1 | **有锚点** | 存在 Owner 明确期望、已建立且当前适用的原则/规则、或宿主当前有效的 Instructions/Skill 要求 |
| D2 | **有具体行为** | 能指出 Agent 实际做了什么（或没做什么），不是泛泛而谈"质量不好" |
| D3 | **有显著背离** | 实际行为与锚点要求之间存在可描述的差距，而不是措辞差异或合理取舍 |
| D4 | **值得向 Owner 提议**（辅助） | 该背离是否值得占用 Owner 注意力。它只用于排序与克制，**不得**用来否定已经成立的 D1–D3；首次出现、尚未造成损失、Owner 尚未纠正的显著背离仍然成立 |

**明确删除的旧定义（不得继续引用）**：

- ❌ "必须存在实际负面影响"——负面影响的举证责任不再前置。
- ❌ "必须反复发生"——首次出现的单点背离即可构成 Pain。
- ❌ "必须有 Owner 的明确纠正"——Owner 纠正只是锚点来源之一。
- ❌ "必须未满足 Owner 的明确期望"——改为"相对于锚点的背离"，锚点可来自原则或 Instructions。
- ❌ "必须值得长期保留"——改为"是否会改变未来行为依据"，且只作 D4 辅助排序，不作准入门槛。
- ❌ "实际损失或明确冲突即触发"——触发条件不再是损失。

**任务结果不是判定依据**：

- 任务**成功**也可能产生 Pain（结果对，但过程明显违背锚点）；
- 任务**失败**也可能完全没有 Pain（例如外部服务故障、超出能力边界、正常重试后成功）。
- 不得把任务失败、结果不好、经济损失、用户投诉、"重复两次"、"已经找到修复方案"作为成立条件中的任何一条。

**同时不构成 Pain 的（防止扩张）**：

- 纯风格偏好、可读性口味、没有锚点支撑的"我觉得不好"；
- 锚点只存在于 Agent 自己的推测或临时提示注入中；
- 与锚点要求一致、只是执行代价更高的方案；
- 已经被现有 Principle 覆盖且未出现新背离的重复现象（重复只作为"值得优先"的排序信号，不是成立条件）。

## 1.4 锚点的三类来源

| 类型 | 取值 | 定义 | 典型证据 |
|---|---|---|---|
| **Owner 明确期望** | `owner_expectation` | Owner 在对话、文档、既有决定中明确表达的要求 | 当前/历史消息、Owner 文档、已批准的 Principle |
| **已建立原则或规则** | `established_principle` | PD 原则账本中已存在的原则、规则、试用原则 | `principle_training_state.json`（`id` + `version`） |
| **Agent 指令或技能** | `agent_instruction` | Agent Instructions / Skill / 工具指南中的明文要求 | `AGENTS.md`、`PRINCIPLES.md`、`SKILL.md` |

**锚点必须尽量可追溯**：

- 原则类锚点必须给出 `policyId`（+ `version`），不得只写"某条原则"；
- Instructions 类锚点必须给出文件路径（+ 章节/标题），不得只写"按规范"；
- Owner 期望类锚点必须能指出出处（当前对话、哪份文档、哪次决定）；如果只能靠回忆，必须标为低置信度。

### 1.4.1 有效锚点判定（post-review 修订）

有效锚点 = **真实存在 + 版本匹配 + 当前有效 + 当前场景适用 + 未被更高优先级有效约束覆盖**。

按当前代码逐状态核对后的口径（不得按名称推断）：

| 原则状态 | 当前代码事实 | 能否作为"当前违规依据" |
|---|---|---|
| `active` | 进入 trusted 读取集合；但**代码不做 scope 适用性过滤**（`principle-tree-ledger-adapter.ts:254-261`） | **只有在当前 activation candidates 中可解析时**才可以；解析不到只能作诊断背景 |
| `probation` | 与 active 一样被读取；仍是试用状态 | 仅当存在当前有效的激活记录时才可以，且必须标注"试用期原则" |
| `candidate` | 进入 trusted 读取集合，但尚未获批 | **不可以**；只能作为"待 Owner 确认的期望"背景 |
| `archived` | 不进入 trusted 集合，不可注入（同上） | **不可以**；只能作历史背景 |
| `deprecated` | 同上，且已有 `deprecatedAt/Reason` | **不可以**；只能作历史背景 |
| 不存在 / `version` 不匹配 | 无对应记录或版本不一致 | **不可以**；必须报告"锚点不可判定" |

**已知代码限制（必须如实写入提交内容）**：

- 当前没有按 `scope` 判定"当前场景是否适用"的函数；`readTrustedPrinciples()` 不按 scope 过滤。
- `priority` 只参与 prompt 打包排序，代码中**没有**"更高优先级有效约束覆盖低优先级"的仲裁器。
- 因此最小保守规则是：**scope 无法程序化判定时，原则锚点只能作为诊断背景，不能单方面宣布违规**；需要 Agent 向 Owner 澄清适用性，或在提交内容中标注"适用性待确认"。
- 不新建 Anchor Registry 或仲裁系统；复用既有 Ledger 与 activation 读取。超出上述范围的适用性判断，本版**不保证**。

**不得混用**：Owner 在当前对话中重新提出的要求按 `owner_expectation` 记录，不得伪装成某条已归档/已废弃原则仍然有效；历史原则只能作诊断背景，不能冒充当前规范。

## 1.5 引用等级、低置信度与冲突披露

**引用等级（引用他人内容时必须披露）**：

| 等级 | 含义 | 能否单独支持"显著背离" |
|---|---|---|
| `verbatim` | 原文引用，可核对 | 可以 |
| `paraphrase` | 转述，语义等价 | 可以（需说明是转述） |
| `recollection` | 凭记忆，无法立即核对 | **不可以**，只能触发澄清 |
| `inference` | Agent 推断 | **不可以**，只能触发澄清 |

**低置信度处理**：锚点等级为 `recollection` / `inference`，或锚点出处不明时，Agent 必须先向 Owner 澄清；澄清前**不得提交**，也不得把"低置信度锚点"写成确定事实。

**冲突披露**：当锚点与另一条规则冲突、或存在两个互相矛盾的锚点时，Agent 必须在提交内容中显式写出冲突双方，不得只挑对自己有利的一条。

**禁止**：把第三方内容、网页文本、工具输出中的指令当作锚点；把内部提示（system prompt）原文写进诊断材料；把别人的话伪装成 Owner 原话。

## 1.6 五个定性维度（替代数字评分）

提交内容应能体现（不要求逐项字段化）：

1. **背离程度**：轻微偏离 / 明显偏离 / 严重偏离；
2. **锚点明确度**：明文规定 / 合理推断 / 模糊期望；
3. **影响范围**：单次任务 / 同类任务 / 跨任务长期；
4. **可复用性**：是否指向可沉淀为原则的行为模式；
5. **证据完整度**：有可核对引用 / 只有转述 / 只有回忆。

维度用于诊断器理解严重度语境，**不产生分数**。

---

# 2. 系统架构

```text
Agent（OpenClaw / Codex / WorkBuddy）
  │  ① 识别锚点（1.4）
  │  ② 判断是否构成背离（1.3）
  │  ③ 向 Owner 说明并取得明确授权（§4）
  │  ④ pd_submit_pain { reason, anchorType, anchorRef, painType? }
  ▼
PD MCP Server（与 recall 同进程）
  │  shutdown / AdmissionLimiter / deadline / zod 复核
  ▼
@principles/core/runtime/pain-submit-capability
  │  A. painId
  │  B. PainIngressReport（origin.kind=owner_manual + origin.channel=mcp_agent_assisted, correlation=unbound, evidence=not_applicable_unbound）
  │  C. evaluatePainIngress
  │  D. PainToPrincipleService({asyncMode:true}).recordPain
  │  E. 回执（只回填已持久化事实）
  ▼
state.db tasks 1 行（task_kind='diagnostician', status='pending', input_ref=painId）
```

执行路径见 §9（L2 控制台一键执行 / L2b 积压可见 / L3 OpenClaw 自动执行）。

---

# 3. MCP Tool 合同

## 3.1 参数

| 参数 | 必填 | 类型 | 约束 | 说明 |
|---|---|---|---|---|
| `reason` | 是 | string | 1–2000 字符 | 按 §5.3 六项内容结构组织 |
| `anchorType` | **是** | enum | `owner_expectation` / `established_principle` / `agent_instruction` | 没有锚点就不是 Pain（§1.3 D1），见 §3.3 |
| `anchorRef` | **是** | string | 1–300 字符 | 原则 id+version、Instructions 路径+章节、或 Owner 期望出处 |
| `painType` | 否 | enum | `principle_deviation` / `tool_failure` / `subagent_error` / `user_frustration` | 省略 → 由 Handler 写入中性默认 `principle_deviation`；**禁止**回填 `user_frustration`；无论是否传值都走同一个 v1 payload（§6.3） |

**禁止的参数**（不得出现在 schema 中）：

- `score` / `severity` / `priority`——Agent 不得自评严重度（§6）；
- `ownerApproved` / `approvalToken`——授权不是可传入的布尔值（§4）；
- `sessionId` / `turnId`——技术身份不得由 Agent 填写（P2）；
- 任意自由结构 `metadata`。

## 3.2 长度依据

- core 的 `PainIngressReport` 只校验 `reason` 非空字符串（`pain-ingress-payload.ts:285`），无长度上限；
- `reason` 落在 `diagnostic_json`（TEXT/JSON），无列级长度约束（`pain-signal-bridge.ts:897-907`）；
- 500 字符上限只存在于 CLI / Hook / 现有 Skill 前端，**不是 core 合同**。

因此 MCP 路径取 1–2000：足够容纳六项结构，又不显著抬高诊断 prompt 预算；CLI / Hook 保持 500 不动，避免影响既有入口。

## 3.3 缺锚点的处理

`anchorType` / `anchorRef` 是 schema 必填。缺失时 Tool 调用在协议层即被拒绝，**不会产生任何持久事实**；Agent 必须回到对话向 Owner 澄清锚点。

不允许"先提交、锚点留空"：那会制造一条无法追溯的 Pain，与 §1.3 D1 直接冲突。若 `reason` 中出现"违反某原则"这类主张但 `anchorRef` 给不出 `id@version`，按 §1.5 的 `inference` 处理，不得提交。

---

# 4. Owner 授权模型

## 4.1 授权只发生在宿主对话

1. Agent 必须先向 Owner 说明：锚点是什么（引用原文或明确出处）、观察到的行为、背离在哪里、为什么值得记录。
2. 必须取得 Owner 的**明确同意**后才可调用 Tool。
3. 优先使用宿主原生交互能力（如 `askme` / `ask_user` / `request_user_input` 等等价工具）；宿主没有时，用普通对话提问。
4. Owner 回复"可以 / 记录吧 / 提交"等明确同意 → 可提交；"不行 / 不用 / 算了" → 不提交；**未回复或回答不明确 → 不提交**。
5. 授权**只针对本次提交**，不得复用于后续 Pain。
6. Owner 修改了要记录的内容 → 提交前必须再次确认最终版本。
7. 没有交互能力的后台 Agent（cron、自动任务、无人值守 worker）**不得自行提交**。
8. Agent 不得以"已经获得授权"为由跳过说明；回执与诊断材料不得声称 Owner 授权了工具调用之外的内容。

## 4.2 为什么不用独立审批服务

引入 PD Companion 审批、Web Console 审批、独立审批 API 或 `ownerApproved` 字段会：产生第二套授权真源（违反 P4/P5）、把"对话中的同意"与"系统里的状态"分裂、并要求三宿主各实现一套审批 UI。v1 明确不做。

## 4.3 宿主原生确认（Owner 裁定 B）

**推荐开启，但不是必要前置条件。**

- 业务条件是 §4.1 的对话授权；
- 宿主原生的 MCP Tool 权限确认（OpenClaw `mcp configure --approval`、Codex MCP 工具审批、WorkBuddy `mcp-approvals.json`）作为**额外安全措施**保留；
- 不得把"三宿主都实现了逐次 MCP Approval"写成产品验收前提；
- 版本差异：V0.6 §4.2 曾把"必须启用原生写入确认"写成强制项，**V0.7 降级为推荐**（这是 Owner 裁定，不是文档漂移）。

---

# 5. Agent 行为规范

## 5.1 何时应该提出

同时满足前三条时，Agent 应主动准备一条候选 Pain：

1. 存在明确锚点（§1.4），且锚点可追溯到具体出处；
2. 能指出 Agent 的具体行为（做了什么 / 没做什么 / 顺序错了 / 跳过了步骤 / 越过了边界）；
3. 该行为与锚点要求存在可描述的差距（显著背离）。

第 4 条只是**辅助说明**，不是准入条件：

4. （辅助）该差距是否可能影响未来类似任务的判断依据——用于说明"为什么值得 Owner 注意"，**不得**因为暂时答不上来就否定第 1–3 条。

**明确不作为否决理由**：只发生过一次、任务最终成功、尚未造成实际损失、暂时无法证明会影响未来类似任务、暂时无法证明长期复用价值。这些都不能改变"Pain 是否成立"。

示例：锚点是原则"改动公共接口前核对所有调用方"，Agent 实际直接改了接口但本次恰好没崩——仍然构成 Pain，因为背离成立，损失不是条件。

## 5.2 何时不应该提出

- 没有锚点，或锚点只来自 Agent 自己的推断（`inference`）；
- 只与风格、措辞、可读性口味有关；
- 行为与锚点一致，只是实现更啰嗦/更慢；
- 同一锚点、同一行为已经被现有原则覆盖，且没有新的背离证据（重复只影响优先级）；
- Agent 无法说明"背离发生在哪一步"；
- 需要读取 Owner 未授权的其他会话、私有文档或他人的 transcript 才能成立；
- 提交内容会包含密钥、凭据、完整私有源码或他人隐私。

## 5.3 内容结构（六项，不是六个参数）

`reason` 应尽量按以下顺序组织为自然语言（不要求机器可解析）：

| # | 项 | 要求 |
|---|---|---|
| 1 | **锚点** | 引用或明确出处；原则给 id+version，Instructions 给路径+章节 |
| 2 | **锚点来源** | 并注明引用等级（`verbatim` / `paraphrase` / `recollection` / `inference`） |
| 3 | **观察到的行为** | 具体动作、顺序、跳过或越界；不写"质量不好" |
| 4 | **背离** | 与锚点的差距；说明是"没做""做反了""做了但绕过" |
| 5 | **为什么值得记录**（辅助） | 用于帮助 Owner 判断注意力优先级；**不要求**必须证明会改变未来任务判断，**不得**把它当作额外准入条件 |
| 6 | **上下文** | 任务类型、所在仓库/目录、可公开的环境事实；不写敏感信息 |

若确实无法给出第 1 或第 3 项，不得提交（回到 §5.2）。

## 5.4 禁止

- 编造锚点、出处、引用、版本号；
- 把自己的推断写成 Owner 原话；
- 把 `recollection` / `inference` 标成 `verbatim`；
- 隐藏冲突锚点；
- 为了"更容易被记录"而夸大背离程度；
- 通过放宽 §5.1/§5.2 的规则来规避 §6 的严重度约束。

## 5.5 Instructions 分发与旧文件废弃（Owner 追加裁定 2）

**分发责任方**：安装器（`npx create-principles-disciple`）是唯一写入方；仓库内的 canonical 源是 `packages/workbuddy-adapter/plugin/skills/pd-pain-signal/SKILL.md`。不得要求 Owner 手工把 Skill 放进用户目录。

**分发落点**：WorkBuddy 插件根下的 `skills/pd-pain-signal/SKILL.md`。

**旧文件识别与废弃**（v0.8 已落地）：

1. 识别对象：`~/.workbuddy/skills/pd-record-pain/SKILL.md`（旧用户级 Skill）。
2. 识别依据：路径 + frontmatter 名称 `pd-record-pain`；不按内容模糊匹配。
3. 内容与已发布版本一致 → 重命名为 `SKILL.md.deprecated-<version>` 保留原件，不删除。
4. 用户改过（哈希不匹配任何已发布版本）→ **不覆盖、不删除**，记录结构化告警（路径 + 原因 + 人工处置指引），由 Owner 决定。
5. 每次安装/升级执行一次，幂等；已废弃文件不再参与 Skill 发现。
6. **不得**为了废弃而在 `~/.workbuddy/skills/` 新建 `pd-pain-signal` 副本——那会与"不创建第二份全局副本"的既有约束冲突。

**实现状态（v0.8，2026-11-11 更新）**：上述 1–6 已由安装器落地，原措辞"本轮只落文档"不再成立。实现位置：`packages/create-principles-disciple/src/installers/legacy-workbuddy-skill.ts`，由 `workbuddy-host-installer.ts` 在安装成功返回前调用，告警经 `HostInstallResult.warnings` 输出到安装摘要。

**超出原措辞的原因**：本 SPEC 起草时把旧 Skill 废弃限定为"只落文档"；Owner 后续明确要求本轮完成落地，因此实现按 1–6 的合同语义执行。实现只补了可证明性约束：识别同时接受仓库中两个已发布历史载荷的 sha256（`0.1.1-openclaw` 与 `0.1.0-workbuddy`），只有字节完全命中其一才重命名；重命名失败或目标已存在时保留原文件并输出 `legacy_skill_rename_failed` 告警。合同 1–6 本身未修改。

---

# 6. 严重度与评分（Owner 裁定 C）

## 6.1 默认中等

**当前代码事实**（post-review 重新核实，行号以当前源码为准）：

- `pd pain record` 有**两处**独立默认：`pain-record.ts:125`（构造 ingress payload 时 `opts.score ?? 80`）与 `pain-record.ts:469`（调用 `recordPain` 时 `opts.score ?? 80`）；
- Observability 写盘有**两处**独立默认：`pain-signal-observability.ts:159/161`（`pain_events` INSERT 的 `score`/`severity`）与 `:221`（events JSONL）；`pain_events.score` 是 `REAL NOT NULL`（`trajectory-schema.ts:185`），**不能写空**；
- `PainToPrincipleService.recordPain` 本身**不补默认值**，原样传 `input.score`（`pain-to-principle-service.ts:171-186`）；
- bridge 侧 `severityFromScore(undefined)` 返回 `moderate`（`pain-signal-bridge.ts:268-273`），但 observability 自己的本地同名函数只接受 `number`（`pain-signal-observability.ts:53-57`），收到 `undefined` 会落 `mild`。

**目标行为**：

| 入口 | 省略严重度时 | 显式给出时 |
|---|---|---|
| MCP `pd_submit_pain` | 不传 `score` → `tasks.diagnostic_json` 落 `moderate`（bridge `undefined → moderate`） | Tool schema 不开放 `score`（§3.1 禁止参数） |
| CLI `pd pain record` | 写 `DEFAULT_PAIN_SCORE = 40`（`moderate` 下限），使 `tasks`、`pain_events`、events JSONL 三处一致为 `moderate` | `--score N` 原样透传，按既有阈值映射 |

- 40 是"中等下限"，不是质量评分；**不新增评分模型、不新增 severity 枚举、不改 `severityFromScore` 阈值**；
- 四处默认值（`pain-record.ts:125/469`、`pain-signal-observability.ts:159/161/221`）必须统一到一个常量，只改其中一处仍会被其余处补回 80；
- `pain-record.ts:635` 的回执展示文案同步改为该默认值，避免"显示 80、实际 40"。

## 6.2 提级只能由授权人工完成

- Agent 不得通过任何参数、措辞或"影响巨大"的描述请求提级；
- 提级必须由**获得授权的人工操作**（Owner 在 Console / CLI 中显式调整）完成；
- 诊断器可以依据 §1.6 的定性维度给出建议，但不得自动改 `score`。
- **权限边界（不得夸大）**：`pd pain record --score` 无法区分操作者是人还是 Agent，代码中没有任何鉴权。因此“仅授权人工提级”是**产品与操作纪律要求**，不是服务端可验证的安全断言；实现时必须在文档与回执中如实说明这一点，不得宣称已验明操作者身份。

## 6.3 `painType`：单一路径，不伪造分类

**当前代码事实**（post-review 重新核实）：

- `PainIngressReport.painType` 与 `PainToPrincipleInput.painType` 都是**必填**（`pain-ingress-payload.ts:113-124`；`pain-to-principle-service.ts:72-73`），枚举只有 `tool_failure | subagent_error | user_frustration`；
- `pd pain record` 把 `painType` **硬编码为 `user_frustration`**（`pain-record.ts:121-131`）；
- legacy 重入归一分支在缺少 `painIngress` 时**再次硬编码回 `user_frustration`**（`pain-signal-bridge.ts:317-394`，约 `:389`）；
- `buildDiagnosticJson` 只在 `data.painIngress` 存在时写 `painIngress` 命名空间（`pain-signal-bridge.ts:408-431`）；
- **`painIngress.v1` 本身不含 `painType`**（`PainIngressV1Payload` 只有 version / origin / correlation / evidenceClass），`diagnostic_json` 的顶层也不写 `painType`（`buildDiagnosticJson` 全字段核对）。因此当前诊断器**读不到** `painType`；它只存在于内存 `PainDetectedData` 与 Observability 的 `evolution.jsonl`（`pain-signal-observability.ts:253-267`）。

**结论**：V0.8 草案"省略 `painType` → 不构造 `painIngress.v1` → 走 legacy"的方案**不成立**：

1. legacy 分支会跳过 `evaluatePainIngress()` 的准入与 `validatePersistedIngressFacts()` 的 v1 一致性校验，形成**第二条准入语义**；
2. legacy 归一还会把未知原因**伪造成 `user_frustration`**，与"不猜"直接冲突；
3. 三个既有枚举也无法描述"原则背离"。

**目标行为**（本轮只落文档，代码未改）：

| 项 | 目标 |
|---|---|
| 提交路径 | **唯一一条**：MCP 路径始终构造 `painIngress.v1` → `evaluatePainIngress()` → `recordPain()`，不新增 legacy 写入分支 |
| `painType`（MCP） | Handler 侧可选；省略时写入**中性默认 `principle_deviation`**（明示的默认，不是原因猜测） |
| `painType`（CLI） | **本轮不改**：`pd pain record` 继续保持既有 `user_frustration` 行为；CLI 产品语义不在本 SPEC 修订范围 |
| 枚举 | 最小必要扩展：新增 `principle_deviation`。既有三个值保留用于真实工具失败 / 子代理错误 / Owner 挫败，**不得**把 Agent 观察归为 `user_frustration` |
| legacy 数据 | 只保留**读取兼容**：旧记录仍可读；本轮不改既有 legacy 归一逻辑；新 MCP 写入不得产生 legacy-only 记录 |
| 下游 | `diagnostic_json` 现状与目标都**不含** `painType`，因此新增值不会改变诊断器读到的材料；`painType` 只作 Observability（`evolution.jsonl`）与后续统计的分类提示 |

**枚举扩展的影响面**（实现时必须逐项处理）：`pain-ingress-payload.ts`（`parsePainIngressReport` 白名单 `:280-283` 与 report 联合 `:117`）、`pain-signal-bridge.ts:92`（`PainDetectedData` 联合）、`evolution-types.ts:63/118/143/264/311/340`（TypeBox 联合，已含 `dispatch_error` 但不含新值）。**CLI 硬编码点 `pain-record.ts:121-131` 本轮保持不变**；既有断言 `user_frustration` 的 CLI 测试无需改动，只新增 MCP 路径的 `principle_deviation` 断言。**注意**：`parsePainIngressV1Payload` 不校验 `painType`（v1 payload 无此字段），所以重入校验不会因新值失败；真正需要同步的是 report parser 与 evolution schema。

## 6.4 CLI 手动入口与 `diagnostician_async_cli`（Owner 追加裁定 1 / 3）

**当前代码事实**：

- `pd pain record` 有**两处**默认 80：`pain-record.ts:125`（ingress payload）与 `:469`（`recordPain` 调用）；
- `recordPainSignalObservability` 另有**两处**默认 80：`pain-signal-observability.ts:159/161`（`pain_events`）与 `:221`（events JSONL）；`pain_events.score` 为 `REAL NOT NULL`，不能留空；
- `diagnostician_async_cli` 是 quiet、**默认关闭**的 flag，开启后提交即返回。

**本轮决定的目标行为**（代码尚未修改）：

| 项 | 目标 |
|---|---|
| 默认严重度 | 省略 `--score` → `DEFAULT_PAIN_SCORE = 40` → `moderate`；**四处默认值必须一起改**，只改一处仍会被其余处补成 80；与 MCP 入口**同一把尺子** |
| 人工提级 | 只有显式传 `--score`（或 Console 显式调整）才算人工提级；且如 §6.2 所述，CLI 无法证明操作者身份，不得宣称服务端鉴权 |
| `diagnostician_async_cli` | **保持默认关闭**，不随 L3 交付自动转开。理由：它改变手动提交的体感（提交即返回），须等真实取证后再评估 |

**记账要求**：本节只描述目标行为；实现落地前不得对外宣称已生效，也不得把测试改成"通过"来假装已实现。

---

# 7. 回执（Owner 裁定 A）

## 7.1 只描述已持久化事实

回执必须能回答：Pain 是否已登记、taskId / painId 是什么、坐标在哪、下一步是什么。**不得**回答"诊断是否完成"。

## 7.2 `diagnosis.mode` 是可选字段

```jsonc
{
  "status": "submitted",
  "painId": "mcp_<...>",
  "taskId": "diagnosis_mcp_<...>",
  "workspaceDir": "<abs>",
  "diagnosis": { "status": "pending" }            // 最保守形态
}
```

| 情形 | 回执 |
|---|---|
| 能证明自动消费者当前可用 | `diagnosis: { status: "pending", mode: "auto" }` |
| 能证明自动消费者当前不可用 | `diagnosis: { status: "pending", mode: "manual" }` |
| **无法证明** | 只回 `diagnosis: { status: "pending" }`，**不带 `mode`** |

**禁止**：

- 用 `PD_MCP_HOST`、静态配置、flag 默认值、或"预期行为"推断 `mode`；
- 在无法证明时返回 `mode: "manual"` 冒充诚实（省略字段才是诚实）；
- 把 `mode: "auto"` 解释为"诊断已完成"；`auto` 只表示"存在自动执行路径"。

## 7.3 合同条目

1. 成功回执 `status` 只能是 `submitted`；
2. 失败回执必须 `isError: true` 且带结构化原因；
3. 已持久化但回执超预算 → **仍为 `submitted`**，附最小字段（见技术方案 §5.4）；
4. 回执不得包含 `succeeded` / `completed` / `success: true` / "诊断完成"；
5. `workspaceDir` 必填（用于跨宿主对账）；
6. `mode` 与真实能力矛盾时，宁可省略；
7. 提交 ≠ 诊断完成 ≠ Principle 生效。

## 7.4 结果未知：`submit_unconfirmed`（post-review 修订）

写入是"先持久化、后返回"。如果 Tool 的等待超时，Handler 可能不知道写入是否完成。此时：

- **不得**返回普通失败（`failed` / "未提交"），因为写入可能已落库；
- **不得**宣称 `submitted`，因为尚未观察到持久事实；
- **不得**自动重试同一提交（会产生第二条 Pain）；
- 必须返回 `status: "submit_unconfirmed"`，并携带**提交前已确定**的 `painId`、`taskId`、`workspaceDir` 与对账方法（`pd recall` / 任务状态读取 / `taskId` 精确查询）。

对账语义：

| 观察到的事实 | 结论 |
|---|---|
| 按 `taskId` 能读到由**本次 `painId`** 产生的任务 | 提交已持久化（`submitted` 的等价事实）；诊断状态另算 |
| 有界回查仍读不到 | 只能记 `submit_unconfirmed`，**不能**断言"未创建"（写入可能迟到） |
| 回查本身失败/超时 | 仍为 `submit_unconfirmed`，`nextAction` 指向稍后按 `taskId` 复核 |

`painId` 必须在 Handler 调用提交能力**之前**生成，`taskId` 由 `painId` 确定性派生（现有 `createDiagnosticianTaskId()` = `diagnosis_<painId>`），否则超时后无法对账。这是本合同的硬前提。

## 7.5 来源与作者归属（post-review 修订）

**原则**：Owner 同意提交 **≠** Owner 亲自报告。Agent 的观察必须保留 Agent 作者身份，不得写进 `owner_statement`，也不得因 Owner 点头就声称"Owner 亲自观察到了问题"。

**当前代码事实**：

| 项 | 事实 |
|---|---|
| `PainProvenance` | 三值字符串枚举：`host_context_bound` / `owner_reported_no_host_trace` / `automatic_hook`（`admission-gate.ts:4-7`） |
| `PainIngressOriginV1` | 对象联合：`owner_manual` + 6 个 channel（`openclaw_command` / `cli_explicit_session` / `external_cli_unbound` / `codex_explicit_prefix` / `codex_explicit_agent` / `workbuddy_explicit_prefix`），或 `automatic_hook` + `source`（`pain-ingress-payload.ts:37-50`） |
| `parseOrigin` | 只接受上述白名单；**`mcp_agent_assisted` 当前会被拒绝**（返回 null → `ingress_origin_invalid`，`pain-ingress-payload.ts:147-161/397`） |
| `validateOriginCorrelationInvariant` | `external_cli_unbound` 必须 unbound；其余显式 channel 必须 bound（`:328-344`） |
| `deriveProvenanceFromIngressFacts` | `automatic_hook` → `automatic_hook`；bound → `host_context_bound`；否则 `owner_reported_no_host_trace`（`:412-419`） |
| 作者归属 | 仅显式 `--owner-statement` 才写 `correctionEvidence.classification='owner_statement'`；read model 的 `rawStatement` 恒为 null、`isOriginalOwnerStatement` 恒为 false（`pain-recall-read-model.ts:102-122`） |

**目标行为（唯一方案，不留待选项）**：

- Agent 提议 + Owner 同意 → `origin.kind = owner_manual`，`channel = mcp_agent_assisted`（**新增值**）；`correlation = unbound` + `missing_host_session`；`evidence = unavailable` + `not_applicable_unbound`。
- provenance = **`agent_reported_owner_approved`**（**新增值**）：含义是"事实由 Agent 观察、提交经 Owner 授权"。在 `deriveProvenanceFromIngressFacts` 中由 `mcp_agent_assisted`（unbound）映射得到。
- **Owner 授权 ≠ Owner 是事实报告者**：不得把 Agent 的描述写进 `owner_statement` / `correctionEvidence.classification='owner_statement'`；除非 Owner 原话被逐字引用且显式标注，否则不写 `owner_statement`。
- **提交路径**：MCP Agent 的 Unbound 报告必须进入统一提交路径并被接受，**不得**返回"用 CLI `--session` 重新提交"的提示——Agent Observation 不是 Owner 在 CLI 亲自提交。
- 影响面：`pain-ingress-payload.ts` 的 origin 联合与 `parseOrigin` 白名单、`validateOriginCorrelationInvariant`（`mcp_agent_assisted` 必须 unbound）、`pain-ingress.ts` 的 `evaluatePainIngress()`（在通用 Unbound 分支**之前**识别该 channel）、`admission-gate.ts` 的 `PainProvenance` 联合与归一、`evidence-guards.ts` 的 `isOwnerExplicitManual`（豁免依据是 **Owner 已授权**，不是 Owner 亲自观察，须注释写明）、`context-payload.ts` 的 `Type.Literal`、`pain-retry.ts` 白名单、Console/Read Model 展示标签。
- 复用现有 CLI channel 冒充 MCP 提交会造成错误归属，**不可取**；不建第二套 Origin/Provenance 模型。

## 7.6 Observability 可见性（post-review 修订）

**当前代码事实**：

- `recordObservability` 默认视为 `true`（仅 `=== false` 时跳过，`pain-to-principle-service.ts:210/255`）。
- `true` 写三处：`events_<date>.jsonl`、`memory/evolution.jsonl`、`trajectory.db` 的 `pain_events` + `sessions`（`pain-signal-observability.ts:120-209/216-285`）。
- `false` 全部跳过，但 `tasks`（诊断任务）与 `tasks.diagnostic_json` 仍写（`pain-signal-bridge.ts:895-933`）。
- CLI 在无 bound session 时主动传 `false`（`pain-record.ts:430`）。
- 后果：只写 `tasks` 时，diagnostician 拿得到完整 Pain；Pain recall 只能走 `state.db` 路径并给出 `pain_event_only_in_state_db` 警告（`pain-recall-capability.ts:233-239`），**Console 读 `trajectory.db`（`sqlite-context-assembler.ts:458-459`），看不到该 Pain**。

**目标行为**：MCP 提交**不得**简单复用 `recordObservability:false`。最小修正是：无 bound session 时仍写 events JSONL 与 evolution.jsonl，并继续写 `pain_events`（沿用既有 `session_id='cli'` 兜底与 `host_kind` 列区分来源），从而保持 Console / recall / 统计可见；不新增表、不重设 Observability、不产生重复记录（`tasks` 与 observability 是不同用途的存储）。

## 7.7 系统层授权：OG-4（post-review 补充）

**两层授权不可互相替代**：

| 层 | 含义 | 当前状态 |
|---|---|---|
| 业务层 | Owner 同意把这一次观察记录为 Pain | 在宿主对话中逐次取得 |
| 系统层 | PD 允许新增一个 MCP **写**能力并交付 | **未授权（OG-4 未启动）** |

**代码事实**：

- `SPEC-PD-AGENT-CAPABILITY-API-001-v0.5.md:332-335` 明确：未来 MCP 写类工具的治理接入（PreToolUse matcher + tool-semantics 条目）= **OG-4 单独授权**，该版只留设计位；`:399` 标注"设计位（未授权）"，`:436` 标注"未启动"。
- 仓库中**没有任何 OG-4 已授权记录**。
- 当前 MCP 只注册一个只读工具 `pd_recall_principle_pains`，`readOnlyHint: true`（`pd-mcp-server/src/server.ts:147`）；**不存在 `pd_submit_pain`，也没有写类 MCP 工具先例**。
- 现有 PreToolUse matcher 匹配 `Bash|apply_patch`，对 MCP 工具名零命中；tool-semantics registry 只登记宿主原生工具（`workbuddy-adapter/src/tool-semantics.ts:23-37`），MCP 工具未登记。

**结论与门槛（生产交付 Gate，不是开发启动 Gate）**：

- OG-4 **未授权**时**允许**：开发分支实现 Core Capability 与 MCP Handler、完成 origin / provenance / 准入 / 持久化逻辑、编写与运行自动化测试、在隔离非生产环境用测试数据做端到端集成验证、验证 MCP 协议 / 回执 / 超时 / 并发与异常处理。
- OG-4 **未授权**时**禁止**：生产 MCP Server 注册 `pd_submit_pain`（`server.ts` 的 `tools/list` 不出现该 Tool）、把写类 Tool 分发到生产宿主、正式发布或部署该写入能力、通过本地开关 / 宿主 matcher 或其他方式绕过该 Gate。
- OG-4 **已授权** → 才进入生产注册与交付，并使用 `readOnlyHint: false`；其 matcher 与 tool-semantics 条目同步落地。
- 不得自行宣称已获授权。原有 OG-4 安全边界不得删除或降级。
- 不新建审批服务、Owner 确认界面、审批 Token、审批库或三套宿主专用治理；不要求三宿主逐次原生审批。现有机制不足的部分列为实施前置问题。

---

# 8. 幂等、并发与失败

| 场景 | 行为 |
|---|---|
| 同一 Agent 重复提交 | v1 不去重；每次生成新 painId |
| 身份生成时机 | MCP Handler 在提交调用与 deadline **之前**生成 `painId`，并按既有规则派生 `taskId = diagnosis_<painId>`；Core Capability 只使用、**不得重新生成或覆盖** |
| 超时后自动重新提交 | **禁止**：只做一次有界回查，复用现有 RuntimeStateManager / TaskStore 只读能力 |
| 并发提交 | 依赖 SQLite 既有并发控制；失败即 `failed`，不静默 |
| 重复 taskId | `createTask` 抛错 → 回执 `failed` |
| 异步落库失败 | `failed` + `nextAction`，不得声称已排队 |
| 已落库但回执构造失败 | 返回最小 `submitted`（§7.3 第 3 条） |
| 已落库但完整回执超预算 | **优先**返回最小 `submitted`（`painId` + `taskId` + `workspaceDir`）；极端情况下最小回执仍超传输约束时，如实说明"已持久化、但无法在本次响应内完整回传"，并给 `taskId` 对账入口 |
| 写入过程中超时 | `submit_unconfirmed` + 已知 `painId`/`taskId`（§7.4）；**不取消**底层写入，不自动重试 |
| 超时后有界回查命中 | 视为已持久化；回执仍不得宣称诊断完成 |
| 超时后有界回查未命中 | `submit_unconfirmed`；不得断言未创建 |
| 执行阶段并发 | 同一 taskId 只有一个租约持有者；后到者 `lease_conflict`，**非变更**、不消耗 attempt |

---

# 9. 执行路径

## 9.1 分层事实

| 问题 | 事实 |
|---|---|
| 谁会执行 pending 诊断 | 自动：`pd codex worker` / `pd workbuddy worker`；手动：`pd diagnose run --task-id`；Console 一键执行与 OpenClaw 自动执行是 V0.8 计划补上的 L2/L3 |
| worker 是否只处理本宿主的 Pain | **不是**，只按 `task_kind` 与状态取任务（跨宿主消费） |
| 谁启动 worker | PD Companion |
| OpenClaw 有没有自动执行者 | 当前没有；L3 补上（新 flag 默认开） |
| 控制台能否看见诊断状态 | 能（`/api/evidence-chain`） |
| 控制台能否推进 pending | **当前不能**；V0.8 计划补 L2 一键执行 |
| 控制台会不会报警 | **当前不能**；V0.8 计划补 L2b 积压可见 |
| 没人执行会怎样 | 永久 pending，无 TTL |

## 9.2 三层要求

| 层 | 范围 | 验收判据 |
|---|---|---|
| **L2** 一键执行 | 控制台对单条 pending 触发一次执行 | 202 只表示受理；DB 行真实迁移 |
| **L2b** 积压可见 | 数量 + 最老等待时长 + 最老任务 ID + 无执行者提示 | 三问可答；有积压不显示 healthy |
| **L3** 自动执行 | OpenClaw 插件内 120s service，每轮最多 1 条 | flag 开→任务真实离开 pending；flag 关→任务停在 pending，日志给出 `flag_off` |

## 9.3 约束

| # | 约束 |
|---|---|
| 1 | 不得新增调度器 / 常驻循环 / 新定时器（L3 复用既有 service） |
| 2 | 不得新增去重表；L2 并发依赖 `acquireLease` |
| 3 | 不得把 202 写成成功（§9.4） |
| 4 | 不得新增 Pain 表或执行历史表 |
| 5 | L2 只作用于当前 workspace，界面必须写明 |
| 6 | L2 状态变更路由必须校验来源（同源/loopback/token），不得默认安全 |
| 7 | L2b 的活动判断不得用"新建 pending 任务"的 `updated_at` 冒充执行活动 |
| 8 | L2b 不得声称"没有执行者进程"，只能说"未观察到自动执行者活动" |
| 9 | L3 未开或能力不可用时，`mode` 不得显示 `auto` |

## 9.4 L2 回执合同

`POST /api/diagnostician/:taskId/run`：

- 202 只允许 `state: "diagnosis_accepted"`；
- 403（跨源）/ 415（非 JSON）/ 404（工作区或任务不存在）/ 409（能力、runtime、状态不允许）；
- 不得返回"已完成"语义；
- 必须携带 `workspaceDir` 与"仅当前工作区"说明；
- 真实结果只能从任务状态读取。

## 9.5 L2b 可见性

必须回答：

1. 现在有没有积压（`pendingCount`）；
2. 积了多久（`oldestPendingAgeMs`）；
3. 最老那条是哪个（`oldestPendingTaskId` / `oldestPendingPainId`）。

附加：`retryWaitCount`、`leasedCount`、`staleLeaseCount`、最近一次**真实执行活动**（来自 `runs` 或租约变化，不得用 `updated_at` 推断）。

---

# 10. 非目标

| 非目标 | 原因 |
|---|---|
| Bound 会话关联 | OpenClaw 不可得；Codex 可得但 v1 无收益 |
| 复用 `recordExplicitOwnerStatement` | 会把 Agent 文本写成 Owner 原话 |
| 全局 Session Registry / Context Lease / 跨进程上下文库 | Owner 禁止；P7 |
| 去重 / 限流 / exactly-once | 不在 v1 范围 |
| 数字评分 / 自动提级 | §6 |
| 把 `diagnostician_async_cli` 随 L3 转默认开 | 改变手动提交体感，等真实取证（§6.4） |
| 静默删除或覆盖用户改过的 Skill 副本 | 破坏式操作；只识别并告警（§5.5） |
| 新增 Pain 表 / 审批库 / 调度器 | §9.3 |

---

# 11. 数据合同（不新增 schema）

| 项 | 落点 |
|---|---|
| Pain 唯一持久形态 | `state.db` 的 `tasks` 1 行（`task_kind='diagnostician'`、`status='pending'`、`input_ref=painId`） |
| 锚点 | 存入 `diagnostic_json`（JSON TEXT），**不新增列**；结构化字段 `anchor: {type, ref}`。锚点原文、引用等级、冲突披露都在 `reasonSummary` 中，不复制成结构化字段（技术方案 §6.2） |
| 严重度 | 不写 `score`（MCP 路径），由 `severityFromScore` 落 `moderate` |
| 状态目录 | `stateDir`（原则账本）= `<workspace>/.state`；`state.db` = `<workspace>/.pd/state.db`（两者不同，见技术方案 §7） |
| 不新增 | `pains` 表、执行历史表、去重表、锚点表 |

---

# 12. 验收矩阵

| 编号 | 场景 | 期望 |
|---|---|---|
| T01 | MCP Tool 注册（前置：OG-4 已授权） | **OG-4 已授权是前置条件**；满足后三宿主 `tools/list` 可见 `pd_submit_pain`，recall 仍在 |
| T02 | 参数校验 | 缺 `reason` / 超长 / 非法 enum → 结构化错误 |
| T03 | 锚点结构化 | `anchorType` + `anchorRef` 落进 `diagnostic_json.anchor` |
| T04 | 锚点缺失 | schema 拒绝，零任务；不产生 `anchor:unstructured` 记录 |
| T05 | 引用等级 | `recollection` / `inference` 不得单独支撑提交（由 Agent 行为层验收） |
| T06 | 冲突披露 | 双锚点冲突时诊断材料保留双方 |
| T07 | 默认严重度 | MCP 省略 `score` 与 CLI 省略 `--score` 均落 `moderate`；必须真实读回 `tasks.diagnostic_json`、`pain_events`、events JSONL 三处，任何一处都不得是 80 或 `severe`；显式 `--score` 仍按既有阈值生效 |
| T08 | 提级禁止 | 任何参数都无法让 Agent 提级 |
| T09 | `painType` 省略（MCP） | MCP 省略时写 `principle_deviation`；**不得**出现 `user_frustration`；带/不带 `painType` 走同一条 v1 准入路径，准入结论一致。CLI 手动报告行为不变（仍为 `user_frustration`），不在本测试断言范围 |
| T10 | 落库 | `tasks` 1 行 pending，`input_ref=painId` |
| T11 | 回执最小集 | 含 painId / taskId / workspaceDir / status |
| T12 | `mode` 可证 | 可证明时才出现；不可证明时字段缺失 |
| T13 | 失败回执 | `isError: true`，不静默成功 |
| T14 | 超预算 | 已持久化仍返回 `submitted`（最小字段） |
| T15 | 重复提交 | 各自生成新 painId，不覆盖 |
| T16 | 并发提交 | 不产生半写状态 |
| T17 | 诊断材料可读 | 诊断器能读到锚点与背离结构 |
| T18 | 三宿主一致 | 同一份 schema、同一份回执字段 |
| T19 | Unbound | `correlation.status=unbound`，不伪造 sessionId |
| T20 | 空证据 | 不伪造 evidence，`not_applicable_unbound` |
| T21 | 跨宿主消费 | OpenClaw 提交的 Pain 可被 codex/workbuddy worker 消费 |
| T22 | Agent Instructions 存在 | 三宿主均可读到提交规范（见技术方案 §7.3） |
| T23 | 授权行为 | 未授权不提交；后台 Agent 不提交（由 Harness 行为验收） |
| T31 | L2 命中 pending | 202 + 状态真实迁移 |
| T32 | L2 拒绝路径 | 403/415/404/409 且零变更 |
| T33 | L2 并发 | 恰好一次执行；后到者 `lease_conflict` |
| T34 | L2b 三问 | 数量/时长/最老 ID 正确；有积压非 healthy |
| T35 | L2b 假阳性 | 新建 pending 不产生"最近有活动" |
| T36 | L3 自动执行 | flag 开 + 能力开 + service 运行 → 两轮 120s 内离开 pending |
| T37 | L3 有界 | 单轮最多 1 条 |
| T38 | L3 关闭 | flag 关 → 任务停在 pending，L3 日志给出 `flag_off`；`mode` 本就不返回 |
| T39 | Skill 分发与旧文件废弃 | 安装/升级后插件根存在 `pd-pain-signal`；旧 `pd-record-pain` 被识别并标记废弃；用户改过的副本不被静默覆盖 |
| T40 | 异步 flag 默认关 | 未显式开启 `diagnostician_async_cli` 时，`pd pain record` 保持等待诊断的既有路径 |
| T41 | 超时对账 | 写入中超时 → `submit_unconfirmed` + 已知 `painId`/`taskId`；有界回查命中/未命中/回查失败三种结果分别符合 §7.4；**不得**自动重提交 |
| T42 | 有效锚点十例 | active+范围匹配 / active+不适用 / candidate / probation / archived / deprecated / 不存在 / 版本错误 / Ledger 损坏 / Owner 当前要求与历史原则冲突——逐个断言"能否作当前违规依据" |
| T43 | OG-4 门槛 | OG-4 是**生产交付 Gate**（不是开发启动 Gate，也不是新增系统建设任务）：未授权时生产环境不注册写类 Tool；授权后才注册，且必须 `readOnlyHint:false`，并有 OG-4 授权的 matcher 与 tool-semantics 条目；不得自行宣称已获授权或通过宿主配置绕过。开发与非生产集成测试不受此 Gate 限制 |
| T44 | 来源归属 | MCP Agent 的 Unbound 报告进入统一提交路径，**不提示**用 CLI `--session` 重提；provenance 为 `agent_reported_owner_approved`；Owner 直接报告 / Agent 提议 Owner 同意 / Agent 提议被拒绝 / 无 Session 的 Agent 观察 / 重读已存记录 / Admission 解释 / Console 展示——作者归属不因"同意"而改变，不写 `owner_statement`，Console 不显示为 Owner 亲自报告 |
| T45 | Observability 可见性 | MCP 提交在无 bound session 时，Console Pain 列表与 `pd recall` 均能看到该 Pain；不得只留在 `tasks` |

---

# 13. 交付验收

**A. 文档层**

- 三份文档内部无矛盾；
- 所有"会/不会"结论都有文件+行号；
- 推断标注等级。

**B. 实现层（后续）**

- T01–T23 自动化；
- T31–T45 路由/集成；
- 三宿主真实落库；
- Agent 授权行为不能只靠服务端单测，必须有 Instructions + Harness 行为证据；
- CLI 默认严重度必须用真实 `pd pain record`（不带 `--score`）落库读回，不能只看帮助文本或代码 diff；
- Skill 分发必须看**安装后**的插件根与旧文件处置结果（T39），不能只看仓库里有没有源文件；
- 锚点有效性必须用 T42 的十种状态逐一验证，不能把 `warnings: non_active` 当作替代品；
- 超时合同必须用 T41 的真实超时 + 回查验证，不能只断言"返回 `submit_unconfirmed` 字符串"；
- OG-4 未授权时，T43 只做**生产注册**的负向断言（`pd_submit_pain` 不进生产 `tools/list`）；开发阶段的非生产集成测试不需要等待 OG-4。

**C. 禁止的验收方式**

- 只看 UI 有按钮；
- 只看 flag 已注册；
- 只看 202；
- 只看 `tasks` 行存在就宣称"诊断成功"。

---

# 14. 禁止事项

1. 新增 Pain 表 / 审批库 / 调度器 / 会话注册中心；
2. 篡改 Pain 生命周期或第二写入口；
3. 在回执里伪造 `auto`、Owner 授权、诊断完成；
4. 在任何入口（MCP / CLI）用默认值让 Pain 直接归 severe（含 `pd pain record` 省略 `--score` 时默认 80）；
5. 用触发规则放宽来规避严重度约束；
6. 把锚点只存在自然语言里而不做结构化（`anchorType`/`anchorRef` 必填；缺锚点不得提交）；
7. 修改产品源码 / schema / 依赖 / 宿主配置（本文档阶段）；
8. 静默删除或覆盖用户目录下用户改过的 Skill 副本（§5.5）；
9. 把 `diagnostician_async_cli` 的默认值随 L3 交付一起翻转（§6.4）；
10. 用 legacy 顶层字段绕过 `evaluatePainIngress()`，或把未知原因的 Pain 归为 `user_frustration`（§6.3）；
11. 把 archived/deprecated 原则当成当前违规依据，或用 `warnings: non_active` 代替有效锚点判定（§1.4.1）；
12. 在超时后宣称"未提交"或自动重试同一 Pain，或在未观察持久事实时宣称 `submitted`（§7.4）；
13. 把 Owner 的"同意提交"写成 Owner 亲自报告，或把 Agent 观察写进 `owner_statement`（§7.5）；
14. 自行宣布 OG-4 已获授权，或在未授权状态下注册写类 MCP Tool（§7.7）；
15. 以 `recordObservability:false` 让 Pain 在 Console / recall 中不可见（§7.6）；
16. 声称 `pd pain record --score` 已验明操作者身份（§6.2）。

---

# 15. 文档一致性

SPEC / REVIEW / TECHNICAL-DESIGN 三份必须一致，重点对账项：

Pain 定义、锚点三类、**有效锚点判定（当前有效 + 场景适用 + 版本匹配）**、引用等级、六项内容结构、`score` 语义、`severity=moderate`、**CLI 默认严重度与 MCP 同口径（四处默认值统一为 40）**、**`painType` 单一路径与 `principle_deviation`**、`diagnosis.mode` 可选、原生确认推荐、授权仅对话、**`submit_unconfirmed` 与超时回查身份**、**Origin/Provenance 与作者归属**、**Observability 可见性**、**OG-4 系统层授权门槛**、StateDir 两个路径、L2/L2b/L3 边界、**WorkBuddy Skill 由安装器分发且旧文件被废弃**、**`diagnostician_async_cli` 保持默认关**、文件清单真实性、测试编号、回执字段、禁止事项、版本号。

发现不一致时：以本 SPEC 为准，并在另两份文档中修正；若 REVIEW 指出的代码事实与本 SPEC 冲突，以代码事实为准并回改本 SPEC。
