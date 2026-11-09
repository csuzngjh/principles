# PRI-1119 宿主消息身份缺口：上游设计提案与发版依赖评估（v2）

- 文档 ID：`pri-1119-host-identity-upstream-design-20261109`；日期：2026-11-09；工单：PRI-1119
- 性质：**只读核查 + 设计提案**（零编码、零宿主启动、零模型调用、零生产配置变更）。
- v2 修订（同日）：收窄必要性结论的适用范围；修正 v1 对发布版本与历史检索范围的表述；补齐身份数据流（已核实/待证分列）；运行验收由「事件有字段」升级为「正文与身份属于同一当前接纳的用户轮」。
- **结论边界**：合并本文件只归档设计评估。正常入口状态继续为 **BLOCKED**；本文件不启动任何依赖该设计的步骤。
- 前置：PRI-1119 PR #2448（阻断报告，宿主身份缺口=阻断 1）；PR #2449（清单补 `principleId`，结论限定「合法配置可通过清单校验」）。

## 1. 结论与核查范围

**结论（收窄后）**：对已核对的官方 OpenClaw embedded 正常入口，若采用宿主提供的原生消息身份，当前需要宿主侧接线——该入口的 before_prompt_build 事件不携带 `currentUserMessage`/`currentUserMessageId`。本结论不外推到未核对的版本、分支或其他入口。

| 核查对象 | 版本/引用 | 结果 | 源码依据 |
|---|---|---|---|
| 本机已安装宿主 | `openclaw --version` = 2026.11.1 (4ffdd20) | embedded 路径事件只含 `{prompt, messages}` | `dist/context-engine-maintenance-B3wgO8Sx.mjs:326-329`（由 `attempt-system-prompt-prepare-F34qAuO4.mjs` 导入，被 `attempt-execution.runtime` 等使用） |
| 发布源 tag | `release-publish/5e1a27a9bcc4-1794101135`（该提交 `package.json` version = 2026.11.1） | 同上 | 该 tag 的 `src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts:58-65` |
| 上游 main | 本地克隆 `origin/main` = `390d069b8a3`（2026-11-09 fetch） | 同上 | 同文件 `:56-66`（`resolvePromptBuildHookResult`） |
| npm 最新 | `npm view openclaw version` = 2026.11.2 | **未核对**：本地引用中未定位到 2026.11.2 的源提交，不对其下结论 | — |

**历史检索的实际范围**：`git log -S "currentUserMessage" origin/main -- src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts`（本地克隆、单一 ref、单一文件）= 0 命中。含义仅为「该文件在该 ref 的可达历史中从未出现该标识符」；不是对 OpenClaw 全部代码、全部分支或全部发布版本的断言。

## 2. 身份数据流（已核实 / 待证分列）

以下均为上游 main `390d069b8a3` 的**静态源码取证**，未做运行验证。

| 段 | 事实 | 状态 | 依据 |
|---|---|---|---|
| ① 接纳 | 回复管线对当前用户轮做准入：`admitUserTurn(followupRun.userTurnTranscriptRecorder)`；准入经 restart-recovery 声明控制器包装 | 已核实（静态） | `src/auto-reply/reply/agent-runner-execute.ts:65,118,166-169,261` |
| ② 绑定 | gateway 记录用户轮时以 `idempotencyKey: sourceId` 与该轮内容一同写入 `PersistedUserTurnMessage`（`content` + `idempotencyKey`） | 已核实（静态） | `src/gateway/server-methods/chat-user-turn-recorder.ts:65`；`src/sessions/user-turn-transcript.types.ts` |
| ③ 传到同一次 attempt | recorder 经候选参数进入 embedded 运行（`userTurnTranscriptRecorder: params.userTurnTranscriptRecorder`），成为 `attempt.userTurnTranscriptRecorder` | 已核实（静态） | `src/auto-reply/reply/agent-runner-embedded-candidate.ts:196` |
| ④ 调用点可得性 | prompt-build 调用点的作用域内已能读取当前轮：`message`（L216）、admission receipt（L329）、并已把 `message.idempotencyKey` 用于当前轮提示边界归一（L536 `currentUserIdempotencyKey`） | 已核实（静态） | `src/agents/embedded-agent-runner/run/attempt-prompt-build.ts:216,329,536` |
| ⑤ 缺口位置 | 同文件调用 `resolvePromptBuildHookResult`（L159）时未传当前轮；helper 只构造 `{prompt, messages}` | 已核实 | `attempt-prompt-build.ts:159`；`attempt-prompt-helpers.ts:56-66` |
| ⑥ 重试/重建归属 | 准入走 restart-recovery 声明控制器，设计上同一用户轮的 recorder 跨 attempt 复用，从而同一 `idempotencyKey` | 控制器与参数流已核实（静态）；**恢复/重建时是否复用同一 recorder 实例：待证（需运行或测试证据）** | `agent-runner-execute.ts:166-169,261` |
| ⑦ 非聊天触发 | cron/心跳/子代理等无用户轮准入的运行中 recorder 的缺省值 | **待证** | — |
| ⑧ 排除上下文消息 | `message.excludeFromContext` 为真时（L216）身份应否透出 | **待证**（设计取向：透出身份不改变上下文排除语义） | `attempt-prompt-build.ts:216` |

参照实现（已核实）：harness 路径 `resolveAgentHarnessBeforePromptBuildResult` 已接受 `currentUserMessage`（string 或 `Pick<PersistedUserTurnMessage, "content" | "idempotencyKey">`）与 `currentUserMessageId`（`src/agents/harness/prompt-compaction-hook-helpers.ts:38-60`），展开逻辑见已安装 `dist/agent-harness-runtime-D36YOAmh.mjs:320-331`（ID = `params.currentUserMessageId ?? currentUserMessage.idempotencyKey`，仅非空 string 才展开）。

## 3. 最小方案（宿主侧，PD 不实施）

1. **接线点**：`attempt-prompt-build.ts:159` 调用 `resolvePromptBuildHookResult` 时，从作用域内已有的 `attempt.userTurnTranscriptRecorder?.message` 取当前轮（与 L536 读取同一来源），以 harness 同名同型参数传入。
2. **helper**：`resolvePromptBuildHookResult` 增加可选 `currentUserMessage` / `currentUserMessageId` 参数，事件展开复用 harness 规则——文本取 content，ID 取显式参数或 `idempotencyKey`，仅非空 string 才写入事件；取不到就不写（宁缺毋假）。
3. **不新增身份语义**：身份即宿主准入时写下的 `idempotencyKey`；不派生、不合成。
4. **PD 侧零改动**：SDK 类型已含两字段（2026-11-05 身份审计时补齐）；读取/解析/additive-only 装配已在 #2436 就绪并有测试；清单声明由 #2449 补齐；身份缺失时 PD 全链 fail-closed 回 Native（#2448 离线复现 A/B 臂已证）。

**语义边界**：首行标记 `[PD-AA:delivery-review:v1]` 只表示场景信号；prompt 哈希只是内容指纹；`sessionId` 只定位会话；`runId` 只定位运行——四者各守已有语义，任何一个单独或组合都不能充当本轮请求身份。

## 4. 运行验收（宿主接线落地后，需另行授权的有界运行）

**通过判据**：每个被判为交付信号轮的 before_prompt_build 事件中，`currentUserMessage` 的文本与 `currentUserMessageId` **属于同一个当前接纳的用户轮**——文本等于该轮准入内容，ID 等于该轮准入时写下的 `idempotencyKey`。仅「`Object.keys(event)` 出现字段」不构成通过。

| 编号 | 场景 | 必须观察到 |
|---|---|---|
| P1 | 第 1 轮输入 A（首行标记 + 正文 A） | 事件文本 = A 的准入内容；ID = A 的准入 `idempotencyKey`；PD 解析到唯一授权激活 |
| P2 | 紧接第 2 轮输入 B（不同正文） | 事件文本 = B；ID = B 的准入键且 ≠ P1 的 ID（不得沿用上一轮陈旧身份） |
| N1 | 无用户轮准入的运行（cron/自动化） | 事件不含身份字段；PD 不触发，回 Native |
| N2 | 心跳轮 | 同 N1 |
| N3 | 历史中含首行标记的旧消息、当前轮无标记 | 身份只来自当前轮；PD 不因历史标记触发 |
| N4 | 同一用户轮的重试 | ID 与文本均保持为该轮原值；不产生第二个「新轮」 |
| N5 | 同一用户轮的恢复/重建（restart-recovery） | 同 N4；若无法证明复用同一准入，则身份缺失并回 Native |
| N6 | 归属无法证明的任一情形 | 保留缺失（unknown），不补造；PD 走原回退 |

证据要求：事件侧只记录字段键、ID 与正文摘要指纹（不落原文）；准入侧引用宿主 transcript 中该轮记录的 `idempotencyKey` 与内容指纹做逐轮比对。比对一致才计为通过；任一正例失败或任一反例出现身份即判失败。

## 5. 外部依赖、发版与回滚

| 环节 | 内容 | 依赖/授权 |
|---|---|---|
| 实施基线 | 与已安装版本匹配的源线（tag `release-publish/5e1a27a9bcc4`）或上游 main；不得用本地 2026-09-07 旧 checkout 冒充 | 上游提交通道（PD 本轮不提交上游代码或 PR） |
| 上游评审 | 重点是 §4 的同轮归属与反例；身份只表相关性，不表执行授权 | 上游维护者 |
| 发布与升级 | 上游发版后升级本机宿主 | Owner 授权（安装/生产变更） |
| PD 侧验证 | §4 有界运行；通过后才可起草 G1 正常入口验收卡 | 有界运行授权 |
| 回滚 | PD：停用映射（操作页既有路径）；宿主：回退版本；身份缺失时 PD 全链 fail-closed 回 Native | — |

## 6. 不做与边界

- 不在 PD 仓内伪造或推断身份；受控准入不适用于普通入口（SPEC §7）。
- 不做广泛宿主取证；本方案只涉及 embedded prompt-build 的一个调用点与 helper 参数。
- 身份透出不改变宿主权限模型（只读事实字段）。
- 合并本文件不改变任何运行行为、不改变 G1/C04/G2 状态。

## 7. 证据索引

| 类型 | 位置 |
|---|---|
| 已安装 bundle（2026.11.1） | `%APPDATA%/npm/node_modules/openclaw/dist/`：`context-engine-maintenance-B3wgO8Sx.mjs:326`、`agent-harness-runtime-D36YOAmh.mjs:320-331`、`agentsapi-attempt-CUirEvwK.mjs:212` |
| 上游 main `390d069b8a3` | `src/agents/embedded-agent-runner/run/attempt-prompt-build.ts:159,216,329,536`、`.../attempt-prompt-helpers.ts:56-66`、`src/agents/harness/prompt-compaction-hook-helpers.ts:38-60`、`src/auto-reply/reply/agent-runner-execute.ts:65,118,166-169,261`、`src/auto-reply/reply/agent-runner-embedded-candidate.ts:196`、`src/gateway/server-methods/chat-user-turn-recorder.ts:65` |
| 发布源 | tag `release-publish/5e1a27a9bcc4-1794101135`（package.json 2026.11.1）；npm latest 2026.11.2（源提交未定位，未核对） |
| PD 侧就绪 | #2436（读取分支 + additive-only）、#2449（清单声明）、2026-11-05 身份审计（SDK 类型） |
