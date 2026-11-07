# PRI-1119 Provider / 宿主取证能力核查（只读）

- 文档 ID：`pd-aa-pri-1119-provider-evidence-20261107`
- 核查时间：2026-11-07（Asia/Shanghai）
- 范围：**当前真实使用的 provider / 宿主版本与已有日志能力**；不开启新日志、不改配置、不发请求、不换模型/provider
- 敏感内容：日志正文只在本地读取；本文只保留字段名、长度、哈希与脱敏引用，不含密钥或原始正文

## 1. 被核查的实际版本

| 项 | 事实 | 证据 |
|---|---|---|
| 宿主存储 | `C:/Users/Administrator/.openclaw/agents/main/agent/openclaw-agent.sqlite` | 只读打开成功；`transcript_events` 68,325 行，`trajectory_runtime_events` 2,828 行 |
| 当前 harness（最近 run） | **OpenClaw `2026.11.1`** | 最新 `trace.metadata.data.harness.version` |
| 当前 provider / model | **`amd-radeon-cn` / `DeepSeek-V4-Flash` / `openai-responses`** | 最新 `trace.metadata.data.model` |
| 样本期 provider / model（修订） | **非单一模型**：主导 `amd-radeon-cn`（`DeepSeek-V4-Flash` 心跳 + `Qwen3.8-Flash-Next` 主工作会话，`openai-completions`/`openai-responses` 混合）；`zai` / `glm-5.3-flash` 仅 2 个 run（C11 交付 run bbfd31e8、C12 冒烟 run ebd486a3） | 全窗口 `trace.metadata` 逐 run 统计：10.5 期 DeepSeek-V4-Flash×106 / Qwen3.8-Flash-Next×50 / glm-5.3-flash×1；10.10 期 DeepSeek-V4-Flash×54 / glm-5.3-flash×1 |
| 样本期 harness 版本 | **窗口内两次变更**：`2026.10.5`（10-30..11-03 上午）→ `2026.10.10`（11-03 13:11 起）→ `2026.11.1`（11-06 10:04 起，当前） | `trace.metadata.data.harness.version` 逐 run 时间线 |
| 工作区 | `D:/.openclaw/workspace`（`.pd/state.db`、`.state/logs/`） | 实际只读查询 |

**注意**：样本期（10-30..11-06）内部就有多次宿主版本变更（`2026.10.5` → `2026.10.10` → 当前 `2026.11.1`）与多次模型使用变更（DeepSeek-V4-Flash / Qwen3.8-Flash-Next / glm-5.3-flash 交替出现）。任何“当前能力”结论都必须按版本限定；样本中的 provider 观测事实不能直接外推到当前版本，反之亦然。“样本期 provider/model”不能写成单一值。

## 2. 记录能力矩阵（已验证 / 未知）

| 能力 | 结论 | 已验证事实 |
|---|---|---|
| 是否记录最终请求正文 | **否（完整正文不可得）** | `context.compiled` / `prompt.submitted` 记录 `messages`（仅前 9 条有内容）、`systemPrompt` 元数据与 `prompt`（用户消息）；`systemPrompt.originalChars` 5.3–6.5 万，但记录被截断在 **32,768** 字符（`reason=trajectory-field-size-limit`）。目标原则正文位于 system prompt 注入块，落在被截断部分 |
| 是否有独立的 provider 侧观测 | **仅有长度校验，无正文** | `provider.prompt.observed` 字段：`expectedChars`、`observedChars`、`matchesAssembledPrompt`、`model`；无 body/hash |
| 能否关联 session / run / request / tool | **可以（session+seq+runId）** | `transcript_events`：`session_id + seq`；`trajectory_runtime_events`：`run_id`、`seq`、`tool_call.toolCallId`；注入事件含 `sessionId`、`workspaceDir`、`runId`、`eventId`、`hostKind` |
| 注入事件能否关联到具体 user turn | **间接（时间/序号）** | 注入事件无 user-turn id，但有 `sessionId + runId`；run 起始时间与 transcript 的 `user` 行 `seq` 可确定“该 run 属于哪次 user turn” |
| 时间戳边界与顺序意义 | **可排序，但不是同一时钟** | transcript `created_at` 为毫秒落库时间；trace `ts`/`created_at` 为运行时事件时间；同一 session 内 `seq` 单调，可作为可靠顺序 |
| PD 自身证据存储 | **有时刻/身份缺口** | `intervention_evidence_records` 的 delivery 行 `occurred_at` 为空、`delivery_key/episode_key` 为空；`recorded_at` 是再摄入时间，不能当发生时间 |
| 开启记录的配置/隐私/容量/性能影响 | **未知（宿主侧）** | 记录已默认开启且字段有 32,768 上限；放宽上限意味着保存敏感 prompt 正文、增大 DB 与写入量。该配置不在 PD 仓库内，未验证 |

## 3. 关键覆盖发现

1. `provider.prompt.observed` 在本窗口的 22 个候选中：**只出现在无工具调用的心跳 run**（C13–C22，10/10）；所有人类交付 run（C01–C11）**均无**该事件。原因未知。
2. 因此，**恰好在我们关心的交付 run 上，D（目标正文进入实际请求）不可独立确认**；心跳 run 虽有长度匹配，但目标原则当轮被 dropped，目标正文本来就不在请求中。
3. 注入事件的 `eligibleCount` 恒为 18，`budget` 在 2000/4000/15625/31250 间变化；`droppedActivationIds` 条数随之变化（0–14），**不存在“每轮固定丢两条”**。
4. 目标原则的 activation 自 **2026-09-25T15:36:19.050Z** 起 active，窗口内没有撤销；因此 dropped 不是“未授权”造成的。
5. **配置-运行漂移**：`openclaw.json` 的 `agents.entries.main.model.primary` 仍是 `zai/glm-5.3-flash`（外部付费），`modelPolicy.allow` 却包含 `amd-radeon-cn` 系列本地模型；窗口内 runtime 实际以 `amd-radeon-cn`（DeepSeek-V4-Flash / Qwen3.8-Flash-Next）为主，`zai/glm-5.3-flash` 仅 2 run。这意味着按配置假设“生产在外部付费模型上运行”已不成立；任何涉及 provider 的成本/隔离论证都必须以 runtime 实际路由为准。

## 4. 未知（保留，不补造）

- `provider.prompt.observed` 的发射条件：是否依赖 provider/API 模式、是否有 tool call、或某个 trace 采样开关？当前证据只支持“与无工具调用相关”，不支持因果。该事件跨 `2026.10.5` / `2026.10.10` / `2026.11.1` 三个 harness 版本期均出现（155/155 个 run 均无工具调用），因此**不是**单一版本的发射逻辑，但版本内条件仍未知。
- 放宽 32,768 字符上限的官方配置入口、成本与隐私后果。
- 当前 harness `2026.11.1` 是否仍采用相同的字段截断与 provider 观测逻辑（样本窗口内 `2026.10.5` / `2026.10.10` 两版均已实测到相同截断 reason 与零工具观测形态；`2026.11.1` 期观测事件也已出现，但窗口更短）。
- 注入事件的 `eventId` 是否能与宿主 request/message id 直接对齐；目前只验证到 session+run 级。

## 5. 最小取证方案（供后续批准，本轮不实施）

不换 provider、不换模型；只补“能让 D 可判定”的最小字段。

| 选项 | 做法 | 决策价值 | 成本/风险 | 结论 |
|---|---|---|---|---|
| **P0（推荐先做）** | 维持现状，用 `systemPrompt.originalChars` + `injectedCharCount` + 注入事件做**长度级关联**，D 保持 `unknown` | 零成本；可支持“注入未注入”和“是否在请求规模内”的判断 | 不能证明正文；D 永远 unknown | 不新增能力 |
| **P1（最小新增）** | 为交付 run 记录 `promptBodySha256`（仅哈希，不存正文）与 `injectedBlockSha256` | 可独立确认“目标块进入了同一请求”；满足 D 的哈希证据 | 需要宿主侧字段；隐私低（哈希）；容量小 | 需 Owner 批准宿主改动 |
| **P2** | 放宽 `systemPrompt` 记录上限或单独存注入块正文 | 正文级 D 证据 | 敏感正文落库；容量/隐私/性能上升 | 不建议作为首选 |
| **P3** | 不补 D，改用产物侧核验（哈希/mtime/重跑）判断遵循 | 可观察行为结果，不可证明请求送达 | 零宿主改动；只能支持 O/行为层 | 与 P1 并行仍不足 D |

**本轮未开启任何新日志、未修改配置、未发送请求。** P1/P2 均需另行批准；在批准前，G1 的 D 证据不可签收。

## 6. 与样本清单的关系

- 样本清单的 `D=unknown` 不是“没查”，而是“现有日志确实没有正文级证据”。
- 若要继续验证“单目标强制装配是否必要”，**不需要先补 D**：用现有 session+seq+runId 联结，扩大只读窗口即可判断“交付机会是否漏注入”。
- 若要验证“原则是否真的进入模型请求并产生影响”，才需要 P1（或 P2）的批准。
