# 提示词：Principles Disciple 进化闭环全面诊断

请复制以下提示词给另一个 AI：

---

## 提示词

你是一个精通 AI Agent 框架和进化系统的架构师。请对 Principles Disciple 项目进行全面诊断，找出进化闭环中的断点，并提出具体的优化建议。

### 一、背景

Principles Disciple 是一个基于 OpenClaw 的 AI Agent 进化框架，核心理念是 "Pain + Reflection = Progress"。框架设计了完整的进化闭环：从 Pain 信号触发 → 诊断 → 落盘 → 提炼原则 → 行为改变。

但实际运行中发现：诊断报告产出了 38 个，但原则库 PRINCIPLES.md 是空的，中间环节存在断裂。

### 二、获取代码（在沙盒中执行）

```bash
# 克隆 Principles Disciple 项目
git clone https://github.com/csuzngjh/principles.git

# 克隆 OpenClaw 源码
git clone https://github.com/openclaw/openclaw.git
```

### 三、需要分析的项目

1. **Principles Disciple 项目**: `principles/`
   - 重点目录: `packages/openclaw-plugin/src/`
   - SKILL 文件: `packages/openclaw-plugin/templates/langs/zh/skills/`
   - 调查报告: `docs/diagnosis/evolution-loop-investigation-report.md`（先阅读这个）

2. **OpenClaw 源码**: `openclaw/`
   - 重点：理解 OpenClaw 的 hook 机制、SKILL 机制、子智能体机制

3. **用户工作目录证据**: 无法访问，但调查报告中有详细记录
   - 诊断报告目录有 38 个文件
   - PRINCIPLES.md 只有模板，无实际原则
   - ISSUE_LOG.md 和 DECISIONS.md 不存在

### 四、需要回答的问题

1. **进化闭环完整性**
   - 从 Pain 触发到原则沉淀，哪些环节是自动化的？哪些需要手动干预？
   - 代码层面的断点在哪里？SKILL 层面的断点在哪里？

2. **OpenClaw 集成点**
   - Principles 插件是如何与 OpenClaw 集成的？
   - OpenClaw 提供了哪些扩展点可以利用？
   - OpenClaw 的 SKILL 是如何被触发执行的？

3. **子智能体机制**
   - 子智能体的输出是如何被处理的？
   - 能否在子智能体完成后自动触发后续流程？
   - OpenClaw 的 `sessions_spawn` 和 `pd_spawn_agent` 有什么区别？

4. **事件日志停滞**
   - 为什么 events.jsonl 停在 2026-03-11？
   - OpenClaw 的事件记录机制是如何工作的？

5. **优化建议**
   - 如何让诊断报告自动转化为原则候选？
   - 如何在子智能体完成后自动触发落盘流程？
   - 是否需要在 OpenClaw 层面做改动？还是只需要修改 Principles 插件？

### 五、期望的输出格式

请按以下结构输出诊断报告：

```markdown
# Principles Disciple 进化闭环全面诊断报告

## 一、进化闭环流程图
[使用 ASCII 或 Mermaid 绘制完整流程图，标注每个节点的自动化程度]

## 二、节点详情表
[每个节点的输入、输出、触发条件、处理代码、状态]

## 三、断点根因分析
[每个断点的深层原因]

## 四、OpenClaw 扩展点分析
[OpenClaw 提供的可利用扩展点]

## 五、优化方案
### 方案 A: 最小改动（只改 Principles 插件）
[具体步骤]

### 方案 B: 完整方案（可能需要改 OpenClaw）
[具体步骤]

## 六、实施优先级
[按优先级排序的具体任务]
```

### 五-A、节点详情表格式要求

请为进化闭环中的每个节点输出以下信息：

| 节点名称 | 触发条件 | 输入 | 输出 | 处理代码位置 | 状态 |
|----------|----------|------|------|--------------|------|
| Pain 触发 | Tool 失败 | error, toolName, filePath | .pain_flag (KV) | hooks/pain.ts | ✅/⚠️/❌ |
| Evolution Worker 轮询 | 定时 15min | .pain_flag | evolution_queue.json | service/evolution-worker.ts | ✅/⚠️/❌ |
| ... | ... | ... | ... | ... | ... |

**每个节点需要回答**：
1. 输入是什么？（文件、参数、事件）
2. 输出是什么？（文件、状态变更、函数调用）
3. 谁触发？（定时器、事件、用户）
4. 代码在哪里？（具体文件和函数）
5. 当前状态？（工作/部分工作/断裂）

### 五-B、流程图要求

请使用 ASCII 图或 Mermaid 绘制：

```
┌─────────────┐
│  节点名称   │ ← 触发条件
│  [状态标记] │
└──────┬──────┘
       │ 输出: xxx
       ▼
┌─────────────┐
│  下一个节点 │
└─────────────┘
```

**状态标记说明**：
- ✅ = 自动化工作正常
- ⚠️ = 部分工作/需手动触发
- ❌ = 断裂/未实现

### 六、关键文件参考

**Principles 项目**（克隆后路径）:
- `principles/packages/openclaw-plugin/src/hooks/pain.ts`
- `principles/packages/openclaw-plugin/src/hooks/prompt.ts`
- `principles/packages/openclaw-plugin/src/hooks/subagent.ts`
- `principles/packages/openclaw-plugin/src/service/evolution-worker.ts`
- `principles/packages/openclaw-plugin/src/core/paths.ts`
- `principles/packages/openclaw-plugin/src/core/path-resolver.ts`
- `principles/packages/openclaw-plugin/templates/langs/zh/skills/evolve-task/SKILL.md`
- `principles/packages/openclaw-plugin/templates/langs/zh/skills/reflection/SKILL.md`
- `principles/packages/openclaw-plugin/src/openclaw-sdk.d.ts` - OpenClaw 插件 SDK 类型定义
- `principles/packages/openclaw-plugin/agents/` - 子智能体定义目录
- `principles/docs/diagnosis/evolution-loop-investigation-report.md`（先阅读）

**OpenClaw 项目**（克隆后路径）:
- `openclaw/packages/core/src/` - 核心逻辑
- `openclaw/packages/plugin-sdk/src/` - 插件 SDK
- 重点查找：hook 机制、skill 加载机制、subagent 机制

**用户工作目录证据**（在调查报告中）:
- PRINCIPLES.md - 原则库（空）
- memory/diagnostics/ - 诊断报告目录（38个文件）
- memory/.state/logs/events.jsonl - 事件日志

### 七、补充事实数据

#### 7.1 OpenClaw Hook 类型（从 openclaw-sdk.d.ts）

```typescript
// 可用的 Hook 类型
type PluginHook = 
  | 'before_prompt_build'    // 构建提示前
  | 'after_prompt_build'     // 构建提示后
  | 'before_tool_call'       // 工具调用前
  | 'after_tool_call'        // 工具调用后
  | 'subagent_ended'         // 子智能体结束
  | 'before_compaction'      // 压缩前
  | 'heartbeat'              // 心跳
  // ... 更多
```

#### 7.2 子智能体类型（从 agents/ 目录）

Principles 定义了以下子智能体类型：
- `diagnostician` - 诊断智能体，分析 Pain 根因
- `explorer` - 探索智能体，收集证据
- `auditor` - 审计智能体，验证方案
- `implementer` - 实施智能体，执行修复
- `planner` - 规划智能体，制定计划
- `reviewer` - 审查智能体，代码审查
- `reporter` - 报告智能体，生成报告

#### 7.3 Pain 字典状态

```json
{
  "rules": {
    "P_CONFUSION_EN": { "hits": 0, "status": "active" },
    "P_LOOP_EN": { "hits": 0, "status": "active" }
  }
}
```
只有 2 条硬编码规则，hits 都是 0。

#### 7.4 事件日志最后记录时间

```
events.jsonl 最后时间戳: 2026-03-11T09:26:24.032Z
当前日期: 2026-03-17
停滞天数: 6 天
```

#### 7.5 关键 SKILL 的落盘指令

`/evolve-task` SKILL Step 9 原文：
```
1. **系统进化**: 将 Pain/Root cause/新原则候选/门禁建议追加到 memory/ISSUE_LOG.md，并更新 memory/DECISIONS.md。
```

`/reflection` SKILL 原文：
```
1. **记录**: 将分析结果写入 `memory/ISSUE_LOG.md`。
```

#### 7.6 paths.ts 已定义的路径

```typescript
export const PD_FILES = {
    PRINCIPLES: path.join(PD_DIRS.IDENTITY, 'PRINCIPLES.md'),
    THINKING_OS: path.join(PD_DIRS.IDENTITY, 'THINKING_OS.md'),
    USER_CONTEXT: path.join(PD_DIRS.MEMORY, 'USER_CONTEXT.md'),
    REFLECTION_LOG: path.join(PD_DIRS.MEMORY, 'reflection-log.md'),
    // 注意：没有 ISSUE_LOG 和 DECISIONS
};
```

---

开始诊断吧！
