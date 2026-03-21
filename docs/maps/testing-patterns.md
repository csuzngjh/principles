# 测试模式 (Testing Patterns)

> **用途**: 定义系统中的测试模式
> **目标用户**: AI 编程智能体
> **最后更新**: 2026-03-21
> **⚠️ 验证状态**: ✅ 已验证 - 与源代码一致

---

## 🧪 1. 测试上下文创建

**源码**: `tests/test-utils.ts`

```typescript
import { createTestContext } from '../test-utils.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

// 创建测试上下文
const wctx = createTestContext({
  workspaceDir: '/tmp/test-workspace',
  stateDir: '/tmp/test-workspace/.state'
});

// wctx 是 WorkspaceContext 实例
expect(wctx).toBeInstanceOf(WorkspaceContext);
```

**⚠️ 重要**:
- `createTestContext()` 返回 `WorkspaceContext`，不是 `TestContext`
- 没有 `cleanup()` 方法
- 使用 `WorkspaceContext.fromHookContext()` 内部实现

---

## 🔌 2. 钩子测试模式

**源码**: `tests/hooks/gate.test.ts`, `tests/hooks/pain.test.ts`

```typescript
import { vi } from 'vitest';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

// Mock WorkspaceContext
vi.mock('../../src/core/workspace-context.js');

const mockWctx = {
  workspaceDir: '/tmp/test',
  stateDir: '/tmp/test/.state',
  trust: { getScore: () => 85, getStage: () => 4 },
  config: { get: (key: string) => /* mock value */ },
  eventLog: { recordGateBlock: vi.fn() }
};

beforeEach(() => {
  vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
});
```

**⚠️ 重要**:
- 使用 `vi.mock()` 隔离 `WorkspaceContext`
- 事件使用 `params` 不是 `parameters`
- 结果使用 `result.block` 不是 `result.blocked`

---

## 🔧 3. 服务测试模式

**源码**: `tests/service/evolution-worker.test.ts`

```typescript
import { EvolutionWorkerService } from '../../src/service/evolution-worker.js';

// 使用静态方法
EvolutionWorkerService.start(ctx as any);
// ...
EvolutionWorkerService.stop(ctx as any);
```

**⚠️ 重要**:
- 使用静态方法 `EvolutionWorkerService.start()` 不是实例方法
- 没有 `service.poll()` 方法

---

## 🔗 相关源码文件

| 文件 | 关键内容 | 用途 |
|------|----------|------|
| `tests/test-utils.ts` | `createTestContext()` | 测试上下文创建 |
| `tests/hooks/gate.test.ts` | 门禁测试示例 | 钩子测试 |
| `tests/hooks/pain.test.ts` | 痛苦测试示例 | 钩子测试 |
| `tests/service/evolution-worker.test.ts` | 服务测试示例 | 服务测试 |

---

**文档版本**: v2.0
**最后更新**: 2026-03-21
**验证状态**: ✅ 已与源代码验证一致
