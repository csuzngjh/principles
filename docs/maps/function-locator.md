# 函数定位快速参考

> **用途**: 快速找到需要修改的函数和文件
> **目标用户**: AI 编程智能体
> **最后更新**: 2026-03-21

---

## 🎯 按任务类型查找

### 信任和权限相关

| 任务 | 文件 | 函数 | 说明 |
|------|------|------|------|
| 修改信任分数计算 | `src/core/trust-engine.ts` | `recordSuccess()`, `recordFailure()` | 成功/失败时的分数变化 |
| 修改信任阶段阈值 | `src/core/config.ts` | `TrustSettings` 接口 | 阶段边界值配置 |
| 添加新的权限检查 | `src/hooks/gate.ts` | `handleBeforeToolCall()` | 门禁主函数 |
| 查看当前信任状态 | `src/commands/trust.ts` | `handleTrustCommand()` | /pd-trust 命令 |

### 进化系统相关

| 任务 | 文件 | 函数 | 说明 |
|------|------|------|------|
| 修改积分计算 | `src/core/evolution-engine.ts` | `recordSuccess()`, `recordFailure()` | 积分增减逻辑 |
| 修改等级阈值 | `src/core/evolution-types.ts` | `TIER_DEFINITIONS` 常量 | 5级定义 |
| 添加新的进化规则 | `src/core/evolution-reducer.ts` | `emit()` | 事件溯源入口 |
| 查看进化状态 | `src/commands/evolution-status.ts` | `handleEvolutionStatusCommand()` | /pd-evolution-status 命令 |
| 处理进化队列 | `src/service/evolution-worker.ts` | `processEvolutionQueue()` | 后台处理 |

### 痛苦检测相关

| 任务 | 文件 | 函数 | 说明 |
|------|------|------|------|
| 添加痛苦检测规则 | `src/core/dictionary.ts` | `addRule()` | 添加新规则 |
| 修改检测逻辑 | `src/core/detection-funnel.ts` | `detect()` | L1/L2/L3 检测 |
| 计算痛苦分数 | `src/core/pain.ts` | `computePainScore()` | 分数计算 |
| 写入痛苦标志 | `src/core/pain.ts` | `writePainFlag()` | 写入 .pain_flag |
| 读取痛苦数据 | `src/core/pain.ts` | `readPainFlagData()` | 读取痛苦数据 |
| 查看痛苦状态 | `src/commands/pain.ts` | `handlePainCommand()` | /pd-status 命令 |

### 钩子相关

| 任务 | 文件 | 函数 | 说明 |
|------|------|------|------|
| 修改上下文注入 | `src/hooks/prompt.ts` | `handleBeforePromptBuild()` | 8层上下文注入 |
| 修改门禁逻辑 | `src/hooks/gate.ts` | `handleBeforeToolCall()` | 5阶段安全检查 |
| 修改痛苦检测 | `src/hooks/pain.ts` | `handleAfterToolCall()` | 失败检测和信任更新 |
| 修改LLM分析 | `src/hooks/llm.ts` | `handleLlmOutput()` | 共情信号检测 |
| 修改会话生命周期 | `src/hooks/lifecycle.ts` | `handleBeforeReset()`, `handleBeforeCompaction()`, `handleAfterCompaction()` | 会话管理 |
| 修改消息清理 | `src/hooks/message-sanitize.ts` | `handleBeforeMessageWrite()` | 敏感数据清理 |

### 命令相关

| 任务 | 文件 | 函数 | 说明 |
|------|------|------|------|
| 修改初始化命令 | `src/commands/strategy.ts` | `handleInitStrategy()` | /pd-init |
| 修改OKR命令 | `src/commands/strategy.ts` | `handleManageOkr()` | /pd-okr |
| 修改思维模型命令 | `src/commands/thinking-os.ts` | `handleThinkingOs()` | /pd-thinking |
| 修改进化命令 | `src/commands/evolver.ts` | `handleEvolveTask()` | /pd-evolve |
| 修改导出命令 | `src/commands/export.ts` | `handleExportCommand()` | /pd-export |
| 修改样本命令 | `src/commands/samples.ts` | `handleSamplesCommand()` | /pd-samples |

### 工具相关

| 任务 | 文件 | 函数 | 说明 |
|------|------|------|------|
| 修改深度反思工具 | `src/tools/deep-reflect.ts` | `createDeepReflectTool()` | deep_reflect 工具 |
| 修改智能体生成工具 | `src/tools/agent-spawn.ts` | `createAgentSpawnTool()` | pd_run_worker 工具 |
| 添加新的自定义工具 | `src/tools/` 目录 | 创建新文件 | 工具工厂模式 |

### 服务相关

| 任务 | 文件 | 函数 | 说明 |
|------|------|------|------|
| 修改进化工作器 | `src/service/evolution-worker.ts` | `EvolutionWorkerService.start()` | 后台轮询 |
| 修改轨迹服务 | `src/service/trajectory-service.ts` | `TrajectoryService.start()` | SQLite 生命周期 |
| 添加新的后台服务 | `src/service/` 目录 | 创建新文件 | 服务接口模式 |

### 配置相关

| 任务 | 文件 | 函数 | 说明 |
|------|------|------|------|
| 添加新的配置项 | `src/core/config.ts` | `PainSettings` 接口 | 主配置接口 |
| 修改默认值 | `src/core/config.ts` | `DEFAULT_SETTINGS` 常量 | 默认配置 |
| 读取配置 | `src/core/config-service.ts` | `ConfigService.get()` | 单例工厂 |
| 访问配置 | `src/core/config.ts` | `PainConfig.get()` | 点号路径访问 |

### 数据存储相关

| 任务 | 文件 | 函数 | 说明 |
|------|------|------|------|
| 修改事件日志 | `src/core/event-log.ts` | `EventLog` 类 | JSONL 缓冲写入 |
| 修改轨迹数据库 | `src/core/trajectory.ts` | `TrajectoryDatabase` 类 | SQLite 操作 |
| 修改会话追踪 | `src/core/session-tracker.ts` | `trackFriction()`, `resetFriction()` | GFI 追踪 |
| 修改文件锁 | `src/utils/file-lock.ts` | `withLock()`, `withLockAsync()` | 并发控制 |

---

## 🔍 按关键词查找

### "trust" - 信任相关

| 文件 | 函数 | 说明 |
|------|------|------|
| `src/core/trust-engine.ts` | `TrustEngine` 类 | 信任引擎核心 |
| `src/core/trust-engine.ts` | `recordSuccess()`, `recordFailure()` | 便捷函数 |
| `src/hooks/gate.ts` | `handleBeforeToolCall()` | 信任检查 |
| `src/commands/trust.ts` | `handleTrustCommand()` | 信任状态命令 |

### "evolution" - 进化相关

| 文件 | 函数 | 说明 |
|------|------|------|
| `src/core/evolution-engine.ts` | `EvolutionEngine` 类 | 进化引擎核心 |
| `src/core/evolution-engine.ts` | `getEvolutionEngine()` | 实例获取 |
| `src/core/evolution-reducer.ts` | `EvolutionReducerImpl` 类 | 事件溯源 |
| `src/service/evolution-worker.ts` | `EvolutionWorkerService` 类 | 后台工作器 |

### "pain" - 痛苦相关

| 文件 | 函数 | 说明 |
|------|------|------|
| `src/core/pain.ts` | `computePainScore()` | 分数计算 |
| `src/core/pain.ts` | `writePainFlag()`, `readPainFlagData()` | 文件 I/O |
| `src/hooks/pain.ts` | `handleAfterToolCall()` | 痛苦检测钩子 |
| `src/commands/pain.ts` | `handlePainCommand()` | 状态命令 |

### "gate" - 门禁相关

| 文件 | 函数 | 说明 |
|------|------|------|
| `src/hooks/gate.ts` | `handleBeforeToolCall()` | 门禁主函数 |
| `src/core/risk-calculator.ts` | `assessRiskLevel()`, `estimateLineChanges()` | 风险评估 |
| `src/constants/tools.ts` | 工具分类常量 | 工具风险分类 |

### "prompt" - 提示相关

| 文件 | 函数 | 说明 |
|------|------|------|
| `src/hooks/prompt.ts` | `handleBeforePromptBuild()` | 上下文注入 |
| `src/core/thinking-models.ts` | `detectThinkingModelMatches()` | 思维模型检测 |
| `src/tools/deep-reflect.ts` | `createDeepReflectTool()` | 深度反思工具 |

### "trajectory" - 轨迹相关

| 文件 | 函数 | 说明 |
|------|------|------|
| `src/core/trajectory.ts` | `TrajectoryDatabase` 类 | SQLite 数据库 |
| `src/core/trajectory.ts` | `TrajectoryRegistry` 类 | 实例管理 |
| `src/service/trajectory-service.ts` | `TrajectoryService` 类 | 生命周期服务 |
| `src/hooks/trajectory-collector.ts` | `handleAfterToolCall()`, `handleLlmOutput()` | 数据收集 |

### "config" - 配置相关

| 文件 | 函数 | 说明 |
|------|------|------|
| `src/core/config.ts` | `PainConfig` 类 | 配置管理器 |
| `src/core/config.ts` | `PainSettings` 接口 | 配置接口 |
| `src/core/config-service.ts` | `ConfigService` 对象 | 单例工厂 |

### "workspace" - 工作区相关

| 文件 | 函数 | 说明 |
|------|------|------|
| `src/core/workspace-context.ts` | `WorkspaceContext` 类 | 中央门面 |
| `src/core/paths.ts` | `PD_FILES`, `PD_DIRS` 常量 | 路径定义 |
| `src/core/path-resolver.ts` | `PathResolver` 类 | 路径解析 |
| `src/core/init.ts` | `ensureWorkspaceTemplates()` | 工作区初始化 |

---

## 📊 按文件类型查找

### 核心业务逻辑 (`src/core/`)

| 文件 | 主要导出 | 用途 |
|------|----------|------|
| `trust-engine.ts` | `TrustEngine`, `recordSuccess()`, `recordFailure()` | 信任评分 |
| `evolution-engine.ts` | `EvolutionEngine`, `getEvolutionEngine()` | 进化积分 |
| `evolution-reducer.ts` | `EvolutionReducerImpl` | 事件溯源 |
| `evolution-types.ts` | `EvolutionTier`, `TierDefinition`, `Principle` | 类型定义 |
| `pain.ts` | `computePainScore()`, `writePainFlag()` | 痛苦计算 |
| `config.ts` | `PainConfig`, `PainSettings` | 配置管理 |
| `event-log.ts` | `EventLog`, `EventLogService` | 事件日志 |
| `trajectory.ts` | `TrajectoryDatabase`, `TrajectoryRegistry` | 轨迹数据库 |
| `session-tracker.ts` | `trackFriction()`, `resetFriction()` | 会话追踪 |
| `workspace-context.ts` | `WorkspaceContext` | 中央门面 |
| `dictionary.ts` | `PainDictionary` | 痛苦模式字典 |
| `detection-funnel.ts` | `DetectionFunnel` | 检测漏斗 |

### 钩子 (`src/hooks/`)

| 文件 | 主要导出 | 用途 |
|------|----------|------|
| `prompt.ts` | `handleBeforePromptBuild()` | 上下文注入 |
| `gate.ts` | `handleBeforeToolCall()` | 安全门禁 |
| `pain.ts` | `handleAfterToolCall()` | 痛苦检测 |
| `llm.ts` | `handleLlmOutput()` | LLM 分析 |
| `lifecycle.ts` | `handleBeforeReset()`, `handleBeforeCompaction()`, `handleAfterCompaction()` | 会话生命周期 |
| `subagent.ts` | `handleSubagentEnded()` | 子智能体管理 |
| `message-sanitize.ts` | `handleBeforeMessageWrite()` | 消息清理 |
| `trajectory-collector.ts` | `handleAfterToolCall()`, `handleLlmOutput()` | 轨迹收集 |

### 命令 (`src/commands/`)

| 文件 | 主要导出 | 用途 |
|------|----------|------|
| `strategy.ts` | `handleInitStrategy()`, `handleManageOkr()` | /pd-init, /pd-okr |
| `capabilities.ts` | `handleBootstrapTools()`, `handleResearchTools()` | /pd-bootstrap, /pd-research |
| `thinking-os.ts` | `handleThinkingOs()` | /pd-thinking |
| `evolver.ts` | `handleEvolveTask()` | /pd-evolve |
| `trust.ts` | `handleTrustCommand()` | /pd-trust |
| `pain.ts` | `handlePainCommand()` | /pd-status |
| `context.ts` | `handleContextCommand()` | /pd-context |
| `focus.ts` | `handleFocusCommand()` | /pd-focus |
| `rollback.ts` | `handleRollbackCommand()` | /pd-rollback |
| `evolution-status.ts` | `handleEvolutionStatusCommand()` | /pd-evolution-status |
| `principle-rollback.ts` | `handlePrincipleRollbackCommand()` | /pd-principle-rollback |
| `export.ts` | `handleExportCommand()` | /pd-export |
| `samples.ts` | `handleSamplesCommand()` | /pd-samples |

### 服务 (`src/service/`)

| 文件 | 主要导出 | 用途 |
|------|----------|------|
| `evolution-worker.ts` | `EvolutionWorkerService` | 进化工作器 |
| `trajectory-service.ts` | `TrajectoryService` | 轨迹服务 |
| `control-ui-query-service.ts` | `ControlUiQueryService` | 控制台查询 |
| `runtime-summary-service.ts` | `RuntimeSummaryService` | 运行时摘要 |
| `empathy-observer-manager.ts` | `EmpathyObserverManager` | 共情观察者 |

### 工具 (`src/tools/`)

| 文件 | 主要导出 | 用途 |
|------|----------|------|
| `deep-reflect.ts` | `createDeepReflectTool()` | deep_reflect 工具 |
| `agent-spawn.ts` | `createAgentSpawnTool()`, `spawnAgentSequence()` | pd_run_worker 工具 |
| `critique-prompt.ts` | 批判提示模板 | 深度反思 |
| `model-index.ts` | 思维模型索引 | 模型管理 |

### 工具函数 (`src/utils/`)

| 文件 | 主要导出 | 用途 |
|------|----------|------|
| `file-lock.ts` | `withLock()`, `withLockAsync()`, `acquireLock()` | 文件锁 |
| `io.ts` | `isRisky()`, `normalizePath()`, `serializeKvLines()` | 文件 I/O |
| `hashing.ts` | `computeHash()`, `denoiseError()` | 哈希工具 |
| `glob-match.ts` | `matchesAnyPattern()` | Glob 匹配 |
| `nlp.ts` | `extractCommonSubstring()` | NLP 工具 |
| `plugin-logger.ts` | 插件日志 | 日志工具 |

---

## 🚀 常用代码模式

### 访问工作区上下文

```typescript
import { WorkspaceContext } from '../core/workspace-context.js';

// 在钩子中（唯一的合规入口）
const wctx = WorkspaceContext.fromHookContext(ctx);

// 访问服务
const trustScore = wctx.trust.getScore();
const evolutionTier = wctx.evolution.getTier();
const config = wctx.config;
const eventLog = wctx.eventLog;
const trajectory = wctx.trajectory;
```

### 读取配置

```typescript
import { ConfigService } from '../core/config-service.js';

const config = ConfigService.get(stateDir);
const painThreshold = config.get('thresholds.pain_trigger');
const trustStages = config.get('trust.stages');
const allSettings = config.getAll();
```

### 写入事件日志

```typescript
import { EventLogService } from '../core/event-log.js';

const eventLog = EventLogService.get(stateDir);
eventLog.recordGateBlock(sessionId, { toolName, filePath, reason });
eventLog.recordPainSignal(sessionId, { score, source, reason });
eventLog.recordTrustChange(sessionId, { oldScore, newScore, reason });
eventLog.recordEvolutionTask(sessionId, { taskId, status });
```

### 使用文件锁

```typescript
import { withLock, withLockAsync } from '../utils/file-lock.js';

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

### 注册钩子

```typescript
// 在 src/index.ts 中
api.on('before_tool_call', (event, ctx) => {
  const workspaceDir = ctx.workspaceDir || api.resolvePath('.');
  return handleBeforeToolCall(event, { ...ctx, workspaceDir, pluginConfig, logger });
});
```

### 注册命令

```typescript
// 在 src/index.ts 中
api.registerCommand({
  name: "pd-my-command",
  description: "My command description",
  handler: (ctx) => handleMyCommand(ctx)
});
```

### 注册工具

```typescript
// 在 src/index.ts 中
api.registerTool(createMyTool(api));
```

### 注册服务

```typescript
// 在 src/index.ts 中
api.registerService(MyService);
```

---

## 🔗 相关文档

- [开发者文件索引](./developer-file-index.md) - 完整的文件目录和导出列表
- [OpenClaw 兼容性地图](./openclaw-compatibility-map.md) - OpenClaw 框架集成点
- [双轨门禁架构](./trust-gate-architecture.md) - 信任+进化双轨系统详解

---

**文档版本**: v1.0
**最后更新**: 2026-03-21
**维护者**: Principles Disciple Team
