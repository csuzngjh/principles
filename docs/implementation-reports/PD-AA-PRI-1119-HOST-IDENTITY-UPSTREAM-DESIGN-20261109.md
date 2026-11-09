# PRI-1119 宿主消息身份缺口：上游设计提案与发版依赖评估

- 文档 ID：`pri-1119-host-identity-upstream-design-20261109`；日期：2026-11-09；工单：PRI-1119
- 性质：**只读核查 + 设计提案**（零编码、零宿主启动、零模型调用、零生产配置变更）。上游变更确属必要（§1），本文件是任务要求的「单独提交设计与发版依赖评估」。
- 前置：PRI-1119 PR #2448（阻断报告：宿主身份缺口=阻断 1）；配置兼容修复 PR #2449（阻断 2 已修，结论限定「合法配置可通过清单校验」）。

## 1. 核查结论：官方宿主当前没有适用的正常入口身份契约

| 检查对象 | 结论 | 源码依据 |
|---|---|---|
| 已安装 OpenClaw 2026.11.1（4ffdd20）的 embedded 生产路径 | before_prompt_build 事件只含 `{prompt, messages}`，无身份 | `dist/context-engine-maintenance-B3wgO8Sx.mjs:326-329`（经 `attempt-system-prompt-prepare-F34qAuO4.mjs` 由 `attempt-execution.runtime` 使用，gateway 聊天即此路径） |
| npm 最新发布 2026.11.2 的源线 | 同上，无身份 | 发布源 tag `release-publish/5e1a27a9bcc4-1794101135`（package version 2026.11.1/2026.11.2 发布线）：同文件 `runBeforePromptBuild({prompt, messages})` L58-65 |
| 上游 main（今日 `390d069b8a3`） | 同上，无身份 | `src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts:56-66` `resolvePromptBuildHookResult` 只发两字段 |
| 该文件全历史 | **从未**透出过 `currentUserMessage`/`currentUserMessageId` | `git log -S "currentUserMessage" -- <该文件>` = 0 命中 |
| 已存在的身份契约（harness/agentsapi 路径） | 参数签名支持 `currentUserMessage`（string 或 `Pick<PersistedUserTurnMessage,"content"\|"idempotencyKey">`）+ `currentUserMessageId`，身份取自当前 admitted 用户轮 | `src/agents/harness/prompt-compaction-hook-helpers.ts:38-60`；调用方 `agentsapi-attempt` 传 `admittedMessage ?? params.prompt`；gateway 录制时 `idempotencyKey: sourceId`（`src/gateway/server-methods/chat-user-turn-recorder.ts:65`） |

**结论**：harness 契约已存在且语义正确（真身份 = admitted 用户轮的 `idempotencyKey`），但它只服务 agentsapi 程序化扩展面，**不是 Owner 生产聊天入口**（SPEC §7：选宿主条件要求 Owner 确实在该模式工作）。embedded 路径（生产选定模式）在所有已发布与上游版本上都无身份透出，且历史上从未有过——上游变更确属必要。

## 2. 最小方案（有源码依据）

**一句话**：让 embedded 生产者复用 harness 已有的身份契约——从当前 turn recorder/admission 读取当前用户轮的 `content` 文本与 `idempotencyKey`，传入 `resolvePromptBuildHookResult`，按 harness 同构方式展开进 before_prompt_build 事件。

设计要点（全部映射到现有上游代码形态，不引入新契约）：

1. **签名扩展**（对齐 harness 既有参数）：`resolvePromptBuildHookResult` 增加可选 `currentUserMessage?: string | Pick<PersistedUserTurnMessage, "content" | "idempotencyKey">` 与 `currentUserMessageId?: string` 参数——与 `resolveAgentHarnessBeforePromptBuildResult` 的既有参数（`prompt-compaction-hook-helpers.ts:41-42`）同名同型。
2. **事件展开**（同构 harness 行为，参照已安装 bundle `agent-harness-runtime-D36YOAmh.mjs:320-331` 的成熟实现）：文本取 content（字符串或扁平化 parts），ID 取 `params.currentUserMessageId ?? currentUserMessage.idempotencyKey`；仅当为非空 string 时展开进事件——**没有可靠身份就不展开，宁缺毋假**。
3. **调用方接线**：embedded attempt 流程在构造 hook 参数处从当前 turn recorder/admission 取值（`agentsapi-attempt` 的 `admittedMessage ?? params.prompt` 是现成参照；gateway 录制已带 `idempotencyKey: sourceId`，无需新写录制逻辑）。
4. **负例义务**（与 harness 同标准）：心跳/自动化/上下文注入轮、无 admission、重建/重试、历史消息——不得传入身份；宁缺毋假（unknown ≠ 伪造）。
5. **PD 侧零改动**：SDK 类型已跟进（2026-11-05 身份审计时补齐 `currentUserMessage`/`currentUserMessageId` 可选字段）；读取/解析/装配分支已在 #2436 就绪并有测试；manifest 声明由 #2449 补齐。

**红线**（身份语义，不容妥协）：首行标记 `[PD-AA:delivery-review:v1]` 只是场景信号；prompt 哈希只是内容指纹；`sessionId`/`runId` 只是轮次定位——**三者单独都不能充当本轮请求身份**。请求身份 = 宿主 admission 写下的 `idempotencyKey`，与 harness 契约同源。

## 3. 发版依赖评估

| 环节 | 内容 | 依赖/授权 |
|---|---|---|
| 实施基线 | 与已安装版本匹配的源线（tag `release-publish/5e1a27a9bcc4`）或上游 main `390d069b8a3`；**不得用本地旧 checkout（2026-09-07）冒充**（2026-11-05 审计已明确的边界） | 需 OpenClaw 仓库的提交通道（上游 PR） |
| 上游评审 | 负例覆盖（无 admission/心跳/重建/历史）是评审重点；身份只表相关性、不表执行授权 | 上游维护者评审 |
| 发布 | 上游发版后 npm latest 前进（当前 2026.11.2 → 含该改动的新版本）；本机 `npm global` 升级**需 Owner 授权**（升级属安装/生产变更） | Owner 授权 |
| PD 侧验证 | 零代码改动；升级后第一验证步 = 一次隔离回合实测 `Object.keys(before_prompt_build event)` 确认身份字段在场，才进入 G1 正常入口验收卡 | 有界运行授权 |
| 回滚 | PD 侧：映射停用（操作页既有停用路径）；宿主侧：回退宿主版本；身份缺失时 PD 全链 fail-closed 回 Native（已复现验证） | — |

## 4. 风险与不做

- 不在 PD 仓内伪造身份或绕过宿主（无 PD 侧旁路；受控准入不适用普通入口，SPEC §7 已禁）。
- 不做广泛宿主取证：本方案只动 embedded 生产者的一个传参点 + 负例测试。
- 身份透出不改变宿主权限模型（hook 事件只新增只读事实字段，无执行授权含义）。

## 5. 证据索引

| 类型 | 位置 |
|---|---|
| 已安装 bundle | `%APPDATA%/npm/node_modules/openclaw/dist/`：`context-engine-maintenance-B3wgO8Sx.mjs:326`、`agent-harness-runtime-D36YOAmh.mjs:320-331`、`agentsapi-attempt-CUirEvwK.mjs:212` |
| 上游 main（2026-11-09 fetch） | `origin/main 390d069b8a3`：`src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts:56-66`、`src/agents/harness/prompt-compaction-hook-helpers.ts:38-60`、`src/gateway/server-methods/chat-user-turn-recorder.ts:65` |
| 发布源 | tag `release-publish/5e1a27a9bcc4-1794101135`（2026.11.1/11.2 发布线）；npm latest `2026.11.2` |
| PD 侧就绪 | #2436（读取分支+additive-only）、#2449（manifest 声明）、11-05 审计（SDK 类型补齐） |
