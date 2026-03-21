# 常见代码模式 (Common Code Patterns)

> **用途**: 定义系统中的标准代码模式
> **目标用户**: AI 编程智能体
> **最后更新**: 2026-03-21
> **⚠️ 验证状态**: ✅ 已验证 - 与源代码一致

---

## 🏭 1. 单例工厂模式

**源码**: `src/core/config-service.ts`

```typescript
let config: PainConfig | null = null;
let lastStateDir: string | null = null;

export const ConfigService = {
  get(stateDir: string): PainConfig {
    if (!config || lastStateDir !== stateDir) {
      config = new PainConfig(stateDir);
      config.load();
      lastStateDir = stateDir;
    }
    return config;
  },

  reset(): void {
    config = null;
  }
};
```

**使用**:
```typescript
import { ConfigService } from '../core/config-service.js';

const config = ConfigService.get(stateDir);
const painThreshold = config.get('thresholds.pain_trigger');
```

---

## 🏛️ 2. WorkspaceContext门面模式

**源码**: `src/core/workspace-context.ts`

```typescript
export class WorkspaceContext {
  private static instances = new Map<string, WorkspaceContext>();

  static fromHookContext(ctx: any): WorkspaceContext {
    const workspaceDir = ctx.workspaceDir || this.pathResolver.getWorkspaceDir();
    // ...
    return WorkspaceContext.instances.get(workspaceDir)!;
  }

  get config(): PainConfig {
    return ConfigService.get(this.stateDir);
  }

  get trust(): TrustEngine {
    return new TrustEngine(this.workspaceDir);
  }

  get evolutionReducer(): EvolutionReducerImpl {
    // 返回 EvolutionReducerImpl 实例
  }
}
```

**⚠️ 重要**: 
- 使用 `evolutionReducer` 不是 `evolution`
- 使用 `new TrustEngine()` 不是 `getTrustEngine()`

---

## 🔒 3. 文件锁模式

**源码**: `src/utils/file-lock.ts`

```typescript
import { acquireLockAsync, releaseLock, type LockContext } from '../utils/file-lock.js';

// 获取锁
const ctx: LockContext = await acquireLockAsync(resourcePath, {
  lockSuffix: '.lock',
  maxRetries: 50,
  baseRetryDelayMs: 10,
  lockStaleMs: 10000,
});

// 释放锁
releaseLock(ctx);
```

**⚠️ 重要**:
- `LockContext` 包含 `{lockPath, pid, acquiredAt}` 不是 `{lockPath, cleanup}`
- 使用 `releaseLock(ctx)` 不是 `ctx.cleanup()`
- 默认 `lockStaleMs` 是 10000 (10秒) 不是 30000

---

## 💾 4. 缓冲写入模式

**源码**: `src/core/event-log.ts`

```typescript
import { EventLogService } from '../core/event-log.js';

// 获取 EventLog 实例
const eventLog = EventLogService.get(stateDir);

// 使用类型化方法记录
eventLog.recordToolCall(sessionId, { toolName, success, exitCode });
eventLog.recordPainSignal(sessionId, { score, source, reason });
```

**⚠️ 重要**:
- 使用 `EventLogService.get(stateDir)` 不是直接 `new EventLog()`
- 使用 `recordToolCall()`, `recordPainSignal()` 等类型化方法

---

## 📝 5. 配置点号路径访问

**源码**: `src/core/config.ts`

```typescript
const config = ConfigService.get(stateDir);

// 点号路径访问
const painThreshold = config.get<number>('thresholds.pain_trigger');
const trustStages = config.get('trust.stages');

// 获取完整配置
const allSettings = config.getAll();
```

---

## 🔗 相关源码文件

| 文件 | 关键内容 | 用途 |
|------|----------|------|
| `src/core/config-service.ts` | ConfigService 单例 | 配置管理 |
| `src/core/workspace-context.ts` | WorkspaceContext 门面 | 服务访问 |
| `src/utils/file-lock.ts` | acquireLockAsync, releaseLock | 文件锁 |
| `src/core/event-log.ts` | EventLogService, record*() | 事件日志 |
| `src/core/config.ts` | PainConfig.get() | 配置访问 |

---

**文档版本**: v2.0
**最后更新**: 2026-03-21
**验证状态**: ✅ 已与源代码验证一致
