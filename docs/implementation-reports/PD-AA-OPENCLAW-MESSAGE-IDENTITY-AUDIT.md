# OpenClaw 当前消息身份暴露调查

2026-11-05，只读代码核查；未修改D:/Code/openclaw或已安装OpenClaw。PD主线继续。

结论：应表述为“当前选定的embedded before_prompt_build没有提供可供PD直接使用的当前消息身份”，不能泛化成OpenClaw全局没有消息ID。没有发现关闭该字段的开关。内部已有身份，未进入该Hook事件；新版另一条harness路径已经提供可选字段。PD本地SDK也尚未跟进新版可选字段，但这不是当前embedded缺字段的首因。

版本必须分开：D:/Code/openclaw HEAD 63fbea0c0fc74ce66b582efeaddb4ed2a7368235，package版本2026.9.2，最后提交2026-09-07；安装包C:/Users/Administrator/AppData/Roaming/npm/node_modules/openclaw是2026.10.10。不能在旧checkout修改后声称修复当前已安装版本。

本地源码证据：
- src/config/sessions/transcript-entry-anchor.ts:8/12/18：entryId、idempotencyKey、logicalTurnId；src/sessions/user-turn-transcript.types.ts:80/145/214：transport.messageId、persist result.messageId、getAdmissionReceipt，说明内部存在不同语义的消息/准入身份。
- src/agents/embedded-agent-runner/run/attempt-prompt-build.ts:145-174：hookCtx提供run/session，组装promptEvent与调用helper时只传prompt/messages，没有当前消息身份。
- src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts:91及152-160：params不接收当前消息ID，runBeforePromptBuild事件只有prompt/messages；不能靠PD读取一个未传出的字段。
- src/plugins/hook-before-agent-start.types.ts:22-27：before_prompt_build公开事件也只有prompt/messages；src/agents/harness/prompt-compaction-hook-helpers.ts:63-66在此旧版本同样只构造两个字段。
- src/plugins/hooks.ts:838-846/1060-1084：事件投影保留...event，之后分发给Hook。没有将currentUserMessageId按配置删掉的分支。src/shared/model-context-message.ts只删除upstreamUserText和toolResult.details，不能声称它统一剥除了消息ID。
- 原始/settled finalization模式会在attempt-prompt-build.ts:120/166跳过整个hook，这是执行模式边界，不是currentUserMessageId开关。

本机已安装2026.10.10证据：
- dist/config-contracts-CaROPwlH.d.ts:14105-14112：currentUserMessage和currentUserMessageId已经是可选公开字段，ID注释为跨重建稳定的native admission identity。
- dist/agent-harness-runtime-BeEWzwHa.mjs:323-329：从明确参数或currentUserMessage.idempotencyKey取得ID，并放进prompt事件。
- dist/agentsapi-attempt-DNXcbiXG.mjs:209-212：传入admittedMessage；没有它时回退到字符串，字符串本身不会提供ID。故harness路径也不保证任何时候都有ID。
- dist/attempt-system-prompt-prepare-BFRZxKas.mjs:136/3903：embedded仍调用context-engine-maintenance-Cgkf_lx3.mjs的helper；后者326-329仍只发prompt/messages。这是本轮selected embedded路径缺能力的直接代码边界。

PD证据：packages/openclaw-plugin/src/openclaw-sdk.ts:200-203仍只声明prompt/messages；hooks/prompt.ts:358-359从event.prompt做包装提取；index.ts:467将event直接交给handler，没有专门剥除上述字段。补齐本地SDK并优先消费新版显式字段是PD侧应跟进的事项，但仅改类型无法让embedded producer自动开始传ID。

影响和修复落点：优先在与安装包匹配的OpenClaw源码中，让embedded生产者从当前turn recorder/admission读取稳定身份，与当前原始用户内容一起传入prompt hook，并补不同消息、重建/重试、历史/插入上下文、无admission的负例。身份只能表示相关性，不能成为执行授权。PD随后更新SDK和Adapter消费路径。不得把runId/sessionId当messageId，不能用历史最后一条user消息猜当前请求。当前旧checkout不可直接作为新安装包修复基线。

证据等级：上述为当前源码/安装包静态链路已核实；未运行OpenClaw测试、未重启Gateway或改配置，也未据此宣布修复或实际启用。此前受控准入方案保留为已批准的隔离取证补充，不能伪称修复上游Hook契约。

## 补充：提交历史与跟踪分支

已从本地git对象核对：字段由5d7f6690c5a（2026-09-16，fix: active memory recalls stale history in large sessions）加入类型和harness producer，71bd3ded986于2026-09-27进一步共享harness准备。跟踪分支origin/main=f6efdcb8ea073ea95d7df10986cf06687b0da205（2026-11-02），已含新字段，但embedded attempt-prompt-helpers仍只发送prompt/messages。未执行fetch，不能将该跟踪引用称为远端当前HEAD。

安装包build-info标明commit=7dc3350cb9f08fcf9a0af5c4845a20d5b2f1a8be；当前本地git对象库没有该commit，因此没有将旧checkout或beta标签冒充正式安装版修复基线。本调查没有修改OpenClaw工作区，git status保持干净。

PD SDK已在集成分支补齐两个可选字段及真实语义注释；这是类型跟进，不声称解决embedded producer缺失。没有更改Native消息抽取或原则激活行为。
