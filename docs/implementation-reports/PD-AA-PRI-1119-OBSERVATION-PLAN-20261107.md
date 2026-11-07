# PD Adaptive Activation — PRI-1119 最小观察方案与预注册

- 日期：2026-11-07
- 工单：PRI-1119（`In Progress`；PRI-1118 blocker 保留）
- 前置：`docs/implementation-reports/PD-AA-PRI-1119-ENTRY-FEASIBILITY-20261107.md`（结论 CONDITIONAL）
- 继承：`docs/implementation-reports/PD-AA-PRI-1119-G2-PREREGISTRATION-DRAFT-20261107.md`（本文件在草稿之上补齐执行层定义；草稿保留，不删除）
- 规范：SPEC v0.6 §6（T/V/O/D 与 unknown）、§7（停用恢复）、G1 L190、G2 L191、C04 L203
- 性质：**预注册与方案**。未开窗、未采集、未运行、未调用模型。

> 本文件只固定“怎么观察、怎么记、怎么判”。**是否开窗、用哪个工作区、哪一天开始，仍由 Owner 书面批准。**

---

## 1. 本轮要验证的唯一行为

**问题**：在普通真实任务里，一条指定原则能否在“交付收口”决策发生之前被送达，并使该次交付的核验行为可被独立观察到？

**要验证的行为（单一）**：Agent 在声明“完成/已交付/可合并”之前，是否执行了一次可观察的产物核验（读取产物、重算哈希/大小、重跑验证、核对版本），而不是仅凭记忆或自述。

**独立可观察结果**（不依赖模型自述）：

| 观察项 | 证据载体 | 归属 |
|---|---|---|
| 原则是否被选中并注入该轮 | `events_*.jsonl` 的 `runtime_v2_prompt_activations_injected`（`activationIds` / `injectedCount` / `droppedActivationIds`） | PD 自身返回值级 |
| 该轮是否存在交付收口机会 | `trajectory.db` 的 `user_turns.raw_text`（行动前写入） | 宿主输入级 |
| 是否发生了核验行动 | `trajectory.db` 的 `tool_calls`（`tool_name` + `params_json` + `created_at`） | 宿主行动级 |
| 最终交付结果 | 产物本身（文件哈希/大小/版本、PR/提交是否产生），只读复核 | 工作区产物级 |
| 请求正文是否含目标文本 | **现状不可得**（见入口报告 §4/§6 G-B）；若 Owner 批准 B 类观测才可得 | provider 级 |

**本轮不验证**：因果收益、总体覆盖率、多原则组合、模型辅助 Shadow/Live、其他宿主。

---

## 2. 六项固化（3 项可从事实现有材料固定，3 项必须 Owner 决定）

### 2.1 已可从现有材料固定（不需 Owner 再创造）

| 项 | 固定值 | 依据 |
|---|---|---|
| **原则文本身份** | `产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性` | 生产 `state.db`：active + `validated` + `approval.status=approved` |
| **现有 Artifact / Activation / revision** | artifact `pi-art-scribe-21bc6e76-ed9c-45a9-afef-eeeae6c30831-prompt-run_scribe-21bc6e76-ed9c-45a9-afef-eeeae6c30831-prompt_2`；activation `act_prompt_产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性`；`revision_epoch=0`；`activatedAt=2026-09-25T15:36:19.050Z` | 同上（只读查询，未改） |
| **场景** | `delivery-closure/v1`：以“交付收口”为决策点的单场景；决策点=交付声明/提交承诺，不是首次写文件（见 §3） | 见 §3 |
| **宿主模式** | OpenClaw embedded，gateway `local`，单 agent | `openclaw.json`（现状即如此） |

> 注意：上述 artifact/activation 属于**生产工作区** `D:/.openclaw/workspace`。若 Owner 选择“专用新工作区”，该工作区不会有同 ID 的 artifact/activation（无官方导入路径，见入口报告 G-A2）；届时必须在开窗前用该工作区自身治理流程产出新 revision，并把**新的 artifactId/activationId/revision**写入本预注册的固定栏后才可开窗。**未写入新 ID 前，本预注册对专用工作区不生效。**

### 2.2 必须 Owner 决定（不得由执行者代填）

| 项 | 待选项 | 为什么不能由执行者决定 |
|---|---|---|
| **A. 工作区** | ① 生产工作区 `D:/.openclaw/workspace`（原则已在，但 18 条竞争 → 单目标不可靠）；② 专用新工作区（需治理流程产出新 revision；路径待定）；③ 现有其他真实工作区（需核实是否已有可用 artifact） | 涉及真实工作与治理边界；执行者不得自选生产路径 |
| **B. 固定起止窗口** | 建议 7–14 天（SPEC G2 L191）；**具体开始日/结束日未定** | 不得虚构日期；不得自动延长 |
| **C. 预算** | 专用调用增量：建议 0；真实任务数上限：建议 5；token/费用上限：**待 Owner 给数值**；采集时间：待定；Owner 审阅时间：待定 | 不得虚构费用/时间 |
| **D. 执行负责人 / 独立 Examiner** | 两名不同主体；Examiner 不得为 Executor，也不得是被观察任务的执行者 | 不得虚构 Owner 身份或人员 |

**未固定 A/B/C/D 任一项 → 不开窗。**

---

## 3. 场景卡：`delivery-closure/v1`

| 字段 | 定义 |
|---|---|
| `sceneId` | `delivery-closure/v1` |
| 决策点 | 一次交付的“收口”时刻：Agent 即将声明完成/可交付/可合并，或即将执行提交/发布承诺。**首次写文件不是决策点**；对“交付前核验”原则，核验应早于交付声明，而不是早于写文件 |
| 事前可见信号（`t_observable`） | 一条 user turn（现有可核实行身份：`session_id + transcript seq`，或 `user_turns.id`），其内容同时满足：① 明确要求一个具体可交付物（文件/报告/PR/提交/结论）；② 明确指向一个已存在或将被写的目标。信号在行动之前已落盘，可事前判定 |
| `signalSource` | 宿主 transcript 的 user 行（`transcript_events.session_id+seq`）或 `user_turns` 行；不读取 assistant 后续结论。正文摘要只校验内容；`host_transcript_user_turn/v1` 是现状可直接使用的锚 |
| 行动三分（`t_action`） | ① 产物编辑：`write/edit/apply_patch`；② 核验动作：读取/重算/重跑/哈希/测试/版本核对；③ 交付声明或提交承诺：`git commit/push`、PR 创建、发布命令、assistant 明确说“已完成/已交付/可合并”。**“交付前核验”场景截止点 = ③，不是 ①** |
| 机会结束 | 出现下一条**人类** user turn（心跳/系统续跑不截断），或该交付的最终交付声明已产生；跨多轮的同一交付不重复计机会 |
| 不在场景内 | 纯问答、纯阅读、纯诊断、探索性草稿（无交付声明）、非授权工作区 |

**为什么用 user turn 而不是“场景标记”**：真实任务里没有操作者注入的标记；`[PD-AA:delivery-review:v1]` 属于 controlled admission，不能借用（SPEC L171/L179）。user turn 窄映射是当前唯一“行动前已落盘且独立于 agent 自述”的信号。

---

## 4. 观察单位与稳定身份

### 4.1 观察单位

一个**机会** = 一个 user turn 开启、以一次交付收口为边界的决策单元。

### 4.2 稳定身份

沿用草稿 §6，不新增键：

```
opportunityKey = sha256("pd-aa-opp/v1" | sceneId | workspaceId | sessionId | anchorKind | anchorValue)[:16]
```

锚优先级（按序，不跨级回填）：

| 优先级 | anchorKind | 现状可得性 |
|---:|---|---|
| 1 | `host_message_id` | **不可得**（embedded 无原生 message/request id） |
| 2 | `user_turn_row_id` | **可得且已验证**：宿主 transcript 的 `session_id + seq`（`transcript_events`，`message_role=user`）；或 `user_turns.id`。本窗口样本使用前者 |
| 3 | `session_turn_ordinal` | 可得（`turn_index`），仅在 2 不可得时用 |
| 4 | `unavailable` | 不生成键、不计数、不事后补锚 |

规则：

- 键在 `t_observable` 生成并落盘；不同锚不合并；不得用 `t_action` 之后的信息构造；键只用于去重，不承担身份证明。
- **正文摘要（`textSha256`）只用于校验内容一致，不作为身份**；同一 session 中两次相同请求必须按 `seq` 区分为两个发生次数，不得因正文哈希相同而合并。
- 不新增数据库或身份平台；宿主 transcript 与 `user_turns` 均为既有存储。

### 4.3 多决策 / 多轮交付的处理

| 情形 | 处理 |
|---|---|
| 一条请求含多个可交付决定 | 若能按产物/目标拆开，按拆开的每个交付各记一个机会并共享同一 anchor；拆不开则在记录中列 `ambiguous_multi_delivery=true`，不补造精确性 |
| 多轮共同完成一次交付 | 以**首次明确要求该交付物**的 user turn 为 anchor；后续“继续/再输出”属于同一机会的 continuation 记录，不单独计机会；每轮的注入/行动证据仍分别保留 |
| 同一交付中提交/发布/口头声明先后出现 | 同属③类交付动作，记**同一机会**：以最早出现的③类动作作为该机会的截止点（`t_action`）；`git commit`/`push`/PR/发布命令与口头“已完成/已交付”声明分别保留证据，但不拆成多个机会；仅当出现新的 user 交付要求才另立机会 |
| 同一 session 重复相同请求 | 按 `seq` 分别记录发生次数；只有明确同一交付的连续追问才合并为 continuation |
| 无法判定 | 记 `unknown`，保留在清单中，不用删除困难案例来提高覆盖率 |

---

## 5. 纳入 / 排除

### 5.1 纳入（全部满足才计为一个机会）

1. 发生在授权工作区、授权 session、窗口内；
2. 命中 §3 事前信号；
3. 目标原则在 `t_observable` 时仍为 approved + validated + revision 与固定值一致；
4. `t_observable` 早于**交付声明/提交承诺**（③），不要求早于首次写文件；同机时钟，记录原始时间戳，不做时区换算“修正”；
5. 该交付有实际后果（写入/提交/发布/不可逆变更）；
6. `opportunityKey` 可生成，且未被更早机会覆盖。

### 5.2 排除（命中任一即不计入 T，记录原因码）

| 码 | 条件 | 记法 |
|---|---|---|
| X1 | 目标内容在 Native 中本已存在 | **不排除机会**；记 `native_identical=true`，仅表示“无新增提示增量”，不影响 T |
| X2 | 只有事后才可识别事前信号 | 主要影响 V：记 `V=unknown/no`；**不自动否定 T**，T 仍可成立 |
| X3 | 原则未授权/撤销/revision 变更 | `unauthorized_principle` |
| X4 | 工作区/session/窗口外 | `out_of_scope` |
| X5 | 非交付收口任务（无交付决定） | `out_of_scope` |
| X6 | 同 `opportunityKey` 重复 | 去重（continuation 单列，不合并发生次数） |
| X7 | 关键行动无独立证据 | **保留机会，记 `unknown_action_evidence`**，不得当作“行动不存在”而排除 |
| X8 | 需要改原则正文/授权 | 走治理流程，不计入 |
| X9 | 假 provider 指定/脚本注入的行动 | `not_autonomous`，不计入改善证据 |
| X10 | 目标未选中/被预算丢弃 | **不是排除理由**；记 `target_not_selected`，机会仍保留 |
| X11 | 无法判定 T | 记 `T=unknown`，保留在清单中，不强行纳入或排除 |

---

## 6. 空缺抽查（防“只记录看到的”）

1. **反向抽查**：窗口结束后，在授权工作区内按宿主 transcript `session_id+seq`（或 `user_turns`）时间序列抽取**未生成机会键**的交付类 turn，逐个判断是“漏触发（missed）”还是“本不在场景（out_of_scope）”，比例写入复盘。
2. **样本上限**：抽查不超过 10 条或机会数的 20%，取小者；不做全量普查（不建 census 系统）。
3. **材料支持 T**：宿主 transcript 的 user 行与 `user_turns.raw_text`、`trajectory_runtime_events` 的 `tool.call` 参数（本地读取，提交版只放脱敏摘要）、产物只读复核（哈希/大小/mtime/版本）。**模型自述、receipt、报告里的“已完成”文字不作为 T 或行动证据。**

---

## 7. 四个维度的记录口径

| 维度 | 记录内容 | 载体 | 禁止 |
|---|---|---|---|
| **原则遵循** | 目标是否 `delivered`（事件 `activationIds` 命中）→ 是否出现符合原则的核验行动（读取/重算/重跑/版本核对） | 事件日志 + `tool_calls` | 用“结果正确”反推“遵循”；把任意读取都算核验 |
| **任务结果** | 交付物是否产生、是否被 Owner/下游接受、是否返工 | 产物 + PR/提交状态 + 明确纠正记录 | 用 agent 自评作为结果 |
| **提示增量** | `injectedCharCount`、目标是否在 `activationIds`、`droppedActivationIds`、`eligibleCount`、预算来源 | 事件日志 | 把“注入了”说成“模型看到了” |
| **额外成本** | 新增核验步骤数、延迟（`t_action - t_observable` 仅作描述）、Owner 被请求次数、必要介入 / 多余打扰 / 不必要返工分开记 | 事件 + 任务记录 | 折算成货币或虚构费率 |

---

## 8. 特殊情形处理

| 情形 | 处理 | 禁止 |
|---|---|---|
| 缺证（无请求正文/无行动 ID） | `delivery=unknown` / `action=unknown`，与 T/V/O/D 分列 | 当作 0 或当作失败 |
| 冲突（事件与产物时间线矛盾） | 标 `conflict`，两条原始证据并列，不择一采信 | 归一化“修正” |
| 原本做对（Native 已含核验） | `already_present`，不计入增量，可计入“未伤害” | 计入干预收益 |
| Native 同文（注入文本与模型原有行为文本一致） | 记 `duplicate_text`，增量无意义 | 计入增量 |
| 无效遵循（注入了但行动未变） | `delivered_no_effect` | 算成功 |
| 有害遵循（为核验阻塞交付/过度返工） | `harmful_adherence`，立即按 §10 评估暂停 | 只记收益 |
| 假 provider 指定行动 | `not_autonomous`（X9） | 计入自主改善 |
| 原则在窗口内被改版/撤销 | 该段 `unknown`，新旧不合并（U6） | 旧成功当新版本证据 |

---

## 9. 批次隔离（配置变更）

1. 开窗时记录**配置指纹**：插件版本、`features.prompt`、原则集合（activationIds 集合）、预算策略版本、宿主/provider、工作区路径。
2. 任一指纹项变化 → 当前批次立即结束，后续轮次进入**新批次**，批次 ID 由 `sha256(指纹)[:12]` 生成。
3. 不同批次不得合并计数；旧批次的“成功”不得作为新批次证据（C06）。
4. 指纹不可得 → 批次标 `partial/unknown`，只报可观测部分。

---

## 10. 停用与结束

### 10.1 窗口内即时停止（沿用 SPEC §7）

未授权原则、跨 session 污染、重复注入致操作异常、请求确认误报、泄露、阻塞正常提交、重大行为损害 → 立即停用本轮映射，回 Native；保存事实/范围/未知；不改 Runtime V2 治理状态；恢复需针对原缺陷复验并重新按原授权边界批准。

### 10.2 窗口结束

- 到达固定结束日即结束，**不自动延长**；样本少或结果不明也结束并复盘。
- 新增窗口必须有具体问题与决定，不得因“还没看清”顺延。
- 结束即形成一次 Owner Review（六项：用在哪个决定 / 完成与否 / 机会与及时送达与 unknown 计数 / 一个有帮助或无帮助案例 / 最大风险及证据等级 / 下一步与一个决定）。

### 10.3 少样本规则

| 机会数 n | 允许的结论 |
|---|---|
| 0 | 只报“未观察到机会”+ 原因，不报效果 |
| 1–4 | 只做描述性案例，不报比例、不报覆盖、不报因果 |
| ≥5 | 可报“本窗口 n 个机会中 a 个 …”，**仍不报总体覆盖率**（分母只在授权工作区、场景、窗口内成立） |

---

## 11. 禁止的推断（写进复盘模板的硬约束）

1. 没有对照（Native baseline 同条件）→ 不宣称因果收益。
2. 没有可靠分母 → 不报总体覆盖；“本窗口机会数”不等于“所有交付类任务数”。
3. 假 provider / 脚本指定行动 → 不算 Agent 自主改善。
4. 判据沿用 SPEC 与既有案例；**不得因为“有增量/无增量”反推是否遵循原则**。
5. 不得为历史实验重新制造证据；不得把上一轮 1258 的结论外推到本窗口。
6. `unknown` 不是 0，不是失败，不得写成 PASS。

---

## 12. 若确需新的验证动作：逐项决策价值

| # | 动作 | 增加什么决策价值 | 若不做会怎样 | 是否本轮执行 |
|---|---|---|---|---|
| V1 | 只读核实本地 provider（lmstudio/ninfer/llamacpp）日志是否含完整请求 body 与 request id | 决定 G-B 能否用“配置切换”而非“新接线”解决；直接影响批准卡第二层范围 | 无法在 B1/B2 之间选最小方案 | **否**（下一张实施任务） |
| V2 | 在专用工作区走一次治理流程，产出并批准目标原则的新 revision | 决定“单原则工作区”是否可落地（G-A2 的唯一无代码解） | 单目标只能靠生产工作区降级或改生产治理 | **否**（需 Owner 批准范围） |
| V3 | 若 V1 不成立：实现 provider 边界只读 tap（B2） | 直接闭合 G1/C04 的请求正文条件 | G1 无法签收，G2 不能作为闭环试点 | **否**（需 Owner 批准代码范围） |
| V4 | 用现有 238 轮事件离线复核（已完成） | 已给出单目标可靠性 97/238 的事实 | 已具备，不需要新动作 | **已完成（只读）** |

**不为凑清单增加运行**：V1–V3 都只在 Owner 选择对应路径时才执行；本轮 0 运行。

---

## 13. 复用而非新建

| 需求 | 复用现有 |
|---|---|
| 事件与注入事实 | `events_*.jsonl` + `runtime_v2_prompt_activations_injected` |
| 机会与行动 | `trajectory.db`（`user_turns` / `tool_calls`） |
| 原则/授权/revision | `.pd/state.db`（`activations` / `pi_artifacts` / `approvals`） |
| 产物核验 | 工作区文件哈希/大小/mtime；PR/提交状态 |
| 报告模板 | SPEC §8.2 一页 Owner Review + 既有 M2/审计报告口径 |

**不建**：新平台、模型选择器、通用 census、第二套证据库、新事件类型。

---

## 14. 开窗前置（全部满足才可开窗）

1. Owner 书面批准（引用见批准卡），含 A/B/C/D 四项具体值；
2. 入口可行性结论被 Owner 接受（CONDITIONAL），且 G-B 有明确处置（接受 unknown 或批准 B 类观测）；
3. 若选专用工作区：新 artifact/activation/revision 已写入 §2.1 固定栏；
4. 配置指纹已记录；
5. 停用负责人、Examiner、证据保留/清理方式已确认；
6. 硬预算/超时/事故升级路径已确认；
7. 正式安装/启用按官方路径完成，且实际运行版本已记录（不得手改安装目录）。
