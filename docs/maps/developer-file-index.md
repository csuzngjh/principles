# Principles Disciple 开发者文件索引

> **目标用户**: AI 编程智能体、新加入的开发者
> **用途**: 快速定位文件和函数，理解项目架构
> **最后更新**: 2026-03-21

---

## 🚀 快速导航

| 我想... | 去这里 |
|---------|--------|
| 找到钩子（hook）实现 | `src/hooks/` 目录 |
| 找到命令处理函数 | `src/commands/` 目录 |
| 找到后台服务 | `src/service/` 目录 |
| 找到自定义工具 | `src/tools/` 目录 |
| 找到核心业务逻辑 | `src/core/` 目录 |
| 找到工具函数 | `src/utils/` 目录 |
| 找到类型定义 | `src/types.ts` 和 `src/core/*.ts` |
| 找到测试文件 | `packages/openclaw-plugin/tests/` |

---

## 📁 完整目录结构

```
packages/openclaw-plugin/
├── src/
│   ├── index.ts                          # 插件入口（541行）- 注册所有钩子、命令、工具、服务
│   ├── types.ts                          # 上下文注入类型（79行）
│   ├── openclaw-sdk.d.ts                 # OpenClaw SDK 类型定义
│   │
│   ├── core/                             # 核心业务逻辑（29个文件）
│   │   ├── trust-engine.ts              # 信任引擎 V2.1（332行）
│   │   ├── evolution-engine.ts          # 进化引擎 V2.0（634行）
│   │   ├── evolution-reducer.ts         # 事件溯源（447行）
│   │   ├── evolution-types.ts           # 进化类型定义（314行）
│   │   ├── evolution-migration.ts       # 数据迁移
│   │   ├── pain.ts                      # 痛苦评分（77行）
│   │   ├── config.ts                    # 配置管理（356行）
│   │   ├── config-service.ts            # 配置服务单例（29行）
│   │   ├── event-log.ts                 # 事件日志（535行）
│   │   ├── trajectory.ts                # 轨迹数据库（1094行）
│   │   ├── session-tracker.ts           # 会话追踪（489行）
│   │   ├── workspace-context.ts         # 工作区上下文门面（203行）
│   │   ├── paths.ts                     # 路径常量（84行）
│   │   ├── path-resolver.ts             # 路径解析
│   │   ├── dictionary.ts                # 痛苦模式字典
│   │   ├── dictionary-service.ts        # 字典服务单例（29行）
│   │   ├── detection-funnel.ts          # 检测漏斗（L1/L2/L3）
│   │   ├── detection-service.ts         # 检测服务单例（31行）
│   │   ├── profile.ts                   # 用户配置
│   │   ├── focus-history.ts             # 焦点历史
│   │   ├── agent-loader.ts              # 智能体定义加载器
│   │   ├── control-ui-db.ts             # 控制台数据库
│   │   ├── init.ts                      # 工作区初始化
│   │   ├── migration.ts                 # 目录结构迁移
│   │   ├── risk-calculator.ts           # 风险计算器
│   │   ├── system-logger.ts             # 系统日志
│   │   ├── thinking-models.ts           # 思维模型检测
│   │   └── hygiene/
│   │       └── tracker.ts               # 认知卫生追踪
│   │
│   ├── hooks/                            # OpenClaw 生命周期钩子（9个文件）
│   │   ├── prompt.ts                    # before_prompt_build（815行）
│   │   ├── gate.ts                      # before_tool_call（872行）
│   │   ├── pain.ts                      # after_tool_call（313行）
│   │   ├── llm.ts                       # llm_output（520行）
│   │   ├── lifecycle.ts                 # before/after_compaction, before_reset（209行）
│   │   ├── subagent.ts                  # subagent_ended
│   │   ├── message-sanitize.ts          # before_message_write
│   │   └── trajectory-collector.ts      # 轨迹收集（Phase 0）
│   │
│   ├── commands/                         # 斜杠命令处理（13个文件）
│   │   ├── strategy.ts                  # /pd-init, /pd-okr
│   │   ├── capabilities.ts              # /pd-bootstrap, /pd-research
│   │   ├── thinking-os.ts               # /pd-thinking
│   │   ├── evolver.ts                   # /pd-evolve
│   │   ├── trust.ts                     # /pd-trust
│   │   ├── pain.ts                      # /pd-status
│   │   ├── context.ts                   # /pd-context
│   │   ├── focus.ts                     # /pd-focus
│   │   ├── rollback.ts                  # /pd-rollback
│   │   ├── evolution-status.ts          # /pd-evolution-status
│   │   ├── principle-rollback.ts        # /pd-principle-rollback
│   │   ├── export.ts                    # /pd-export
│   │   └── samples.ts                   # /pd-samples
│   │
│   ├── service/                          # 后台服务（5个文件）
│   │   ├── evolution-worker.ts          # 进化工作器（620行）
│   │   ├── trajectory-service.ts        # 轨迹服务（15行）
│   │   ├── control-ui-query-service.ts  # 控制台查询服务
│   │   ├── runtime-summary-service.ts   # 运行时摘要服务
│   │   └── empathy-observer-manager.ts  # 共情观察者管理器
│   │
│   ├── tools/                            # 自定义工具（3个文件）
│   │   ├── deep-reflect.ts              # deep_reflect 工具（402行）
│   │   ├── critique-prompt.ts           # 深度反思提示模板
│   │   └── model-index.ts               # 思维模型索引构建器
│   │
│   ├── utils/                            # 工具函数（6个文件）
│   │   ├── file-lock.ts                 # 文件锁（391行）
│   │   ├── io.ts                        # 文件 I/O 工具
│   │   ├── hashing.ts                   # 哈希工具
│   │   ├── glob-match.ts               # Glob 模式匹配
│   │   ├── nlp.ts                       # NLP 工具
│   │   └── plugin-logger.ts             # 插件日志
│   │
│   ├── constants/                        # 常量定义
│   │   └── tools.ts                     # 工具分类常量（62行）
│   │
│   ├── http/                             # HTTP 路由
│   │   └── principles-console-route.ts  # Principles Console API
│   │
│   └── i18n/                             # 国际化
│       └── commands.ts                   # 命令描述翻译
│
├── tests/                                # 测试文件（69个）
│   ├── index.test.ts                    # 插件注册测试
│   ├── index.integration.test.ts        # 集成测试
│   ├── core/                            # 核心模块测试
│   ├── hooks/                           # 钩子测试
│   ├── commands/                        # 命令测试
│   ├── service/                         # 服务测试
│   ├── tools/                           # 工具测试
│   └── utils/                           # 工具函数测试
│
├── templates/                            # 工作区模板
│   ├── langs/zh/                        # 中文模板
│   └── langs/en/                        # 英文模板
│
└── agents/                               # 智能体定义文件
```

---

## 🔑 核心模块详解

### 1. 入口文件 `src/index.ts`

**职责**: 注册所有插件组件

**注册的钩子** (12个):
```typescript
api.on('before_prompt_build', handleBeforePromptBuild);
api.on('before_tool_call', handleBeforeToolCall);
api.on('after_tool_call', handleAfterToolCall);
api.on('llm_output', handleLlmOutput);
api.on('before_message_write', handleBeforeMessageWrite);
api.on('subagent_spawning', ...);
api.on('subagent_ended', handleSubagentEnded);
api.on('before_reset', handleBeforeReset);
api.on('before_compaction', handleBeforeCompaction);
api.on('after_compaction', handleAfterCompaction);
// 轨迹收集器（额外的 after_tool_call 和 llm_output）
```

**注册的命令** (16个):
- `/pd-init`, `/pd-okr`, `/pd-bootstrap`, `/pd-research`
- `/pd-thinking`, `/pd-evolve`, `/pd-daily`, `/pd-grooming`
- `/pd-trust`, `/pd-status`, `/pd-context`, `/pd-focus`
- `/pd-rollback`, `/pd-evolution-status`, `/pd-principle-rollback`
- `/pd-export`, `/pd-samples`, `/pd-help`

**注册的工具** (1个):
- `deep_reflect` - 深度反思工具

**注册的服务** (2个):
- `EvolutionWorkerService` - 进化工作器
- `TrajectoryService` - 轨迹服务

---

### 2. 核心业务逻辑 `src/core/`

#### 信任引擎 `trust-engine.ts`

**导出**:
```typescript
export class TrustEngine {
  constructor(workspaceDir: string, config?: Partial<TrustSettings>);
  
  // 核心方法
  getScore(): number;
  getStage(): TrustStage;  // 1 | 2 | 3 | 4
  getScorecard(): TrustScorecard;
  getStats(): TrustStats;
  getStatusSummary(): TrustStatusSummary;
  
  recordSuccess(toolName: string, isRisky?: boolean): void;
  recordFailure(toolName: string, isRisky?: boolean): void;
}

// 便捷函数
export function recordSuccess(workspaceDir: string, toolName: string, isRisky?: boolean): void;
export function recordFailure(workspaceDir: string, toolName: string, isRisky?: boolean): void;
export function getAgentScorecard(workspaceDir: string): TrustScorecard;
export function getTrustStats(workspaceDir: string): TrustStats;
export function getTrustStatus(workspaceDir: string): TrustStatusSummary;
```

**4阶段模型**:
| 阶段 | 分数范围 | 权限 |
|------|----------|------|
| Observer | < 30 | 只读 |
| Editor | 30-59 | 单文件编辑 |
| Developer | 60-79 | 多文件编辑 |
| Architect | ≥ 80 | 完全权限 |

---

#### 进化引擎 `evolution-engine.ts`

**导出**:
```typescript
export class EvolutionEngine {
  constructor(workspaceDir: string, config?: Partial<EvolutionConfig>);
  
  // 核心方法
  getPoints(): number;
  getAvailablePoints(): number;
  getTier(): EvolutionTier;  // 1 | 2 | 3 | 4 | 5
  getTierDefinition(): TierDefinition;
  getScorecard(): EvolutionScorecard;
  getStats(): EvolutionStats;
  getStatusSummary(): EvolutionStatusSummary;
  
  recordSuccess(context: ToolCallContext): EvolutionEvent;
  recordFailure(context: ToolCallContext): EvolutionEvent;
  checkGate(context: ToolCallContext): GateDecision;
}

// 实例管理
export function getEvolutionEngine(workspaceDir: string): EvolutionEngine;
export function disposeEvolutionEngine(workspaceDir: string): void;
export function checkEvolutionGate(workspaceDir: string, toolName: string, filePath?: string): GateDecision;

// 便捷函数
export function recordEvolutionSuccess(workspaceDir: string, toolName: string, filePath?: string): void;
export function recordEvolutionFailure(workspaceDir: string, toolName: string, filePath?: string): void;
```

**5级系统**:
| 等级 | 名称 | 所需积分 | 最大行数 | 最大文件数 | 风险路径 | 子智能体 |
|------|------|----------|----------|------------|----------|----------|
| 1 | Seed | 0 | 20 | 1 | ❌ | ❌ |
| 2 | Sprout | 50 | 50 | 2 | ❌ | ❌ |
| 3 | Sapling | 200 | 200 | 5 | ❌ | ✅ |
| 4 | Tree | 500 | 500 | 10 | ✅ | ✅ |
| 5 | Forest | 1000 | ∞ | ∞ | ✅ | ✅ |

---

#### 事件溯源 `evolution-reducer.ts`

**导出**:
```typescript
export interface EvolutionReducer {
  emit(event: EvolutionLoopEvent): void;
  getActivePrinciples(): Principle[];
  getPrinciplesByStatus(status: PrincipleStatus): Principle[];
  getProbationPrinciples(): Principle[];
  sweepExpiredProbation(): void;
  recordProbationFeedback(principleId: string, success: boolean): void;
  stableContentHash(content: string): string;
}

export class EvolutionReducerImpl implements EvolutionReducer {
  constructor(workspaceDir: string);
  // ... 实现方法
}
```

**原则生命周期**:
```
candidate → probation → active → deprecated
     ↑          ↓          ↑
     └──────────┴──────────┘
        失败时回退
```

---

#### 工作区上下文 `workspace-context.ts`

**导出**:
```typescript
export class WorkspaceContext {
  // 静态工厂方法（唯一的合规入口）
  static fromHookContext(ctx: HookContext): WorkspaceContext;
  
  // 服务访问器
  get config(): PainConfig;
  get eventLog(): EventLog;
  get dictionary(): PainDictionary;
  get trust(): TrustEngine;
  get evolution(): EvolutionEngine;
  get reducer(): EvolutionReducer;
  get trajectory(): TrajectoryDatabase;
  
  // 工具方法
  resolve(key: keyof typeof PD_FILES): string;
  resolvePdPath(key: string): string;
}
```

**使用模式**:
```typescript
// ✅ 正确：通过 WorkspaceContext 访问服务
const wctx = WorkspaceContext.fromHookContext(ctx);
const score = wctx.trust.getScore();

// ❌ 错误：直接实例化服务
const trust = new TrustEngine(workspaceDir);  // 不要这样做！
```

---

### 3. 钩子实现 `src/hooks/`

#### `prompt.ts` - 上下文注入（815行）

**职责**: 在 `before_prompt_build` 钩子中注入多层上下文

**注入层次** (8个阶段):
1. **身份层**: 核心原则、Thinking OS
2. **信任层**: 当前信任分数和阶段
3. **进化层**: 进化指令（EVOLUTION_DIRECTIVE）
4. **共情层**: 共情观察者生成
5. **心跳层**: 心跳检查清单
6. **态度层**: 基于 GFI 的态度矩阵
7. **系统层**: 项目上下文、思维模型、反思日志
8. **大小守卫**: 10K token 限制

**关键函数**:
```typescript
export async function handleBeforePromptBuild(
  event: PluginHookBeforePromptBuildEvent,
  ctx: ExtendedAgentContext
): Promise<PluginHookBeforePromptBuildResult | void>;
```

---

#### `gate.ts` - 安全门禁（872行）

**职责**: 在 `before_tool_call` 钩子中执行安全检查

**5阶段检查**:
1. **Trust Engine 检查**: 阶段权限验证
2. **Evolution Engine 检查**: GFI TIER 1-3 + Agent 工具检查
3. **Bash 安全**: Unicode 反混淆、命令分词、危险模式检测
4. **Edit Verification**: P-03 精确/模糊匹配
5. **Thinking Checkpoint Gate**: 思维检查点验证

**关键函数**:
```typescript
export function handleBeforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: ExtendedToolContext
): PluginHookBeforeToolCallResult | void;
```

---

#### `pain.ts` - 痛苦检测（313行）

**职责**: 在 `after_tool_call` 钩子中检测失败并更新信任

**流程**:
1. 提取退出码/错误
2. 调用 `trackFriction()` 更新 GFI
3. 调用 `TrustEngine.recordSuccess()` 或 `recordFailure()`
4. 记录事件日志
5. 记录轨迹数据
6. 检查试用期原则反馈

**关键函数**:
```typescript
export function handleAfterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: ExtendedToolContext,
  api: OpenClawPluginApi
): void;
```

---

#### `llm.ts` - LLM 输出分析（520行）

**职责**: 在 `llm_output` 钩子中分析 LLM 响应

**检测内容**:
- 共情信号（XML/JSON/遗留标签）
- 语义痛苦漏斗（L1/L2/L3）
- 瘫痪检测
- 思维模型使用追踪
- 共情回滚检测

**关键函数**:
```typescript
export function handleLlmOutput(
  event: PluginHookLlmOutputEvent,
  ctx: ExtendedAgentContext
): void;
```

---

### 4. 后台服务 `src/service/`

#### 进化工作器 `evolution-worker.ts`（620行）

**职责**: 每15分钟轮询处理痛苦信号

**轮询周期**:
1. `checkPainFlag()` - 读取 `.pain_flag`，如果分数 ≥ 30 则入队
2. `processEvolutionQueue()` - 处理待处理任务，写入 `EVOLUTION_DIRECTIVE.json`
3. `processDetectionQueue()` - 语义漏斗 L2→L3 检测
4. `processPromotion()` - 将候选晋升为规则

**关键函数**:
```typescript
export class EvolutionWorkerService implements OpenClawPluginService {
  static api: OpenClawPluginApi;
  
  id = 'evolution-worker';
  
  start(ctx: OpenClawPluginServiceContext): void;
  stop(ctx: OpenClawPluginServiceContext): void;
}
```

---

### 5. 自定义工具 `src/tools/`

#### `deep-reflect.ts` - 深度反思工具（402行）

**工具名称**: `deep_reflect`

**参数**:
- `context: string` - 当前任务上下文
- `depth?: 1 | 2 | 3` - 反思深度（默认2）
- `model_id?: string` - 思维模型 ID

**导出**:
```typescript
export function createDeepReflectTool(api: OpenClawPluginApi): AnyAgentTool;
```

---

### 6. 工具函数 `src/utils/`

#### `file-lock.ts` - 文件锁（391行）

**导出**:
```typescript
export class LockAcquisitionError extends Error {
  constructor(lockPath: string, timeoutMs: number);
}

export interface LockContext {
  lockPath: string;
  cleanup: () => void;
}

export function acquireLock(
  targetPath: string,
  options?: { lockSuffix?: string; lockStaleMs?: number }
): LockContext;

export async function acquireLockAsync(
  targetPath: string,
  options?: { lockSuffix?: string; lockStaleMs?: number }
): Promise<LockContext>;

export function withLock<T>(
  targetPath: string,
  fn: () => T,
  options?: { lockSuffix?: string; lockStaleMs?: number }
): T;

export async function withLockAsync<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options?: { lockSuffix?: string; lockStaleMs?: number }
): Promise<T>;
```

**使用模式**:
```typescript
// 同步
const result = withLock(filePath, () => {
  // 临界区
  return data;
}, { lockSuffix: '.lock', lockStaleMs: 30000 });

// 异步
const result = await withLockAsync(filePath, async () => {
  // 异步临界区
  return data;
});
```

---

### 7. 类型定义

#### `src/types.ts` - 上下文注入类型（79行）

```typescript
export interface ContextInjectionConfig {
  thinkingOs: boolean;      // 注入思维模型
  projectFocus: boolean;    // 注入项目焦点
  reflectionLog: boolean;   // 注入反思日志
  trustScore: boolean;      // 注入信任分数
}

export const defaultContextConfig: ContextInjectionConfig = {
  thinkingOs: true,
  projectFocus: true,
  reflectionLog: true,
  trustScore: true,
};

export interface ReflectionLogEntry {
  timestamp: string;
  model: string;
  context: string;
  insights: string[];
  actions: string[];
}
```

---

#### `src/core/evolution-types.ts` - 进化类型定义（314行）

```typescript
export enum EvolutionTier {
  Seed = 1,
  Sprout = 2,
  Sapling = 3,
  Tree = 4,
  Forest = 5
}

export interface TierPermissions {
  maxLinesPerWrite: number;
  maxFilesPerTask: number;
  allowRiskPath: boolean;
  allowSubagentSpawn: boolean;
}

export interface TierDefinition {
  tier: EvolutionTier;
  name: string;
  requiredPoints: number;
  permissions: TierPermissions;
}

export const TIER_DEFINITIONS: readonly TierDefinition[] = [/* ... */];

export interface EvolutionScorecard {
  totalPoints: number;
  availablePoints: number;
  currentTier: EvolutionTier;
  recentFailureHashes: Map<string, number>;
  stats: EvolutionStats;
}

export interface EvolutionEvent {
  id: string;
  timestamp: string;
  type: 'success' | 'failure';
  taskHash: string;
  toolName: string;
  filePath?: string;
  difficulty: TaskDifficulty;
  pointsDelta: number;
  isDoubleReward: boolean;
}

export interface Principle {
  id: string;
  rule: string;
  status: 'candidate' | 'probation' | 'active' | 'deprecated';
  source: 'tool_failure' | 'subagent_error' | 'user_frustration';
  createdAt: string;
  updatedAt: string;
  successCount: number;
  conflictCount: number;
  probationExpiresAt?: string;
}
```

---

#### `src/constants/tools.ts` - 工具分类常量（62行）

```typescript
export const READ_ONLY_TOOLS: Set<string> = new Set([
  'read', 'read_file', 'read_many_files', 'image_read',
  'search_file_content', 'grep', 'grep_search', 'list_directory', 'ls', 'glob',
  'lsp_hover', 'lsp_goto_definition', 'lsp_find_references',
  'web_fetch', 'web_search', 'ref_search_documentation', 'ref_read_url',
  'resolve-library-id', 'get-library-docs',
  'todo_read', 'save_memory',
  // ... 更多
]);

export const LOW_RISK_WRITE_TOOLS: Set<string> = new Set([
  'write', 'edit', 'create_file',
  // ... 更多
]);

export const HIGH_RISK_TOOLS: Set<string> = new Set([
  'bash', 'terminal', 'shell',
  // ... 更多
]);

export const BASH_TOOLS_SET: Set<string> = new Set([
  'bash', 'terminal', 'shell',
  // ... 更多
]);

export const AGENT_TOOLS: Set<string> = new Set([
  'sessions_spawn', 'task',
  // ... 更多
]);

export const CONTENT_LIMITED_TOOLS: Set<string> = new Set([
  // ... 受内容限制的工具
]);

export const CONSTRUCTIVE_TOOLS: Set<string> = new Set([
  // ... 建设性工具
]);

export const EXPLORATORY_TOOLS: Set<string> = new Set([
  // ... 探索性工具
]);
```

---

## 🔍 常见任务快速定位

### 我想修改信任分数计算逻辑

**文件**: `src/core/trust-engine.ts`

**关键函数**:
- `recordSuccess()` - 记录成功
- `recordFailure()` - 记录失败
- `getScore()` - 获取分数
- `getStage()` - 获取阶段

**相关配置**: `src/core/config.ts` → `TrustSettings`

---

### 我想修改进化积分计算

**文件**: `src/core/evolution-engine.ts`

**关键函数**:
- `recordSuccess()` - 记录成功并计算积分
- `recordFailure()` - 记录失败
- `checkGate()` - 检查门禁
- `getTier()` - 获取当前等级

**相关配置**: `src/core/config.ts` → `EvolutionConfig`

---

### 我想添加新的痛苦检测规则

**文件**: `src/core/dictionary.ts`, `src/core/detection-funnel.ts`

**关键函数**:
- `addRule()` - 添加规则
- `match()` - 匹配文本
- `detect()` - 检测痛苦信号

**相关配置**: `src/core/config.ts` → `PainSettings`

---

### 我想修改钩子行为

**文件**: `src/hooks/` 目录下对应的文件

| 钩子 | 文件 |
|------|------|
| `before_prompt_build` | `prompt.ts` |
| `before_tool_call` | `gate.ts` |
| `after_tool_call` | `pain.ts` |
| `llm_output` | `llm.ts` |

---

### 我想添加新的斜杠命令

**步骤**:
1. 在 `src/commands/` 目录创建新文件
2. 实现处理函数
3. 在 `src/index.ts` 中注册命令

**示例**:
```typescript
// src/commands/my-command.ts
export function handleMyCommand(ctx: PluginCommandContext) {
  return { text: "Hello from my command!" };
}

// src/index.ts
api.registerCommand({
  name: "pd-my-command",
  description: "My custom command",
  handler: (ctx) => handleMyCommand(ctx)
});
```

---

### 我想添加新的自定义工具

**步骤**:
1. 在 `src/tools/` 目录创建新文件
2. 实现工具工厂函数
3. 在 `src/index.ts` 中注册工具

**示例**:
```typescript
// src/tools/my-tool.ts
export function createMyTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: 'my_tool',
    description: 'My custom tool',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Input parameter' }
      },
      required: ['input']
    },
    execute: async (params, ctx) => {
      // 工具逻辑
      return { result: 'success' };
    }
  };
}

// src/index.ts
api.registerTool(createMyTool(api));
```

---

### 我想修改后台服务行为

**文件**: `src/service/` 目录下对应的文件

**关键服务**:
- `evolution-worker.ts` - 进化工作器
- `trajectory-service.ts` - 轨迹服务

**服务生命周期**:
```typescript
export class MyService implements OpenClawPluginService {
  id = 'my-service';
  
  start(ctx: OpenClawPluginServiceContext): void {
    // 启动逻辑
  }
  
  stop(ctx: OpenClawPluginServiceContext): void {
    // 停止逻辑
  }
}
```

---

## 🧪 测试结构

```
tests/
├── index.test.ts                 # 插件注册测试
├── index.integration.test.ts     # 集成测试
├── core/
│   ├── trust-engine.test.ts      # 信任引擎测试
│   ├── evolution-engine.test.ts  # 进化引擎测试
│   ├── evolution-reducer.test.ts # 事件溯源测试
│   ├── trajectory.test.ts        # 轨迹数据库测试
│   └── ...
├── hooks/
│   ├── gate.test.ts              # 门禁测试
│   ├── pain.test.ts              # 痛苦检测测试
│   └── ...
└── ...
```

**测试工具**:
```typescript
import { createTestContext } from '../test-utils.js';

const ctx = createTestContext({
  workspaceDir: '/tmp/test-workspace',
  stateDir: '/tmp/test-workspace/.state'
});
```

---

## 📦 构建和部署

**构建命令**:
```bash
npm run build              # TypeScript 编译
npm run build:web          # 构建 React Web UI
npm run build:bundle       # esbuild 打包 + Web UI
npm run build:production   # 完整生产构建
npm test                   # 运行 Vitest 测试
```

**TypeScript 配置**:
- 目标: ES2022
- 模块: ESNext
- 严格模式: 启用
- 输出目录: `./dist`

**包分发**:
```json
{
  "name": "principles-disciple",
  "version": "1.7.1",
  "openclaw": {
    "id": "principles-disciple",
    "name": "Principles Disciple",
    "extensions": ["./dist/index.js"]
  }
}
```

---

## 🔗 相关文档

- [OpenClaw 兼容性地图](./openclaw-compatibility-map.md) - OpenClaw 框架集成点
- [双轨门禁架构](./trust-gate-architecture.md) - 信任+进化双轨系统详解
- [全景架构图](./principles-disciple-panorama-zh.md) - 产品视角的架构概览

---

**文档版本**: v1.0
**最后更新**: 2026-03-21
**维护者**: Principles Disciple Team
