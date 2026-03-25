# Issue: pd_run_worker Subagent Runtime 不可用

**日期**: 2026-03-22
**状态**: 调查中
**影响**: Principles Disciple 插件的 `pd_run_worker` 工具无法派生内置子智能体

---

## 1. 问题现象

调用 `pd_run_worker` 时抛出错误：

```
Plugin runtime subagent methods are only available during a gateway request.
```

## 2. 根本原因

### 2.1 架构差异

OpenClaw 有两种运行模式：

| 模式 | 触发方式 | Subagent Runtime |
|------|----------|------------------|
| **Gateway 模式** | `openclaw gateway` 或 WebUI/API | ✅ 可用 |
| **Embedded 模式** | `openclaw agent` CLI 命令 | ❌ 不可用 |

### 2.2 代码追踪

**错误来源** (`D:\Code\openclaw\src\plugins\runtime\index.ts`):

```typescript
function createUnavailableSubagentRuntime(): PluginRuntime["subagent"] {
  const unavailable = () => {
    throw new Error("Plugin runtime subagent methods are only available during a gateway request.");
  };
  return {
    run: unavailable,
    waitForRun: unavailable,
    getSessionMessages: unavailable,
    getSession: unavailable,
    deleteSession: unavailable,
  };
}
```

**Late Binding 机制**:

```typescript
function createLateBindingSubagent(
  explicit?: PluginRuntime["subagent"],
  allowGatewaySubagentBinding = false,
): PluginRuntime["subagent"] {
  if (explicit) {
    return explicit;  // 优先使用显式传入的 subagent
  }

  const unavailable = createUnavailableSubagentRuntime();
  if (!allowGatewaySubagentBinding) {
    return unavailable;  // 不允许 gateway binding，返回 unavailable
  }

  // 允许 gateway binding 时，使用 Proxy 延迟解析
  return new Proxy(unavailable, {
    get(_target, prop, _receiver) {
      const resolved = gatewaySubagentState.subagent ?? unavailable;
      return Reflect.get(resolved, prop, resolved);
    },
  });
}
```

**关键状态** (`gatewaySubagentState`):

```typescript
const gatewaySubagentState: GatewaySubagentState = (() => {
  const g = globalThis as typeof globalThis & {
    [GATEWAY_SUBAGENT_SYMBOL]?: GatewaySubagentState;
  };
  // ...
  const created: GatewaySubagentState = { subagent: undefined };
  g[GATEWAY_SUBAGENT_SYMBOL] = created;
  return created;
})();
```

### 2.3 Gateway 模式下的初始化

**文件**: `D:\Code\openclaw\src\gateway\server-plugins.ts`

```typescript
export function loadGatewayPlugins(params: { ... }) {
  // ...
  // 在加载插件之前设置全局 gateway subagent runtime
  const gatewaySubagent = createGatewaySubagentRuntime();
  setGatewaySubagentRuntime(gatewaySubagent);  // ← 关键！设置全局状态

  const pluginRegistry = loadOpenClawPlugins({
    // ...
    runtimeOptions: {
      allowGatewaySubagentBinding: true,  // ← 关键！允许 binding
    },
    // ...
  });
  // ...
}
```

### 2.4 Embedded 模式下的问题

**文件**: `D:\Code\openclaw\src\agents\runtime-plugins.ts`

```typescript
export function ensureRuntimePluginsLoaded(params: {
  config?: OpenClawConfig;
  workspaceDir?: string | null;
  allowGatewaySubagentBinding?: boolean;
}): void {
  // ...
  loadOpenClawPlugins({
    config: params.config,
    workspaceDir,
    runtimeOptions: params.allowGatewaySubagentBinding
      ? {
          allowGatewaySubagentBinding: true,  // ← 设置了 true
        }
      : undefined,
  });
}
```

**问题**: 即使设置了 `allowGatewaySubagentBinding: true`，但 `gatewaySubagentState.subagent` 从未被设置（因为没有调用 `setGatewaySubagentRuntime()`），所以 Proxy 解析后仍然是 `unavailable`。

## 3. 调用链分析

### 3.1 `pd_run_worker` 的实现

**文件**: `D:\Code\principles\packages\openclaw-plugin\src\tools\agent-spawn.ts`

```typescript
export function createAgentSpawnTool(api: OpenClawPluginApi) {
  return {
    name: 'pd_run_worker',
    // ...
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      // ...
      // 检查 subagent runtime 是否可用
      const subagentRuntime = api.runtime?.subagent;
      if (!subagentRuntime) {
        return {
          content: [{
            type: 'text',
            text: `❌ Subagent runtime 不可用。请确保 OpenClaw Gateway 正在运行。`
          }]
        };
      }

      // 调用 subagent.run() - 这里会抛出错误！
      await subagentRuntime.run({
        sessionKey,
        message: task,
        extraSystemPrompt,
        lane: 'subagent',
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      // ...
    },
  };
}
```

**问题**: `api.runtime?.subagent` 存在（是一个 Proxy 对象），但调用它的方法时会抛出错误。

### 3.2 Gateway Subagent Runtime 的实现

**文件**: `D:\Code\openclaw\src\gateway\server-plugins.ts`

```typescript
function createGatewaySubagentRuntime(): PluginRuntime["subagent"] {
  return {
    async run(params) {
      // 使用 dispatchGatewayMethod 调用 gateway 的 "agent" 方法
      const payload = await dispatchGatewayMethod<{ runId?: string }>(
        "agent",
        {
          sessionKey: params.sessionKey,
          message: params.message,
          // ...
        },
      );
      // ...
    },
    async waitForRun(params) {
      const payload = await dispatchGatewayMethod<{ status?: string; error?: string }>(
        "agent.wait",
        { runId: params.runId, ... },
      );
      // ...
    },
    getSessionMessages: async (params) => {
      const payload = await dispatchGatewayMethod<{ messages?: unknown[] }>("sessions.get", {
        key: params.sessionKey,
        // ...
      });
      return { messages: Array.isArray(payload?.messages) ? payload.messages : [] };
    },
    // ...
  };
}
```

**关键点**: Gateway subagent runtime 使用 `dispatchGatewayMethod` 与 Gateway 进程通信。

## 4. Embedded 模式下的替代方案探讨

### 4.1 Embedded 模式如何派生子智能体？

**文件**: `D:\Code\openclaw\src\agents\tools\sessions-spawn-tool.ts`

`sessions_spawn` 工具在 Embedded 模式下通过以下方式派生子智能体：

```typescript
export function createSessionsSpawnTool(opts?: { ... }): AnyAgentTool {
  return {
    name: "sessions_spawn",
    // ...
    execute: async (_toolCallId, args) => {
      // ...
      if (runtime === "acp") {
        const result = await spawnAcpDirect(...);
        return jsonResult(result);
      }

      // subagent runtime
      const result = await spawnSubagentDirect(...);  // ← 直接调用，不通过 api.runtime.subagent
      return jsonResult(result);
    },
  };
}
```

**关键发现**: `sessions_spawn` 使用 `spawnSubagentDirect()` 函数，而不是 `api.runtime.subagent`！

### 4.2 `spawnSubagentDirect` 的实现

**文件**: `D:\Code\openclaw\src\agents\subagent-spawn.ts`

```typescript
export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  // ...
  // 使用 callGateway 与 gateway 通信
  const payload = await callGateway({
    method: "agent",
    params: {
      sessionKey: childSessionKey,
      message: task,
      // ...
    },
  });
  // ...
}
```

**关键点**: `spawnSubagentDirect` 使用 `callGateway()` 而不是 `api.runtime.subagent`。

## 5. 问题总结

| 组件 | Gateway 模式 | Embedded 模式 |
|------|-------------|---------------|
| `gatewaySubagentState.subagent` | ✅ 已设置 | ❌ 未设置 |
| `api.runtime.subagent` | ✅ 可用 | ❌ 抛出错误 |
| `sessions_spawn` 工具 | ✅ 可用 | ✅ 可用 (通过 `callGateway`) |
| `pd_run_worker` 工具 | ✅ 可用 | ❌ 不可用 |

**根本问题**: 
- `pd_run_worker` 使用 `api.runtime.subagent` API
- 这个 API 在 Embedded 模式下不可用
- 但 `sessions_spawn` 使用 `callGateway()` 直接调用，在两种模式下都可用

## 6. 可能的解决方案

### 方案 A: 修改 Principles Disciple 插件 (推荐)

**不修改 OpenClaw 源码**，修改 `pd_run_worker` 的实现：

1. **检测 Embedded 模式**: 在调用 `api.runtime.subagent` 前检测是否可用
2. **给出清晰的错误提示**: 告知用户这个功能需要 Gateway 模式
3. **或者**: 使用其他方式派生子智能体（如通过 `sessions_spawn` 工具间接调用）

**优点**: 
- 不需要修改 OpenClaw
- 符合 OpenClaw 的设计意图（embedded 模式限制某些功能）

**缺点**:
- `pd_run_worker` 在 Embedded 模式下不可用

### 方案 B: 向 OpenClaw 提交 PR

为 Embedded 模式添加 subagent runtime 支持：

1. 创建 `createEmbeddedSubagentRuntime()` 函数
2. 在 `ensureRuntimePluginsLoaded()` 中设置 `gatewaySubagentState.subagent`
3. Embedded subagent runtime 直接调用 `spawnSubagentDirect()` 等函数

**优点**:
- 完整解决问题
- 所有插件都能受益

**缺点**:
- 需要等待 OpenClaw 团队审核和合并
- 可能被拒绝（可能是故意的设计决策）

### 方案 C: Hybrid 方案

1. 先实施方案 A（修改插件给出清晰错误）
2. 同时向 OpenClaw 提交 Issue/PR 请求支持
3. 如果 OpenClaw 接受 PR，再更新插件使用新功能

## 7. 相关文件索引

### OpenClaw 源码

| 文件 | 作用 |
|------|------|
| `src/plugins/runtime/index.ts` | Plugin runtime 定义，`createLateBindingSubagent()` |
| `src/plugins/runtime/types.ts` | `PluginRuntime` 类型定义 |
| `src/gateway/server-plugins.ts` | Gateway 模式初始化，`createGatewaySubagentRuntime()` |
| `src/agents/runtime-plugins.ts` | Embedded 模式初始化，`ensureRuntimePluginsLoaded()` |
| `src/agents/subagent-spawn.ts` | `spawnSubagentDirect()` 实现 |
| `src/agents/tools/sessions-spawn-tool.ts` | `sessions_spawn` 工具实现 |
| `src/gateway/call.ts` | `callGateway()` 函数 |

### Principles Disciple 源码

| 文件 | 作用 |
|------|------|
| `packages/openclaw-plugin/src/tools/agent-spawn.ts` | `pd_run_worker` 实现 |
| `packages/openclaw-plugin/src/openclaw-sdk.d.ts` | OpenClaw SDK 类型定义 |

## 8. 方案分析

### 方案 A：注册 workers 到 agents.list ❌ 不可行

**调查发现**：OpenClaw 的 `agents.list` **不支持自定义系统提示词**。

**配置结构** (`D:\Code\openclaw\src\config\types.agents.ts`):

```typescript
export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentModelConfig;
  skills?: string[];
  identity?: IdentityConfig;  // 只有 name, theme, emoji, avatar
  // ... 没有 systemPrompt 字段
};

export type IdentityConfig = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  // 没有 systemPrompt
};
```

**结论**：无法通过配置为 agents.list 中的 agent 设置自定义系统提示词。系统提示词由 OpenClaw 根据 agent 类型（embedded/acp）自动生成。

### 方案 B：用 `api.runtime.agent.runEmbeddedPiAgent` ✅ 可行

**关键发现**：插件可以通过 `api.runtime.agent.runEmbeddedPiAgent` 直接运行 embedded agent！

**文件**: `D:\Code\openclaw\src\plugins\runtime\types-core.ts`

```typescript
export type PluginRuntimeCore = {
  // ...
  agent: {
    // ...
    runEmbeddedPiAgent: typeof import("../../agents/pi-embedded.js").runEmbeddedPiAgent;
    // ...
  };
  // ...
};
```

**优点**：
- **不需要修改 OpenClaw！**
- 在 Embedded 模式和 Gateway 模式下都可用
- 支持自定义 `extraSystemPrompt` 参数

**缺点**：
- 需要自己管理 session 生命周期
- 没有自动的结果回传机制（需要手动获取结果）

**修改方案**：
1. 修改 `pd_run_worker` 的实现
2. 使用 `api.runtime.agent.runEmbeddedPiAgent` 代替 `api.runtime.subagent`
3. 手动处理 session 管理和结果获取

### 方案 C：用同级代理 ⚠️ 不推荐

通过 `sessions_send` 向已存在的同级代理发消息。

**缺点**：
- 需要先创建/启动同级代理
- 没有父子关系管理
- 需要手动处理结果同步
- 同级代理无法注入自定义系统提示词

## 9. 推荐方案

**方案 B** 是唯一可行的方案，不需要修改 OpenClaw，只需要修改 Principles Disciple 插件的 `pd_run_worker` 实现。

## 10. 验证命令

```bash
# 检查 OpenClaw 状态
cd D:\Code\openclaw
git status

# 检查 Principles Disciple 状态
cd D:\Code\principles
git status
```

---

## 附录：测试方法

1. **Gateway 模式测试**:
   ```bash
   cd D:\Code\spicy_evolver_souls
   openclaw gateway
   # 在另一个终端调用 pd_run_worker
   ```

2. **Embedded 模式测试**:
   ```bash
   cd D:\Code\spicy_evolver_souls
   openclaw agent --session-key "agent:main"
   # 调用 pd_run_worker 观察错误
   ```


---

## 11. 最终实施方案：Heartbeat 驱动的本地反思闭环

**日期**: 2026-03-23
**状态**: 已实施
**实施者**: Kiro

### 11.1 问题重新定位

在深入分析之后，发现原始报告（第 6-9 节）对问题的定位存在一个关键偏差：

**原始报告的假设**：问题是 `pd_run_worker` 工具在 embedded 模式下无法调用 `api.runtime.subagent`。

**实际问题**：即使 `pd_run_worker` 能正常工作，整个反思闭环也是断裂的。原因在于 `processEvolutionQueue`（`src/service/evolution-worker.ts`）把任务标记为 `in_progress` 之后，**什么都没有做**——它只是写了任务描述到队列文件，然后期望主代理在下次对话时通过 `before_prompt_build` 注入的 `<evolution_task>` 指令去调用 `pd_run_worker`。

这意味着：
1. 反思的触发依赖用户主动发消息（没有用户消息就没有 `before_prompt_build`）
2. 反思执行依赖 `pd_run_worker` → `api.runtime.subagent`（embedded 模式下不可用）
3. 任务永远停在 `in_progress`，超时后重置，再次 `in_progress`，死循环

### 11.2 为什么放弃 subagent 方案

原始设计意图是：痛苦信号 → 子代理异步反思 → 产出原则 → 长期生效。这个方向是正确的，但执行路径（`api.runtime.subagent`）被 OpenClaw 的架构限制了。

**OpenClaw 的 subagent 限制**（来自源码 `D:\Code\openclaw\src\plugins\runtime\index.ts`）：

```typescript
function createUnavailableSubagentRuntime(): PluginRuntime["subagent"] {
  const unavailable = () => {
    throw new Error("Plugin runtime subagent methods are only available during a gateway request.");
  };
  // ...
}
```

`api.runtime.subagent` 在 embedded 模式下是一个 Proxy 对象（所以 `if (!subagentRuntime)` 检查永远不会触发），但调用它的任何方法都会同步抛出错误。这是 OpenClaw 的有意设计——embedded 模式没有调度中心，无法管理子代理的生命周期。

**原始报告方案 B（`api.runtime.agent.runEmbeddedPiAgent`）被否定**：该 API 属于 OpenClaw 内部的 `PluginRuntimeCore`，不在插件暴露的 `PluginRuntime` 接口里，`openclaw-sdk.d.ts` 中没有这个字段，无法从插件代码访问。

### 11.3 关键洞察：Heartbeat 机制

OpenClaw 提供了一个定时任务调度机制：每隔一定时间间隔，会自动拉起一个代理，读取 `HEARTBEAT.md` 文件向 LLM 发起对话。这个机制：

- 在 embedded 模式和 gateway 模式下**都可用**
- 触发时 `trigger === 'heartbeat'`，是独立的 LLM 调用，**完全不干扰用户对话**
- `before_prompt_build` 里已有完整的 heartbeat 注入逻辑（`src/hooks/prompt.ts` 第 561-574 行）
- `HEARTBEAT.md` 的内容没有格式限制，写什么进去代理就看到什么

同时，`src/core/agent-loader.ts` 提供了 `loadAgentDefinition()` 函数，可以读取 `agents/diagnostician.md` 的完整内容，包括 5 Whys SOP 和标准输出格式。

**这两个已有机制的组合，就是完整的解决方案。**

### 11.4 方案设计

**核心思路**：Worker 在把任务标记为 `in_progress` 时，同时把 diagnostician 的完整 SOP + 痛苦信号上下文写入 `HEARTBEAT.md`。OpenClaw 的定时 heartbeat 触发后，代理读到文件，按 5 Whys 流程执行反思，产出原则写入 `PRINCIPLES.md`。

**完整闭环**：

```
after_tool_call hook
    ↓ 检测到痛苦信号
写入 PAIN_FLAG 文件
    ↓
EvolutionWorkerService 轮询（默认 15 分钟）
    ↓ checkPainFlag()
写入 EVOLUTION_QUEUE（status: pending）
    ↓ processEvolutionQueue()
取最高分 pending 任务 → 标记 in_progress
    ↓ [新增] 写入 HEARTBEAT.md
    内容 = 任务上下文（score/source/reason/trigger）
          + diagnostician.md 完整 SOP（5 Whys + 输出格式）
          + 收尾指令（写原则到 PRINCIPLES.md）
    ↓
OpenClaw 定时触发 heartbeat
    ↓ before_prompt_build（trigger=heartbeat）
读取 HEARTBEAT.md → 注入 <heartbeat_checklist>
    ↓
代理按 diagnostician SOP 执行 5 Whys 反思
    ↓
产出原则 → 写入 PRINCIPLES.md（长期生效）
```

**与原始设计的对比**：

| 维度 | 原始设计（subagent） | 新方案（heartbeat） |
|------|---------------------|---------------------|
| 执行者 | 独立子代理 | 主代理在 heartbeat 上下文 |
| 是否干扰用户对话 | 否（独立进程） | 否（heartbeat 独立触发） |
| SOP 注入 | `extraSystemPrompt` 参数 | `HEARTBEAT.md` 文件内容 |
| 原则去向 | PRINCIPLES.md（长期） | PRINCIPLES.md（长期，相同） |
| embedded 模式 | ❌ 不可用 | ✅ 可用 |
| gateway 模式 | ✅ 可用 | ✅ 可用 |
| 依赖外部服务 | 需要 Gateway | 无 |
| 改动范围 | 需要修改 OpenClaw 或等待支持 | 仅修改 PD 插件 |

### 11.5 实施细节

**修改文件**：`packages/openclaw-plugin/src/service/evolution-worker.ts`

**改动 1**：新增 import

```typescript
import { loadAgentDefinition } from '../core/agent-loader.js';
```

**改动 2**：在 `processEvolutionQueue` 的 `in_progress` 标记之后，写入 `HEARTBEAT.md`

```typescript
// Write diagnostician SOP + task into HEARTBEAT.md so the next
// heartbeat cycle picks it up and executes the reflection via LLM.
try {
    const agentDef = loadAgentDefinition('diagnostician');
    const heartbeatPath = wctx.resolve('HEARTBEAT');
    const heartbeatContent = [
        `## Evolution Task [ID: ${highestScoreTask.id}]`,
        ``,
        `**Pain Score**: ${highestScoreTask.score}`,
        `**Source**: ${highestScoreTask.source}`,
        `**Reason**: ${highestScoreTask.reason}`,
        `**Trigger**: "${highestScoreTask.trigger_text_preview || 'N/A'}"`,
        `**Queued At**: ${highestScoreTask.enqueued_at || nowIso}`,
        ``,
        `---`,
        ``,
        agentDef ? agentDef.systemPrompt : `Use 5 Whys methodology to diagnose the root cause of the pain signal above.`,
        ``,
        `---`,
        ``,
        `After completing the analysis, write the resulting principle(s) to PRINCIPLES.md`,
        `and mark the task complete by replacing this file content with "HEARTBEAT_OK".`,
    ].join('\n');
    fs.writeFileSync(heartbeatPath, heartbeatContent, 'utf8');
} catch (heartbeatErr) {
    if (logger) logger.warn(`[PD:EvolutionWorker] Failed to write HEARTBEAT.md: ${String(heartbeatErr)}`);
}
```

**`HEARTBEAT.md` 写入内容结构**：

```markdown
## Evolution Task [ID: a1b2c3d4]

**Pain Score**: 65
**Source**: tool_error
**Reason**: Repeated file write failures
**Trigger**: "Cannot write to .principles/PRINCIPLES.md: permission denied"
**Queued At**: 2026-03-23T14:32:00.000Z

---

# Diagnostician

你是专业的根因分析专家。你的任务是使用结构化方法识别问题的根本原因。

## 分析方法

使用 5 Whys 方法进行根因分析：
...（diagnostician.md 完整正文）

---

After completing the analysis, write the resulting principle(s) to PRINCIPLES.md
and mark the task complete by replacing this file content with "HEARTBEAT_OK".
```

**为什么这样设计内容结构**：

1. **任务上下文放在最前面**：代理首先看到的是"要分析什么"，而不是"怎么分析"。这符合 LLM 的注意力分布规律，避免 SOP 覆盖任务描述。

2. **完整 SOP 而非摘要**：`diagnostician.md` 包含 5 Whys 的每一步说明和标准输出格式。截断 SOP 会导致代理产出格式不一致的分析结果，影响后续原则提取的质量。

3. **收尾指令明确**：告诉代理把结果写到哪里，以及如何标记任务完成。避免代理分析完之后不知道下一步做什么。

4. **fallback 处理**：如果 `loadAgentDefinition('diagnostician')` 失败（文件不存在或解析错误），使用内联的最小化指令，确保 heartbeat 仍然能触发有效的反思，而不是静默失败。

### 11.6 同步修复：subagent 可用性检测

除了主方案，同时修复了两个相关问题：

**问题 A：`EmpathyObserverManager` 的噪音日志**

`empathy-observer-manager.ts` 的 `shouldTrigger()` 没有检测 subagent 是否可用，导致每次 heartbeat 或用户消息都尝试 spawn observer，每次都失败并打 `warn` 日志。

修复：在 `EmpathyObserverManager` 里加入 `isSubagentAvailable()` 探测方法，缓存结果，`shouldTrigger()` 在 subagent 不可用时直接返回 `false`。

探测逻辑利用了 unavailable runtime 和真实 runtime 的行为差异：
- unavailable runtime 的方法是普通同步函数（`constructor.name === 'Function'`）
- 真实 gateway runtime 的方法是 async 函数（`constructor.name === 'AsyncFunction'`）

```typescript
private isSubagentAvailable(api: EmpathyObserverApi): boolean {
    if (this.subagentAvailableCache !== null) return this.subagentAvailableCache;
    try {
        const runFn = api.runtime?.subagent?.run;
        this.subagentAvailableCache = typeof runFn === 'function' 
            && runFn.constructor?.name === 'AsyncFunction';
        return this.subagentAvailableCache;
    } catch {
        this.subagentAvailableCache = false;
        return false;
    }
}
```

**问题 B：`pd_run_worker` 的误导性错误提示**

原来的检查 `if (!subagentRuntime)` 永远不会触发（Proxy 对象总是 truthy），导致工具直接走到 `.run()` 才抛出错误，错误信息对用户不友好。

修复：使用相同的 `AsyncFunction` 检测逻辑，在工具执行入口提前检测，给出明确的错误提示：

```typescript
const isSubagentAvailable = (() => {
    if (!subagentRuntime) return false;
    try {
        const runFn = subagentRuntime.run;
        return typeof runFn === 'function' && runFn.constructor?.name === 'AsyncFunction';
    } catch {
        return false;
    }
})();

if (!isSubagentAvailable) {
    return {
        content: [{
            type: 'text',
            text: `❌ Subagent runtime 不可用。\n\n当前运行在 embedded 模式（openclaw agent CLI），该模式不支持派生子智能体。\n\n请通过 Gateway 模式运行（openclaw gateway），然后再调用 pd_run_worker。`
        }]
    };
}
```

### 11.7 遗留问题

**任务完成标记**：代理在 heartbeat 里完成反思后，需要把 `EVOLUTION_QUEUE` 里对应任务标记为 `completed`。目前的指令是让代理把 `HEARTBEAT.md` 内容替换为 `"HEARTBEAT_OK"`，但 `EVOLUTION_QUEUE` 的状态更新还没有自动化。

可能的解决方案：
1. 在 `agent_end` hook 里检测 heartbeat session 的输出，如果包含原则写入操作，自动标记任务 `completed`
2. 提供一个专用的 slash command（如 `/pd-complete-task <id>`）让代理在反思结束时主动调用
3. Worker 在下次轮询时检测 `HEARTBEAT.md` 是否已被替换为 `HEARTBEAT_OK`，据此标记任务完成

**Gateway 模式下的行为**：在 Gateway 模式下，`api.runtime.subagent` 是可用的。此时 `pd_run_worker` 和 EmpathyObserver 会走原来的 subagent 路径，heartbeat 方案作为 embedded 模式的 fallback。两条路径并存，不冲突。

### 11.8 修改文件汇总

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/service/evolution-worker.ts` | 功能新增 | `processEvolutionQueue` 在标记 `in_progress` 后写入 `HEARTBEAT.md` |
| `src/service/empathy-observer-manager.ts` | Bug 修复 | 新增 `isSubagentAvailable()` 探测，避免 embedded 模式下的噪音日志 |
| `src/tools/agent-spawn.ts` | Bug 修复 | 修复 subagent 可用性检测逻辑，提供清晰的错误提示 |

---

## 12. 生产环境验证结果（2026-03-24）

### 12.1 运行模式确认

**生产服务器**：谷歌云 Debian
**运行模式**：✅ Gateway 模式

```
$ ps aux | grep openclaw
csuzngjh 3591647  4.5  4.9 23648064 1638764 ?    Ssl  Mar23  35:53 openclaw-gateway

$ netstat -tlnp | grep openclaw
tcp        0      0 127.0.0.1:18789         0.0.0.0:*               LISTEN      3591647/openclaw-ga
tcp        0      0 127.0.0.1:18791         0.0.0.0:*               LISTEN      3591647/openclaw-ga
tcp        0      0 127.0.0.1:18792         0.0.0.0:*               LISTEN      3591647/openclaw-ga
```

### 12.2 关键发现

**问题重新定位**：

| 链路 | 状态 | 证据 |
|------|------|------|
| Pain 信号触发 | ✅ 工作 | `pain_events` 表有 5 条记录 |
| Principle 自动生成 | ✅ 工作 | `principle_events` 表有 10 条记录 |
| diagnostician 子智能体 | ❌ 从未运行 | `task_outcomes` 表是空的（0 行） |
| pain_dictionary 更新 | ❌ 没有新规则 | 只有 4 条初始规则 |

**核心结论**：
1. Gateway 模式下 `api.runtime.subagent` 应该可用
2. 但 diagnostician 子智能体从未成功运行
3. Principle 是通过 `onPainDetected()` 自动生成的，不依赖 diagnostician
4. **真正的问题**：为什么 Gateway 模式下 subagent 仍然不工作？

### 12.3 待排查项

需要在生产服务器上检查：

1. subagent/diagnostician 相关日志
2. evolution_queue.json 中 in_progress 任务状态
3. HEARTBEAT.md 是否有 Evolution Task
4. pd_run_worker 工具是否被调用

### 12.4 生产数据备份位置

本地备份：`D:\Code\spicy_evolver_souls`

---

## 13. 诊断深入分析（2026-03-24 下午）

### 13.1 关键发现：diagnostician 确实在运行！

通过分析生产环境同步的数据，发现之前的假设是错误的：

| 指标 | workspace-main | workspace-diagnostician |
|------|----------------|------------------------|
| task_outcomes | **0** | **0** |
| sessions | - | 78 |
| tool_calls | - | 63 |
| pain_events | 48 | 0 |
| gate_blocks | 42 | 0 |

**结论**：diagnostician 子智能体**确实在运行**（78 个会话，63 个工具调用），但 `task_outcomes` 表为空。

### 13.2 evolution_queue.json 状态分析

```
=== Evolution Queue Analysis ===

Task ID: 36f252fa
  Status: in_progress
  Assigned Session: agent:diagnostician:ad069408-1f9e-41c4-8a17-ba12b46833cf
  Started At: 2026-03-24T01:56:48.031Z

Task ID: e5da4f5c
  Status: in_progress
  Assigned Session: N/A  ← 问题！
  Started At: 2026-03-24T02:11:48.049Z

Task ID: 24e30221
  Status: in_progress
  Assigned Session: N/A  ← 问题！
  Started At: 2026-03-24T02:26:41.883Z
```

**发现问题**：部分 `in_progress` 任务没有 `assigned_session_key`。

### 13.3 根因分析

`handleSubagentEnded()` 的匹配条件：

```typescript
const matchedTask = queue.find((task: any) =>
    task?.status === 'in_progress'
    && typeof task?.assigned_session_key === 'string'
    && task.assigned_session_key === targetSessionKey
);
```

**问题**：
1. 如果任务没有 `assigned_session_key`，永远无法匹配
2. `registerDiagnosticianRun()` 只在 `extractEvolutionTaskId(task)` 返回非空时工作
3. HEARTBEAT 方式会**删除** `assigned_session_key`（evolution-worker.ts 第 297 行）

### 13.4 两种启动路径的冲突

| 启动方式 | assigned_session_key | handleSubagentEnded 匹配 |
|----------|---------------------|------------------------|
| pd_run_worker | ✅ 有（通过 registerDiagnosticianRun） | ✅ 可匹配 |
| HEARTBEAT | ❌ 被删除 | ❌ 无法匹配 |

**冲突**：HEARTBEAT 方式在标记任务为 `in_progress` 后删除了 `assigned_session_key`，导致后续任何 `pd_run_worker` 调用都无法正确关联。

### 13.5 真正的问题

**不是** "diagnostician 不工作"，而是：

1. diagnostician 确实在运行（78 个会话）
2. 但 `handleSubagentEnded()` 找不到匹配的任务
3. 因为 `assigned_session_key` 要么没设置，要么被删除了
4. 结果：任务状态无法更新，`task_outcomes` 无法记录

### 13.6 修复建议

**方案 1**：修改 `handleSubagentEnded()` 匹配逻辑

不再依赖 `assigned_session_key`，而是使用 `extractEvolutionTaskId()` 从任务描述中提取 ID：

```typescript
// 当前逻辑
const matchedTask = queue.find((task: any) =>
    task?.status === 'in_progress'
    && task?.assigned_session_key === targetSessionKey
);

// 建议改为
const targetTaskId = extractEvolutionTaskId(/* 从 context 获取 */);
const matchedTask = queue.find((task: any) =>
    task?.status === 'in_progress'
    && (task?.assigned_session_key === targetSessionKey || task?.id === targetTaskId)
);
```

**方案 2**：统一启动路径

废弃 HEARTBEAT 方式，全部使用 `pd_run_worker` 启动 diagnostician。

**方案 3**：HEARTBEAT 完成后手动标记

在 HEARTBEAT.md 中添加指令，让代理完成后调用一个新命令（如 `/pd-complete-task <id>`）来手动标记任务完成。

### 13.7 下一步行动

1. 在 `handleSubagentEnded()` 中添加更多调试日志
2. 验证 `registerDiagnosticianRun()` 是否被正确调用
3. 检查 HEARTBEAT 和 pd_run_worker 是否同时运行导致冲突
