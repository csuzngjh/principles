# 提示词：Principles Disciple 进化闭环全面诊断

请复制以下提示词给另一个 AI：

---

## 提示词

你是一个精通 AI Agent 框架和进化系统的架构师。请对 Principles Disciple 项目进行全面诊断，找出进化闭环中的断点，并提出具体的优化建议。

### 一、背景

Principles Disciple 是一个基于 OpenClaw 的 AI Agent 进化框架，核心理念是 "Pain + Reflection = Progress"。框架设计了完整的进化闭环：从 Pain 信号触发 → 诊断 → 落盘 → 提炼原则 → 行为改变。

但实际运行中发现：诊断报告产出了 38 个，但原则库 PRINCIPLES.md 是空的，中间环节存在断裂。

### 二、调查报告位置

请先阅读调查报告：
```
/home/csuzngjh/code/principles/docs/diagnosis/evolution-loop-investigation-report.md
```

### 三、需要分析的项目

1. **Principles Disciple 项目**: `/home/csuzngjh/code/principles`
   - 重点目录: `packages/openclaw-plugin/src/`
   - SKILL 文件: `packages/openclaw-plugin/templates/langs/zh/skills/`

2. **OpenClaw 源码**: 请从 GitHub 克隆
   ```
   git clone https://github.com/openclaw/openclaw.git /tmp/openclaw
   ```
   - 重点：理解 OpenClaw 的 hook 机制、SKILL 机制、子智能体机制

3. **用户工作目录**: `/home/csuzngjh/clawd`
   - 查看实际运行产生的文件和日志

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

**Principles 项目**:
- `packages/openclaw-plugin/src/hooks/pain.ts`
- `packages/openclaw-plugin/src/hooks/prompt.ts`
- `packages/openclaw-plugin/src/hooks/subagent.ts`
- `packages/openclaw-plugin/src/service/evolution-worker.ts`
- `packages/openclaw-plugin/src/core/paths.ts`
- `packages/openclaw-plugin/src/core/path-resolver.ts`
- `packages/openclaw-plugin/templates/langs/zh/skills/evolve-task/SKILL.md`
- `packages/openclaw-plugin/templates/langs/zh/skills/reflection/SKILL.md`

**用户工作目录**:
- `~/clawd/.principles/PRINCIPLES.md` - 原则库（空）
- `~/clawd/memory/diagnostics/` - 诊断报告目录（38个文件）
- `~/clawd/memory/.state/logs/events.jsonl` - 事件日志

---

开始诊断吧！
