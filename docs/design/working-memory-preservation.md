# 工作记忆保留系统设计

> Version: v1 | Status: DRAFT | Created: 2026-03-24

## 问题陈述

会话压缩后，智能体出现"失忆"现象：
- 不知道当前正在做什么任务
- 不知道已经输出了哪些文件
- 不知道遇到了什么问题、如何解决的
- 不知道下一步该做什么
- 不知道之前做了哪些决策

## 解决方案

利用 OpenClaw 的 **Context Engine** 插件接口，实现工作记忆的保留和恢复。

### 核心功能

1. **压缩时保留工作记忆** - 在 `before_compaction` 钩子提取并持久化
2. **压缩后恢复工作记忆** - 在 `before_prompt_build` 读取并注入上下文
3. **子智能体上下文继承** - 通过 `prepareSubagentSpawn` 传递给 diagnostician 等

---

## 工作记忆内容

### 需要保留的信息

| 类别 | 内容 | 示例 |
|------|------|------|
| **Current Session** | 当前任务、目标、进度 | "实现 Context Engine 功能", 60% |
| **Recent Outputs** | 已创建/修改的文件 | `src/context-engine/principles-engine.ts` (created) |
| **Active Context** | 当前问题、解决方案 | 问题：压缩后失忆；方案：Context Engine |
| **Next Actions** | 下一步具体行动 | 1. 实现 compact 钩子 2. 添加测试 |
| **Decisions Made** | 已做决策及原因 | 选择混合架构，原因：保留灵活性 |
| **Evolution State** | GFI、活跃原则、Pain 信号 | GFI: 15, Principles: 3 |

### 数据结构

```typescript
interface WorkingMemorySnapshot {
  // 元数据
  sessionId: string;
  lastUpdated: string;
  
  // 当前任务
  currentTask: {
    description: string;        // "实现 Context Engine 功能"
    goal: string;               // "让压缩后智能体保持工作连续性"
    status: 'in_progress' | 'blocked' | 'reviewing' | 'completed';
    startedAt: string;
    progress: number;           // 0-100
  };

  // 工作产物
  artifacts: {
    created: string[];          // ["src/context-engine/principles-engine.ts"]
    modified: string[];         // ["src/hooks/prompt.ts", "src/index.ts"]
    pending: string[];          // ["tests/context-engine.test.ts"]
  };

  // 问题解决
  problemSolving: {
    active: {
      problem: string;          // "压缩后智能体失忆"
      attemptedSolutions: string[];
      currentApproach: string;  // "用 Context Engine 保留工作记忆"
    };
    solved: Array<{
      problem: string;
      solution: string;
    }>;
    blockers: string[];
  };

  // 下一步行动
  nextActions: string[];        // ["实现 compact 钩子", "添加测试用例"]

  // 决策上下文
  decisions: Array<{
    choice: string;             // "选择混合架构"
    rationale: string;          // "保留动态指令的灵活性"
    alternatives: string[];     // ["完全替代", "渐进迁移"]
    rejectedReasons: string[];  // ["完全替代风险大"]
  }>;

  // 进化状态
  evolution: {
    gfi: number;
    trustScore: number;
    activePrinciples: string[];
    recentPainSignals: string[];
  };
}
```

---

## 存储方案

### 存储位置：CURRENT_FOCUS.md

扩展现有文件，添加 `## 🧠 Working Memory` 部分：

```markdown
# CURRENT_FOCUS
> Version: v1 | Status: EXECUTING

## Status Snapshot      ← 项目级别状态（保持不变）

## Current Tasks        ← 任务清单（保持不变）

## Next                 ← 下一步（保持不变）

## References           ← 参考文件（保持不变）

---

## 🧠 Working Memory

### Current Session
- **Task**: 实现 Context Engine 功能
- **Goal**: 让压缩后智能体保持工作连续性
- **Status**: in_progress
- **Started**: 2026-03-24 10:30
- **Progress**: 60%

### Recent Outputs
| File | Action | Status |
|------|--------|--------|
| `src/context-engine/principles-engine.ts` | created | done |
| `src/hooks/prompt.ts` | modified | done |
| `tests/context-engine.test.ts` | created | pending |

### Active Context
- **Problem**: 压缩后智能体失忆
- **Current Approach**: 用 Context Engine 保留工作记忆
- **Blockers**: 无

### Next Immediate Actions
1. 实现 `compact()` 钩子
2. 添加测试用例
3. 验证压缩恢复流程

### Decisions Made
- **Choice**: 混合架构（Hook + Context Engine）
- **Rationale**: 保留动态指令的灵活性
- **Alternatives**: 完全替代、渐进迁移

### Evolution State
- **GFI**: 15
- **Trust Score**: 85
- **Active Principles**: 3
```

### 为什么选择 CURRENT_FOCUS.md

| 考虑因素 | 优势 |
|----------|------|
| **统一管理** | 任务规划和工作记忆在同一文件 |
| **自动更新** | 已有注入机制，扩展简单 |
| **版本历史** | Git 追踪工作记忆变化 |
| **无需新建** | 复用现有文件，减少复杂度 |

---

## 技术架构

### 混合模式架构

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenClaw Runtime                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────┐     ┌───────────────────────────┐   │
│  │   Hook Layer       │     │   Context Engine Layer    │   │
│  │   (动态指令)        │     │   (工作记忆管理)           │   │
│  ├────────────────────┤     ├───────────────────────────┤   │
│  │ - before_prompt    │     │ - bootstrap()             │   │
│  │   ├─ trustScore    │     │ - compact()               │   │
│  │   ├─ evolutionTask │     │ - afterTurn()             │   │
│  │   └─ heartbeat     │     │ - prepareSubagentSpawn()  │   │
│  │                    │     │ - onSubagentEnded()       │   │
│  │ - before_compact   │◄───►│                           │   │
│  │   └─ 提取工作记忆   │     │ - 工作记忆解析/更新       │   │
│  │                    │     │ - 状态持久化              │   │
│  │ - after_compact    │     │                           │   │
│  │   └─ 写入文件      │     └───────────────────────────┘   │
│  │                    │                                      │
│  └────────────────────┘                                      │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                 CURRENT_FOCUS.md                        │ │
│  │  ┌──────────────────┐  ┌─────────────────────────────┐ │ │
│  │  │ Project Focus    │  │ 🧠 Working Memory          │ │ │
│  │  │ (手动维护)        │  │ (自动更新)                  │ │ │
│  │  └──────────────────┘  └─────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 职责划分

| 组件 | 职责 | 触发时机 |
|------|------|---------|
| **Hook Layer** | 动态运行时指令 | 每次提示构建 |
| - before_prompt_build | trustScore, GFI, 进化任务指令 | 每次 LLM 调用 |
| - before_compaction | 提取工作记忆 | 上下文压缩前 |
| - after_compaction | 写入持久化存储 | 上下文压缩后 |
| **Context Engine** | 静态工作记忆管理 | 会话生命周期 |
| - bootstrap | 初始化工作记忆 | 会话开始 |
| - compact | 保留进化关键信息 | 上下文压缩 |
| - afterTurn | 更新工作记忆 | 每轮结束 |
| - prepareSubagentSpawn | 子智能体上下文继承 | 子智能体启动 |
| - onSubagentEnded | 收集学习成果 | 子智能体结束 |

---

## 实现细节

### 1. WorkingMemoryManager 类

```typescript
// src/core/working-memory.ts

export class WorkingMemoryManager {
  private workspaceDir: string;
  private currentFocusPath: string;
  private cache: WorkingMemorySnapshot | null = null;
  private dirty: boolean = false;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.currentFocusPath = path.join(workspaceDir, 'memory/okr/CURRENT_FOCUS.md');
  }

  // 解析 CURRENT_FOCUS.md 中的 Working Memory 部分
  parse(): WorkingMemorySnapshot | null {
    if (!fs.existsSync(this.currentFocusPath)) return null;
    
    const content = fs.readFileSync(this.currentFocusPath, 'utf-8');
    const wmSection = this.extractWorkingMemorySection(content);
    if (!wmSection) return null;
    
    return this.parseWorkingMemorySection(wmSection);
  }

  // 更新工作记忆（内存 + 标记脏）
  update(updates: Partial<WorkingMemorySnapshot>): void {
    if (!this.cache) {
      this.cache = this.parse() || this.createEmpty();
    }
    this.cache = { ...this.cache, ...updates, lastUpdated: new Date().toISOString() };
    this.dirty = true;
  }

  // 添加文件输出记录
  addArtifact(file: string, action: 'created' | 'modified'): void {
    if (!this.cache) this.cache = this.parse() || this.createEmpty();
    
    if (action === 'created') {
      if (!this.cache.artifacts.created.includes(file)) {
        this.cache.artifacts.created.push(file);
      }
    } else {
      if (!this.cache.artifacts.modified.includes(file)) {
        this.cache.artifacts.modified.push(file);
      }
    }
    this.dirty = true;
  }

  // 持久化到文件
  persist(): void {
    if (!this.dirty || !this.cache) return;
    
    let content = '';
    if (fs.existsSync(this.currentFocusPath)) {
      content = fs.readFileSync(this.currentFocusPath, 'utf-8');
    }
    
    const newContent = this.mergeWorkingMemorySection(content, this.cache);
    fs.writeFileSync(this.currentFocusPath, newContent, 'utf-8');
    this.dirty = false;
  }

  // 从消息中提取工作记忆
  extractFromMessages(messages: AgentMessage[]): Partial<WorkingMemorySnapshot> {
    const extracted: Partial<WorkingMemorySnapshot> = {};
    
    // 分析最近消息，提取：
    // - 当前任务描述
    // - 遇到的问题
    // - 决策内容
    // - 下一步行动
    
    return extracted;
  }

  // 生成上下文注入字符串
  toInjectionString(): string {
    if (!this.cache) return '';
    
    const lines: string[] = ['<working_memory preserved="true">'];
    
    if (this.cache.currentTask) {
      lines.push(`### Current Task`);
      lines.push(`- **Description**: ${this.cache.currentTask.description}`);
      lines.push(`- **Goal**: ${this.cache.currentTask.goal}`);
      lines.push(`- **Progress**: ${this.cache.currentTask.progress}%`);
      lines.push(`- **Status**: ${this.cache.currentTask.status}`);
    }
    
    if (this.cache.artifacts.created.length > 0 || this.cache.artifacts.modified.length > 0) {
      lines.push(`### Recent Outputs`);
      this.cache.artifacts.created.forEach(f => lines.push(`- [CREATED] ${f}`));
      this.cache.artifacts.modified.forEach(f => lines.push(`- [MODIFIED] ${f}`));
    }
    
    if (this.cache.nextActions.length > 0) {
      lines.push(`### Next Actions`);
      this.cache.nextActions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
    }
    
    lines.push('</working_memory>');
    return lines.join('\n');
  }
}
```

### 2. PrinciplesContextEngine 类

```typescript
// src/context-engine/principles-engine.ts

import type { ContextEngine, ContextEngineInfo } from './types.js';

export class PrinciplesContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: 'principles-evolution',
    name: 'Principles Evolution Context Engine',
    version: '1.0.0',
    ownsCompaction: false  // 不接管压缩，只增强
  };

  private workspaceDir: string;
  private workingMemoryManager: WorkingMemoryManager;
  private sessionStates = new Map<string, SessionEvolutionState>();

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.workingMemoryManager = new WorkingMemoryManager(workspaceDir);
  }

  async bootstrap(params: { sessionId: string; sessionKey?: string; sessionFile: string }) {
    // 加载工作记忆
    const snapshot = this.workingMemoryManager.parse();
    
    // 初始化会话状态
    this.sessionStates.set(params.sessionId, {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      startedAt: new Date().toISOString(),
      snapshot
    });

    return { bootstrapped: true, importedMessages: 0 };
  }

  async afterTurn(params: AfterTurnParams): Promise<void> {
    const state = this.sessionStates.get(params.sessionId);
    if (!state) return;

    // 从消息中提取工作记忆更新
    const updates = this.workingMemoryManager.extractFromMessages(params.messages);
    
    if (Object.keys(updates).length > 0) {
      this.workingMemoryManager.update(updates);
    }
  }

  async compact(params: CompactParams): Promise<CompactResult> {
    // 1. 提取工作记忆
    const state = this.sessionStates.get(params.sessionId);
    if (state) {
      const updates = this.workingMemoryManager.extractFromMessages(params.messages);
      this.workingMemoryManager.update(updates);
    }

    // 2. 持久化
    this.workingMemoryManager.persist();

    // 3. 返回结果（不执行实际压缩）
    return {
      ok: true,
      compacted: false,
      result: {
        tokensBefore: 0
      }
    };
  }

  async prepareSubagentSpawn(params: { parentSessionKey: string; childSessionKey: string; ttlMs?: number }) {
    const parentState = this.sessionStates.get(params.parentSessionKey);
    if (!parentState) return undefined;

    // 创建子会话状态，继承父会话的工作记忆
    const childState: SessionEvolutionState = {
      sessionId: params.childSessionKey,
      sessionKey: params.childSessionKey,
      startedAt: new Date().toISOString(),
      snapshot: parentState.snapshot,
      parentSessionKey: params.parentSessionKey,
      inherited: true
    };

    this.sessionStates.set(params.childSessionKey, childState);

    return {
      rollback: () => {
        this.sessionStates.delete(params.childSessionKey);
      }
    };
  }

  async onSubagentEnded(params: { childSessionKey: string; reason: string }): Promise<void> {
    const childState = this.sessionStates.get(params.childSessionKey);
    if (!childState?.parentSessionKey) return;

    // 收集子智能体的学习成果到父会话
    const parentState = this.sessionStates.get(childState.parentSessionKey);
    if (parentState && childState.snapshot) {
      // 合并决策、问题解决记录等
      // ...
    }

    this.sessionStates.delete(params.childSessionKey);
  }

  // 获取工作记忆注入字符串
  getWorkingMemoryInjection(sessionId: string): string {
    return this.workingMemoryManager.toInjectionString();
  }
}
```

### 3. Hook 集成

```typescript
// src/hooks/lifecycle.ts 增强

export async function handleBeforeCompaction(
  event: PluginHookBeforeCompactionEvent,
  ctx: PluginHookAgentContext
): Promise<void> {
  // ... 现有逻辑 ...

  // 新增：提取并保存工作记忆
  const contextEngine = getContextEngine();
  if (contextEngine && event.messages) {
    await contextEngine.compact({
      sessionId: ctx.sessionId!,
      sessionFile: event.sessionFile!,
      messages: event.messages
    });
  }
}

export async function handleAfterCompaction(
  event: PluginHookAfterCompactionEvent,
  ctx: PluginHookAgentContext
): Promise<void> {
  // ... 现有逻辑 ...

  // 新增：持久化工作记忆
  const contextEngine = getContextEngine();
  if (contextEngine) {
    // 工作记忆已在 before_compaction 中更新
    // 这里确保持久化完成
  }
}
```

```typescript
// src/hooks/prompt.ts 增强

export async function handleBeforePromptBuild(
  event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext
): Promise<PluginHookBeforePromptBuildResult | void> {
  // ... 现有逻辑 ...

  // 新增：注入工作记忆
  const contextEngine = getContextEngine();
  if (contextEngine && ctx.sessionId) {
    const workingMemoryInjection = contextEngine.getWorkingMemoryInjection(ctx.sessionId);
    if (workingMemoryInjection) {
      prependContext += workingMemoryInjection + '\n';
    }
  }

  // ... 其余逻辑 ...
}
```

### 4. 注册 Context Engine

```typescript
// src/index.ts

import { PrinciplesContextEngine } from './context-engine/principles-engine.js';

const plugin = {
  name: "Principles Disciple",
  // ...

  register(api: OpenClawPluginApi) {
    // 注册 Context Engine
    const workspaceDir = api.resolvePath('.');
    api.registerContextEngine('principles-evolution', () => 
      new PrinciplesContextEngine(workspaceDir)
    );

    // ... 其余注册逻辑 ...
  }
};
```

---

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/core/paths.ts` | 修改 | 添加 WORKING_MEMORY 相关路径 |
| `src/core/working-memory.ts` | 新建 | WorkingMemoryManager 类 |
| `src/context-engine/types.ts` | 新建 | Context Engine 类型定义（适配 OpenClaw） |
| `src/context-engine/principles-engine.ts` | 新建 | PrinciplesContextEngine 实现 |
| `src/hooks/lifecycle.ts` | 修改 | 增强工作记忆提取写入 |
| `src/hooks/prompt.ts` | 修改 | 增强工作记忆注入 |
| `src/index.ts` | 修改 | 注册 Context Engine |
| `src/openclaw-sdk.d.ts` | 修改 | 添加 Context Engine 相关类型 |

---

## 测试计划

### 单元测试

1. **WorkingMemoryManager**
   - 解析 CURRENT_FOCUS.md 中的 Working Memory 部分
   - 更新工作记忆并标记脏
   - 持久化到文件
   - 从消息中提取工作记忆

2. **PrinciplesContextEngine**
   - bootstrap 初始化会话状态
   - afterTurn 更新工作记忆
   - compact 提取并持久化
   - prepareSubagentSpawn 继承工作记忆
   - onSubagentEnded 收集学习成果

### 集成测试

1. **压缩恢复流程**
   - 模拟压缩前状态
   - 触发 before_compaction
   - 验证工作记忆已保存
   - 触发 before_prompt_build
   - 验证工作记忆已注入

2. **子智能体继承**
   - 创建父会话
   - 启动子智能体
   - 验证工作记忆继承
   - 子智能体结束
   - 验证学习成果合并

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| CURRENT_FOCUS.md 损坏 | 工作记忆丢失 | 创建备份，解析失败时使用默认值 |
| 工作记忆过大 | 增加上下文 | 限制保留条目数量，智能摘要 |
| 解析性能 | 影响响应速度 | 缓存机制，增量更新 |
| 并发写入 | 数据冲突 | 文件锁保护 |

---

## 后续优化

1. **智能提取** - 使用 LLM 分析消息，自动提取工作记忆
2. **差异压缩** - 只保留变化部分，减少存储
3. **多会话合并** - 支持多个会话的工作记忆合并
4. **可视化** - 在 Control UI 中展示工作记忆状态
