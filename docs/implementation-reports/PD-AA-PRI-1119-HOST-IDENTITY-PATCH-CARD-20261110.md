# PRI-1119 宿主身份最小补丁卡：OpenClaw embedded 正常入口接线当前用户轮身份（可批准实施版）

- 文档 ID：`pri-1119-host-identity-patch-card-20261110`；日期：2026-11-10；工单：PRI-1119（blockedBy PRI-1118 维持）
- 性质：**只读核查 + 可批准补丁卡**。本轮 0 宿主启动、0 模型调用、0 生产写入、0 上游提交、0 安装、0 配置变更。
- 基线：OpenClaw 上游 `origin/main` = `baccc7e152916c7f4a48596b5cb544c12264ac54`（2026-11-10 fetch，版本文件 2026.11.2）；PD 仓工作树 base = `125b506f706`（origin/main，fetched）。
- 前序：#2451（身份设计 v2，已合并）、#2458（入口决策卡，READY_FOR_OWNER_DECISION 已交付）、#2448（阻断报告+操作页，OPEN）、#2436/#2449（PD 侧能力，已发布安装 3.1.3）。
- 本卡是 #2458 §5 环节①（接线工作）的可批准实施底稿：**批准对象 = 按本卡在 OpenClaw 仓隔离任务工作树实施补丁并跑定向测试**（§9）；上游提交、发版、本机升级、验收运行仍各按序另行批准。

## 1. 结论

1. **缺口仍在，且无等价接线**：在补丁目标基线 `baccc7e1529` 上复核，`prepareEmbeddedAttemptPromptAssembly` 调 `resolvePromptBuildHookResult`（`attempt-prompt-build.ts:159`）仍只传 `{prompt, messages}`；`git log -S "currentUserMessage"`（两目标文件）与 `git grep`（embedded-agent-runner 全目录）均为 **0 命中**——跳过重复实现的条件不成立。
2. **事件契约已存在，补丁不改任何类型/协议/SDK**：`PluginHookBeforePromptBuildEvent` **已声明**可选 `currentUserMessage`（"Current request before projection… omission is legacy"）与 `currentUserMessageId`（"Stable native admission identity across rebuilds; differs between admitted requests"）（`src/plugins/hook-before-agent-start.types.ts:24-37`）；harness 路径已在填充（参照实现 §4⑦）。补丁只让 embedded 路径**填充既有契约字段**。
3. **PD 侧零改动**：SDK 类型两字段（2026-11-05 身份审计）、读取/fail-closed（#2436）、清单声明（#2449）均已随 3.1.3 发布并安装本机。

## 2. 基线核对（本轮实测）

| 对象 | 值 | 核对方式与结果 |
|---|---|---|
| OpenClaw 上游 main（补丁目标基线） | `baccc7e1529`，版本文件 **2026.11.2**（close-out `bd0557f4fac` #195249，2026-11-09） | fetch 后逐行复核缺口；`-S`/`grep` 双零命中 |
| npm latest | **2026.11.2**（`npm view openclaw version`） | 与 main 版本文件一致 → **闭项**：#2451 遗留「npm 2026.11.2 源提交未定位」——latest 即 main 的 2026.11.2 线（`bd0557f4fac` 收口），该线上缺口同样存在 |
| 本机已装宿主 | **2026.11.1（不变）** | `%APPDATA%/npm/node_modules/openclaw/package.json` |
| 本机已装 PD 扩展 | **3.1.3（不变）** | `~/.openclaw/extensions/principles-disciple/package.json` |
| PD 仓基准 | origin/main `125b506f706` | 本卡所在工作树（`ai/PRI-1119-host-identity-patch-card`，READY，claim zcode） |

## 3. 补丁范围（批准后实施的全部文件）

| # | 文件（OpenClaw 仓） | 改动 | 规模 |
|---|---|---|---|
| 1 | `src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts` | `resolvePromptBuildHookResult` 参数增加可选 `currentUserMessage?: string \| Pick<PersistedUserTurnMessage, "content" \| "idempotencyKey">`；事件展开镜像 harness 规则（仅非空 string 写入） | 约 +15 行（含 type-only import） |
| 2 | `src/agents/embedded-agent-runner/run/attempt-prompt-build.ts` | `prepareEmbeddedAttemptPromptAssembly` 内调用点（:157-166）读 `attempt.userTurnTranscriptRecorder?.message`，经 `excludeFromContext` 门后作为 `currentUserMessage` 传入 | 约 +4 行 |
| 3 | `src/agents/embedded-agent-runner/run/attempt.prompt-helpers.test.ts`（扩展既有文件） | §6 冻结测试臂 | 约 +60 行 |
| 4 | 调用点接线测试（既有 attempt 级 fixture 模式扩展，实施时按仓库惯例落位） | excludeFromContext 门 + 无 recorder 两臂 | 约 +40 行 |

**不触碰**：`PluginHookBeforePromptBuildEvent`/`PluginHookBeforePromptBuildResult` 类型、plugin-sdk 导出、`src/agents/cli-runner/prepare.ts:647`（另一调用方，新参数可选天然兼容，零改动）、config schema、cron/子代理代码、PD 仓所有 packages。

### 3.1 调用点草图（attempt-prompt-build.ts，`prepareEmbeddedAttemptPromptAssembly` 内）

```ts
const identityMessage =
  attempt.userTurnTranscriptRecorder?.message?.excludeFromContext === true
    ? undefined
    : attempt.userTurnTranscriptRecorder?.message;
const hookResult = preserveExactPrompt
  ? undefined
  : await resolvePromptBuildHookResult({
      config: attempt.config ?? getRuntimeConfig(),
      prompt: promptEvent.prompt,
      messages: promptBuildMessages,
      hookCtx,
      hookRunner: input.hookRunner,
      refreshContinuation: attempt.pluginRuntimeRefreshUserPrompt !== undefined,
      currentUserMessage: identityMessage,
    });
```

### 3.2 helper 展开草图（attempt-prompt-helpers.ts，镜像 harness 规则 `prompt-compaction-hook-helpers.ts:60-77`）

```ts
const currentUserMessage = params.currentUserMessage;
const currentUserMessageText =
  typeof currentUserMessage === "string"
    ? currentUserMessage
    : currentUserMessage
      ? typeof currentUserMessage.content === "string"
        ? currentUserMessage.content
        : currentUserMessage.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
      : undefined;
const currentUserMessageId =
  typeof currentUserMessage === "object" ? currentUserMessage.idempotencyKey : undefined;
// 仅非空 string 才写入事件（宁缺毋假；harness 参照为 !== undefined，本卡收严为真值判定，
// 空串不写——PD 侧对空值本就 fail-closed，收严无副作用）：
{
  prompt: params.prompt,
  ...(currentUserMessageText ? { currentUserMessage: currentUserMessageText } : {}),
  ...(currentUserMessageId ? { currentUserMessageId } : {}),
  messages: params.messages,
}
```

## 4. 当前用户轮如何到达同一次 embedded attempt（`baccc7e1529` 行号，全部静态复核）

| 段 | 事实 | 依据 |
|---|---|---|
| ① 绑定 | gateway 记录用户轮时写 `idempotencyKey: sourceId` 与内容一体 | `src/gateway/server-methods/chat-user-turn-recorder.ts:144` |
| ② 准入 | 执行前 `await admitUserTurn(followupRun.userTurnTranscriptRecorder)`；restart-recovery 声明控制器包装（跨 attempt 复用同一 recorder 的设计依据） | `src/auto-reply/reply/agent-runner-execute.ts:231`（声明 :129；控制器 = #2451 §2⑥ 已核） |
| ③ 进 attempt | recorder 经 params 进入 embedded 运行 | `run/backend.ts:39`、`run/run-attempt-dispatch.ts:471`、`src/auto-reply/reply/agent-runner-run-params.ts:181` |
| ④ 调用点作用域已有当前轮 | 同函数已四处读取同一来源 | `attempt-prompt-build.ts:216`（excludeFromContext）、:329（admission receipt）、:400-401（admission owner）、:536（`currentUserIdempotencyKey`） |
| ⑤ 缺口 | :159 调用未传当前轮；helper 事件只含 `{prompt, messages}` | `attempt-prompt-build.ts:153-166`；`attempt-prompt-helpers.ts:43-66` |
| ⑥ 事件契约已存在 | 两可选字段已声明且注明 legacy 省略语义 | `src/plugins/hook-before-agent-start.types.ts:24-37` |
| ⑦ harness 参照实现 | 同名同型参数与展开规则（文本展开 + ID 取显式参数或 `idempotencyKey` + 条件写入） | `src/agents/harness/prompt-compaction-hook-helpers.ts:38-77` |

接线读的就是宿主现有「当前轮」定义（④ 的同源），不引入新的信任假设或身份派生：**身份即宿主准入时写下的 `idempotencyKey`，不合成、不推断**。

## 5. 哪些情况下字段必须缺失（宁缺毋假）

| # | 条件 | 行为 |
|---|---|---|
| M1 | `preserveExactPrompt` 分支 | 整个 hook 不运行（现状语义，不变）→ 无事件无字段 |
| M2 | 无 recorder 或 `recorder.message === undefined`（未准入/未持久化） | 两字段全缺 |
| M3 | content 展开结果为空串（含纯非文本 parts） | `currentUserMessage` 缺 |
| M4 | `idempotencyKey` 缺失或空 | 仅 `currentUserMessageId` 缺（文本独立诚实；PD 侧 ID 缺失时既有 fail-closed 回 Native 兜底） |
| M5 | `message.excludeFromContext === true` | **两字段全缺**（调用点门）：被排除正文不透给插件（#2458 §7 约束）。备注供上游评审：#2451 §2⑧ 曾倾向「透身份不改排除语义」，本卡取更保守侧；上游若确立宿主契约可后续放宽，属独立变更 |
| M6 | 归属无法证明的任何情形 | 保留缺失（unknown），不补造 |

**触发无关语义（本轮新核实，须随卡披露）**：cron isolated-agent 每次运行都创建 recorder（`src/cron/isolated-agent/run-prompt-executor.ts:185-199`），且其转写测试断言 `message.idempotencyKey` 已定义（`run.fallback-transcript-turn.test.ts:30`）。因此接线后，**凡是持久化了用户轮的运行（聊天、cron、子代理通告）都会在事件中携带「该轮自己的」身份**——这是宿主字段文档的既有语义，补丁不加触发分支（加分支等于新造身份语义）。对 PD 的安全语义不变：PD 只在当前轮命中交付标记才解析映射，非标记轮不触发、回 Native。

## 6. 测试（批准后执行；定向，不跑全量）

**环境与纪律**：在 OpenClaw 仓**新建任务工作树**（base = `baccc7e1529` 或实施时最新 main）内实施与测试；**绝不动 Owner 主检出（禁改红线）、不动已装宿主、不启动 Gateway、不调用模型**。依赖缺失时 `pnpm install` 一次；按上游 AGENTS.md 用定向 `pnpm test <path>` 与 `pnpm check:changed`。

| 臂 | 场景 | 断言 |
|---|---|---|
| P-A | 第 1 次调用，recorder.message = `{content:"正文A", idempotencyKey:"rk-a"}` | 事件含 `currentUserMessage:"正文A"`、`currentUserMessageId:"rk-a"` |
| P-B | 紧接第 2 次调用，`{content:"正文B", idempotencyKey:"rk-b"}` | 事件含 B/b，且 `b ≠ a`（不沿用上一轮陈旧身份） |
| P-parts | content 为 `[{type:"text",text:"x"},{type:"image_url",…}]` | 文本展开为 `"x"`（镜像 harness 规则） |
| N1 | 不传 `currentUserMessage` | 事件两字段全缺 |
| N2 | `recorder.message === undefined`（调用点臂） | 两字段全缺 |
| N3 | content 为 `""` | `currentUserMessage` 缺（空串不写） |
| N4 | content 在场、`idempotencyKey` 缺失 | 仅 ID 缺，文本在场（各字段独立诚实） |
| N5 | 同一 recorder 对象连续两次调用（重试） | 两次事件字段逐字一致（同轮同身份，不产生「新轮」） |
| N6 | `message.excludeFromContext === true`（调用点臂） | 两字段全缺（M5 门） |

测试文件：主臂扩展既有 `attempt.prompt-helpers.test.ts`（既有 `build()` 覆盖模式 + fake hookRunner 捕获事件首参）；N2/N6 调用点臂用既有 attempt 级 fixture 模式（`attempt-prompt-phase.test.ts:613` 同款 `fixture.input.attempt.userTurnTranscriptRecorder = recorder`）。重试/重建（N5 上游版）属 restart-recovery 运行时行为，静态已核控制器设计（§4②），运行时证明留给环节④验收（N5 原判据不变：同轮身份一致；无法证明复用同一准入则身份缺失回 Native）。

## 7. 验收语义勘误提案（对 #2458 §7 / #2448 的 N1/N2，供环节④采纳）

原 N1/N2 写「事件不含身份字段」。本轮 cron 证据（§5）表明该形状预测不成立：持久化了用户轮的非聊天运行会携带自己的身份。**建议把 N1/N2 判据修正为安全判据**：「PD 不触发、装配回 Native（无交付标记即不解析映射）」，事件形状如实记录（有/无身份字段都记录）。P1/P2/N3–N6 原判据不变。此勘误不扩大补丁范围，只是防止验收卡按错误预测误判失败；建议 Owner 处置 #2448 时一并采纳。

## 8. 回滚

| 层 | 手段 |
|---|---|
| 上游补丁 | 单提交 revert（改动面 = 2 生产文件 + 测试，无 schema/协议/配置/依赖变更） |
| 宿主 | 官方版本回退（若已升级） |
| PD | 映射未启用 = 零行为差异；已启用时停用 = 操作页既有路径（enabled=false / 删键 / expiresAt 自然过期）；身份缺失全链 fail-closed 回 Native（#2448 离线四臂已复现） |

## 9. 批准对象与外部依赖

**批准对象（一句话）**：批准按本卡 §3/§6 实施 OpenClaw 上游补丁——在 OpenClaw 仓隔离任务工作树（base `baccc7e1529` 或实施时最新 main）修改两生产文件 + 扩展测试，跑定向测试与 `pnpm check:changed`，产出最小上游提交草案（附A）；**不提交上游、不安装、不启用、不动生产**。

| 环节 | 内容 | 授权/依赖 | 状态 |
|---|---|---|---|
| ① 本补丁实施 + 定向测试 | §3/§6 | **本卡批准即启动** | 待批 |
| ② 上游提交与评审 | 提交通道由 Owner 圈定；评审重点 = §4 同轮归属、§5 缺失条件/保守门、§7 触发无关语义 | 上游维护者 | 未开始（等待时间未知，不作承诺） |
| ③ 发版与本机升级 | 上游发版后升级本机宿主 | Owner 授权（安装/生产变更） | 未开始 |
| ④ 有界验收 | keys 探针 → P1/P2 + N1–N6（按 §7 勘误口径）→ 三元工具专项核对（阻断报告 §7，PRI-1152 遗留）→ 通过后才起草 G1 正常入口验收卡 | 有界运行授权；G1/C04 门槛维持 | 未开始 |

## 10. 不做与边界

- PD 仓零代码改动；不动 `~/.pd`、`~/.openclaw`、生产库与两处生产配置；不启用映射。
- 不跑四臂研究/行为实验/新 Gateway 包（本轮与 PRI-1163 验收互不等待）。
- 不提交上游代码或 PR；不含糊化 M5 保守门为「已确认语义」——它随卡提交上游评审确认。
- cli-runner 路径（`prepare.ts:647`）不在范围（可选参数天然兼容）；其他宿主版本（beta/nightly/其他 npm 档）不核对。
- 长文档伪影风险照旧：发文前读回复核；Mimosa enobufs 不作安全声明。

## 11. 证据索引

| 类型 | 位置 |
|---|---|
| 缺口与无等价接线 | openclaw `origin/main` `baccc7e1529`：`attempt-prompt-build.ts:153-166`；`attempt-prompt-helpers.ts:43-66`；`git log -S currentUserMessage`（两文件）= 0；`git grep currentUserMessage -- src/agents/embedded-agent-runner/` = 0 |
| 事件契约已存在 | `src/plugins/hook-before-agent-start.types.ts:24-37` |
| harness 参照 | `src/agents/harness/prompt-compaction-hook-helpers.ts:38-77`（含 plugin-sdk 出口 `src/plugin-sdk/agent-harness-runtime.ts`） |
| 数据流 | §4 表（`chat-user-turn-recorder.ts:144`、`agent-runner-execute.ts:129,231`、`backend.ts:39`、`run-attempt-dispatch.ts:471`、`attempt-prompt-build.ts:216,329,400,536`） |
| 触发无关证据 | `src/cron/isolated-agent/run-prompt-executor.ts:185-199`；`run.fallback-transcript-turn.test.ts:30` |
| 另一调用方（不触碰） | `src/agents/cli-runner/prepare.ts:87,647` |
| 既有测试底座 | `src/agents/embedded-agent-runner/run/attempt.prompt-helpers.test.ts:64-91` |
| 版本档位 | §2 表（npm view / 主检出 package.json / 已装扩展 package.json） |
| 前序文档 | #2451 `PD-AA-PRI-1119-HOST-IDENTITY-UPSTREAM-DESIGN-20261109.md`；#2458 `PD-AA-PRI-1119-ENTRY-DECISION-20261110.md`；#2448 阻断报告与操作页 |

## 附A：最小上游提交说明草案（实施时按上游最新约定微调）

```text
feat(agents): pass current user turn identity to embedded before_prompt_build events

The embedded prompt-build path sends only {prompt, messages} to
before_prompt_build hooks, although PluginHookBeforePromptBuildEvent
already declares optional currentUserMessage/currentUserMessageId and
the agent harness path populates both. Plugins that need the native
admission identity of the current user turn cannot bind assembly to a
specific admitted request on this entry.

Read attempt.userTurnTranscriptRecorder.message in
prepareEmbeddedAttemptPromptAssembly and pass it to
resolvePromptBuildHookResult, which expands it with the same rules as
the harness path: text from string content or joined text parts, id
from the message idempotencyKey, each field written only when it
expands to a non-empty string. excludeFromContext messages are not
handed to plugins (both fields stay absent) pending an explicit host
contract. Trigger-agnostic: any run that persists a user turn exposes
that turn's own identity; runs without one keep the fields absent.
```
