# PD BDD 规约层设计

> 文档版本：2.0（评审修订版）
>
> 状态：Design ready for maintainer review，尚未批准实施
>
> 代码基线：feat-bdd-tdd-pd-project-j7lEfa@HEAD
>
> 适用范围：MVP-Core 用户旅程（后端切面 + 前端切面）+ CLI/Operator 命令契约
>
> 关联文档：[ADR-0014 MVP-First](../../adr/0014-mvp-first-strategy-and-product-pivot.md)、[PRODUCT_IDENTITY](../../product/PRODUCT_IDENTITY.md)、[TESTING](../../process/TESTING.md)、[AGENTS.md](../../../AGENTS.md)、[ERROR_PATTERN_INDEX](../../process/error-management/ERROR_PATTERN_INDEX.md)

## 0. 决策摘要

本设计在 PD 项目引入一层**可执行的行为规约**（BDD，Behavior-Driven Development），用 `.feature` 文件描述 Owner 可读的用户旅程契约，通过 `@cucumber/gherkin` 解析后注册为 Vitest / Playwright 测试。

本次只推进 Phase 1（规约试点，3 条最高价值路径）：

- 引入 `@cucumber/gherkin` 与 `@cucumber/messages` 作为 root `devDependencies`（**不**进 `@principles/core` 发布包）；
- 在 `packages/principles-core/tests/bdd/support/` 实现 `gherkin-loader.ts` 与 `vitest-bdd.ts`（测试基础设施，**不**进 src）；
- 在 `packages/pd-console/tests/bdd/support/` 实现 `playwright-bdd.ts`（复用现有 `e2e-start.mjs`）；
- 在 `docs/specs/features/` 落地 3 个示范 `.feature` 文件：
  1. `story-a/owner-approve-prompt.feature`（后端，从 `story-a-acceptance.test.ts` 抽取）
  2. `story-a/owner-approve-prompt-ui.feature`（前端，从 `focus-approve-flow.spec.ts` 抽取）
  3. `cli/json-output.feature`（CLI，新建，对应 cli-1-strict-json）
- 配套 1 个 ADR 与 AGENTS.md / CLAUDE.md 工作流更新。

本次**不**推进：

- PRD 验收矩阵 8 项全部转 `.feature`（Phase 2，条件性）；
- Runtime Contract rc-1~rc-9 与 ERR 类回归场景（Phase 3，post-MVP）；
- `check:bdd-coverage` 静态检查（Phase 2）；
- 把 BDD 纳入 `verify:merge` 合并门禁（Phase 2 评估）；
- Cucumber 报告/HTML 输出/scenario outline 矩阵化（Phase 3 可选）。

本设计**不**把 PD 变成 BDD 工具栈。`.feature` 是规约载体，不是新的执行框架；现有 200+ 单元测试、`verify:merge` 9 道门、Playwright e2e 启动逻辑全部不动。

**关键诚实声明**：Phase 1 的 BDD 场景**不**在 `verify:merge` 合并门禁内。它们随 CI 的 per-package test job 跑（`test-principles-core`、`test-pd-cli`）和独立 workflow（`pd-console-e2e.yml`），但 `verify:merge` 本身只跑 9 个静态检查（见 [package.json verify:merge](../../../package.json) L23）。要让 BDD 成为合并门禁，必须显式修改 CI required checks，Phase 1 不做这件事。

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
| `mvp-q-2-how-observed` | 如何观察 BDD 工作？—— CI 的 per-package test job 输出里有 `✓ Scenario: owner approve prompt channel` 这种以 Owner 语言命名的测试。Owner 在 PR 检查时能直接读 `.feature`。 |
| `mvp-q-3-how-disabled` | 如何禁用？—— 必须显式 `@disabled(reason,owner,date)` 标签 + runner skip report，不允许通过删除 `.feature` 让测试绿（详见 3.2）。 |
| `mvp-q-4-emotional-value` | 情感价值？—— 降低失控感（Owner 看懂验收标准）、提升沉淀感（行为契约变成可读文档）。依据见 `docs/.private/product/emotional-value.md`（private junction，主 worktree 可读）。 |

四个问题都能回答，且答案直接对应 [PRODUCT_IDENTITY.md](../../product/PRODUCT_IDENTITY.md) 的"owner-governed, reversible"承诺。引入合规。

### 1.3 反模式自检

- ❌ `antipattern-future-extensibility`：Phase 2/3 是条件性，Phase 1 范围克制到 3 个示范 `.feature`，不为完整覆盖预留接口。
- ❌ `antipattern-completeness`：Phase 1 不追求"覆盖所有 PRD 矩阵"。
- ❌ `antipattern-prep-next-phase`：Phase 2 的 `check:bdd-coverage` 不在 Phase 1 实现，不留 hook。
- ❌ `antipattern-core-io`：BDD 解析器放 `tests/bdd/support/`，**不**进 `principles-core/src/`；遵循 core 是纯 logic 的边界，也避免污染发布 SDK。

### 1.4 关键风险：ERR-025 / ERR-088（BDD 假护栏）

本设计最大的风险是变成"测试框架看起来存在，但没有真正守住生产路径和合并门禁"——这正是 [ERROR_PATTERN_INDEX.md](../../process/error-management/ERROR_PATTERN_INDEX.md) EP-07 中 ERR-025 / ERR-088 描述的失败模式。

缓解措施（贯穿全文）：
1. **不**声称 BDD 自动进入 `verify:merge`，明确说清合并门禁边界（§0、§5）；
2. **不**设计"删除 .feature 自动空跑"的禁用路径，避免 AI 助手通过删规约让测试绿（§3.2）；
3. `.feature` 路径解析走 repo-root resolver，避免在 package cwd 下找不到文件造成"场景被静默跳过"（§3.5）；
4. BDD runner 放测试目录而非 `src/`，避免测试工具进发布包导致"SDK 用户能看到 BDD API 但实际项目没用"（§3.1、§3.2）；
5. Phase 2 触发条件可观察（§6.2）：至少 2-3 个真实 PR 中 BDD 阻止了误解/回归/无用扩张，才扩展覆盖。

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
│    cli/                                                     │
│      json-output.feature                                    │
└─────────────────────────────────────────────────────────────┘
                          ↓ 解析
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: 解析层 (@cucumber/gherkin 适配)                    │
│  ─────────────────────────────────────────────────────────  │
│  packages/principles-core/tests/bdd/support/                │
│    gherkin-loader.ts  — parseFeature() → ParsedScenario[]   │
│    vitest-bdd.ts      — defineFeature() 注册为 describe/it  │
│    repo-root.ts       — resolveRepoRoot() 路径解析          │
│  packages/pd-console/tests/bdd/support/                     │
│    playwright-bdd.ts  — defineFeature() 注册为 test         │
└─────────────────────────────────────────────────────────────┘
                          ↓ 注册为
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: 执行层 (复用现有 runner, 0 改造)                   │
│  ─────────────────────────────────────────────────────────  │
│  后端: Vitest runner  ← step defs in *.steps.ts             │
│        (CI: test-principles-core job, NOT in verify:merge)  │
│  前端: Playwright runner ← step defs in *.steps.ts          │
│        (CI: pd-console-e2e.yml workflow)                    │
│  CLI:  Vitest runner  ← step defs in *.steps.ts             │
│        (CI: test-pd-cli job, NOT in verify:merge)           │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 关键设计决策

1. **`.feature` 文件集中在 `docs/specs/features/`**，不分散在 `packages/*/tests/`。这是规约，不是测试代码；Owner/PD 应该在一个地方看完所有用户旅程，AI 助手读规约时不用跨包搜索。

2. **step definitions 跟着测试代码走**，放 `packages/<pkg>/tests/bdd/*.steps.ts`。step 是实现细节，跟测试基础设施绑定，跟着 `vitest.config.ts` / `playwright.config.ts` 走。

3. **BDD runner 放 `tests/bdd/support/`，不进 `src/`**。理由：(a) `@principles/core` 是公开发布的 SDK（`publishConfig.access: public`，`files: ["dist"]`），放 `src/testing/` 会被 tsc 编译进 dist，把 BDD 工具带进 SDK；(b) 解析器依赖 `@cucumber/gherkin` 与 `@cucumber/messages`，不应进入生产依赖；(c) 遵循"测试基础设施属于测试目录"的常规边界。这两个包放 root `devDependencies`，所有包共享。

4. **前后端 `.feature` 文件同名不同后缀**：`xxx.feature`（后端切面，数据流验证）vs `xxx-ui.feature`（前端切面，操作旅程验证）。同一个用户旅程的两个切面，文件名共享便于交叉引用。

5. **不引入完整 Cucumber 栈**，只用 `@cucumber/gherkin` 解析器与消息类型。执行仍由 Vitest/Playwright 负责，0 运行时改造。

6. **`.feature` 路径解析走 repo-root resolver**，不依赖 `process.cwd()`。理由：`cd packages/principles-core && npm test` 时 cwd 是包目录，相对路径 `docs/specs/...` 找不到文件，可能造成"场景被静默跳过"——这是 ERR-088 的典型失败模式。

### 2.3 与现有体系的关系

| 现有 | BDD 引入后的关系 |
|------|----------------|
| `story-a-acceptance.test.ts` | **保留**，作为后端切面 BDD 的 step definitions 池；`.feature` 文件驱动它 |
| `focus-approve-flow.spec.ts` | **保留**，作为前端切面 BDD 的 step definitions 池；`.feature` 文件驱动它 |
| `verify:merge` 9 道门 | **不改动，也不纳入**。BDD 场景随 CI per-package test job 跑，与 `verify:merge` 互不依赖 |
| 200+ 单元测试 | **不动**，BDD 不替代 TDD，二者互补 |
| Runtime Contract rc-1~rc-9 | BDD 场景**引用** rc ID，但 rc 检查仍走 `check:runtime-contract` 静态扫描 |
| Error Handbook ERR 条目 | 高频复现 ERR 类转回归 `.feature` scenario（Phase 3） |
| `pd-console-e2e.yml` 独立 workflow | **复用**，前端 BDD 场景随此 workflow 跑 |

## 3. 组件设计

### 3.1 `gherkin-loader.ts`（解析层）

**位置**：`packages/principles-core/tests/bdd/support/gherkin-loader.ts`

**职责**：把 `@cucumber/gherkin` 解析结果转成 PD 内部用的扁平结构，供 Vitest/Playwright step runner 消费。

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
- pure logic，无 I/O；
- 不依赖 vitest/playwright，只输出数据结构；
- 解析失败时 fail loud（rc-3-fail-loud-missing），抛错带行列号；
- 不在 `src/` 目录，不进发布包；通过 `architecture-regression.test.ts` 守卫"测试代码不进 src"的边界（如果当前守卫未覆盖此点，Phase 1 实施时同步加强守卫）。

### 3.2 `vitest-bdd.ts`（Vitest Step Runner）

**位置**：`packages/principles-core/tests/bdd/support/vitest-bdd.ts`

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
- step 匹配支持两种 pattern 形式：精确字符串（`'owner 审批通过'`）和正则（`/原则处于 (.+) 状态/`，用于参数化）；
- 每个场景独立 `StepContext`，避免跨场景污染（rc-7-loop-state-freshness）；
- step 未匹配时 fail loud（rc-3-fail-loud-missing），报错信息含未匹配 step 文本 + 已注册 steps 列表；
- `attachments` 单条 body 硬限 4KB（rc-8-safe-serialization）；
- **禁用机制**：scenario 标记 `@disabled(reason,owner,date)` 时，runner 输出**显式 skip 报告**（`SKIP: scenario "xxx" — reason: ...; owner: ...; date: ...`），不允许静默通过；**禁止**通过删除 `.feature` 文件或重命名为 `.feature.disabled` 让测试绿，这会被 AI 助手利用来绕过规约。

### 3.3 `playwright-bdd.ts`（Playwright Step Runner）

**位置**：`packages/pd-console/tests/bdd/support/playwright-bdd.ts`

**职责**：同 3.2，但注册为 Playwright `test.describe` / `test`，并暴露 `page` / `APIRequestContext`。

**关键约束**：
- 复用现有 `e2e-start.mjs` 启动逻辑，0 改造；
- step 函数签名扩展为 `(ctx, page, apiContext, ...args)`；
- 失败时自动 screenshot 到 `packages/pd-console/test-results/bdd-screenshots/<feature>-<scenario>-<timestamp>.png`；
- 仍然 fail loud，step 未匹配直接 `test.fail`；
- 同 3.2，禁用机制走 `@disabled` 标签 + 显式 skip 报告。

### 3.4 `repo-root.ts`（路径解析器，新增）

**位置**：`packages/principles-core/tests/bdd/support/repo-root.ts`

**职责**：解析仓库根路径，让 `.feature` 文件路径不依赖 `process.cwd()`。

**接口**：

```typescript
export function resolveRepoRoot(): string;
export function resolveFeaturePath(relativePath: string): string;
// 例如：resolveFeaturePath('docs/specs/features/story-a/owner-approve-prompt.feature')
// 返回绝对路径，无论 cwd 是 packages/principles-core 还是仓库根
```

**实现策略**：
- 优先使用 `process.env.PD_REPO_ROOT`（CI 显式注入）；
- 否则从 `import.meta.url` 向上查找，直到找到 `package.json` 含 `"name": "principles-disciple-monorepo"` 的目录；
- 解析失败 fail loud（rc-3），抛错带搜索路径列表。

**关键约束**：
- 避免相对路径在 package cwd 下找不到 `.feature` 造成"场景被静默跳过"（ERR-088 风险）；
- 不依赖 git 子进程（避免 CI shallow clone 或 git 不可用环境失败）。

### 3.5 `.feature` 文件组织

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
- **双语策略**：Feature/Scenario 描述、Given/When/Then 步骤文本**全中文**为主（Owner 是中文非技术用户），关键术语首次出现用 `原则 (principle)` / `激活 (activation)` 中英对照，跟现有 `pd-console/src/ui/i18n/zh-CN.json` 风格一致。step pattern 用中文 regex（`/原则处于 (.+) 状态/`，TypeScript RegExp 原生支持 unicode）。Phase 1 不做双语 `.feature` 文件，全中文单一语言；如果未来 Owner 切换英文，再考虑双语。
- `.feature` 文件可以删除（重构导致场景不再适用），但**不能为了让测试绿而删除**——删除必须在 PR 描述中说明"行为契约被移除的原因"，且 PR 模板有强制项（见 §5.4）。

### 3.6 Step Definitions 组织

**后端 steps**：`packages/principles-core/tests/bdd/story-a.steps.ts`

```typescript
import { createStepRegistry, defineFeature } from './support/vitest-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';

// Phase 1 实施时需要先从 story-a-acceptance.test.ts 抽取 createTestWorkspace /
// createPrincipleArtifact 等辅助函数到一个共享文件（如 tests/bdd/support/helpers.ts），
// 让 acceptance test 和 BDD steps 共用，避免重复实现。
import { createTestWorkspace, createPrincipleArtifact } from './support/helpers.js';

const registry = createStepRegistry();

registry.given(/原则处于 (.+) 状态/, (ctx, status) => {
  ctx.state.workspace = createTestWorkspace();
  ctx.state.artifact = createPrincipleArtifact({ validationStatus: status });
});

registry.when('owner 审批通过', (ctx) => {
  // 调用 ApprovalCompletionService
});

registry.then('原则被激活', (ctx) => {
  // 断言 activation state
});

defineFeature(
  readFileSync(resolveFeaturePath('docs/specs/features/story-a/owner-approve-prompt.feature'), 'utf8'),
  registry
);
```

**前端 steps**：`packages/pd-console/tests/bdd/focus-page.steps.ts`

```typescript
registry.given('治理队列有 2 条待审批项', async (ctx, page, api) => {
  const resp = await api.get('/api/v1/governance/queue');
  expect(resp.ok()).toBeTruthy();
  ctx.redactable.pendingCount = (await resp.json()).data.pendingReviewCount;
});
registry.when('owner 在 FocusPage 点击审批通过', async (ctx, page) => {
  await page.goto('/#/focus');
  await page.getByRole('button', { name: /审批通过|approve/i }).first().click();
});
registry.then('激活项出现在 ActivationPage', async (ctx, page) => {
  await page.goto('/#/activation');
  await expect(page.getByText(/active|已激活/i)).toBeVisible();
});
```

**CLI steps**：`packages/pd-cli/tests/bdd/cli-contract.steps.ts`

```typescript
registry.when('operator 执行 `pd pain retry --pain-id X --confirm`', async (ctx) => {
  ctx.state.result = await runCli(['pain', 'retry', '--pain-id', 'pain-001', '--confirm']);
});
registry.then('stdout 是严格的单一 JSON 对象', (ctx) => {
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
2. *.steps.ts 顶部：defineFeature(readFeature(resolveFeaturePath('xxx.feature')), registry)
       ↓
3. gherkin-loader.ts 调用 @cucumber/gherkin 解析
       ↓
4. 解析得 ParsedScenario[]
       ↓
5. 对每个 ParsedScenario，vitest-bdd 调用 describe(scenarioName, () => {
       // 检查 @disabled 标签：如有，输出显式 skip 报告并 test.skip()
       // 而非静默通过
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
| `.feature` 文件路径解析失败 | `resolveRepoRoot()` 抛错，带搜索路径列表 | rc-3, ERR-088（避免静默跳过） |
| step 文本未匹配任何 registry | 抛错，列出"已注册 steps"+"未匹配文本"，**禁止 silently skip** | rc-3, ERR-009 |
| step 函数抛错 | Vitest/Playwright 标准失败报告，含 step 文本+场景名 | - |
| Background 步骤失败 | 整个 scenario 失败，不继续后续 step | rc-7（状态隔离） |
| step 中读到的数据不符合预期类型 | step 内部用 type guard，失败时抛 `StepDataMismatch` | rc-1, rc-2, ERR-001 |
| `ctx.state` 跨场景泄漏 | 每个 scenario 新建 `ctx`，**禁止跨 scenario 共享** | rc-7, ERR-015 |
| Playwright step 超时 | 复用 `playwright.config.ts` 的 timeout，失败报告含截图 | - |
| `.feature` 引用的 fixture 不存在 | step 内部 fail loud，带"fixture X not found" | rc-3, ERR-010 |
| scenario 标记 `@disabled` | 输出显式 skip 报告（含 reason/owner/date），`test.skip()`；**不允许静默通过** | rc-9（no silent fallback） |

### 4.3 失败诊断信息（关键设计）

每个失败 scenario 的报告必须包含：

```
✗ Scenario: owner 拒绝后原则不被激活 [tags: @mvp-core, @prd-matrix:owner-reject]
  Feature: docs/specs/features/story-a/owner-reject.feature:14
  Failed step: Then 原则不应出现在激活队列中
  Step source: packages/principles-core/tests/bdd/story-a.steps.ts:42
  Error: AssertionError: expected queue to contain 0 items, got 1
    at registry.then (story-a.steps.ts:42:15)

  Redactable state at failure:
    { approvalId: "appr-001", resultStatus: "rejected", activatedRuleId: undefined }
  Attachments:
    [approve-response] {"status":"rejected","reason":"owner_rejected","timestamp":"..."}

  Step trace (with timing):
    ✓ Given 原则处于 awaiting_owner_review 状态          (12ms)
    ✓ When owner 拒绝它                                  (45ms)
    ✗ Then 原则不应出现在激活队列中                       (8ms, FAILED)
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
[trace] Scenario "owner 拒绝后原则不被激活" starting
[trace]   Given: 原则处于 awaiting_owner_review 状态
[trace]     → createTestWorkspace() → workspaceDir=/tmp/pd-bdd-abc123
[trace]     → createPrincipleArtifact({validationStatus:'validated'}) → art-p-001
[trace]   When: owner 拒绝它
[trace]     → approvalStore.reject('appr-001') → ok
[trace]   Then: 原则不应出现在激活队列中
[trace]     → stateStore.listActive() → [art-rule-001]  ← UNEXPECTED
[trace]   FAILED: AssertionError at story-a.steps.ts:42
```

trace 模式只在本地诊断用，CI 默认关闭，避免日志爆炸。

### 4.5 与 Error Handbook 的关系

每个 `.feature` scenario 可以在注释里引用 ERR ID（Phase 3 主要使用，Phase 1 不强制）：

```gherkin
@prd-matrix:lineage-mismatch @err:ERR-004
Scenario: 审批的 lineage 不匹配时被拒绝
  ...
```

- AI 助手读 `.feature` 时，看到 `@err:ERR-004` 标签就知道这个 scenario 在守护哪个错误类；
- 但**不强制**每个 scenario 都有 `@err:` 标签——MVP-Core 旅程场景不直接对应单条 ERR；
- 后续 `check:bdd-coverage` 可以扫描 `@err:` 标签覆盖率，作为 Phase 2。

## 5. 测试与发版集成

### 5.1 测试组织

| 测试类型 | 位置 | runner | 触发命令 | CI 位置 |
|---------|------|--------|---------|--------|
| 后端 BDD | `packages/principles-core/tests/bdd/*.steps.ts` | Vitest | `cd packages/principles-core && npm test` | `test-principles-core` job |
| 前端 BDD | `packages/pd-console/tests/bdd/*.steps.ts` | Playwright | `cd packages/pd-console && npm run test:e2e` | `pd-console-e2e.yml` workflow |
| CLI BDD | `packages/pd-cli/tests/bdd/*.steps.ts` | Vitest | `cd packages/pd-cli && npm test` | `test-pd-cli` job |
| 现有单元测试 | （不动） | Vitest | 同上 | 同上 |
| 现有 e2e 测试 | （不动） | Playwright | 同上 | 同上 |

**关键决策**：
- BDD 场景跟现有测试**共用 runner，共用配置**，不新增 npm script；
- BDD 场景随 CI 现有 per-package test job 跑，**0 CI 改造**；
- Playwright BDD 跟现有 e2e 共用 `e2e-start.mjs` 启动逻辑，**0 改造**。

### 5.2 CI 集成（明确边界，避免假护栏）

`.github/workflows/ci.yml` 现有 11 个 job 中，BDD 场景跑在：

| Job | 包含的 BDD | 是否在 `verify:merge` 内 |
|-----|-----------|--------------------------|
| `test-principles-core` | 后端 BDD（随 `npm test`） | **否** |
| `test-pd-cli` | CLI BDD（随 `npm test`） | **否** |
| `test-openclaw-plugin-unit/integration` | （无 BDD，MVP-First 阶段不覆盖 plugin 层） | **否** |
| `test-pd-console` | 单元测试（无 BDD） | **否** |
| `pd-console-e2e.yml`（独立 workflow） | 前端 BDD（随 `npm run test:e2e`） | **否**（独立 workflow） |

**关键诚实声明**（对应 ERR-025/088 风险）：
- `verify:merge`（[package.json L23](../../../package.json)）只跑 9 个静态检查：`check:generated-artifacts`、`check:error-handbook`、`check:repo-hygiene`、`check:runtime-contract`、`check:docs-structure`、`lint`、`build`、`build:pd-cli`、`typecheck:openclaw-plugin`、`typecheck:pd-console`。
- CI 第 105 行明确注释："verify:merge does NOT run package tests"。
- **BDD 场景不在 `verify:merge` 合并门禁内**。它们随 CI per-package test job 跑，但这些 job 是否被 GitHub 配为 required check，决定了 BDD 是否真正阻塞合并。
- Phase 1 不改 required checks 配置。如果 Owner 希望某条 BDD 场景成为合并门禁，需显式在 GitHub branch protection 添加对应 job 为 required check，并在 PR 模板注明。

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

发版前 `npm run verify:merge` **不会**跑 BDD 场景（见 §5.2）。BDD 场景的护栏价值依赖 CI required checks 配置。

**新增的发版检查清单项**（写到 PR 模板）：

```markdown
## BDD 影响评估

- [ ] 本 PR 是否修改了 MVP-Core 用户旅程？如果是，对应 `.feature` 是：
      - [ ] 保持不变（行为契约未变）
      - [ ] 更新（行为契约变化，已在 PR 描述说明原因）
      - [ ] 不适用（说明为什么这条旅程不再适用，例如功能被移除）
- [ ] 本 PR 是否新增/修改了 CLI 命令？如果是，cli-1~cli-7 对应 `.feature` 是否更新？
- [ ] 本 PR 是否触发了 ERR 类？如果是，是否新增了回归 `.feature` scenario？
- [ ] 本 PR 是否删除了 `.feature` 文件？如果是，是否在 PR 描述说明了"行为契约被移除的原因"？
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

**关键约束**（修订：原"不能改 step definitions"规则过硬）：
- AI 助手**可以**修改 step definitions（重构真实接口时是必要的）；
- AI 助手**不能降低 `.feature` 的可观察结果**——任何 `.feature` 行为变化必须 Owner-visible，并在 PR 描述说明原因；
- AI 助手**不能**通过删除 `.feature` 文件或加 `@disabled` 标签让测试绿（除非 PR 描述明确说明行为契约被移除/暂停的原因，且 Owner 已确认）；
- 这条约束写到 AGENTS.md 的 PR Pre-Review Gate 段。

## 6. Phase 划分与范围控制

### 6.1 Phase 1：规约试点（本次实施）

**目标**：让 PD 项目第一次有可执行的 `.feature` 规约，验证整个三层架构，覆盖 3 条最高价值路径。

**范围**：
- 在 root `package.json` 添加 `@cucumber/gherkin` 与 `@cucumber/messages` 到 `devDependencies`；
- 实现 `gherkin-loader.ts`（解析层，~80 行）；
- 实现 `vitest-bdd.ts`（Vitest step runner，~150 行，含 `@disabled` 处理）；
- 实现 `playwright-bdd.ts`（Playwright step runner，~100 行）；
- 实现 `repo-root.ts`（路径解析器，~30 行）；
- 从 `story-a-acceptance.test.ts` / `focus-approve-flow.spec.ts` 抽取共享 helpers 到 `tests/bdd/support/helpers.ts`，让原测试和 BDD steps 共用，避免重复实现；
- **3 个示范 `.feature` 文件**：
  1. `docs/specs/features/story-a/owner-approve-prompt.feature`（后端，从 `story-a-acceptance.test.ts` 抽取）
  2. `docs/specs/features/story-a/owner-approve-prompt-ui.feature`（前端，从 `focus-approve-flow.spec.ts` 抽取）
  3. `docs/specs/features/cli/json-output.feature`（CLI，新建，对应 cli-1）
- 对应的 3 个 step definition 文件；
- 1 个 ADR：`docs/adr/00XX-bdd-specification-layer.md`（记录为什么选方案 A、为什么 `.feature` 集中在 `docs/specs`、为什么不进 `verify:merge`、为什么不进 `src/`）；
- 更新 `AGENTS.md` 和 `CLAUDE.md`：加入"AI 助手改代码前先读 `.feature`"工作流；
- 更新 `.github/PULL_REQUEST_TEMPLATE.md`：加入"BDD 影响评估"段（含 `.feature` 删除强制说明）。

**验收标准**：
1. `cd packages/principles-core && npm test` 跑通后端 BDD 场景；
2. `cd packages/pd-console && npm run test:e2e` 跑通前端 BDD 场景（本地）；
3. `cd packages/pd-cli && npm test` 跑通 CLI BDD 场景；
4. 故意改坏一行代码，BDD 场景失败时报告含完整诊断信息（feature 路径、step source、step trace、redactable state）；
5. 故意删除一个 `.feature` 文件，对应 step definition 文件加载时报错 fail loud（不允许静默通过）；
6. 故意给 scenario 加 `@disabled(reason,owner,date)` 标签，runner 输出显式 skip 报告（含 reason/owner/date）；
7. AI 助手能从 `.feature` 读出"owner approve prompt channel 的行为契约"，无需读 step definitions；
8. `npm run verify:merge` 通过，9 道门无任何改动；
9. `@principles/core` 的 `dist/` 不含 BDD 相关代码（`ls dist/` 不应有 `testing/` 目录）。

**不在 Phase 1 范围**：
- `check:bdd-coverage` 静态检查；
- 全部 PRD 验收矩阵转 `.feature`（只做 3 个示范）；
- Runtime Contract rc-1~rc-9 全部转 `.feature`；
- ERR 类全部转回归 `.feature`；
- 把 BDD 纳入 `verify:merge` 或 CI required checks；
- Cucumber 报告/HTML 输出；
- scenario outline 矩阵化（虽然 Gherkin AST 支持，但 Phase 1 不用）；
- 双语 `.feature` 文件（Phase 1 全中文）。

### 6.2 Phase 2（条件性，需新 issue）：覆盖扩展

**触发条件**（可观察，非主观判断）：
- Phase 1 合并后**至少 2-3 个真实 PR** 中，BDD 场景**实际阻止了**以下任一情况：
  - 误解（AI 助手或开发者误以为某行为是允许的，被 `.feature` 拦下）；
  - 回归（重构破坏了已有用户旅程，被 `.feature` 拦下）；
  - 无用功能扩张（PR 试图添加 `.feature` 未覆盖的边界，被 PR 模板"对应 `.feature` 是否更新"拦下并引发讨论）。
- 且 Owner 在 PR review 中实际读过 `.feature` 文件（PR 评论里有引用）。

**范围**：
- PRD 验收矩阵 8 项全部转 `.feature`（对应 `story-a-acceptance.test.ts` coverage matrix）；
- CLI 契约 cli-1~cli-7 全部转 `.feature`；
- `check:bdd-coverage` 静态检查；
- `@err:ERR-XXX` 标签机制 + 覆盖率扫描；
- 评估是否把核心 BDD 场景加入 CI required checks（需 Owner 决策）。

**MVP-First 红线**：Phase 2 不能引入新运行时依赖，不能改动 `verify:merge` 9 道门结构。

### 6.3 Phase 3（条件性，post-MVP）：Runtime Contract + ERR 全覆盖

**触发条件**：MVP-First 结束，进入 post-MVP 阶段（参考 `post-mvp-conditional-roadmap.md`）。

**范围**：
- rc-1~rc-9 全部转 `.feature`；
- ERR-001~ERR-025+ 高频复现类转回归 `.feature`；
- scenario outline 矩阵化（rc-4 validate-array-elements 这种适合矩阵）；
- 可选：引入更完整的 Cucumber 执行生态（如果 Phase 2 证明现有 runner 不够用）。

## 7. Emotional Value 评估

依据 `docs/.private/product/emotional-value.md`（private junction，主 worktree 可读；当前 worktree 可能未挂载，需在主 worktree 验证）§7：

- **降低的负面情绪**：
  - 失控感（Owner 看不懂测试，"开发说什么就是什么"）
  - 疲惫感（每次发版要重新确认行为没坏）
  - 不信任感（AI 助手改代码可能破坏契约）
- **提升的正面感受**：
  - 沉淀感（行为契约变成可读文档，跨 session 不丢失）
  - 清醒感（看一眼 `.feature` 就知道这个旅程在守护什么）
  - 掌控感（Owner 能直接审阅/修改 `.feature`）
- **不直接服务的**：安心感（BDD 不直接产生安心，安心来自产品行为正确）

**实施时核实**：Phase 1 实施前需确认 `docs/.private/product/emotional-value.md` 在主 worktree 实际可读；如果文件不存在或路径变化，修正本节引用。

## 8. ERR 合规自检

本设计实施前考虑的 ERR 条目：

- **ERR-001 / ERR-005 / ERR-007**（as bypass validation 类）：`gherkin-loader.ts` 解析结果类型固定为 `ParsedScenario[]`，step 函数参数通过 `registry.match()` 类型 narrowed，禁止 `as` 强转。
- **ERR-009 / ERR-010**（fail loud 类）：step 未匹配、fixture 不存在、Gherkin 解析失败、`.feature` 路径解析失败，全部 fail loud。
- **ERR-015 / ERR-018 / ERR-019**（stale loop state 类）：每个 scenario 独立 `StepContext`，禁止跨 scenario 共享 `ctx.state`。
- **ERR-014 / ERR-016 / ERR-017**（safe serialization 类）：`attachments` 单条 body 硬限 4KB；`redactable` 只输出 step 显式标红字段；不输出 `ctx.state` 全部。
- **ERR-002**（silent fallback 类）：step 未匹配不 silently skip，直接抛错；`@disabled` 标签不静默通过，输出显式 skip 报告。
- **ERR-025 / ERR-088**（EP-07：tests prove strings, not real behavior）：本设计最大风险。缓解措施见 §1.4：明确 `verify:merge` 边界、禁用必须显式、路径解析走 repo-root resolver、BDD runner 不进发布包、Phase 2 触发条件可观察。

实施 PR 时会在 PR body 中再次列 ERR checklist。

## 9. 未决问题

- **9.1 pd-console e2e 是否在 CI 跑**：实施时需先核查 `.github/workflows/ci.yml` 与 `packages/pd-console/playwright.config.ts`，以及独立的 `pd-console-e2e.yml`。如果不在 CI 跑，前端 BDD 也只在本地跑，PR 描述需注明"前端 BDD 已本地验证"。
- **9.2 ADR 编号**：实施时确认 `docs/adr/` 下一个可用编号，本设计文档占位为 `00XX`。
- **9.3 Cucumber parser 版本**：实施时锁定兼容的 `@cucumber/gherkin` 与 `@cucumber/messages` 版本并记录到 ADR。两者作为 root devDependencies，可接受，但**不**进任何 package 的 `dependencies`。
- **9.4 `architecture-regression.test.ts` 守卫加强**：当前守卫可能未覆盖"测试代码不进 `src/`"。Phase 1 实施时核查，如未覆盖，新增规则禁止 `packages/principles-core/src/testing/` 之类的目录存在。
- **9.5 `docs/.private/product/emotional-value.md` 可读性**：**已解决**（2026-06-30）。根因：private repo `D:\Code\principles-private` 工作区文件被误删（未提交），通过 `git restore docs/` 恢复；同时 Trae worktree 的 `docs\.private` junction 缺失，通过 `.\scripts\setup-private-docs-symlink.ps1` 重建。文件 7752 bytes / 174 行，通过 worktree junction 可读。

## 10. 参考文档

- [PRODUCT_IDENTITY.md](../../product/PRODUCT_IDENTITY.md) — 产品边界
- [ADR-0014 MVP-First](../../adr/0014-mvp-first-strategy-and-product-pivot.md) — MVP-First 战略
- [TESTING.md](../../process/TESTING.md) — 测试基础设施
- [ERROR_PATTERN_INDEX.md](../../process/error-management/ERROR_PATTERN_INDEX.md) — 错误模式索引（EP-07 / ERR-025 / ERR-088）
- [AGENTS.md](../../../AGENTS.md) — AI 助手工作流
- [package.json verify:merge](../../../package.json) — 合并门禁脚本（L23）
- [ci.yml](../../../.github/workflows/ci.yml) — CI 配置（L105 注释"verify:merge does NOT run package tests"）
- [pd-console-e2e.yml](../../../.github/workflows/pd-console-e2e.yml) — 前端 e2e 独立 workflow
- [story-a-acceptance.test.ts](../../../packages/principles-core/src/runtime-v2/activation/__tests__/story-a-acceptance.test.ts) — 后端切面 step 池
- [focus-approve-flow.spec.ts](../../../packages/pd-console/tests/e2e/focus-approve-flow.spec.ts) — 前端切面 step 池
- `docs/.private/product/emotional-value.md` — 情感价值设计指南（private junction）
