# Pi 1.2.0 兼容性审计报告（Phase 0A）

- SPEC：SPEC-PD-PI12-COMPAT-001（Phase 0 时点为 v0.1；现行版本见同目录 `SPEC-PD-PI12-COMPAT-001-v0.2.md`）
- 日期：2026-10-17
- 入库说明：本文件为受版本控制的审计交付副本（`docs/audit/` 被 gitignore，按仓库 Reality-Audit 入库惯例存放于 `docs/specs/`）。内容与 Phase 0 审计一致；§B/§C 的版本对照结论不随后续实施变化。
- 审计基线：PD `main @ 702d92233`（产品版本 2.3.6，当时与 origin/main 一致；Phase 1 实施基线前移至 `d91b9e07e`，差异仅 PRI-1011/PRI-995 等，与本审计的 Pi 版本对照无交集，已在 SPEC v0.2 §15 以共存测试覆盖）
- 对比对象：`@earendil-works/pi-ai` / `@earendil-works/pi-agent-core`，**v0.85.1（现用）→ v1.2.0（目标）**
- 证据方法：全部结论来自本地 `D:\Code\pi-mono` 两个 git tag 的真实源码（`git show v0.85.1:…` / `git show v1.2.0:…`）与 PD 当前源码逐行核验；npm registry 已发布 1.2.0（与本地 tag 同名版本）。本文所有 `path@tag:line` 引用均为只读源码证据。

---

## A. PD 侧 Pi 调用点全景

**全部直接 import 只存在于 8 个生产文件**（全仓 `rg` 所有 import 形态核实，含 host-runtime / pd-cli / openclaw-plugin / pd-console / workbuddy-adapter / create-principles-disciple——后者仅声明依赖与锁，无源码 import）：

| 路径 | 文件 | 使用的 Pi 符号 |
|---|---|---|
| A. One-shot | `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts`（1639 行） | compat: `getModel`, `completeSimple`；类型 `Context/UserMessage/AssistantMessage/Model/SimpleStreamOptions/ToolCall` |
| A. One-shot | `.../adapter/pi-ai-catalog.ts`（20 行） | compat: `getProviders`（EP-06：跨包查询不经 pi-ai） |
| A. One-shot | `.../adapter/pi-ai-http-transport.ts`（104 行） | 类型 `FetchFunction`（undici dispatcher 绑定；I/O seam 注册） |
| A. One-shot | `.../adapter/tools/diagnostician-tool.ts`（48 行） | 类型 `Tool`（record_* 工具定义） |
| B. Dreamer L2 | `.../adapter/l2-agent-loop-adapter.ts`（727 行） | `runAgentLoop`；类型 `AgentMessage/AgentLoopConfig/AgentEvent`；compat: `getModel/getProviders/completeSimple/streamSimple`；`Model/Message/KnownProvider/Context/Api/SimpleStreamOptions` |
| B/C 共用 | `l2-agent-loop-adapter.ts` 内 `pdStreamSimple`（:284-286，导出给 Artificer） | compat `streamSimple` + PD 自定义 fetch |
| B. 工具 | `.../tools/agent-tool-contract.ts`（220 行） | 类型 `AgentTool/AgentToolResult`（read_principles / read_artifact / submit_output） |
| C. Artificer L2 | `.../adapter/artificer-l2-adapter.ts`（751 行） | `runAgentLoop`；同 B 类型集 |
| C. 工具 | `.../tools/artificer-l2-tool-contract.ts`（415 行） | 类型 `AgentTool/AgentToolResult`（read_rulecode_spec / validate_rulecode / replay_rulecode / submit_rulecode） |

生产接线（均经 `@principles/core/runtime-v2` 公共导出，无直接 Pi import）：

- core 内：`pain-signal-runtime-factory.ts:38-39,556-567,768-780`（复用评估门 + diagnostician 桥）、`runtime-v2/cli/probe.ts:74-95`。
- host-runtime：`src/internalization-consumer-cycle.ts:39-41,648-721` —— **三适配器的唯一生产装配点**；入口 openclaw-plugin `src/service/internalization-auto-consumer-service.ts`。
- pd-cli：`src/services/runtime-adapter-resolver.ts:160,282-320` + diagnose/candidate/pain-retry/runtime-internalization-run-once/run-rulehost 各命令。
- openclaw-plugin：`src/core/signal-collector-host.ts:724-734`、`src/service/correction-observer-service.ts:183-193` 直接构造 PiAiRuntimeAdapter。

打包/安装面：

- 声明：`packages/principles-core/package.json:108-109` 与 `packages/create-principles-disciple/core/package.json:102-103`（`^0.85.1`）；**全仓仅此两处声明**。
- release-locks：7 个 `release-locks/*/package-lock.json` 全部精确解析 0.85.1（installer `scripts/generate-release-locks.mjs` 生成）。
- 卫兵：`scripts/build/check-satellite-purity.mjs:62-69`（LLM 包禁入卫星 bundle，主 bundle 豁免）；`packages/openclaw-plugin/tests/scripts/transitive-deps.test.ts`（传递闭包守卫，静态 fixture）。
- 插件运行时解析：`openclaw-plugin/esbuild.config.js:35-62` —— **pi-ai/pi-agent-core 在构建期内联进 `dist/bundle.js`**（externals 仅 openclaw 系 + better-sqlite3）。

关键治理事实（与 Pi 版本无关、迁移不可绕过）：

- Artificer 的 Owner-Evidence 就绪门在**适配器构造之前**：`internalization-consumer-cycle.ts:504-594`（preflightArtificerOwnerEvidence：`evidence_source_unavailable/error/blocked` 三态全部阻止运行；blocked 原子转 `needs_human_review`）。Pi 升级不触碰该层。
- Artificer **无 L1 回退**（`artificer-l2-adapter.ts:25-28,619-622`，PRI-439）；Dreamer 有 `l2FallbackToL1`（默认 true）。
- `run-once` 拒绝 Code Rule 任务、`run-rulehost` 原子解析整条能力链（`pd-cli/src/commands/runtime-internalization-run-once.ts:570-578`、`runtime-internalization-run-rulehost.ts:192-256`）。

## B. pi-ai 差异（0.85.1 → 1.2.0，PD 视角）

1. **`/compat` 门面签名完全不变**：`complete/completeSimple/stream/streamSimple/getModel/getProviders` 签名逐字相同（`compat.ts@v1.2.0:278-302` vs `@v0.85.1`）。内部变化仅一处垫片：`stream/streamSimple` 先 `normalizeContext(context)` 把 `Context.systemPrompt/tools` 折叠为首条 SystemMessage 再分派（`utils/transcript.ts@v1.2.0:29-34`）。**PD 的 One-shot 路径因此零迁移**。
2. `getModel(provider, id)` 两参签名不变（无第三参 override；自定义 baseUrl 仍靠展开 model 对象——PD `resolveModel`/`resolveL2Model` 正是这么做的）。两处 `@ts-expect-error` 依旧成立。
3. `SimpleStreamOptions`/`StreamOptions`：PD 使用的 `signal/apiKey/fetch/onPayload/onResponse/timeoutMs/maxRetries/maxTokens/temperature/reasoning` 全部保留；新增 `onProviderStreamEvent`（0.99）。**无 `responseFormat` 字段**（PD 的 json_schema 走 `onPayload` 改写 payload，见 §B.6）。
4. `StopReason`、`Usage` 枚举/字段不变；`AssistantMessage` 新增 `thinkingLevel?`（0.99）与 `durationMs?`（1.1）——多余字段，PD 提取器天然容忍。
5. 类型收紧（编译期，PD 实测仅 1 处碰撞）：`ToolCall.arguments: Record<string,any>` → `JsonObject`；`ToolResultMessage` 条件 JSON 类型；`Message` 联合新增 `SystemMessage`。
6. **`onPayload` 消费位置不变**：仍在各 per-API 适配器内（`api/openai-completions.ts@v0.85.1:357` vs `@v1.2.0:366`，逐 API 对照完全同构）；`simple-options.ts` 依旧从 SimpleStreamOptions 转发。PD 的 `tool_choice:'required'`（:1086-1092）与 `response_format json_schema`（:1159-1182）改写机制存活。
7. Google 双适配器对自定义 fetch 的入口拒绝原样保留（`api/google-generative-ai.ts@v1.2.0:88`、`api/google-vertex.ts:97`，错误文本不变）——PD 的 `CUSTOM_FETCH_REJECTED_APIS` 集合继续正确。
8. Provider 目录：`azure-openai-responses` → `azure`（1.0.3，Breaking）。**PD 全生产源码零处 azure 引用**（rg 核实），无影响。
9. 重试分类扩展（0.86→1.2 多次）：PD `maxRetries:0` 关闭库内重试、自管重试按 errorMessage 正则分类——分类词表变化只影响 PD 正则的命中率边缘，`classifyFailure` 的 timeout/rate-limit 正则不受影响（源码核对 `utils/retry.ts` 变更集）。
10. 打包：ESM-only 不变；`engines.node >=22.19.0` 不变；`files` 仍为 dist+README；新增轻量 `./models` 入口（0.99.2）。依赖变化（全部纯 JS、无新原生/平台二进制）：openai 6.40→7.19、@anthropic-ai/sdk 0.123→0.129、@google/genai 1.52→2.21、http(s)-proxy-agent 7→9.1、@aws-sdk/client-bedrock-runtime 3.1048→3.1127、typebox 1.3.7→1.3.27、pi-telemetry ^0.85.1→^1.2.0（实测解析 1.3.0）。

## C. pi-agent-core 差异（0.85.1 → 1.2.0，PD 视角）

1. **`runAgentLoop` 6 参位置签名不变**（`agent-loop.ts@两tag`）；`streamFn ?? getDefaultStreamFn()` 回退不变；`AgentLoopConfig extends SimpleStreamOptions` 不变；**两版都没有 `maxTurns` 字段**（轮数上限本就由停止钩子实现——PD 自管计数器不受影响）。
2. **`AgentContext.systemPrompt` 被移除**（`types.ts@v0.85.1:415` vs `@v1.2.0:502`）：1.2.0 中 system prompt 与工具声明全部进入 transcript（SystemMessage）。`runAgentLoop` 入口用 `declareToolChanges(context, prompts)`（`agent-loop.ts@v1.2.0:110,333-360`）把 `context.tools` 合并进 prompts 中最后一条 system 消息的 `toolsAdded`；请求构造改为 `normalizeContext({ messages: llmMessages })`（:407-419，**不再读取 context.systemPrompt/tools**）。
   - **暗坑（编译不可见）**：PD 的 `agentContext` 经无标注中间 const 传入，多余属性 `systemPrompt` 会被结构性类型静默忽略——不迁移则 system prompt 无声丢失，tsc 不报错。
3. **`shouldStopAfterTurn` → `finishTurn`**（0.87.0 Breaking；官方迁移式见 `packages/agent/CHANGELOG.md@v1.2.0` §0.87.0）。语义矩阵（两版 `agent-loop.ts` 逐行对照）：

| 维度 | 0.85.1 `shouldStopAfterTurn` | 1.2.0 `finishTurn` |
|---|---|---|
| 调用时机 | `turn_end` 事件**之后**，仅正常回合 | `turn_end` **之前**，每个回合 |
| error/aborted 回合 | **不调用**（`agent-loop.ts@v0.85.1:215-219`） | **会调用**（`@v1.2.0:245-257`）但决策被忽略（硬退出不变） |
| 返回 true / `{action:'end'}` | 立即 `agent_end` 返回；不轮询 steering/followUp 队列 | 同效果（先发 `turn_end` 再结束；同样跳过队列轮询与 `prepareNextTurn`） |
| 返回 `{action:'continue'}` | 不存在 | 保证恰好再发一次 provider 请求（无排程时做一次纯上下文请求后停止，`:310-313`） |
| 入参 | `(turn)` | `(turn, signal?)`，`turn.message.stopReason` 可用于守卫 |

   迁移式（PD 两个 L2 适配器采用）：守卫 error/aborted **在递增 turnCount 之前** return undefined，其余返回 `{action:'end'}`/undefined——保真 0.85 的轮数记账与硬退出行为。
4. `convertToLlm`：1.2.0 文档契约允许并期望 `system` 角色直通（`defaultConvertToLlm` 0.85 过滤 system、1.2 直通）。PD 两适配器的三元角色白名单必须加 `system`，否则迁移后首请求即抛 `output_invalid`。
5. `AgentTool`/`AgentToolResult`：`execute` 契约从「失败必须 throw」扩展为「throw 或 `isError:true`」；新增 `outputSchema?/structuredContent?`；**`addedToolNames` 移除**（PD 未使用）；`terminate` 保留（批内全部 terminate 才短路 `hasMoreToolCalls`，两版同 `.every()` 语义）。PD 工具全部走 `content+terminate`，零迁移；1.2 下白名单外工具调用由循环本体先拒绝（`Tool <name> not found` + `isError:true`，两层防御与 0.85 一致）。
6. `AgentEvent` 联合不变（`tool_execution_end` 增可选 `durationMs`）；`message_end` 事件仍是 stopReason/errorMessage 观测点——Artificer 的 EP002-R3 错误捕获通道存活。
7. `getFollowUpMessages`/`getSteeringMessages`/`beforeToolCall`/`afterToolCall`/`toolExecution` 契约不变——Artificer 的 no-tool-call nudge 机制原样保留（`prepareNextTurn` 新增 messages 注入能力，PD 不需要）。
8. **1.1.0 Breaking（对自定义 stream 函数）**：stream 函数须返回 `AssistantMessageEventStream`。PD 的 `pdStreamSimple` 直接包装 compat `streamSimple`（1.2.0 已返回该类型），且 loop 传入的 `TranscriptContext` 结构性满足 `Context` 参数——实测编译通过、运行正常。
9. 1.0.0 大扫除：实验 Harness、`./node`、`./harness/*`、durable/sessions、`uuidv7`/pi-telemetry 再导出全部移除——PD 仅用 `runAgentLoop`+类型，零影响；**依赖从 7 个减到 2 个**（`pi-ai ^1.2.0` + `typebox 1.3.27`；chord/diff/ignore/yaml/pi-telemetry 全部消失，实测 `npm ls` 确认）。

## D. 差异矩阵（要求格式）

| # | API | 旧版本（0.85.1 实际行为） | 新版本（1.2.0 实际行为） | 调用点（PD 文件:行） | 差异 | 风险 | 迁移方式 | 验证 |
|---|---|---|---|---|---|---|---|---|
| 1 | `runAgentLoop` 签名 | 6 位置参数，返回 `AgentMessage[]` | 同 | `l2-agent-loop-adapter.ts:487-494`、`artificer-l2-adapter.ts:563-578` | 兼容 | P3 | 无 | E02/E03 真实 loop |
| 2 | `AgentContext` | `{systemPrompt, messages, tools}` | `systemPrompt` 移除；prompt/工具走 transcript | 同上 :458-462 / :448-452 | **行为破坏（编译不可见）** | **P0** | prompts 前插 SystemMessage；`messages: []`；工具仍走 `context.tools`（declareToolChanges 合并进 system 消息） | E02 断言请求 transcript 形状 |
| 3 | `shouldStopAfterTurn` | turn_end 后、仅正常回合、boolean | 移除，替换为 `finishTurn`（§C.3 矩阵） | `l2:479-482`、`artificer:499-502` | **签名+语义变化** | **P0** | error/aborted 守卫前置（不计数）+ `{action:'end'}` | 契约测试 6 处更新 + E02/E03 轮上限/中止用例 |
| 4 | `convertToLlm` 角色域 | user/assistant/toolResult | 须放行 system（否则抛错） | `l2:467-472`、`artificer:487-492` | 行为破坏 | **P1** | 白名单加 `system` | E02 首请求即覆盖 |
| 5 | `ToolCall.arguments` | `Record<string,any>` | `JsonObject` | `pi-ai-runtime-adapter.ts:1101-1104` | 编译期收紧 | P2 | 谓词改用 SDK `ToolCall` 类型 | tsc 全绿 + Path-1 既有套件 |
| 6 | compat 五函数 | — | 签名逐字相同，内部 normalizeContext 垫片 | `pi-ai-runtime-adapter.ts:21`、`l2:37` 等 | 兼容 | P3 | 无 | E04 + core 全量 8486 |
| 7 | `SimpleStreamOptions` | signal/timeoutMs/maxRetries/fetch/onPayload… | 全保留，新增 onProviderStreamEvent | 全部 options 构造点 | 兼容 | P3 | 无 | E04 重试/超时/中止 |
| 8 | `onPayload` 改写 | openai-completions 适配器内消费 | 同位置同构 | `pi-ai-runtime-adapter.ts:1086-1092,1159-1182` | 兼容 | P2（仅源码级验证） | 无 | faux 不走 HTTP 适配器 → 标注 SOURCE-VERIFIED，真实 HTTP NOT_RUN |
| 9 | Google 自定义 fetch 拒绝 | 两适配器入口 throw | 不变 | `pi-ai-http-transport.ts:81-84` | 兼容 | P3 | 无 | 既有 transport 套件在 1.2 下通过 |
| 10 | Provider `azure-openai-responses` | 存在 | 更名 `azure` | PD 零引用 | 无影响 | P3 | 无 | rg 全仓核实 |
| 11 | `AgentTool/AgentToolResult` | addedToolNames… | isError/structuredContent 新增，addedToolNames 移除 | 两个 tool-contract | 兼容（PD 未用移除项） | P3 | 无 | E02/E03 工具全链 |
| 12 | `Message` 联合 | 3 角色 | +SystemMessage；transcript 遍历 | 两 L2 适配器后处理 | 兼容（后处理按 role 过滤） | P3 | 无 | E02/E03 |
| 13 | 依赖树 | agent-core 带 chord/diff/ignore/yaml/pi-telemetry | 仅 pi-ai+typebox；pi-ai 依赖大版本上移 | 两处 package.json + 7 锁 | 打包变化 | P2 | 重生成 release-locks（Node22/npm10 工具链） | E05：core/host-runtime 锁已再生成解析 1.2.0 |
| 14 | `engines.node` | ≥22.19.0 | ≥22.19.0 | — | 兼容 | P3 | 无 | 安装链核实 |

## E. 审计中发现的存量怪癖（非 1.2 引入，迁移决策须显式化）

1. **0.85.1 生产路径用户消息每请求重复两次**：PD 把同一 `prompts` 数组同时作为 `runAgentLoop` 的第 1、2 参，而两版 loop 都构造 `[...context.messages, ...prompts]`（`agent-loop.ts@v0.85.1:110-113`）——LLM 请求中用户消息出现两份。1.2 迁移改为 `context.messages: []`，**顺带修复该缺陷**（行为变化：请求负载不再重复；成本微降、语义无损失）。E02 以断言锁定新形状（`['system','user']` 恰好各一条）。
2. **Dreamer 预算中止分类宽松**（存量）：中止回合无 submit/无文本 → `empty` → （禁回退时）`output_invalid`，而非 timeout。0.85 与 1.2 行为一致（E02 实测）；严格分类只在 Artificer（PRI-795）。不在本 SPEC 范围内修复。
3. **beforeToolCall 白名单双层防御**：白名单外工具（不在 context.tools）由 loop 本体以 `Tool <name> not found` + `isError:true` 拒绝，PD 的 beforeToolCall 是第二层。两版一致（E03 实测断言）。

## F. 仅源码级验证 / NOT_RUN 清单

| 项 | 状态 | 原因 |
|---|---|---|
| `onPayload` 对真实 HTTP payload 的改写（tool_choice/response_format） | SOURCE-VERIFIED | faux provider 绕过 per-API HTTP 适配器；两版消费点同构已逐行核对。真实连发验证留给 PR-04 的 opt-in 真实 LLM E2E（LLM_E2E_ENABLED） |
| 真实付费 LLM 行为（思考格式/成本/限流词表） | NOT_RUN | 任务书禁止付费调用 |
| pi-telemetry 1.3.0 传递依赖的运行时行为 | 间接验证 | 随 1.2.0 锁解析；core 全量套件含其代码路径 |
| plugin/codex-adapter/console/pd-cli/workbuddy release-locks 再生成 | NOT_RUN（本地） | npm11 对 file: 依赖写 link 形态，脚本自身要求 Node22/npm10 工具链（与 Pi 版本无关的环境约束）；core/host-runtime 锁已成功再生成并解析 1.2.0 |

---

## G. 审计结论

PD 的 Pi 消费面**惊人地窄**：8 个文件、1 个循环入口、5 个 compat 函数、1 组类型。1.2.0 的破坏集中在 agent-core 的 transcript 化改造（#2/#3/#4），pi-ai 侧对 PD 完全兼容（compat 门面逐字不变）。编译碰撞实测仅 3 处；行为风险集中在「编译不可见的 systemPrompt 静默丢失」与「finishTurn 语义三处细差」，两者均有明确迁移式与测试锁定。**审计判定：迁移面小、可控、可验证；无 P0 级不可解风险。**
