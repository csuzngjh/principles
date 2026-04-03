# Testing Patterns

**Analysis Date:** 2026-04-02

## Framework

**Runner:**
- Vitest `^4.1.0` (NOT Jest)
- Config: `packages/openclaw-plugin/vitest.config.ts`

**Assertion Library:**
- Vitest 内置 `expect`（兼容 Jest API）

**Coverage:**
- Provider: `@vitest/coverage-v8` `^4.1.0`
- Reporter: `text`, `html`
- Exclude: `tests/**`

**Run Commands:**
```bash
# 从 packages/openclaw-plugin/ 目录运行
cd packages/openclaw-plugin
npm test                       # 运行所有测试 (vitest run)
npx vitest                     # 等效命令
npx vitest --watch             # 监听模式
npx vitest --coverage          # 生成覆盖率报告
npx vitest tests/core/pain.test.ts  # 运行单个测试文件
```

**Vitest 配置要点** (`packages/openclaw-plugin/vitest.config.ts`):
- `environment: 'node'` — 默认 Node.js 环境
- `pool: 'forks'` — 每个测试文件在独立进程中运行（隔离）
- `teardownTimeout: 15000` — 测试完成后进程退出超时
- `include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx']` — 测试文件匹配模式

**注意：** UI 测试使用 jsdom 环境，通过文件内指令 `// @vitest-environment jsdom` 切换，而非全局配置。

## Test File Organization

**Location:**
- 测试文件与源码分离，集中在 `packages/openclaw-plugin/tests/` 目录
- 测试目录结构与 `src/` 完全镜像

**Naming:**
- 单元测试: `*.test.ts` — 绝大多数测试文件
- 集成测试: `*.integration.test.ts` — 如 `tests/index.integration.test.ts`
- 端到端测试: `*.e2e.test.ts` — 如 `tests/core/evolution-e2e.test.ts`
- React 组件测试: `*.test.tsx` — 如 `tests/ui/app.test.tsx`
- 构建验证测试: `tests/build-artifacts.test.ts` — 检查生产构建产物

**Structure:**
```
packages/openclaw-plugin/tests/
├── core/                          # 对应 src/core/ — 核心域逻辑 (53 files)
│   ├── pain.test.ts               # Pain 信号评分
│   ├── evolution-engine.test.ts   # 进化引擎 (积分、等级)
│   ├── evolution-e2e.test.ts      # 进化循环端到端
│   ├── evolution-user-stories.e2e.test.ts
│   ├── evolution-engine-gate-integration.test.ts
│   ├── workspace-context.test.ts  # WorkspaceContext 门面
│   ├── trajectory.test.ts         # SQLite 轨迹数据库
│   ├── config.test.ts             # 配置系统
│   ├── dictionary.test.ts         # 规则字典
│   ├── nocturnal-*.test.ts        # 夜间训练系统 (~10 files)
│   └── ...                        # 迁移、检测、信任等
├── hooks/                         # 对应 src/hooks/ — 生命周期钩子 (17 files)
│   ├── gate.test.ts               # Progressive Gate 单元测试
│   ├── gate-pipeline-integration.test.ts  # Gate 管道集成
│   ├── gate-edit-verification.test.ts
│   ├── prompt.test.ts             # Prompt 注入钩子
│   ├── pain.test.ts               # Pain 钩子
│   ├── llm.test.ts                # LLM 输出钩子
│   ├── subagent.test.ts           # 子代理钩子
│   └── bash-risk*.test.ts         # Bash 风险检测
├── commands/                      # 对应 src/commands/ — 斜杠命令 (10 files)
│   ├── evolution-status.test.ts
│   ├── thinking-os.test.ts
│   ├── pain.test.ts
│   └── ...
├── service/                       # 对应 src/service/ — 后台服务 (9 files)
│   ├── evolution-worker.test.ts   # 进化轮询工作器
│   ├── nocturnal-runtime.test.ts  # 夜间训练运行时
│   └── ...
├── tools/                         # 对应 src/tools/ — 自定义工具 (3 files)
│   ├── deep-reflect.test.ts       # 深度反思工具
│   ├── critique-prompt.test.ts
│   └── model-index.test.ts
├── utils/                         # 对应 src/utils/ — 工具函数 (5 files)
│   ├── file-lock.test.ts          # 文件锁
│   ├── hashing.test.ts
│   ├── io.test.ts
│   ├── nlp.test.ts
│   └── plugin-logger.test.ts
├── ui/                            # 对应 ui/ — React Web UI (1 file)
│   └── app.test.tsx               # @vitest-environment jsdom
├── http/                          # 对应 src/http/ — HTTP 路由 (1 file)
│   └── principles-console-route.test.ts
├── fixtures/                      # 测试夹具和兼容性测试 (3 files)
│   ├── production-compatibility.test.ts  # 生产数据兼容性 (skipIf 无数据)
│   ├── production-mock-generator.ts      # 从生产数据生成 mock
│   └── nocturnal-reviewed-subset.json    # JSON 夹具
├── index.test.ts                  # 插件注册基础测试
├── index.integration.test.ts      # 插件集成测试（钩子注册验证）
├── index.shadow-routing.integration.test.ts
├── build-artifacts.test.ts        # 构建产物验证
├── task-compliance.test.ts        # 任务合规性测试
├── hygiene-tracker.test.ts        # 卫生跟踪器测试
├── test-utils.ts                  # 核心测试工具函数
└── README.md                      # 对话测试指南
```

**测试文件映射规则:**
- `tests/core/X.test.ts` → 测试 `src/core/X.ts`
- `tests/hooks/X.test.ts` → 测试 `src/hooks/X.ts`
- `tests/commands/X.test.ts` → 测试 `src/commands/X.ts`
- `tests/service/X.test.ts` → 测试 `src/service/X.ts`
- `tests/utils/X.test.ts` → 测试 `src/utils/X.ts`

## Test Structure

**Suite Organization:**
```typescript
// 标准单元测试模式（来自 tests/core/pain.test.ts）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs');  // 顶层 mock 外部依赖

describe('Pain Detection Module', () => {
  describe('computePainScore', () => {
    it('should compute score correctly', () => {
      expect(computePainScore(0, false, false, 0)).toBe(0);
    });
  });
});
```

**Setup/Teardown 模式:**
```typescript
// 带临时工作区的测试（来自 tests/core/evolution-engine.test.ts）
describe('EvolutionEngine', () => {
  let workspace: string;
  let engine: EvolutionEngine;

  beforeEach(() => {
    workspace = createTempWorkspace();  // os.tmpdir() + 随机后缀
    engine = new EvolutionEngine(workspace);
  });

  afterEach(() => {
    disposeAllEvolutionEngines();  // 清理单例缓存
    cleanupWorkspace(workspace);   // fs.rmSync(dir, { recursive: true, force: true })
  });
});
```

**使用 test-utils.ts 的模式:**
```typescript
// 来自 tests/test-utils.ts — createTestContext()
import { createTestContext, safeRmDir } from '../test-utils';

// createTestContext() 创建 WorkspaceContext：
// - 自动创建临时目录 (os.tmpdir() + 'pd-test-')
// - 清除 WorkspaceContext 缓存确保隔离
// - 返回完整的 WorkspaceContext 实例
const ctx = createTestContext();
// ctx.workspaceDir — 临时工作区路径
// ctx.stateDir — 状态目录
// ctx.config, ctx.eventLog, ctx.trust, ctx.trajectory — 懒加载服务

// safeRmDir() — 安全删除（忽略 Windows EPERM/ENOTEMPTY）
```

**嵌套 describe 分组:**
```typescript
// 按功能域分组（来自 tests/core/evolution-engine.test.ts）
describe('EvolutionEngine', () => {
  describe('Tier System', () => { /* 等级相关测试 */ });
  describe('Points Calculation', () => { /* 积分计算测试 */ });
  describe('Pain Penalty', () => { /* 失败惩罚测试 */ });
  describe('Streak Bonus', () => { /* 连胜奖励测试 */ });
});
```

## Mocking

**Framework:** Vitest 内置 `vi` mock API

**Patterns:**

**1. 模块级 Mock（最常见）:**
```typescript
// 在文件顶层 mock 整个模块
vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');
vi.mock('../../src/core/risk-calculator.js');
vi.mock('../../src/core/evolution-engine.js');
```

**2. 带工厂函数的 Mock:**
```typescript
// 自定义 mock 实现
vi.mock('../../src/core/trajectory.js', () => ({
    TrajectoryRegistry: {
        get: vi.fn(() => ({ dispose: vi.fn() })),
        use: vi.fn(),
        dispose: vi.fn(),
        clear: vi.fn(),
    }
}));
```

**3. 部分 Mock（保留实际实现 + 覆盖特定导出）:**
```typescript
// 来自 tests/hooks/gate-pipeline-integration.test.ts
vi.mock('../../src/core/evolution-engine.js', async () => {
  const actual = await vi.importActual('../../src/core/evolution-engine.js');
  return {
    ...actual,
    checkEvolutionGate: vi.fn(() => ({ allowed: true, currentTier: 'SEED' })),
    getEvolutionEngine: vi.fn(),
  };
});
```

**4. 构造复杂 Mock 对象:**
```typescript
// 来自 tests/hooks/gate.test.ts — 模拟完整的 WorkspaceContext 依赖
const mockWctx = {
  workspaceDir,
  stateDir: '/mock/state',
  trust: { getScore: vi.fn(), getStage: vi.fn(), getScorecard: vi.fn() },
  config: {
    get: vi.fn().mockImplementation((key) => {
      if (key === 'trust') return { limits: { stage_2_max_lines: 10 } };
      return undefined;
    })
  },
  eventLog: { recordGateBlock: vi.fn(), recordPlanApproval: vi.fn() },
  trajectory: { recordGateBlock: vi.fn() },
  resolve: vi.fn().mockImplementation((key) => { /* ... */ }),
};

vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
```

**5. Mock API 对象（插件接口）:**
```typescript
// 来自 tests/index.integration.test.ts — 模拟 OpenClaw Plugin API
mockApi = {
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  pluginConfig: { language: 'en' },
  resolvePath: vi.fn((p: string) => `/resolved/${p}`),
  on: vi.fn((hookName, handler) => { registeredHooks.set(hookName, handler); }),
  registerService: vi.fn(),
  registerCommand: vi.fn(),
  registerHttpRoute: vi.fn(),
  registerTool: vi.fn(),
};
```

**6. 时间 Mock:**
```typescript
// 来自 tests/service/evolution-worker.test.ts
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

// 设置特定时间（来自 tests/service/nocturnal-runtime.test.ts）
vi.setSystemTime(new Date('2026-03-27T12:00:00.000Z'));
```

**What to Mock:**
- `fs` — 文件系统操作（最常被 mock 的模块）
- `WorkspaceContext` — 使用 `vi.mock` + `mockReturnValue` 注入 mock 依赖
- 外部服务模块（`evolution-engine`, `risk-calculator`, `session-tracker` 等）
- `TrajectoryRegistry` — SQLite 数据库交互

**What NOT to Mock:**
- 纯计算函数（如 `computePainScore`, `painSeverityLabel`）
- EvolutionReducer 的 `emitSync` / `createPrincipleFromDiagnosis` 等核心逻辑
- TrajectoryDatabase — 在 E2E 测试中使用真实 SQLite（临时目录）
- 文件锁 — 使用真实临时文件

## Fixtures and Test Data

**Test Data Patterns:**

**1. 临时工作区模式（最主要）:**
```typescript
// 大多数测试创建临时目录作为隔离的工作区
function createTempWorkspace(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-'));
  const stateDir = path.join(tmpDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  return tmpDir;
}
```

**2. JSON Fixture 文件:**
- `tests/fixtures/nocturnal-reviewed-subset.json` — 预审数据子集

**3. 生产数据兼容性测试:**
- `tests/fixtures/production-mock-generator.ts` — 从生产数据提取模式生成 mock
- `tests/fixtures/production-compatibility.test.ts` — 验证新代码与生产数据兼容
- 使用 `describe.skipIf(!hasProductionData)` 条件跳过（无生产数据时）

**4. HTTP 测试辅助:**
```typescript
// 来自 tests/http/principles-console-route.test.ts
class MockResponse extends EventEmitter {
  statusCode = 200;
  headers = new Map<string, string>();
  body = '';
  setHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value); }
  end(chunk?: Buffer | string) { /* ... */ }
}

function createRequest(method: string, url: string, body?: string): IncomingMessage {
  // 构造模拟 HTTP 请求
}
```

**5. React 测试辅助:**
```typescript
// 来自 tests/ui/app.test.tsx
// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value; },
    // ...
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock fetch
vi.stubGlobal('fetch', vi.fn((input) => {
  return Promise.resolve(new Response(JSON.stringify({ ... }), { status: 200 }));
}));
```

## Coverage

**Requirements:** 无强制覆盖率阈值

**Configuration** (`packages/openclaw-plugin/vitest.config.ts`):
```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'html'],
  exclude: ['tests/**']
}
```

**View Coverage:**
```bash
cd packages/openclaw-plugin
npx vitest --coverage
# HTML 报告生成在 coverage/ 目录
```

## Test Types

**Unit Tests (绝大多数):**
- 纯函数测试: 直接调用函数验证返回值（如 `tests/core/pain.test.ts`）
- Mock 隔离测试: mock 外部依赖后测试单元逻辑（如 `tests/hooks/gate.test.ts`）
- 临时文件系统测试: 使用真实 `fs` + 临时目录（如 `tests/utils/file-lock.test.ts`）
- 范围: 单个函数/类/模块

**Integration Tests:**
- 标识: `*.integration.test.ts` 后缀
- 示例:
  - `tests/index.integration.test.ts` — 验证插件注册所有钩子、命令、服务、路由
  - `tests/index.shadow-routing.integration.test.ts` — Shadow 路由集成
  - `tests/hooks/gate-pipeline-integration.test.ts` — Gate 管道完整流程
  - `tests/core/evolution-engine-gate-integration.test.ts` — 进化引擎与 Gate 集成
  - `tests/core/phase7-rollout-integration.test.ts` — Phase 7 部署集成

**E2E Tests (Vitest 内):**
- 标识: `*.e2e.test.ts` 后缀
- 示例:
  - `tests/core/evolution-e2e.test.ts` — 完整 pain → principle → status → rollback 流程
  - `tests/core/evolution-user-stories.e2e.test.ts` — 用户故事端到端

**E2E Tests (项目根目录):**
- 位置: `tests/` 根目录（非 `packages/openclaw-plugin/tests/`）
- 类型: Shell 脚本驱动的真实环境测试
- 示例: `tests/e2e-conversation-test.sh`, `tests/e2e-loop-test.sh`
- 需要 OpenClaw Gateway 运行
- 参考: `tests/TESTING_GUIDE.md`

**UI Tests:**
- 使用 `@testing-library/react`
- jsdom 环境（文件内 `// @vitest-environment jsdom` 指令）
- 示例: `tests/ui/app.test.tsx` — Principles Console Web UI

## Common Patterns

**Async Testing:**
```typescript
// 标准异步测试
it('should handle async operations', async () => {
  const result = await someAsyncFunction();
  expect(result).toBeDefined();
});

// 配合 waitFor（React 测试）
await waitFor(() => {
  expect(screen.getByText('Principles Console')).toBeTruthy();
});
```

**Error Testing:**
```typescript
// 验证错误被正确记录
expect(result).toBeDefined();
expect(result?.block).toBe(true);
expect(result?.blockReason).toContain('risk path');

// 验证不抛出异常
expect(() => wctx.invalidate()).not.toThrow();
```

**Conditional Tests:**
```typescript
// 条件跳过（无生产数据时）
const hasProductionData = fs.existsSync(PRODUCTION_FIXTURES.STATE_DIR);
describe.skipIf(!hasProductionData)('Production Data Compatibility', () => { /* ... */ });

// 条件通过（无构建产物时）
const isProductionBuild = existsSync(join(packageRoot, 'dist'));
it('should include dist/bundle.js', () => {
  if (!isProductionBuild) return; // 静默通过
  // ...
});
```

**Singleton Cleanup:**
```typescript
// 清除 WorkspaceContext 单例缓存（确保测试隔离）
WorkspaceContext.clearCache();

// 清除 EvolutionEngine 单例
disposeAllEvolutionEngines();
```

## CI Integration

**CI 工作流:** `.github/workflows/ci.yml`

**Pipeline 结构:**
```
lint → test → build-openclaw-plugin → test-openclaw-plugin
```

**test job:**
- 触发: push to `main`/`develop`, PR to `main`
- 矩阵: Node.js 18, 20, 22
- 命令: `npm test --if-present`（从根目录）

**build-openclaw-plugin job:**
- 依赖: test job 通过
- Node.js 20
- 步骤: `npm install` → `npm run build` → `tsc --noEmit` → `npm run build:production`
- 工作目录: `packages/openclaw-plugin`

**test-openclaw-plugin job:**
- 依赖: build-openclaw-plugin job 通过
- Node.js 20
- 命令: `npm test`（从 `packages/openclaw-plugin`）
- 这是专门的插件测试，确保构建后的代码能通过测试

**PR Checks:** `.github/workflows/pr-checks.yml`
- 自动标签、PR 大小检查、首次贡献者欢迎

## Known Issues

**跳过的测试:**
- `tests/fixtures/production-compatibility.test.ts` — 使用 `describe.skipIf(!hasProductionData)`，仅在检测到生产数据（`~/.openclaw/`）时运行。CI 环境中通常跳过。这不是 bug，是设计如此。

**条件通过的测试:**
- `tests/build-artifacts.test.ts` — 未构建时 (`dist/` 不存在) 所有测试静默通过。需先运行 `npm run build:production` 才能真正验证。

**E2E 测试需要外部依赖:**
- 根目录 `tests/` 下的 Shell 脚本测试需要 OpenClaw Gateway 运行
- 不在 CI 中自动运行

**没有 `.skip()` 或 `.todo()` 测试:**
- 代码库中未发现 `it.skip()`、`describe.skip()`、`it.todo()` 等标记
- 所有测试均正常运行

**Windows 兼容性:**
- `test-utils.ts` 中的 `safeRmDir()` 专门处理 Windows EPERM/ENOTEMPTY 错误
- 部分测试使用 `path.resolve()` 确保跨平台路径兼容

---

*Testing analysis: 2026-04-02*
