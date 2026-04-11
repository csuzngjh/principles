# Nocturnal Trinity runEmbeddedPiAgent 调试交接文档

**日期**: 2026-04-11
**状态**: 未解决
**问题**: `runEmbeddedPiAgent` 始终使用 `openai` provider，无视传入的 config 和 sessionFile

---

## 1. 问题背景

### 目标
让 Nocturnal Trinity (Dreamer → Philosopher → Scribe) 在 Evolution Worker 后台环境中正确执行。

### 原始问题
- `api.runtime.subagent.run()` 需要 gateway request scope
- Evolution Worker 在后台运行，没有 gateway context
- 解决方案：改用 `api.runtime.agent.runEmbeddedPiAgent()`

---

## 2. 已完成的修改

### 2.1 核心修改：`nocturnal-trinity.ts`

**文件**: `packages/openclaw-plugin/src/core/nocturnal-trinity.ts`

**修改 1**: 将 `subagent.run()` 改为 `runEmbeddedPiAgent()`

```typescript
// 旧代码
await this.api.runtime.subagent.run({
  sessionKey: sessionKey,
  message: prompt,
  systemPrompt: systemPrompt,
});

// 新代码
await this.api.runtime.agent.runEmbeddedPiAgent({
  sessionId: runId,
  sessionFile,
  prompt,
  extraSystemPrompt: NOCTURNAL_DREAMER_PROMPT,
  config: this.api.config,
  timeoutMs: this.stageTimeoutMs,
  runId,
  disableTools: true,
});
```

**修改 2**: `createSessionFile` 写入 model_change 事件

```typescript
private createSessionFile(stage: string): string {
  // ... 创建 temp 目录 ...
  
  // 从 api.config 提取 model 配置
  const config = this.api.config as Record<string, unknown> | undefined;
  const modelConfig = config?.agents?.defaults?.model;
  
  // 解析 model 字符串
  let provider = 'minimax-portal';  // 默认值
  let modelId = 'MiniMax-M2.7';
  
  // 写入 model_change 事件到 JSONL
  const modelChangeEvent = {
    type: 'model_change',
    id: randomUUID().slice(0, 8),
    parentId: null,
    timestamp: new Date().toISOString(),
    provider,
    modelId
  };
  
  fs.writeFileSync(sessionFile, JSON.stringify(modelChangeEvent) + '\n');
  return sessionFile;
}
```

### 2.2 相关修改

- `openclaw-sdk.d.ts`: 添加 `runEmbeddedPiAgent` 类型定义
- `nocturnal-runtime.ts`: 修复 legacy session 过滤逻辑
- `nocturnal-workflow-manager.ts`: 移除 `isSubagentRuntimeAvailable` 检查

### 2.3 Git Commits

```
e1f74e73 fix(trinity): create JSONL session file with model_change event
6101784c fix(nocturnal): use runEmbeddedPiAgent for background Trinity execution
c4b0ec10 fix(idle): treat legacy sessions (missing trigger/sessionKey) as system sessions
```

---

## 3. 当前障碍

### 错误信息
```
No API key found for provider "openai". 
Auth store: /home/csuzngjh/.openclaw/agents/main/agent/auth-profiles.json
```

### 日志证据
```
[agent] [workspace-fallback] caller=runEmbeddedPiAgent reason=missing 
run=dreamer-xxx session=sha256:xxx sessionKey=sha256:xxx agent=main workspace=sha256:xxx
```

### 关键发现

1. **`runEmbeddedPiAgent` 忽略了 sessionFile 中的 model_change 事件**
   - 创建的 sessionFile 包含 `minimax-portal/MiniMax-M2.7`
   - 但 OpenClaw 内部仍然使用 `openai` 作为 provider

2. **`reason=missing` + `workspace-fallback`**
   - OpenClaw 日志显示 `reason=missing`
   - 说明 sessionFile 可能格式不对或路径有问题

3. **没有 "Created session" 日志**
   - 我的 `createSessionFile` 代码有日志输出
   - 但日志中没有看到，说明代码可能没有被执行到

---

## 4. 需要诊断的信息

### 4.1 确认代码是否正确加载

```bash
# 检查 bundle.js 是否包含新代码
grep -A 5 "sensible default" ~/.openclaw/extensions/principles-disciple/dist/bundle.js

# 检查构建指纹
cat ~/.openclaw/extensions/principles-disciple/dist/openclaw.plugin.json | jq .buildFingerprint
```

### 4.2 确认 sessionFile 是否被创建

```bash
# 检查 temp 目录
ls -la /tmp/pd-trinity-*/

# 检查 sessionFile 内容
cat /tmp/pd-trinity-*/dreamer-*.jsonl
```

### 4.3 确认 OpenClaw 的 runEmbeddedPiAgent 实现

```bash
# 查看 OpenClaw 版本
openclaw --version

# 查看 runEmbeddedPiAgent 相关日志
journalctl --user -u openclaw-gateway --since "10 min ago" | grep -E "runEmbedded|sessionFile|model_change"
```

### 4.4 确认 config 传递

```bash
# 检查 api.config 内容
# 在代码中添加日志：
console.log('api.config:', JSON.stringify(this.api.config, null, 2));
```

---

## 5. 根因假设

### 假设 A: `runEmbeddedPiAgent` 不支持通过 sessionFile 设置 model

OpenClaw 的 `runEmbeddedPiAgent` 可能：
- 完全忽略 sessionFile 中的 `model_change` 事件
- 需要通过其他方式（如 config 参数）传递 model
- 有硬编码的 `openai` 默认值

### 假设 B: config 参数格式不对

我传递的是 `this.api.config`（整个 OpenClaw config 对象），但 `runEmbeddedPiAgent` 可能期望：
- 只需要 `{ model: "provider/model" }` 格式
- 或者需要特定的 agent 配置结构

### 假设 C: bundle.js 没有正确更新

虽然 `sync-plugin.mjs` 显示成功，但：
- esbuild 可能 tree-shake 了某些代码
- 或者热更新没有生效，需要完全重启 Gateway

---

## 6. 建议的解决方案

### 方案 1: 研究 OpenClaw 源码

查看 `runEmbeddedPiAgent` 的实现：
- 它如何决定使用哪个 provider/model？
- 它是否读取 sessionFile 中的 `model_change` 事件？
- config 参数的正确格式是什么？

```bash
# OpenClaw 源码位置（如果有）
find ~/.npm-global -name "*.js" -exec grep -l "runEmbeddedPiAgent" {} \;
```

### 方案 2: 尝试不同的 config 格式

```typescript
// 尝试显式传递 model
await this.api.runtime.agent.runEmbeddedPiAgent({
  sessionId: runId,
  sessionFile,
  prompt,
  extraSystemPrompt: NOCTURNAL_DREAMER_PROMPT,
  config: {
    agents: {
      defaults: {
        model: 'minimax-portal/MiniMax-M2.7'
      }
    }
  },
  timeoutMs: this.stageTimeoutMs,
  runId,
  disableTools: true,
});
```

### 方案 3: 放弃 runEmbeddedPiAgent，使用其他方案

如果 `runEmbeddedPiAgent` 无法正确设置 model，考虑：
- 使用 `api.runtime.subagent.run()` 但在 gateway context 中触发
- 使用外部 HTTP API 调用
- 使用 `openclaw agent` CLI 命令

### 方案 4: 联系 OpenClaw 团队

询问：
- `runEmbeddedPiAgent` 如何设置 model？
- sessionFile 的正确格式是什么？
- 是否有示例代码？

---

## 7. 快速验证命令

```bash
# 1. 清理冷却
python3 -c "
import json, os
f = os.path.expanduser('~/.openclaw/workspace-main/.state/nocturnal-runtime.json')
d = json.load(open(f))
d['globalCooldownUntil'] = None
d['recentRunTimestamps'] = []
json.dump(d, open(f, 'w'), indent=2)
"

# 2. 触发测试
# 在飞书发送 /pd-reflect

# 3. 监控日志
journalctl --user -u openclaw-gateway -f | grep -E "Trinity|Dreamer|openai|minimax|Created session"

# 4. 检查任务状态
cat ~/.openclaw/workspace-main/.state/evolution_queue.json | jq '.[-1]'
```

---

## 8. 相关文件

| 文件 | 说明 |
|------|------|
| `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` | Trinity 核心逻辑，包含 runEmbeddedPiAgent 调用 |
| `packages/openclaw-plugin/src/openclaw-sdk.d.ts` | OpenClaw SDK 类型定义 |
| `packages/openclaw-plugin/src/service/nocturnal-runtime.ts` | Nocturnal 运行时服务 |
| `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` | 工作流管理器 |
| `~/.openclaw/extensions/principles-disciple/dist/bundle.js` | 打包后的插件代码 |
| `~/.openclaw/workspace-main/.state/nocturnal-runtime.json` | Nocturnal 状态文件 |
| `~/.openclaw/workspace-main/.state/evolution_queue.json` | 进化队列 |

---

## 9. 测试历史

| 时间 | 测试结果 | 错误 |
|------|---------|------|
| 12:38 | ❌ 失败 | No API key for openai |
| 12:43 | ❌ 失败 | Global cooldown + No API key for openai |
| 12:54 | ❌ 失败 | No API key for openai |
| 13:05 | ❌ 失败 | No API key for openai |
| 13:11 | ❌ 失败 | No API key for openai |

所有测试都是相同的错误：`runEmbeddedPiAgent` 使用了 `openai` provider 而不是配置的 `minimax-portal/MiniMax-M2.7`。
