# PRI-1119 离线样本清单（有限窗口、只读）

- 文档 ID：`pd-aa-pri-1119-sample-inventory-20261107`
- 生成时间：2026-11-07（Asia/Shanghai）
- 数据性质：**历史样本观察**，不是前瞻预注册成功，不估计总体覆盖率或因果效果
- 配套机器可读文件：[PD-AA-PRI-1119-SAMPLES-20261107.json](./PD-AA-PRI-1119-SAMPLES-20261107.json)

## 1. 冻结规则（先冻结，后联结注入结果）

| 项 | 冻结值 |
|---|---|
| 数据来源 | 宿主 transcript：`C:/Users/Administrator/.openclaw/agents/main/agent/openclaw-agent.sqlite` 的 `transcript_events`（`message_role=user`）；宿主运行时 trace：同库 `trajectory_runtime_events` |
| 注入事实来源 | `D:/.openclaw/workspace/.state/logs/events_2026-10-31.jsonl` … `events_2026-11-07.jsonl` 中 `runtime_v2_prompt_activations_injected` |
| 治理事实来源 | `D:/.openclaw/workspace/.pd/state.db`（只读）：`activations` / `pi_artifacts` / `intervention_evidence_records` |
| 快照时间 | 2026-11-07；生产宿主仍在运行，因此快照是“某时刻只读切片”，不是封闭库 |
| 历史窗口 | `2026-10-30T00:00:00Z` .. `2026-11-06T00:00:00Z`（连续 7 个 UTC 日） |
| 候选选择规则 | ① 窗口内**全部**人类 user turn（`message_role=user` 且 `message.provenance.kind` 缺失），按 `created_at, session_id, seq` 排序，上限 20；② 窗口内宿主合成 user turn（`provenance.kind=internal_system`）按时间顺序**每 10 条取 1 条**，上限 10 |
| 样本上限 | 20 人类 + 10 审计 = 30；实际 12 + 10 = 22，未触发截断 |
| 禁止筛选 | 选择阶段不使用“是否注入 / 是否成功 / 是否犯错 / 是否 dropped”；注入事实在候选列表冻结后才联结 |
| 身份 | `session_id + transcript seq`（现有可核实行标识）；`textSha256` 只校验内容，不用于合并 |
| 计数 | 由确定性脚本产出，不做模型心算 |

冻结时的可用量：窗口内人类 user turn 12 条，宿主合成 user turn 133 条。注入日志仅从 `2026-10-31` 起存在，因此 `2026-10-30` 的候选 `injectionObservable=false`。

## 2. 计数（确定性脚本输出）

| 指标 | 数量 |
|---|---|
| 候选总数 | **22** |
| 人类请求 / 心跳审计 | 12 / 10 |
| 交付机会锚点（unique） | **8** |
| continuation 记录（同一机会，不重复计机会） | 3 |
| 非交付机会（排除） | **11** |
| 排除原因 | `NO_DELIVERY_DECISION` ×11 |
| T | 记录级：yes ×8；inherited_yes ×3（C09–C11 续轮继承 OPP-08）；no ×11；unknown ×0 → 机会级去重后 T=yes ×8、no ×11 |
| V（机会锚点） | yes ×8 |
| O（机会级） | unknown ×7；yes ×1（OPP-08，经 continuation 观测） |
| D（机会级） | unknown ×8 |
| 目标原则状态 | injected ×4；dropped ×8；`unobservable_event_log_gap` ×10 |
| 核验证据强度 | observed ×5；observed_in_continuation ×1；partial_existence_only ×1；none ×15 |
| 已确认“确实遗漏目标原则”的机会 | **0** |
| Native 同文 / 无新增提示增量 | 0（未发现可证实的 Native 同文场景） |

**注意**：`D/T` 的分母是 8 个抽样机会，不是 238，也不是总体覆盖率。任何“覆盖率”表述都只在本样本内成立。

## 3. 逐候选摘要

完整字段（内容哈希、注入 runId、工具类别、claim seq、缺失/冲突说明）见配套 JSON；下表只做导航。

| ID | 层 | 时间(UTC) | session/seq | 机会 | T/V/O/D | 目标状态 | 核验证据 | 说明 |
|---|---|---|---|---|---|---|---|---|
| C01 | human | 10-30 11:24 | 42b62f3e/1 | yes | yes/yes/unknown/unknown | unobs | none | 调查答复已交付；未见核验动作；注入日志缺口 |
| C02 | human | 10-30 11:31 | 42b62f3e/25 | yes | yes/yes/unknown/unknown | unobs | observed | 哈希/读取先于完成；未见交付声明文本 |
| C03 | human | 10-30 13:22 | 42b62f3e/64 | yes | yes/yes/unknown/unknown | unobs | none | 零工具纠正说明；无法确认漏触发 |
| C04 | human | 10-30 13:26 | 42b62f3e/67 | yes | yes/yes/unknown/unknown | unobs | observed | 持久信号创建；可能含多个交付决定（歧义） |
| C05 | human | 10-30 14:33 | 42b62f3e/218 | yes | yes/yes/unknown/unknown | unobs | none | 零工具判断答复；漏触发不可确认 |
| C06 | human | 10-30 14:44 | 42b62f3e/222 | yes | yes/yes/unknown/unknown | unobs | observed | 调查型，有读取/哈希动作 |
| C07 | human | 10-30 15:43 | 42b62f3e/288 | yes | yes/yes/unknown/unknown | unobs | none | 短结论请求；无核验动作 |
| C08 | human | 10-30 15:53 | 42b62f3e/294 | **yes（OPP-08 锚）** | yes/yes/unknown/unknown | unobs | observed_in_continuation | 明确报告交付物；该 turn 注入不可观测，续轮可观测 |
| C09 | human | 10-31 00:01 | 42b62f3e/301 | cont→OPP-08 | inherited_yes/yes/partial/unknown | injected | observed | 仅 00:44:23 注入先于后段动作 |
| C10 | human | 10-31 01:47 | 42b62f3e/427 | cont→OPP-08 | inherited_yes/yes/yes/unknown | injected | observed | 两 run 均注入目标 |
| C11 | human | 10-31 03:44 | 42b62f3e/474 | cont→OPP-08 | inherited_yes/yes/yes/unknown | injected | partial_existence_only | 写产物→目录清单→交付声明(seq 656)；清单只证存在 |
| C12 | human | 11-05 08:20 | 196f042b/4 | no | no/-/-/- | injected | none | `pd_recall` 工具冒烟，无交付物 |
| C13–C22 | audit | 10-30..11-03 | 8e64912c/* | no | no/-/-/- | unobs×2 / dropped×8 | none | 心跳轮：无产物编辑、无工具、无交付决定；排除**不**依据 dropped |

## 4. 关键观察（只描述事实）

1. **唯一完整可观测的交付机会**（OPP-08，报告任务）在 C10/C11 两个 run 中目标原则均被注入（C11：`eligibleCount=18 / injectedCount=18`，`budget=15625`），且注入了多次核验动作（哈希/读取）与一次“写产物→目录清单→交付声明”的收口链。
2. **收口前的核验是弱核验**：C11 的 `ls` 只能确认文件存在，不能确认新鲜度/内容正确；交付声明（seq 656）之前没有哈希、重跑或内容比对。证据强度记为 `partial_existence_only`。
3. **心跳轮不构成交付机会**：10 条审计样本均无产物编辑、无工具调用、无用户要求的交付物；其中 8 条目标原则被 dropped，但排除理由是 `NO_DELIVERY_DECISION`，**不是** dropped。
4. **注入日志存在历史缺口**：`events_2026-10-30.jsonl` 不存在，10-30 的 8 个人类交付机会全部 `injectionObservable=false`；这些机会的 O/D 只能记 unknown。
5. **无法用正文哈希合并请求**：C10 与 C11 都是“输出报告”，但按 `session+seq` 计为同一机会的两个 continuation，不合并发生次数、也不因正文相似而合并。
6. **预算不是固定 4000**：窗口内 `budget` 分布 2000×157、4000×46、15625×33、31250×2；C09/C10 为 2000，C11 为 15625。因此“每轮固定丢 2 条”不成立。

## 5. 限制与未知

- `transcript_events` 的 `created_at` 是落库时间；`trajectory_runtime_events` 的 `seq` 是 session 内单调序号。二者结合可给排序，但**不是同一时钟的同一事件时间戳**。
- `context.compiled.systemPrompt` 记录被截断在 32768 字符（`reason=trajectory-field-size-limit`，原始 53362–64892 字符），**目标原则正文不在已记录片段内**；`messages` 只含前 9 条内容消息。
- `provider.prompt.observed` 只记录 `expectedChars/observedChars/matchesAssembledPrompt`，不记录正文；且在本窗口中只出现在**无工具调用的心跳 run**，C09–C11 等交付 run 均无该事件。原因未知。
- PD 自身的 `intervention_evidence_records` 中 `occurred_at/delivery_key/episode_key` 为空，不能提供发生时刻或交付身份；排序必须回到宿主 trace。
- 本窗口内真正的人类交付请求很少（12 条人类 turn，其中 8 条为同一调查/报告会话语义），**样本量不足以判断总体覆盖率，也不足以单独判定“单目标强制装配”是否必要**。
- 未读取、未提交任何密钥；提交版 JSON 不含原始 user/assistant 文本或工具参数，仅含哈希、长度、类别与脱敏说明。
