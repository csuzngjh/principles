# PD BDD 规约层设计

> 文档版本：1.0
>
> 状态：Design ready for maintainer review，尚未批准实施
>
> 代码基线：feat-bdd-tdd-pd-project-j7lEfa@HEAD
>
> 适用范围：MVP-Core 用户旅程（后端切面 + 前端切面）+ CLI/Operator 命令契约
>
> 关联文档：[ADR-0014 MVP-First](../../adr/0014-mvp-first-strategy-and-product-pivot.md)、[PRODUCT_IDENTITY](../../product/PRODUCT_IDENTITY.md)、[TESTING](../../process/TESTING.md)、[AGENTS.md](../../../AGENTS.md)

## 0. 决策摘要

本设计在 PD 项目引入一层**可执行的行为规约**（BDD，Behavior-Driven Development），用 `.feature` 文件描述 Owner 可读的用户旅程契约，通过 `@cucumber/gherkin-utils` 解析后注册为 Vitest / Playwright 测试。

本次只推进 Phase 1（MVP-Core BDD 地基）：

- 引入 `@cucumber/gherkin-utils` 作为唯一新依赖（纯解析器，无运行时执行框架）；
- 在 `packages/principles-core/src/testing/` 实现 `gherkin-loader.ts` 与 `vitest-bdd.ts`（pure logic，~200 行）；
- 在 `packages/pd-console/tests/bdd/` 实现 `playwright-bdd.ts`（复用现有 `e2e-start.mjs`）；
- 在 `docs/specs/features/` 落地 3 个示范 `.feature` 文件，覆盖三个切面各一个：
  1. `story-a/owner-approve-prompt.feature`（后端，从 `story-a-acceptance.test.ts` 抽取）
  2. `story-a/owner-approve-prompt-ui.feature`（前端，从 `focus-approve-flow.spec.ts` 抽取）
  3. `cli/json-output.feature`（CLI，新建，对应 cli-1-strict-json）
- 配套 1 个 ADR 与 AGENTS.md / CLAUDE.md 工作流更新。

本次**不**推进：

- PRD 验收矩阵 8 项全部转 `.feature`（Phase 2，条件性）；
- Runtime Contract rc-1~rc-9 与 ERR 类回归场景（Phase 3，post-MVP）；
- `check:bdd-coverage` 静态检查（Phase 2）；
- Cucumber 报告/HTML 输出/scenario outline 矩阵化（Phase 3 可选）。

本设计**不**把 PD 变成 BDD 工具栈。`.feature` 是规约载体，不是新的执行框架；现有 200+ 单元测试、`verify:merge` 9 道门、Playwright e2e 启动逻辑全部不动。

## 1. 问题定义

### 1.1 当前问题

PD 当前测试体系存在三类痛点，BDD 是针对性解法：

**痛点 1：Owner 看不懂验收标准。**
PRD 验收矩阵以注释形式散落在 [story-a-acceptance.test.ts](../../../packages/principles-core/src/runtime-v2/activation/__tests__/story-a-acceptance.test.ts) 第 17-26 行（"owner reject: does not activate" 等 8 项）。Owner 无法独立审阅这些标准，"做完"的定义事实上由开发者解释。

**痛点 2：AI 助手跨 session 反复犯同类错误。**
Error Handbook 中 ERR-001/005/007（as bypass validation）、ERR-015/018/019（stale loop state）等高频复现类，根因是 AI 助手没有"不可破坏的行为契约"作为护栏。Runtime Contract rc-1~rc-9 是评审检查表，不是可执行场景。

**痛点 3：发版时"实现绿但旅程断"。**
200+ 单元测试都是细节级，唯一端到端的 `story-a-acceptance.test.ts` 是命令式 `test.describe` + `test('步骤1...')`，重构时容易"绿了单元、断了旅程"。

### 1.2 决策问题

是否值得在 MVP-First 阶段引入 BDD 规约层？

按 AGENTS.md 的 MVP 三问检验：

| MVP 问 | 回答 |
|--------|------|
| `mvp-q-1-what-if-skip` | 跳过会怎样？—— 30 天内会有人提。AI 助手反复犯 ERR-001/005/015 时，Owner 会问"为什么没有规约层防止"。Phase 1 直接缓解。 |
| `mvp-q-2-how-observed` | 如何观察 BDD 工作？—— `npm test` 输出里有 `✓ Scenario: owner approve prompt channel` 这种以 Owner 语言命名的测试。Owner 在 PR 检查时能直接读 `.feature`。 |
| `mvp-q-3-how-disabled` | 如何禁用？—— 删 `.feature` 文件或重命名为 `.feature.disabled`，step definitions 自动空跑。无需 feature flag。 |
| `mvp-q-4-emotional-value` | 情感价值？—— 降低失控感（Owner 看懂验收标准）、提升沉淀感（行为契约变成可读文档）。 |

四个问题都能回答，且答案直接对应 [PRODUCT_IDENTITY.md](../../product/PRODUCT_IDENTITY.md) 的"owner-governed, reversible"承诺。引入合规。

### 1.3 反模式自检

- ❌ `antipattern-future-extensibility`：Phase 2/3 是条件性，Phase 1 范围克制到 3 个示范 `.feature`，不为完整覆盖预留接口。
- ❌ `antipattern-completeness`：Phase 1 不追求"覆盖所有 PRD 矩阵"。
- ❌ `antipattern-prep-next-phase`：Phase 2 的 `check:bdd-coverage` 不在 Phase 1 实现，不留 hook。
- ❌ `antipattern-core-io`：`gherkin-loader.ts` 在 core 但纯 logic，通过 `architecture-regression.test.ts` 守卫。

## 2. 整体架构

### 2.1 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: 规约层 (.feature 文件) — Owner/PD/AI 共同可读      │
│  ─────────────────────────────────────────────────────────  │
│  docs/specs/features/                                       │
│    story-a/                                                 │
│      owner-approve-prompt.feature       (后端切面)          │
│      owner-approve-prompt-ui.feature    (前端切面)          │
│      owner-reject.feature               (Phase 2)           │
│      ...                                                    │
│    cli/                                                     │
│      json-output.feature                                    │
│      ...                                                    │
└─────────────────────────────────────────────────────────────┘
                          ↓ 解析
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: 解析层 (@cucumber/gherkin-utils 适配)              │
│  ─────────────────────────────────────────────────────────  │
│  packages/principles-core/src/testing/                      │
│    gherkin-loader.ts  — parseFeature() → ParsedScenario[]   │
│    vitest-bdd.ts      — defineFeature() 注册为 describe/it  │
│  packages/pd-console/tests/bdd/                             │
│    playwright-bdd.ts  — defineFeature() 注册为 test         │
└─────────────────────────────────────────────────────────────┘
                          ↓ 注册为
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: 执行层 (复用现有 runner, 0 改造)                   │
│  ─────────────────────────────────────────────────────────  │
│  后端: Vitest runner  ← step defs in *.steps.ts             │
│  前端: Playwright runner ← step defs in *.steps.ts          │
│  CLI:  Vitest runner  ← step defs in *.steps.ts             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 关键设计决策

1. **`.feature` 文件集中在 `docs/specs/features/`**，不分散在 `packages/*/tests/`。这是规约，不是测试代码；Owner/PD 应该在一个地方看完所有用户旅程，AI 助手读规约时不用跨包搜索。

2. **step definitions 跟着测试代码走**，放 `packages/<pkg>/tests/bdd/*.steps.ts`。step 是实现细节，跟测试基础设施绑定，跟着 `vitest.config.ts` / `playwright.config.ts` 走。

3. **Gherkin 解析器放 `principles-core/src/testing/`**，作为 pure logic 模块。遵循 core/plugin 边界——解析是纯函数，无 I/O，放 core；前后端共用一个解析器，保证场景语言统一。

4. **前后端 `.feature` 文件同名不同后缀**：`xxx.feature`（后端切面，数据流验证）vs `xxx-ui.feature`（前端切面，操作旅程验证）。同一个用户旅程的两个切面，文件名共享便于交叉引用。

5. **不引入完整 Cucumber 栈**，只用 `@cucumber/gherkin-utils`（纯解析器，~30KB）。执行仍由 Vitest/Playwright 负责，0 运行时改造。

### 2.3 与现有体系的关系

| 现有 | BDD 引入后的关系 |
|------|----------------|
| `story-a-acceptance.test.ts` | **保留**，作为后端切面 BDD 的 step definitions 池；`.feature` 文件驱动它 |
| `focus-approve-flow.spec.ts` | **保留**，作为前端切面 BDD 的 step definitions 池；`.feature` 文件驱动它 |
| `verify:merge` 9 道门 | **不改动**，BDD 场景通过现有 `npm test` 跑，自动纳入 |
| 200+ 单元测试 | **不动**，BDD 不替代 TDD，二者互补 |
| Runtime Contract rc-1~rc-9 | BDD 场景**引用** rc ID，但 rc 检查仍走 `check:runtime-contract` 静态扫描 |
| Error Handbook ERR 条目 | 高频复现 ERR 类转回归 `.feature` scenario（Phase 3） |

## 3. 组件设计

### 3.1 `gherkin-loader.ts`（解析层）

**位置**：`packages/principles-core/src/testing/gherkin-loader.ts`

**职责**：把 `@cucumber/gherkin-utils` 解析结果转成 PD 内部用的扁平结构，供 Vitest/Playwright step runner 消费。

**接口**：

```typescript
export interface ParsedStep {
  keyword: 'Given' | 'When' | 'Then' | 'And' | 'But';
  text: string;
}

export interface ParsedScenario {
  featureName: string;
  featureTags: string[];
  scenarioName: string;
  scenarioTags: string[];
  background?: ParsedStep[];
  steps: ParsedStep[];
}

export function parseFeature(featureText: string): ParsedScenario[];
```

**关键约束**：
- pure logic，无 I/O，通过 `architecture-regression.test.ts` 守卫；
- 不依赖 vitest/playwright，只输出数据结构；
- 解析失败时 fail loud（rc-3-fail-loud-missing），抛错带行列号。

### 3.2 `vitest-bdd.ts`（Vitest Step Runner）

**位置**：`packages/principles-core/src/testing/vitest-bdd.ts`

**职责**：把 ParsedScenario 注册为 `describe/it`，匹配 step definitions。

**接口**：

```typescript
export interface StepContext {
  state: Record<string, unknown>;        // 步骤间共享状态，场景级隔离
  redactable: Record<string, unknown>;   // step 显式标红可输出（诊断用）
  attachments: Array<{ name: string; body: string }>;  // step 主动附加的诊断文本
}

export type StepFn = (ctx: StepContext, ...args: unknown[]) => void | Promise<void>;

export interface StepRegistry {
  given(pattern: string | RegExp, fn: StepFn): void;
  when(pattern: string | RegExp, fn: StepFn): void;
  then(pattern: string | RegExp, fn: StepFn): void;
  match(step: ParsedStep): { fn: StepFn; args: unknown[] } | null;
}

export function createStepRegistry(): StepRegistry;
export function defineFeature(featureText: string, registry: StepRegistry): void;
```

**关键约束**：
- step 匹配支持两种 pattern 形式：精确字符串（`'owner approves it'`）和正则（`/a principle in (\w+) status/`，用于参数化）；
- 每个场景独立 `StepContext`，避免跨场景污染（rc-7-loop-state-freshness）；
- step 未匹配时 fail loud（rc-3-fail-loud-missing），报错信息含未匹配 step 文本 + 已注册 steps 列表；
- `attachments` 单条 body 硬限 4KB（rc-8-safe-serialization）。

### 3.3 `playwright-bdd.ts`（Playwright Step Runner）

**位置**：`packages/pd-console/tests/bdd/playwright-bdd.ts`

**职责**：同 3.2，但注册为 Playwright `test.describe` / `test`，并暴露 `page` / `APIRequestContext`。

**关键约束**：
- 复用现有 `e2e-start.mjs` 启动逻辑，0 改造；
- step 函数签名扩展为 `(ctx, page, apiContext, ...args)`；
- 失败时自动 screenshot 到 `packages/pd-console/test-results/bdd-screenshots/<feature>-<scenario>-<timestamp>.png`；
- 仍然 fail loud，step 未匹配直接 `test.fail`。

### 3.4 `.feature` 文件组织

**位置**：`docs/specs/features/`

```
docs/specs/features/
├── story-a/                              # MVP-Core 用户旅程
│   ├── _shared-backgrounds.md            # 跨场景共享的 Background 说明（给人读）
│   ├── owner-approve-prompt.feature      # 后端：approve prompt channel 全流程
│   ├── owner-approve-prompt-ui.feature   # 前端：Owner 在 FocusPage 审批
│   ├── owner-reject.feature              # Phase 2
│   ├── owner-edit.feature                # Phase 2
│   ├── rollback-deactivates.feature      # Phase 2
│   └── feature-disabled.feature          # Phase 2
├── cli/
│   ├── json-output.feature               # cli-1: strict JSON
│   ├── pain-retry.feature                # Phase 2: cli-5
│   └── dry-run-confirm-mutex.feature     # Phase 2: cli-4
└── README.md                             # 怎么读、怎么加场景
```

**关键约束**：
- 每个 `.feature` 文件开头必须有 `@mvp-core` 或 `@cli-contract` 标签，供工具筛选；
- scenario 命名包含 PRD 验收矩阵项 ID（如 `@prd-matrix:owner-reject`），便于追溯到 `story-a-acceptance.test.ts` 的 coverage matrix；
- 双语策略：Feature/Scenario 描述用中文为主（Owner 是中文用户），关键术语首次出现用 `原则 (principle)` / `激活 (activation)` 中英对照，跟现有 `pd-console/src/ui/i18n/zh-CN.json` 风格一致；步骤文本（Given/When/Then）用英文便于 step pattern 匹配稳定。

### 3.5 Step Definitions 组织

**后端 steps**：`packages/principles-core/tests/bdd/story-a.steps.ts`

```typescript
import { readFileSync } from 'node:fs';
import { createStepRegistry, defineFeature } from '../../src/testing/vitest-bdd.js';

// Phase 1 实施时需要先从 story-a-acceptance.test.ts 抽取 createTestWorkspace /
// createPrincipleArtifact 等辅助函数到一个共享文件（如 tests/bdd/helpers.ts），
// 让 acceptance test 和 BDD steps 共用，避免重复实现。
import { createTestWorkspace, createPrincipleArtifact } from './helpers.js';

const registry = createStepRegistry();

registry.given(/a principle in (\w+) status/, (ctx, status) => {
  ctx.state.workspace = createTestWorkspace();
  ctx.state.artifact = createPrincipleArtifact({ validationStatus: status });
});

registry.when('owner approves it', (ctx) => {
  // 调用 ApprovalCompletionService
});

registry.then('the principle is activated', (ctx) => {
  // 断言 activation state
});

defineFeature(
  readFileSync('docs/specs/features/story-a/owner-approve-prompt.feature', 'utf8'),
  registry
);
```

**前端 steps**：`packages/pd-console/tests/bdd/focus-page.steps.ts`

```typescript
registry.given('the governance queue has 2 pending approvals', async (ctx, page, api) => {
  const resp = await api.get('/api/v1/governance/queue');
  expect(resp.ok()).toBeTruthy();
  ctx.redactable.pendingCount = (await resp.json()).data.pendingReviewCount;
});
registry.when('owner clicks approve on FocusPage', async (ctx, page) => {
  await page.goto('/#/focus');
  await page.getByRole('button', { name: /approve/i }).first().click();
});
registry.then('the activation appears on ActivationPage', async (ctx, page) => {
  await page.goto('/#/activation');
  await expect(page.getByText(/active/i)).toBeVisible();
});
```

**CLI steps**：`packages/pd-cli/tests/bdd/cli-contract.steps.ts`

```typescript
registry.when('operator runs `pd pain retry --pain-id X --confirm`', async (ctx) => {
  ctx.state.result = await runCli(['pain', 'retry', '--pain-id', 'pain-001', '--confirm']);
});
registry.then('stdout is exactly one JSON object', (ctx) => {
  const out = ctx.state.result.stdout;
  expect(() => JSON.parse(out)).not.toThrow();
  // 严格单 JSON：parse 后不应有多余字符
});
```

## 4. 数据流与错误处理

### 4.1 数据流（单个 scenario 执行）

```
1. Vitest/Playwright 启动，加载 *.steps.ts
       ↓
2. *.steps.ts 顶部：defineFeature(readFeature('xxx.feature'), registry)
       ↓
3. gherkin-loader.ts 调用 @cucumber/gherkin-utils 解析
       ↓
4. 解析得 ParsedScenario[]
       ↓
5. 对每个 ParsedScenario，vitest-bdd 调用 describe(scenarioName, () => {
       it(`✓ ${scenarioName}`, async () => {
         const ctx = { state: {}, redactable: {}, attachments: [] };
         for (step of [...background, ...scenarioSteps]) {
           const match = registry.match(step);
           if (!match) throw new Error(...);  // fail loud (rc-3)
           await match.fn(ctx, ...match.args);
         }
       });
     })
       ↓
6. Vitest/Playwright 执行 it/test，失败时报告（见 4.3）
```

### 4.2 错误处理策略（对齐 Runtime Contract）

| 错误场景 | 处理方式 | 对应 rc/ERR |
|---------|---------|------------|
| `.feature` 文件语法错误 | 解析器抛错，带行列号；Vitest 报告"Feature file malformed" | rc-3-fail-loud |
| step 文本未匹配任何 registry | 抛错，列出"已注册 steps"+"未匹配文本"，**禁止 silently skip** | rc-3, ERR-009 |
| step 函数抛错 | Vitest/Playwright 标准失败报告，含 step 文本+场景名 | - |
| Background 步骤失败 | 整个 scenario 失败，不继续后续 step | rc-7（状态隔离） |
| step 中读到的数据不符合预期类型 | step 内部用 type guard，失败时抛 `StepDataMismatch` | rc-1, rc-2, ERR-001 |
| `ctx.state` 跨场景泄漏 | 每个 scenario 新建 `ctx`，**禁止跨 scenario 共享** | rc-7, ERR-015 |
| Playwright step 超时 | 复用 `playwright.config.ts` 的 timeout，失败报告含截图 | - |
| `.feature` 引用的 fixture 不存在 | step 内部 fail loud，带"fixture X not found" | rc-3, ERR-010 |

### 4.3 失败诊断信息（关键设计）

每个失败 scenario 的报告必须包含：

```
✗ Scenario: owner reject does not activate [tags: @mvp-core, @prd-matrix:owner-reject]
  Feature: docs/specs/features/story-a/owner-reject.feature:14
  Failed step: Then the principle should not be in activation queue
  Step source: packages/principles-core/tests/bdd/story-a.steps.ts:42
  Error: AssertionError: expected queue to contain 0 items, got 1
    at registry.then (story-a.steps.ts:42:15)

  Redactable state at failure:
    { approvalId: "appr-001", resultStatus: "rejected", activatedRuleId: undefined }
  Attachments:
    [approve-response] {"status":"rejected","reason":"owner_rejected","timestamp":"..."}

  Step trace (with timing):
    ✓ Given a principle in awaiting_owner_review status       (12ms)
    ✓ When owner rejects it                                   (45ms)
    ✗ Then the principle should not be in activation queue    (8ms, FAILED)
                                                            [scenario total: 65ms]

  Screenshot: packages/pd-console/test-results/bdd-screenshots/owner-reject-1735600000.png
```

**关键决策**：
- `Feature:` 路径用相对仓库根路径，方便 AI 助手读；
- `Step source` 路径让 AI 助手能直接定位 step 实现；
- `Step trace` 让 Owner 看得懂"卡在哪一步"，不需要读代码；
- `Redactable state` 只输出 step 显式标红的字段，不输出 `ctx.state` 全部（可能含敏感数据，rc-8-safe-serialization）；
- `Attachments` 单条 body 硬限 4KB；
- `Screenshot` 路径只在前端切面失败时出现；
- 步骤耗时：超过 2s 标黄，超过 5s 标红（对应 TESTING.md 的 p99 性能基线）。

### 4.4 失败前的完整步骤日志（trace 模式）

每个 step 执行前后写入 trace log（默认 OFF，通过 `PD_BDD_TRACE=1` 环境变量开启）：

```
[trace] Scenario "owner reject" starting
[trace]   Given: a principle in awaiting_owner_review status
[trace]     → createTestWorkspace() → workspaceDir=/tmp/pd-bdd-abc123
[trace]     → createPrincipleArtifact({validationStatus:'validated'}) → art-p-001
[trace]   When: owner rejects it
[trace]     → approvalStore.reject('appr-001') → ok
[trace]   Then: the principle should not be in activation queue
[trace]     → stateStore.listActive() → [art-rule-001]  ← UNEXPECTED
[trace]   FAILED: AssertionError at story-a.steps.ts:42
```

trace 模式只在本地诊断用，CI 默认关闭，避免日志爆炸。

### 4.5 与 Error Handbook 的关系

每个 `.feature` scenario 可以在注释里引用 ERR ID（Phase 3 主要使用，Phase 1 不强制）：

```gherkin
@prd-matrix:lineage-mismatch @err:ERR-004
Scenario: approval with mismatched lineage is refused
  ...
```

- AI 助手读 `.feature` 时，看到 `@err:ERR-004` 标签就知道这个 scenario 在守护哪个错误类；
- 但**不强制**每个 scenario 都有 `@err:` 标签——MVP-Core 旅程场景不直接对应单条 ERR；
- 后续 `check:bdd-coverage` 可以扫描 `@err:` 标签覆盖率，作为 Phase 2。

## 5. 测试与发版集成

### 5.1 测试组织

| 测试类型 | 位置 | runner | 触发 |
|---------|------|--------|------|
| 后端 BDD | `packages/principles-core/tests/bdd/*.steps.ts` | Vitest | `cd packages/principles-core && npm test` |
| 前端 BDD | `packages/pd-console/tests/bdd/*.steps.ts` | Playwright | `cd packages/pd-console && npm run test:e2e` |
| CLI BDD | `packages/pd-cli/tests/bdd/*.steps.ts` | Vitest | `cd packages/pd-cli && npm test` |
| 现有单元测试 | （不动） | Vitest | 同上 |
| 现有 e2e 测试 | （不动） | Playwright | 同上 |

**关键决策**：
- BDD 场景跟现有测试**共用 runner，共用配置**，不新增 npm script；
- `verify:merge` 的 `test` 检查项自动覆盖 BDD 场景，**0 改造**；
- Playwright BDD 跟现有 e2e 共用 `e2e-start.mjs` 启动逻辑，**0 改造**。

### 5.2 CI 集成

`.github/workflows/ci.yml` 现有 11 个 job 中，BDD 场景自动跑在：

| Job | 包含的 BDD |
|-----|-----------|
| `test-principles-core` | 后端 BDD（随 `npm test`） |
| `test-pd-cli` | CLI BDD（随 `npm test`） |
| `test-openclaw-plugin-unit/integration` | （无 BDD，MVP-First 阶段不覆盖 plugin 层） |
| `test-pd-console` | 前端 BDD（随 `npm run test:e2e`，如果 CI 跑 e2e） |

**注意**：pd-console 当前 e2e 是否在 CI 跑需要核查（看 `playwright.config.ts` 和 ci.yml）。如果不在 CI 跑，前端 BDD 也只在本地跑。这是现有约束，BDD 不改变它。

### 5.3 `check:bdd-coverage`（Phase 2，本次不实施）

未来添加一个静态检查：

```bash
npm run check:bdd-coverage
```

检查项：
1. 每个 `.feature` 文件的所有 scenario 是否都有对应 step definition；
2. 每个 `@mvp-core` 标签的 scenario 是否真的覆盖了 PRD 验收矩阵项；
3. 每个 `@err:ERR-XXX` 标签的 scenario 是否真的覆盖了对应 ERR 类。

失败时 fail loud，带"未覆盖的 scenario"+"未匹配的 step"报告。

**Phase 1 不做**，Phase 1 只保证基础 BDD 跑起来。

### 5.4 发版流程集成

发版前 `npm run verify:merge` 自动跑 BDD 场景，无需新增步骤。

**新增的发版检查清单项**（写到 PR 模板）：

```markdown
## BDD 影响评估

- [ ] 本 PR 是否修改了 MVP-Core 用户旅程？如果是，对应 `.feature` 是否更新？
- [ ] 本 PR 是否新增/修改了 CLI 命令？如果是，cli-1~cli-7 对应 `.feature` 是否更新？
- [ ] 本 PR 是否触发了 ERR 类？如果是，是否新增了回归 `.feature` scenario？
```

### 5.5 AI 助手工作流集成

AI 助手在 PD 项目改代码时的新流程（写到 AGENTS.md）：

```
1. 读 docs/specs/features/ 找到受影响的 .feature 文件
2. 读 .feature 确认行为契约
3. 改代码
4. 跑受影响的 .feature 场景（npx vitest run ... 或 npx playwright test ...）
5. 如果场景失败，确认是代码 bug 还是 .feature 过时
   - 代码 bug → 修代码
   - .feature 过时 → 跟 Owner 确认后改 .feature，并在 PR 说明中记录
6. PR Pre-Review Gate 的对抗式自检，优先检查 .feature 是否都绿
```

**关键约束**：
- AI 助手**不能**为了通过 BDD 场景而修改 step definitions（那是实现层）；
- AI 助手**可以**修改 `.feature`，但必须在 PR 说明中说明"行为契约为什么变了"；
- 这条约束写到 AGENTS.md 的 PR Pre-Review Gate 段。

## 6. Phase 划分与范围控制

### 6.1 Phase 1：MVP-Core BDD 地基（本次实施）

**目标**：让 PD 项目第一次有可执行的 `.feature` 规约，验证整个三层架构。

**范围**：
- 安装 `@cucumber/gherkin-utils` 依赖；
- 实现 `gherkin-loader.ts`（解析层，~80 行）；
- 实现 `vitest-bdd.ts`（Vitest step runner，~120 行）；
- 实现 `playwright-bdd.ts`（Playwright step runner，~80 行）；
- 从 `story-a-acceptance.test.ts` / `focus-approve-flow.spec.ts` 抽取共享 helpers 到 `tests/bdd/helpers.ts`，让原测试和 BDD steps 共用，避免重复实现；
- **3 个示范 `.feature` 文件**（覆盖三个切面各一个）：
  1. `docs/specs/features/story-a/owner-approve-prompt.feature`（后端，从 `story-a-acceptance.test.ts` 抽取）
  2. `docs/specs/features/story-a/owner-approve-prompt-ui.feature`（前端，从 `focus-approve-flow.spec.ts` 抽取）
  3. `docs/specs/features/cli/json-output.feature`（CLI，新建，对应 cli-1）
- 对应的 3 个 step definition 文件；
- 1 个 ADR：`docs/adr/00XX-bdd-specification-layer.md`（记录为什么选方案 A、为什么 `.feature` 集中在 `docs/specs`）；
- 更新 `AGENTS.md` 和 `CLAUDE.md`：加入"AI 助手改代码前先读 `.feature`"工作流；
- 更新 `.github/PULL_REQUEST_TEMPLATE.md`：加入"BDD 影响评估"段。

**验收标准**：
1. `cd packages/principles-core && npm test` 跑通后端 BDD 场景；
2. `cd packages/pd-console && npm run test:e2e` 跑通前端 BDD 场景（本地）；
3. `cd packages/pd-cli && npm test` 跑通 CLI BDD 场景；
4. 故意改坏一行代码，BDD 场景失败时报告含完整诊断信息（feature 路径、step source、step trace、redactable state）；
5. AI 助手能从 `.feature` 读出"owner approve prompt channel 的行为契约"，无需读 step definitions；
6. `npm run verify:merge` 通过，9 道门无任何改动。

**不在 Phase 1 范围**：
- `check:bdd-coverage` 静态检查；
- 全部 PRD 验收矩阵转 `.feature`（只做 3 个示范）；
- Runtime Contract rc-1~rc-9 全部转 `.feature`；
- ERR 类全部转回归 `.feature`；
- Cucumber 报告/HTML 输出；
- scenario outline 矩阵化（虽然 `@cucumber/gherkin-utils` 支持，但 Phase 1 不用）。

### 6.2 Phase 2（条件性，需新 issue）：覆盖扩展

**触发条件**：Phase 1 合并后，Owner/PD 反馈 `.feature` 形态有价值，且 AI 助手确实在用 `.feature` 当规约。

**范围**：
- PRD 验收矩阵 8 项全部转 `.feature`（对应 `story-a-acceptance.test.ts` coverage matrix）；
- CLI 契约 cli-1~cli-7 全部转 `.feature`；
- `check:bdd-coverage` 静态检查；
- `@err:ERR-XXX` 标签机制 + 覆盖率扫描。

**MVP-First 红线**：Phase 2 不能引入新运行时依赖，不能改动 `verify:merge` 9 道门结构。

### 6.3 Phase 3（条件性，post-MVP）：Runtime Contract + ERR 全覆盖

**触发条件**：MVP-First 结束，进入 post-MVP 阶段（参考 `post-mvp-conditional-roadmap.md`）。

**范围**：
- rc-1~rc-9 全部转 `.feature`；
- ERR-001~ERR-025+ 高频复现类转回归 `.feature`；
- scenario outline 矩阵化（rc-4 validate-array-elements 这种适合矩阵）；
- 可选：替换 `@cucumber/gherkin-utils` 为更完整的 cucumber 生态（如果 Phase 2 证明不够用）。

## 7. Emotional Value 评估

按 [emotional-value.md](../../product/emotional-value.md) §7：

- **降低的负面情绪**：
  - 失控感（Owner 看不懂测试，"开发说什么就是什么"）
  - 疲惫感（每次发版要重新确认行为没坏）
  - 不信任感（AI 助手改代码可能破坏契约）
- **提升的正面感受**：
  - 沉淀感（行为契约变成可读文档，跨 session 不丢失）
  - 清醒感（看一眼 `.feature` 就知道这个旅程在守护什么）
  - 掌控感（Owner 能直接审阅/修改 `.feature`）
- **不直接服务的**：安心感（BDD 不直接产生安心，安心来自产品行为正确）

## 8. ERR 合规自检

本设计实施前考虑的 ERR 条目：

- **ERR-001 / ERR-005 / ERR-007**（as bypass validation 类）：`gherkin-loader.ts` 解析结果类型固定为 `ParsedScenario[]`，step 函数参数通过 `registry.match()` 类型 narrowed，禁止 `as` 强转。
- **ERR-009 / ERR-010**（fail loud 类）：step 未匹配、fixture 不存在、`@cucumber/gherkin-utils` 解析失败，全部 fail loud。
- **ERR-015 / ERR-018 / ERR-019**（stale loop state 类）：每个 scenario 独立 `StepContext`，禁止跨 scenario 共享 `ctx.state`。
- **ERR-014 / ERR-016 / ERR-017**（safe serialization 类）：`attachments` 单条 body 硬限 4KB；`redactable` 只输出 step 显式标红字段；不输出 `ctx.state` 全部。
- **ERR-002**（silent fallback 类）：step 未匹配不 silently skip，直接抛错。

实施 PR 时会在 PR body 中再次列 ERR checklist。

## 9. 未决问题

- **9.1 pd-console e2e 是否在 CI 跑**：实施时需先核查 `.github/workflows/ci.yml` 与 `packages/pd-console/playwright.config.ts`。如果不在 CI 跑，前端 BDD 也只在本地跑，PR 描述需注明"前端 BDD 已本地验证"。
- **9.2 ADR 编号**：实施时确认 `docs/adr/` 下一个可用编号，本设计文档占位为 `00XX`。
- **9.3 `@cucumber/gherkin-utils` 版本**：实施时确认 npm 上最新稳定版，记录到 ADR。

## 10. 参考文档

- [PRODUCT_IDENTITY.md](../../product/PRODUCT_IDENTITY.md) — 产品边界
- [ADR-0014 MVP-First](../../adr/0014-mvp-first-strategy-and-product-pivot.md) — MVP-First 战略
- [TESTING.md](../../process/TESTING.md) — 测试基础设施
- [AGENTS.md](../../../AGENTS.md) — AI 助手工作流
- [story-a-acceptance.test.ts](../../../packages/principles-core/src/runtime-v2/activation/__tests__/story-a-acceptance.test.ts) — 后端切面 step 池
- [focus-approve-flow.spec.ts](../../../packages/pd-console/tests/e2e/focus-approve-flow.spec.ts) — 前端切面 step 池
