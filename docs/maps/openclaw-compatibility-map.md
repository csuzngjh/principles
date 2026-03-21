# OpenClaw Compatibility Map

> Created: 2026-03-18
> Purpose: Upstream compatibility reference for Principles Disciple
> Upstream repo: `D:\Code\openclaw`

---

## Why This Document Exists

Principles Disciple is an OpenClaw plugin. That means our product quality depends not only on our own code, but also on how accurately we stay aligned with OpenClaw's plugin system.

This document is a working map of the OpenClaw areas we should treat as compatibility-critical.

---

## One-Sentence Summary

For Principles Disciple, the most important parts of OpenClaw are not the entire product surface, but these layers:

1. plugin discovery
2. plugin manifest and entry resolution
3. `OpenClawPluginApi`
4. hook type definitions
5. hook execution semantics
6. runtime context propagation

---

## The Most Important Upstream Files

### First Priority

- [types.ts](D:\Code\openclaw\src\plugins\types.ts)
- [hooks.ts](D:\Code\openclaw\src\plugins\hooks.ts)
- [registry.ts](D:\Code\openclaw\src\plugins\registry.ts)
- [loader.ts](D:\Code\openclaw\src\plugins\loader.ts)
- [manifest.ts](D:\Code\openclaw\src\plugins\manifest.ts)
- [discovery.ts](D:\Code\openclaw\src\plugins\discovery.ts)

### Second Priority

- [runtime index](D:\Code\openclaw\src\plugins\runtime\index.ts)
- [runtime-plugins.ts](D:\Code\openclaw\src\agents\runtime-plugins.ts)
- [agent-command.ts](D:\Code\openclaw\src\agents\agent-command.ts)
- [pi-tools.before-tool-call.ts](D:\Code\openclaw\src\agents\pi-tools.before-tool-call.ts)
- [attempt.ts](D:\Code\openclaw\src\agents\pi-embedded-runner\run\attempt.ts)
- [pi-embedded-subscribe.handlers.tools.ts](D:\Code\openclaw\src\agents\pi-embedded-subscribe.handlers.tools.ts)

### Reference Docs And SDK Files

- [plugin.md](D:\Code\openclaw\docs\tools\plugin.md)
- [plugin-sdk index](D:\Code\openclaw\src\plugin-sdk\index.ts)
- [plugin-runtime.ts](D:\Code\openclaw\src\plugin-sdk\plugin-runtime.ts)
- [hook-runtime.ts](D:\Code\openclaw\src\plugin-sdk\hook-runtime.ts)
- [package.json](D:\Code\openclaw\package.json)

---

## What Each Area Means For Us

### 1. Discovery

Key file:

- [discovery.ts](D:\Code\openclaw\src\plugins\discovery.ts)

Why it matters:

- Controls where OpenClaw looks for plugins
- Affects whether our plugin can be found at all
- Important for install/update workflows

What to watch:

- plugin root search locations
- path safety checks
- workspace-level extension directory rules

### 2. Manifest And Entry Resolution

Key files:

- [manifest.ts](D:\Code\openclaw\src\plugins\manifest.ts)
- [loader.ts](D:\Code\openclaw\src\plugins\loader.ts)

Why it matters:

- Controls how `openclaw.plugin.json` is parsed
- Controls how entrypoints are resolved
- Affects bundle/source loading behavior

What to watch:

- manifest schema changes
- `package.json` `openclaw` metadata changes
- entry resolution changes

### 3. `OpenClawPluginApi`

Key file:

- [types.ts](D:\Code\openclaw\src\plugins\types.ts)

Why it matters:

- This is the real contract between OpenClaw and Principles Disciple
- If this changes, our plugin can break even when our local code still builds

Important API areas for us:

- `registerTool`
- `registerService`
- `registerCommand`
- `registerHook`
- `registerChannel`
- `registerCli`
- `registerHttpRoute`
- `resolvePath`
- `on(...)`
- `runtime`
- `logger`
- `pluginConfig`

### 4. Hook Contracts

Key files:

- [types.ts](D:\Code\openclaw\src\plugins\types.ts)
- [hooks.ts](D:\Code\openclaw\src\plugins\hooks.ts)

Why it matters:

- Principles Disciple is a hook-heavy plugin
- Hook payload changes directly affect `prompt.ts`, `gate.ts`, and `pain.ts`

Most important hooks for us:

- `before_prompt_build`
- `before_tool_call`
- `after_tool_call`
- `llm_output`
- `before_message_write`
- `before_compaction`
- `after_compaction`
- `before_reset`
- `subagent_spawning`
- `subagent_ended`

What to watch:

- hook name changes
- event field changes
- context shape changes
- merge behavior changes
- priority rules
- serial vs parallel behavior

### 5. Runtime Context Propagation

Key files:

- [runtime-plugins.ts](D:\Code\openclaw\src\agents\runtime-plugins.ts)
- [agent-command.ts](D:\Code\openclaw\src\agents\agent-command.ts)
- [types.ts](D:\Code\openclaw\src\plugins\types.ts)

Why it matters:

- Our plugin depends heavily on workspace-local state
- If OpenClaw changes how workspace/session/run metadata is passed around, our state resolution can break

Fields we care about most:

- `workspaceDir`
- `agentDir`
- `agentId`
- `sessionId`
- `sessionKey`
- `runId`
- `toolCallId`
- `toolName`
- `params`
- `result`
- `error`

Important compatibility conclusion:

- `workspaceDir` should be treated as optional in practice
- We should continue using defensive fallback logic such as `ctx.workspaceDir || api.resolvePath('.')`

---

## Hook Execution Semantics We Must Remember

Based on the upstream exploration, the most important behavior is not only what hooks exist, but how they run.

### For Principles Disciple, these assumptions are critical

- `before_prompt_build` is a modifying hook and participates in result merging
- `before_tool_call` is suitable for interception and parameter rewriting
- `after_tool_call` behaves more like event notification and should not rely on strict ordering
- hook priority affects outcome

If any of the above changes upstream, our plugin behavior can drift silently.

---

## Where OpenClaw Actually Wires These Hooks Into Agent Flow

### Tool interception path

- [pi-tools.before-tool-call.ts](D:\Code\openclaw\src\agents\pi-tools.before-tool-call.ts)

Why it matters:

- Confirms that hook output can affect the actual tool call
- Important for our gate logic

### Prompt-build path

- [attempt.ts](D:\Code\openclaw\src\agents\pi-embedded-runner\run\attempt.ts)

Why it matters:

- Confirms where `before_prompt_build` is injected into execution
- Important for our prompt mutation strategy

### Tool completion path

- [pi-embedded-subscribe.handlers.tools.ts](D:\Code\openclaw\src\agents\pi-embedded-subscribe.handlers.tools.ts)

Why it matters:

- Confirms where `after_tool_call` is triggered
- Important for pain capture and trust updates

---

## Examples Worth Reusing As Upstream References

### Real plugin examples

- [synthetic](D:\Code\openclaw\extensions\synthetic\index.ts)
- [voice-call](D:\Code\openclaw\extensions\voice-call\index.ts)
- [memory-core](D:\Code\openclaw\extensions\memory-core\index.ts)
- [diffs](D:\Code\openclaw\extensions\diffs\index.ts)
- [discord](D:\Code\openclaw\extensions\discord\index.ts)

These are useful for:

- plugin entry patterns
- config schema patterns
- runtime integration patterns
- CLI and service registration examples

### Test references

- [plugin-api mock](D:\Code\openclaw\test\helpers\extensions\plugin-api.ts)
- [plugin-runtime mock](D:\Code\openclaw\test\helpers\extensions\plugin-runtime-mock.ts)
- [SDK boundary test](D:\Code\openclaw\test\extension-plugin-sdk-boundary.test.ts)
- [import boundary test](D:\Code\openclaw\test\plugin-extension-import-boundary.test.ts)

These are useful for:

- understanding the intended stable boundary
- designing our own compatibility tests

---

## Most Important Compatibility Risks For Principles Disciple

### Risk 1: Hook type drift

Most dangerous upstream file:

- [types.ts](D:\Code\openclaw\src\plugins\types.ts)

If field names, optionality, or nesting change, our plugin can break in subtle ways.

### Risk 2: Hook execution drift

Most dangerous upstream file:

- [hooks.ts](D:\Code\openclaw\src\plugins\hooks.ts)

If merge or scheduling rules change, our behavior can change without obvious type errors.

### Risk 3: Path and workspace propagation drift

Most dangerous upstream files:

- [agent-command.ts](D:\Code\openclaw\src\agents\agent-command.ts)
- [runtime-plugins.ts](D:\Code\openclaw\src\agents\runtime-plugins.ts)

This affects `.principles`, `.state`, and `memory` path resolution.

### Risk 4: Manifest or discovery drift

Most dangerous upstream files:

- [manifest.ts](D:\Code\openclaw\src\plugins\manifest.ts)
- [discovery.ts](D:\Code\openclaw\src\plugins\discovery.ts)
- [loader.ts](D:\Code\openclaw\src\plugins\loader.ts)

This affects whether our plugin is discovered, loaded, and activated at all.

### Risk 5: Prompt injection policy tightening

Most relevant upstream file:

- [plugin.md](D:\Code\openclaw\docs\tools\plugin.md)

If prompt mutation gets restricted upstream, our core product value is directly threatened.

---

## Recommended Upgrade Checklist

Whenever OpenClaw changes or we upgrade against a newer upstream version, check these in order:

1. Diff [types.ts](D:\Code\openclaw\src\plugins\types.ts)
2. Diff [hooks.ts](D:\Code\openclaw\src\plugins\hooks.ts)
3. Diff [registry.ts](D:\Code\openclaw\src\plugins\registry.ts)
4. Diff [loader.ts](D:\Code\openclaw\src\plugins\loader.ts)
5. Diff [manifest.ts](D:\Code\openclaw\src\plugins\manifest.ts)
6. Diff [discovery.ts](D:\Code\openclaw\src\plugins\discovery.ts)
7. Diff [pi-tools.before-tool-call.ts](D:\Code\openclaw\src\agents\pi-tools.before-tool-call.ts)
8. Diff [attempt.ts](D:\Code\openclaw\src\agents\pi-embedded-runner\run\attempt.ts)
9. Diff [pi-embedded-subscribe.handlers.tools.ts](D:\Code\openclaw\src\agents\pi-embedded-subscribe.handlers.tools.ts)

Then verify locally:

1. plugin can still be discovered
2. prompt injection still fires
3. tool interception still works
4. pain capture still receives expected payloads
5. workspace path resolution still points to the correct project state

---

## OpenClaw Hook System Reference

### Complete Hook Names (26 hooks)

**Source**: `D:\Code\openclaw\src\plugins\types.ts` (Lines 1370-1395)

```typescript
export type PluginHookName =
  | "before_model_resolve"      // Override provider/model before resolution
  | "before_prompt_build"       // Inject context & system prompt before submission
  | "before_agent_start"        // Legacy: combines model resolve + prompt build
  | "llm_input"                // Observe exact LLM input payload
  | "llm_output"               // Observe exact LLM output payload
  | "agent_end"                // Analyze completed conversations
  | "before_compaction"         // Before session context compaction
  | "after_compaction"         // After session context compaction
  | "before_reset"             // When /new or /reset clears session
  | "inbound_claim"            // Claim inbound event before commands/agent
  | "message_received"          // After message received
  | "message_sending"           // Modify or cancel outgoing messages
  | "message_sent"             // After message sent
  | "before_tool_call"         // Modify or block tool calls
  | "after_tool_call"          // After tool execution
  | "tool_result_persist"      // Modify tool result before transcript write (SYNC)
  | "before_message_write"     // Before message written to session JSONL (SYNC)
  | "session_start"            // Session started
  | "session_end"              // Session ended
  | "subagent_spawning"        // Subagent spawning
  | "subagent_delivery_target" // Subagent delivery routing
  | "subagent_spawned"        // Subagent spawned
  | "subagent_ended"          // Subagent ended
  | "gateway_start"           // Gateway starting
  | "gateway_stop";            // Gateway stopping
```

### Hook Execution Patterns

| Pattern | Execution | Use Case |
|---------|----------|----------|
| **Void Hook** | Parallel (`Promise.all`) | Fire-and-forget: `llm_input`, `llm_output`, `agent_end`, `message_received`, `message_sent`, `session_start`, `session_end`, `gateway_start`, `gateway_stop` |
| **Modifying Hook** | Sequential (priority order) | Results merged: `before_model_resolve`, `before_prompt_build`, `message_sending`, `before_tool_call` |
| **Claiming Hook** | Sequential, first wins | `inbound_claim` |
| **Sync Hook** | Sequential, blocking | `tool_result_persist`, `before_message_write` |

### Principles Disciple 使用的钩子

| 钩子 | 文件 | 用途 |
|------|------|------|
| `before_prompt_build` | `src/hooks/prompt.ts` | 注入多层上下文 |
| `before_tool_call` | `src/hooks/gate.ts` | 安全门禁检查 |
| `after_tool_call` | `src/hooks/pain.ts` | 痛苦检测和信任更新 |
| `llm_output` | `src/hooks/llm.ts` | 共情信号检测 |
| `before_message_write` | `src/hooks/message-sanitize.ts` | 敏感数据清理 |
| `before_compaction` | `src/hooks/lifecycle.ts` | 上下文压缩前检查点 |
| `after_compaction` | `src/hooks/lifecycle.ts` | 上下文压缩后恢复 |
| `before_reset` | `src/hooks/lifecycle.ts` | 会话重置处理 |
| `subagent_ended` | `src/hooks/subagent.ts` | 子智能体生命周期闭合 |
| `subagent_spawning` | `src/index.ts` | 子智能体生成（暂时无操作） |

---

## OpenClaw Plugin API Reference

**Source**: `D:\Code\openclaw\src\plugins\types.ts` (Lines 1286-1351)

```typescript
export type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  rootDir?: string;
  registrationMode: PluginRegistrationMode;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;

  // 工具注册
  registerTool: (
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: OpenClawPluginToolOptions,
  ) => void;

  // 钩子注册
  registerHook: (
    events: string | string[],
    handler: InternalHookHandler,
    opts?: OpenClawPluginHookOptions,
  ) => void;
  on: <K extends PluginHookName>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ) => void;

  // HTTP 路由
  registerHttpRoute: (params: OpenClawPluginHttpRouteParams) => void;

  // 频道集成
  registerChannel: (registration: OpenClawPluginChannelRegistration | ChannelPlugin) => void;

  // 网关方法
  registerGatewayMethod: (method: string, handler: GatewayRequestHandler) => void;

  // CLI 集成
  registerCli: (registrar: OpenClawPluginCliRegistrar, opts?: { commands?: string[] }) => void;

  // 后台服务
  registerService: (service: OpenClawPluginService) => void;

  // 提供者注册
  registerProvider: (provider: ProviderPlugin) => void;
  registerSpeechProvider: (provider: SpeechProviderPlugin) => void;
  registerMediaUnderstandingProvider: (provider: MediaUnderstandingProviderPlugin) => void;
  registerImageGenerationProvider: (provider: ImageGenerationProviderPlugin) => void;
  registerWebSearchProvider: (provider: WebSearchProviderPlugin) => void;

  // 交互处理器
  registerInteractiveHandler: (registration: PluginInteractiveHandlerRegistration) => void;
  onConversationBindingResolved: (
    handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>,
  ) => void;

  // 命令
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;

  // 上下文引擎
  registerContextEngine: (
    id: string,
    factory: ContextEngineFactory,
  ) => void;

  // 工具方法
  resolvePath: (input: string) => string;
};
```

### Hook Context 类型

```typescript
// Agent 上下文（在 agent 钩子中共享）
export type PluginHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;        // "user", "heartbeat", "cron", "memory"
  channelId?: string;
};

// 工具上下文
export type PluginHookToolContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
};

// 消息上下文
export type PluginHookMessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
};

// 会话上下文
export type PluginHookSessionContext = {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
};

// 网关上下文
export type PluginHookGatewayContext = {
  port?: number;
};
```

---

## What This Means For Product Development

For Principles Disciple, compatibility work with OpenClaw is not background maintenance. It is part of the product surface.

The practical strategy should be:

- depend on the stable plugin boundary whenever possible
- avoid coupling to arbitrary internal upstream details
- keep a compatibility map like this one updated
- build a small compatibility test suite around our critical hooks

In short:

**our plugin is only as stable as our understanding of OpenClaw's plugin boundary**

