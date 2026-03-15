# 子智能体模型覆盖方案设计

> 创建日期：2026-03-14
> 状态：待实现

## 背景

### 问题陈述

当前 Principles Disciple 插件的心跳智能体配置为弱模型（如 `gpt-4o-mini`），目的是降低成本和减少 Token 消耗。然而，当心跳检测到痛觉信号时，需要执行深度诊断任务（`/evolve-task` 或 `/reflection`），这需要强模型的推理能力。

**核心矛盾**：
- 心跳智能体：弱模型，成本低，但无法进行深度分析
- 诊断任务：需要强模型，但当前设计会继承父智能体的弱模型

### 当前限制

Principles Disciple 插件的 `pd_spawn_agent` 工具不支持模型覆盖：

```typescript
// packages/openclaw-plugin/src/core/agent-loader.ts
export interface AgentDefinition {
  /** Preferred model (informational, OpenClaw subagents use parent model) */
  model?: string;  // 仅作信息展示，不生效
}
```

---

## 解决方案

### 方案概述

利用 OpenClaw 原生的 `sessions_spawn` 工具的 `--model` 参数，在运行时指定子智能体使用的模型。

```
弱模型心跳智能体 → sessions_spawn --model claude-opus-4-5 → 强模型诊断子智能体
```

### 核心思想

**弱模型做"调度员"，强模型做"专家"**

| 角色 | 模型 | 职责 | 成本 |
|------|------|------|------|
| 心跳智能体 | gpt-4o-mini | 检测信号、转发任务 | 低（每次心跳少量 token） |
| 诊断子智能体 | claude-opus-4-5 | 深度根因分析、复杂推理 | 高（只在需要时调用） |

---

## 完整工作流程

### 场景示例

| 组件 | 配置 |
|------|------|
| **心跳智能体** | 模型：`gpt-4o-mini`（弱模型） |
| **诊断子智能体** | 模型：`claude-opus-4-5`（强模型） |
| **触发条件** | 工具写入失败，产生痛觉信号 |

### Step 1: 痛觉信号产生

```
用户对话：
用户: "帮我修改 config.json，添加一个新配置项"
Agent: 调用 write_file 工具...
❌ 错误：EACCES permission denied
```

`hooks/pain.ts` 捕获并写入：

```json
// .state/.pain_flag
{
  "score": 85,
  "source": "tool_failure", 
  "time": "2026-03-14T10:30:00Z",
  "reason": "Tool write failed on config.json. Error: EACCES permission denied"
}
```

### Step 2: Evolution Worker 后台处理

Evolution Worker Service（15分钟轮询）：

```
检测到 .pain_flag 存在
↓
分数 85 ≥ 30，入队
↓
写入 evolution_queue.json
```

```json
// .state/evolution_queue.json
[
  {
    "id": "pain-6a93e370",
    "task": "Diagnose systemic pain [ID: pain-6a93e370]. Source: tool_failure...",
    "score": 85,
    "status": "in_progress"
  }
]
```

### Step 3: 心跳触发并注入指令

心跳触发时，`hooks/prompt.ts` 检测到 `in_progress` 任务，注入：

```
[🚨 SYSTEM OVERRIDE 🚨]
A critical evolution task is assigned to you. YOU MUST PRIORITIZE THIS TASK.
TASK: "Diagnose systemic pain [ID: pain-6a93e370]..."

ACTION REQUIRED:
Reply ONLY with "[EVOLUTION_ACK]". Then immediately invoke the `sessions_spawn` tool:

sessions_spawn target="diagnostician" message="Diagnose systemic pain..." model="claude-opus-4-5"

NO OTHER ACTIONS PERMITTED.
```

### Step 4: 弱模型心跳智能体转发

心跳智能体（gpt-4o-mini）收到指令后：

```
心跳智能体回复: "[EVOLUTION_ACK]"

心跳智能体调用工具:
sessions_spawn(
  target: "diagnostician",
  message: "Diagnose systemic pain...",
  model: "claude-opus-4-5"  ← 指定强模型
)
```

**关键**：心跳智能体只做简单转发，不需要深度思考。

### Step 5: 强模型子智能体执行

OpenClaw 创建子智能体会话，使用 `claude-opus-4-5` 模型：

```
诊断过程：
1. 分析失败原因：权限不足
2. 检查文件权限：ls -la config.json
3. 检查当前用户：whoami
4. 提出解决方案

输出：根因分析报告
```

### Step 6: 结果返回

```
diagnostician 完成
↓
结果返回给父智能体
↓
标记任务为 completed
↓
清理 .pain_flag
```

---

## 实现方案

### 核心思路：从 OpenClaw 配置动态读取模型

OpenClaw 插件 API 提供了 `api.config`，包含完整的 OpenClaw 配置。我们可以从中读取：

1. `agents.defaults.subagents.model` - 子智能体默认模型（优先）
2. `agents.defaults.model` - 主智能体默认模型（备选）

### 配置优先级

```
agents.defaults.subagents.model  ← 第一优先级（专门为子智能体配置）
        ↓ 如果不存在
agents.defaults.model            ← 第二优先级（主智能体模型）
        ↓ 如果不存在
硬编码默认值                      ← 最后备选
```

### 待修改文件

`packages/openclaw-plugin/src/hooks/prompt.ts`

### 当前代码

```typescript
// 约第 100 行
prependContext += `\n[🚨 SYSTEM OVERRIDE 🚨]\n` +
  `A critical evolution task is assigned to you. YOU MUST PRIORITIZE THIS TASK.\n` +
  `TASK: "${inProgressTask.task}"\n\n` +
  `ACTION REQUIRED:\n` +
  `Reply ONLY with "[EVOLUTION_ACK]". Then immediately invoke the \`sessions_spawn\` tool targeting \`diagnostician\` with the task above. NO OTHER ACTIONS PERMITTED.`;
```

### 修改后代码

```typescript
/**
 * 从 OpenClaw 配置中解析模型选择
 * 支持 string 或 { primary, fallbacks } 格式
 */
function resolveModelFromConfig(modelConfig: unknown): string | null {
  if (!modelConfig) return null;
  
  // 格式 1: "provider/model" 字符串
  if (typeof modelConfig === 'string') {
    return modelConfig.trim() || null;
  }
  
  // 格式 2: { primary: "provider/model", fallbacks: [...] } 对象
  if (typeof modelConfig === 'object' && modelConfig !== null) {
    const cfg = modelConfig as { primary?: string };
    if (cfg.primary && typeof cfg.primary === 'string') {
      return cfg.primary.trim() || null;
    }
  }
  
  return null;
}

/**
 * 获取诊断子智能体应使用的模型
 * 优先级：subagents.model > 主模型 > 硬编码默认值
 */
function getDiagnosticianModel(api: any): string {
  const agentsConfig = api?.config?.agents?.defaults;
  
  // 优先使用子智能体专用模型
  const subagentModel = resolveModelFromConfig(agentsConfig?.subagents?.model);
  if (subagentModel) {
    return subagentModel;
  }
  
  // 备选：使用主智能体模型
  const primaryModel = resolveModelFromConfig(agentsConfig?.model);
  if (primaryModel) {
    return primaryModel;
  }
  
  // 最后备选：硬编码默认值（Claude Opus 4.5 是目前最强的分析模型之一）
  return 'claude-opus-4-5';
}

// 在 SYSTEM OVERRIDE 注入部分使用：
const diagnosticianModel = getDiagnosticianModel(api);

prependContext += `\n[🚨 SYSTEM OVERRIDE 🚨]\n` +
  `A critical evolution task is assigned to you. YOU MUST PRIORITIZE THIS TASK.\n` +
  `TASK: "${inProgressTask.task}"\n\n` +
  `ACTION REQUIRED:\n` +
  `Reply ONLY with "[EVOLUTION_ACK]". Then immediately invoke the \`sessions_spawn\` tool:\n` +
  `\`\`\`\n` +
  `sessions_spawn target="diagnostician" message="${inProgressTask.task}" model="${diagnosticianModel}"\n` +
  `\`\`\`\n` +
  `NO OTHER ACTIONS PERMITTED.`;
```

### 用户配置示例

用户只需在 OpenClaw 配置文件（`~/.openclaw/openclaw.json`）中添加：

```json
{
  "agents": {
    "defaults": {
      "model": "openai/gpt-4o",
      "subagents": {
        "model": "anthropic/claude-opus-4-5"
      }
    }
  }
}
```

这样：
- 主智能体使用 `gpt-4o`（日常对话，成本较低）
- 子智能体（如 diagnostician）使用 `claude-opus-4-5`（深度分析，能力强）
- 心跳智能体也可以单独配置弱模型，但在需要时会召唤强模型子智能体

---

## 备选方案

### 方案 A: 全局默认子智能体模型

在 OpenClaw 配置中设置：

```json
{
  "agents": {
    "defaults": {
      "subagents": {
        "model": "anthropic/claude-opus-4-5"
      }
    }
  }
}
```

**优点**：一劳永逸，无需修改代码
**缺点**：所有子智能体用同一个模型，不够灵活

### 方案 B: 按 Agent 配置

```json
{
  "agents": {
    "list": [
      {
        "id": "diagnostician",
        "subagents": {
          "model": "anthropic/claude-opus-4-5"
        }
      },
      {
        "id": "explorer",
        "subagents": {
          "model": "gpt-4o"
        }
      }
    ]
  }
}
```

**优点**：灵活，每个 Agent 可不同
**缺点**：需要维护配置

### 方案 C: 增强 pd_spawn_agent

修改 `pd_spawn_agent` 工具支持 `model` 参数：

```typescript
parameters: Type.Object({
  agentType: Type.String(),
  task: Type.String(),
  model: Type.Optional(Type.String({ description: '模型覆盖' })),
}),
```

**优点**：完全控制
**缺点**：需要开发工作量

---

## 推荐方案

**推荐**：方案 B（按 Agent 配置）+ 运行时指定（方案 C 的一部分）

1. 在 OpenClaw 配置中预设 diagnostician 的模型
2. 同时在 prompt 注入中加入 model 参数，作为双重保障

这样可以确保：
- 即使配置缺失，也能通过运行时指定
- 配置存在时，可以灵活调整不同 Agent 的模型

---

## OpenClaw 配置结构参考

### agents.defaults 配置字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | `string \| { primary, fallbacks }` | 主智能体模型 |
| `subagents.model` | `string \| { primary, fallbacks }` | 子智能体默认模型 |
| `heartbeat.model` | `string` | 心跳智能体模型（可配置为弱模型） |

### 配置示例

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-4o",
        "fallbacks": ["openai/gpt-4o-mini"]
      },
      "subagents": {
        "model": "anthropic/claude-opus-4-5"
      },
      "heartbeat": {
        "model": "openai/gpt-4o-mini",
        "every": "5m"
      }
    }
  }
}
```

### 插件访问配置的方式

```typescript
// 在 hook handler 中
api.config                           // 完整的 OpenClaw 配置
api.config.agents?.defaults?.model   // 主模型配置
api.config.agents?.defaults?.subagents?.model  // 子智能体模型配置
```

---

## 相关代码位置

| 文件 | 作用 |
|------|------|
| `packages/openclaw-plugin/src/hooks/pain.ts` | 捕获工具失败，生成 pain_flag |
| `packages/openclaw-plugin/src/service/evolution-worker.ts` | 后台轮询，入队进化任务 |
| `packages/openclaw-plugin/src/hooks/prompt.ts` | 注入进化指令 |
| `packages/openclaw-plugin/src/tools/agent-spawn.ts` | 子智能体启动工具 |
| `packages/openclaw-plugin/src/core/agent-loader.ts` | Agent 定义加载器 |

## 参考资料

- OpenClaw 子智能体模型配置：`openclaw/src/agents/model-selection.ts`
- OpenClaw sessions_spawn 工具：`openclaw/src/agents/subagent-spawn.ts`
- 测试用例：`openclaw/src/cron/isolated-agent.subagent-model.test.ts`
