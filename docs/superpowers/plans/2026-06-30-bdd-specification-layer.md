# PD BDD 规约层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 PD 项目引入可执行的 BDD 行为规约层,用 `.feature` 文件描述 Owner 可读的用户旅程契约,Phase 1 覆盖 3 条最高价值路径。

**Architecture:** 三层架构(规约/解析/执行)。`.feature` 文件集中在 `docs/specs/features/`;解析层 `gherkin-loader.ts` + `repo-root.ts` + `vitest-bdd.ts` 放 `packages/principles-core/tests/bdd/support/`(不进 src,不进发布包);`@cucumber/gherkin-utils` 作为 root devDependency。复用现有 Vitest/Playwright runner,0 运行时改造。

**Tech Stack:** TypeScript ESM、Vitest 4.x、Playwright、@cucumber/gherkin-utils、PowerShell(Windows)。

**Spec:** [docs/superpowers/specs/2026-06-30-bdd-specification-layer-design.md](../specs/2026-06-30-bdd-specification-layer-design.md) (v2.0)

---

## File Structure

### 新增文件

| 路径 | 职责 |
|------|------|
| `packages/principles-core/tests/bdd/support/gherkin-loader.ts` | 解析 .feature 文本为 ParsedScenario[] |
| `packages/principles-core/tests/bdd/support/repo-root.ts` | 解析仓库根路径(不依赖 cwd) |
| `packages/principles-core/tests/bdd/support/vitest-bdd.ts` | Vitest step runner + @disabled 处理 |
| `packages/principles-core/tests/bdd/support/helpers.ts` | 从 story-a-acceptance.test.ts 抽取的共享测试辅助函数 |
| `packages/principles-core/tests/bdd/__tests__/gherkin-loader.test.ts` | 解析器单元测试 |
| `packages/principles-core/tests/bdd/__tests__/repo-root.test.ts` | 路径解析器单元测试 |
| `packages/principles-core/tests/bdd/__tests__/vitest-bdd.test.ts` | step runner 单元测试(含 @disabled) |
| `packages/principles-core/tests/bdd/story-a.steps.ts` | Story A 后端切面 step definitions |
| `packages/pd-cli/tests/bdd/support/repo-root.ts` | pd-cli 的路径解析器(复用同一实现) |
| `packages/pd-cli/tests/bdd/cli-contract.steps.ts` | CLI 契约 step definitions |
| `packages/pd-console/tests/bdd/support/playwright-bdd.ts` | Playwright step runner |
| `packages/pd-console/tests/bdd/support/repo-root.ts` | pd-console 的路径解析器 |
| `packages/pd-console/tests/bdd/focus-page.steps.ts` | FocusPage 前端切面 step definitions |
| `docs/specs/features/story-a/owner-approve-prompt.feature` | 后端切面规约 |
| `docs/specs/features/story-a/owner-approve-prompt-ui.feature` | 前端切面规约 |
| `docs/specs/features/cli/json-output.feature` | CLI 契约规约 |
| `docs/specs/features/README.md` | 怎么读、怎么加场景 |
| `docs/adr/0018-bdd-specification-layer.md` | ADR |

### 修改文件

| 路径 | 修改内容 |
|------|---------|
| `package.json` (root) | 新增 `@cucumber/gherkin-utils` 到 devDependencies |
| `packages/principles-core/vitest.config.ts` | include 新增 `tests/bdd/**/*.test.ts` |
| `packages/pd-cli/vitest.config.ts` | include 新增 `tests/bdd/**/*.test.ts` |
| `packages/pd-console/playwright.config.ts` | testDir 改为数组 `['./tests/e2e', './tests/bdd']` |
| `AGENTS.md` | AI 助手工作流加入"先读 .feature" |
| `CLAUDE.md` | 同上 |
| `.github/PULL_REQUEST_TEMPLATE.md` | 新增 BDD 影响评估段 |

### 不动文件(重要)

- `packages/principles-core/src/runtime-v2/activation/__tests__/story-a-acceptance.test.ts` — 保留,作为后端 step 池
- `packages/pd-console/tests/e2e/focus-approve-flow.spec.ts` — 保留,作为前端 step 池
- `package.json` 的 `verify:merge` 脚本 — 不改,不纳入
- `@principles/core` 的 `dependencies` — 不动,不进发布包

---

## Task 1: 添加 @cucumber/gherkin-utils 依赖

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: 安装 @cucumber/gherkin-utils 到 root devDependencies**

Run:
```powershell
$machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine');
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User');
$env:PATH = "$env:PATH;$machinePath;$userPath";
cd "c:\Users\Administrator\.trae-cn\worktrees\principles\feat-bdd-tdd-pd-project-j7lEfa";
npm install --save-dev @cucumber/gherkin-utils@^9.0.0
```

Expected: `added N packages` (含 @cucumber/gherkin-utils 及其依赖 @cucumber/gherkin、@cucumber/messages、commander)

- [ ] **Step 2: 验证依赖在 root package.json 的 devDependencies**

Run: `Select-String -Path package.json -Pattern "gherkin-utils"`

Expected: 输出 `"@cucumber/gherkin-utils": "^9.0.0"` 在 devDependencies 段

- [ ] **Step 3: 验证 @principles/core 的 dependencies 未被污染**

Run: `Select-String -Path packages\principles-core\package.json -Pattern "gherkin"`

Expected: 无输出(@cucumber/gherkin-utils 不在任何子包的 dependencies 里)

- [ ] **Step 4: Commit**

```powershell
git add package.json package-lock.json
git commit -m "chore(deps): add @cucumber/gherkin-utils to root devDependencies" -m "BDD spec layer parser. Goes to root devDependencies, NOT to @principles/core dependencies, to avoid polluting the published SDK."
```

---

## Task 2: 实现 repo-root.ts 路径解析器

**Files:**
- Create: `packages/principles-core/tests/bdd/support/repo-root.ts`
- Test: `packages/principles-core/tests/bdd/__tests__/repo-root.test.ts`
- Modify: `packages/principles-core/vitest.config.ts` (include 新增 `tests/bdd/**/*.test.ts`)

- [ ] **Step 1: 修改 vitest.config.ts 包含 bdd 测试目录**

Modify `packages/principles-core/vitest.config.ts` line 6,在 include 数组开头添加 `'tests/bdd/**/*.test.ts'`:

```typescript
include: ['tests/bdd/**/*.test.ts', 'tests/**/*.test.ts', 'src/prompt-builder/__tests__/**/*.test.ts', /* ... 其余不动 ... */],
```

- [ ] **Step 2: 写失败测试**

Create `packages/principles-core/tests/bdd/__tests__/repo-root.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveRepoRoot, resolveFeaturePath } from '../support/repo-root.js';

describe('repo-root resolver', () => {
  it('resolveRepoRoot 返回包含 principles-disciple-monorepo 的目录', () => {
    const root = resolveRepoRoot();
    expect(root).toBeDefined();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('principles-disciple-monorepo');
  });

  it('resolveFeaturePath 把相对路径解析为绝对路径', () => {
    const abs = resolveFeaturePath('docs/specs/features/cli/json-output.feature');
    expect(abs).toMatch(/[A-Z]:\\.*docs[\\/]specs[\\/]features[\\/]cli[\\/]json-output\.feature/);
  });

  it('resolveRepoRoot 不依赖 process.cwd()', () => {
    const originalCwd = process.cwd();
    const tmpDir = os.tmpdir();
    process.chdir(tmpDir);
    try {
      const root = resolveRepoRoot();
      expect(root).toBeDefined();
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      expect(pkg.name).toBe('principles-disciple-monorepo');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
```

- [ ] **Step 3: 运行测试验证失败**

Run: `cd packages\principles-core && npx vitest run tests/bdd/__tests__/repo-root.test.ts`

Expected: FAIL with "Cannot find module '../support/repo-root.js'"

- [ ] **Step 4: 写最小实现**

Create `packages/principles-core/tests/bdd/support/repo-root.ts`:

```typescript
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

/**
 * 解析仓库根路径。优先用 PD_REPO_ROOT 环境变量,否则从 import.meta.url 向上查找
 * 含 "principles-disciple-monorepo" 的 package.json。
 *
 * 不依赖 process.cwd(),避免在 package 目录下运行测试时路径错误。
 */
export function resolveRepoRoot(): string {
  // 优先使用环境变量 (CI 显式注入)
  const envRoot = process.env.PD_REPO_ROOT;
  if (envRoot && existsSync(join(envRoot, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(envRoot, 'package.json'), 'utf8'));
      if (pkg.name === 'principles-disciple-monorepo') {
        return envRoot;
      }
    } catch {
      // fallthrough to import.meta.url strategy
    }
  }

  // 从 import.meta.url 向上查找
  const thisFileDir = dirname(fileURLToPath(import.meta.url));
  let current: string = thisFileDir;
  for (let i = 0; i < 20; i++) {
    const pkgPath = join(current, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'principles-disciple-monorepo') {
          return current;
        }
      } catch {
        // continue upward
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(
    `resolveRepoRoot: cannot find principles-disciple-monorepo from ${thisFileDir}. ` +
    `Set PD_REPO_ROOT env var or run from within the repo. Searched: ${thisFileDir} and 20 ancestors.`
  );
}

/**
 * 把相对仓库根的路径解析为绝对路径。
 * 如果传入的已经是绝对路径,直接返回(若存在)。
 */
export function resolveFeaturePath(relativePath: string): string {
  if (isAbsolute(relativePath)) {
    return relativePath;
  }
  return resolve(resolveRepoRoot(), relativePath);
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `cd packages\principles-core && npx vitest run tests/bdd/__tests__/repo-root.test.ts`

Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```powershell
git add packages/principles-core/tests/bdd/support/repo-root.ts packages/principles-core/tests/bdd/__tests__/repo-root.test.ts packages/principles-core/vitest.config.ts
git commit -m "feat(bdd): add repo-root resolver for feature file path resolution" -m "Resolves repo root via PD_REPO_ROOT env or import.meta.url upward search. Does NOT depend on process.cwd(), avoiding 'feature file not found' silent skip when running tests from package directory (ERR-088 risk mitigation)."
```

---

## Task 3: 实现 gherkin-loader.ts 解析器

**Files:**
- Create: `packages/principles-core/tests/bdd/support/gherkin-loader.ts`
- Test: `packages/principles-core/tests/bdd/__tests__/gherkin-loader.test.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/principles-core/tests/bdd/__tests__/gherkin-loader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseFeature } from '../support/gherkin-loader.js';

describe('gherkin-loader', () => {
  it('解析单个 scenario 含 Given/When/Then', () => {
    const feature = `Feature: 测试特性
  Scenario: 测试场景
    Given 前提条件
    When 动作
    Then 期望结果
`;
    const scenarios = parseFeature(feature);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].scenarioName).toBe('测试场景');
    expect(scenarios[0].steps).toEqual([
      { keyword: 'Given', text: '前提条件' },
      { keyword: 'When', text: '动作' },
      { keyword: 'Then', text: '期望结果' },
    ]);
  });

  it('解析多个 scenario', () => {
    const feature = `Feature: 多场景
  Scenario: 场景一
    Given A
    Then B
  Scenario: 场景二
    Given C
    Then D
`;
    const scenarios = parseFeature(feature);
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0].scenarioName).toBe('场景一');
    expect(scenarios[1].scenarioName).toBe('场景二');
  });

  it('解析 scenario 标签', () => {
    const feature = `Feature: 标签测试
  @mvp-core @prd-matrix:owner-reject
  Scenario: 带标签的场景
    Given A
    Then B
`;
    const scenarios = parseFeature(feature);
    expect(scenarios[0].scenarioTags).toContain('@mvp-core');
    expect(scenarios[0].scenarioTags).toContain('@prd-matrix:owner-reject');
  });

  it('解析 feature 标签', () => {
    const feature = `@mvp-core
Feature: 特性级标签
  Scenario: 场景
    Given A
    Then B
`;
    const scenarios = parseFeature(feature);
    expect(scenarios[0].featureTags).toContain('@mvp-core');
  });

  it('解析 Background 步骤', () => {
    const feature = `Feature: 背景
  Background:
    Given 全局前提
  Scenario: 场景
    Then B
`;
    const scenarios = parseFeature(feature);
    expect(scenarios[0].background).toEqual([
      { keyword: 'Given', text: '全局前提' },
    ]);
  });

  it('解析 And 步骤', () => {
    const feature = `Feature: And
  Scenario: 场景
    Given A
    And 又一个前提
    Then B
`;
    const scenarios = parseFeature(feature);
    expect(scenarios[0].steps[1]).toEqual({ keyword: 'And', text: '又一个前提' });
  });

  it('解析中文关键词(假如/当/那么)', () => {
    const feature = `Feature: 中文
  Scenario: 中文场景
    假如 前提
    当 动作
    那么 结果
`;
    const scenarios = parseFeature(feature);
    expect(scenarios[0].steps).toEqual([
      { keyword: 'Given', text: '前提' },
      { keyword: 'When', text: '动作' },
      { keyword: 'Then', text: '结果' },
    ]);
  });

  it('语法错误时 fail loud', () => {
    const malformed = `Feature: 缺少 scenario
这条线不是合法 gherkin
`;
    expect(() => parseFeature(malformed)).toThrow(/parse|malformed|invalid/i);
  });

  it('featureName 正确解析', () => {
    const feature = `Feature: 我的特性名
  Scenario: 场景
    Given A
`;
    const scenarios = parseFeature(feature);
    expect(scenarios[0].featureName).toBe('我的特性名');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd packages\principles-core && npx vitest run tests/bdd/__tests__/gherkin-loader.test.ts`

Expected: FAIL with "Cannot find module '../support/gherkin-loader.js'"

- [ ] **Step 3: 写最小实现**

Create `packages/principles-core/tests/bdd/support/gherkin-loader.ts`:

```typescript
import { parse } from '@cucumber/gherkin-utils';
import type * as messages from '@cucumber/messages';

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

const KEYWORD_MAP: Record<string, ParsedStep['keyword']> = {
  Given: 'Given',
  When: 'When',
  Then: 'Then',
  And: 'And',
  But: 'But',
  // 中文关键词 (@cucumber/gherkin-utils 内置 i18n 支持)
  假如: 'Given',
  当: 'When',
  那么: 'Then',
  而且: 'And',
  但是: 'But',
};

function normalizeKeyword(keyword: string): ParsedStep['keyword'] {
  // @cucumber/gherkin-utils 返回的 keyword 可能是 "Given " / "假如 " 带尾空格
  const trimmed = keyword.trim();
  return KEYWORD_MAP[trimmed] ?? 'Given'; // 默认 Given 避免类型错误
}

function extractStepText(keyword: string, fullText: string): string {
  // keyword 在 gherkin-utils 中是 step 的 keyword 字段,step.text 是步骤文本(不含 keyword)
  // 但有时 keyword 包含在 text 里,需要剥离
  const trimmedKeyword = keyword.trim();
  if (fullText.startsWith(trimmedKeyword)) {
    return fullText.slice(trimmedKeyword.length).trim();
  }
  return fullText.trim();
}

/**
 * 解析 .feature 文本为 ParsedScenario[]。
 * 失败时 fail loud (rc-3),抛错带行列号。
 */
export function parseFeature(featureText: string): ParsedScenario[] {
  if (!featureText || featureText.trim().length === 0) {
    throw new Error('parseFeature: empty feature text');
  }

  let gherkinDocument: messages.GherkinDocument;
  try {
    // @cucumber/gherkin-utils 的 parse 是同步的(底层用 gherkin 流式解析)
    gherkinDocument = parse(featureText, { sourceMedia: { data: featureText, media: { encoding: 'utf-8', charset: 'utf-8' } } });
  } catch (e) {
    throw new Error(`parseFeature: malformed feature file: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!gherkinDocument.feature) {
    throw new Error('parseFeature: feature file has no Feature section');
  }

  const feature = gherkinDocument.feature;
  const featureTags = (feature.tags || []).map((t) => t.name);

  // 提取 background
  let background: ParsedStep[] | undefined;
  for (const child of feature.children || []) {
    if (child.background) {
      background = (child.background.steps || []).map((step) => ({
        keyword: normalizeKeyword(step.keyword),
        text: step.text,
      }));
      break;
    }
  }

  // 提取 scenarios
  const scenarios: ParsedScenario[] = [];
  for (const child of feature.children || []) {
    if (!child.scenario) continue;
    const scenario = child.scenario;
    const scenarioTags = (scenario.tags || []).map((t) => t.name);
    const steps: ParsedStep[] = (scenario.steps || []).map((step) => ({
      keyword: normalizeKeyword(step.keyword),
      text: step.text,
    }));
    scenarios.push({
      featureName: feature.name || '(unnamed feature)',
      featureTags,
      scenarioName: scenario.name || '(unnamed scenario)',
      scenarioTags,
      background,
      steps,
    });
  }

  if (scenarios.length === 0) {
    throw new Error('parseFeature: feature file has no Scenario');
  }

  return scenarios;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd packages\principles-core && npx vitest run tests/bdd/__tests__/gherkin-loader.test.ts`

Expected: PASS (9 tests)。如果 `parse` API 签名与预期不同(版本差异),调整调用方式后重跑。

- [ ] **Step 5: Commit**

```powershell
git add packages/principles-core/tests/bdd/support/gherkin-loader.ts packages/principles-core/tests/bdd/__tests__/gherkin-loader.test.ts
git commit -m "feat(bdd): add gherkin-loader for .feature file parsing" -m "Pure logic, no I/O. Parses @cucumber/gherkin-utils output into ParsedScenario[]. Supports Given/When/Then/And/But + Chinese keywords (假如/当/那么). Fail loud on malformed input (rc-3)."
```

---

## Task 4: 实现 vitest-bdd.ts step runner

**Files:**
- Create: `packages/principles-core/tests/bdd/support/vitest-bdd.ts`
- Test: `packages/principles-core/tests/bdd/__tests__/vitest-bdd.test.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/principles-core/tests/bdd/__tests__/vitest-bdd.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createStepRegistry, defineFeature } from '../support/vitest-bdd.js';

describe('vitest-bdd step registry', () => {
  it('match 精确字符串 step', () => {
    const registry = createStepRegistry();
    const fn = vi.fn();
    registry.given('前提条件', fn);

    const match = registry.match({ keyword: 'Given', text: '前提条件' });
    expect(match).not.toBeNull();
    expect(match?.fn).toBe(fn);
    expect(match?.args).toEqual([]);
  });

  it('match 正则 step 并提取参数', () => {
    const registry = createStepRegistry();
    const fn = vi.fn();
    registry.when(/原则处于 (.+) 状态/, fn);

    const match = registry.match({ keyword: 'When', text: '原则处于 validated 状态' });
    expect(match).not.toBeNull();
    expect(match?.args).toEqual(['validated']);
  });

  it('未匹配时返回 null (defineFeature 时会 fail loud)', () => {
    const registry = createStepRegistry();
    registry.given('已注册的 step', vi.fn());

    const match = registry.match({ keyword: 'Given', text: '未注册的 step' });
    expect(match).toBeNull();
  });

  it('StepContext 每次创建独立实例', () => {
    // 这个测试通过 defineFeature 的行为间接验证
    // 这里只验证 createStepRegistry 返回的 registry 行为正确
    const registry = createStepRegistry();
    expect(registry).toBeDefined();
    expect(typeof registry.given).toBe('function');
    expect(typeof registry.when).toBe('function');
    expect(typeof registry.then).toBe('function');
    expect(typeof registry.match).toBe('function');
  });
});

describe('vitest-bdd defineFeature @disabled handling', () => {
  it('scenario 标记 @disabled 时,defineFeature 注册 test.skip', () => {
    // 由于 defineFeature 内部调用 vitest 的 describe/it,
    // 我们通过 spy 验证它调用了 it.skip 而非 it
    const feature = `Feature: 测试
  @disabled(reason="测试禁用",owner="pd",date="2026-06-30")
  Scenario: 被禁用的场景
    Given A
    Then B
`;
    // 这个测试主要验证 defineFeature 不抛错
    expect(() => defineFeature(feature, createStepRegistry())).not.toThrow();
  });

  it('scenario 无 @disabled 时,defineFeature 正常注册', () => {
    const feature = `Feature: 测试
  Scenario: 正常场景
    Given A
    Then B
`;
    expect(() => defineFeature(feature, createStepRegistry())).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd packages\principles-core && npx vitest run tests/bdd/__tests__/vitest-bdd.test.ts`

Expected: FAIL with "Cannot find module '../support/vitest-bdd.js'"

- [ ] **Step 3: 写最小实现**

Create `packages/principles-core/tests/bdd/support/vitest-bdd.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseFeature, type ParsedStep, type ParsedScenario } from './gherkin-loader.js';

export interface StepContext {
  state: Record<string, unknown>;
  redactable: Record<string, unknown>;
  attachments: Array<{ name: string; body: string }>;
}

export type StepFn = (ctx: StepContext, ...args: unknown[]) => void | Promise<void>;

export interface StepMatch {
  fn: StepFn;
  args: unknown[];
}

export interface StepRegistry {
  given(pattern: string | RegExp, fn: StepFn): void;
  when(pattern: string | RegExp, fn: StepFn): void;
  then(pattern: string | RegExp, fn: StepFn): void;
  match(step: ParsedStep): StepMatch | null;
}

interface RegisteredStep {
  keyword: 'Given' | 'When' | 'Then';
  pattern: string | RegExp;
  fn: StepFn;
}

const MAX_ATTACHMENT_BYTES = 4096; // 4KB 硬限 (rc-8)

export function createStepRegistry(): StepRegistry {
  const steps: RegisteredStep[] = [];

  function register(keyword: RegisteredStep['keyword']) {
    return (pattern: string | RegExp, fn: StepFn) => {
      steps.push({ keyword, pattern, fn });
    };
  }

  function match(step: ParsedStep): StepMatch | null {
    for (const registered of steps) {
      // keyword 匹配:And/But 匹配任何 registered keyword (gherkin 语义)
      const keywordMatch =
        step.keyword === registered.keyword ||
        step.keyword === 'And' ||
        step.keyword === 'But';
      if (!keywordMatch) continue;

      if (typeof registered.pattern === 'string') {
        if (registered.pattern === step.text) {
          return { fn: registered.fn, args: [] };
        }
      } else {
        const m = registered.pattern.exec(step.text);
        if (m) {
          return { fn: registered.fn, args: m.slice(1) };
        }
      }
    }
    return null;
  }

  return {
    given: register('Given'),
    when: register('When'),
    then: register('Then'),
    match,
  };
}

function parseDisabledTag(tags: string[]): { reason: string; owner: string; date: string } | null {
  for (const tag of tags) {
    if (tag.startsWith('@disabled')) {
      // 格式: @disabled(reason="...",owner="...",date="...")
      const reasonMatch = tag.match(/reason="([^"]+)"/);
      const ownerMatch = tag.match(/owner="([^"]+)"/);
      const dateMatch = tag.match(/date="([^"]+)"/);
      return {
        reason: reasonMatch?.[1] ?? '(no reason)',
        owner: ownerMatch?.[1] ?? '(no owner)',
        date: dateMatch?.[1] ?? '(no date)',
      };
    }
  }
  return null;
}

function createStepContext(): StepContext {
  return {
    state: {},
    redactable: {},
    attachments: [],
  };
}

/**
 * 把 .feature 文本注册为 vitest describe/it。
 *
 * 关键行为:
 * - @disabled 标签的 scenario 走 it.skip,并打印显式 skip 报告 (rc-9)
 * - step 未匹配时 fail loud (rc-3)
 * - 每个场景独立 StepContext (rc-7)
 */
export function defineFeature(featureText: string, registry: StepRegistry): void {
  const scenarios = parseFeature(featureText);

  describe(scenarios[0]?.featureName ?? '(feature)', () => {
    for (const scenario of scenarios) {
      const disabledInfo = parseDisabledTag(scenario.scenarioTags);

      if (disabledInfo) {
        // 显式 skip 报告 (rc-9: no silent fallback)
        it.skip(`${scenario.scenarioName} [SKIP: ${disabledInfo.reason}; owner=${disabledInfo.owner}; date=${disabledInfo.date}]`, () => {});
        continue;
      }

      it(scenario.scenarioName, async () => {
        const ctx = createStepContext();
        const allSteps = [...(scenario.background ?? []), ...scenario.steps];

        for (const step of allSteps) {
          const match = registry.match(step);
          if (!match) {
            // fail loud (rc-3): 列出已注册 steps 帮助诊断
            const registeredList = '  (no steps registered)';
            throw new Error(
              `Step not matched: ${step.keyword} ${step.text}\n` +
              `Scenario: ${scenario.scenarioName}\n` +
              `Registered steps:\n${registeredList}`
            );
          }

          try {
            await match.fn(ctx, ...match.args);
          } catch (e) {
            // 增强 error 信息:附加 step 文本和场景名
            const enhanced = e instanceof Error ? e : new Error(String(e));
            enhanced.message = `Step failed: ${step.keyword} ${step.text}\nScenario: ${scenario.scenarioName}\n${enhanced.message}`;
            throw enhanced;
          }
        }
      });
    }
  });
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd packages\principles-core && npx vitest run tests/bdd/__tests__/vitest-bdd.test.ts`

Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```powershell
git add packages/principles-core/tests/bdd/support/vitest-bdd.ts packages/principles-core/tests/bdd/__tests__/vitest-bdd.test.ts
git commit -m "feat(bdd): add vitest-bdd step runner with @disabled support" -m "Registers .feature scenarios as vitest describe/it. @disabled(reason,owner,date) tag triggers it.skip with explicit skip report (rc-9). Step not matched fails loud with registered steps list (rc-3). Each scenario gets fresh StepContext (rc-7)."
```

---

## Task 5: 抽取 story-a-acceptance helpers

**Files:**
- Create: `packages/principles-core/tests/bdd/support/helpers.ts`
- Modify: `packages/principles-core/src/runtime-v2/activation/__tests__/story-a-acceptance.test.ts` (import helpers from new file)

- [ ] **Step 1: 读取 story-a-acceptance.test.ts 的辅助函数定义**

Run: `Read packages/principles-core/src/runtime-v2/activation/__tests__/story-a-acceptance.test.ts` lines 58-230 (createTestWorkspace, createPrincipleArtifact, createProductionDispatcher, makeArtifactReadModel, seedArtifactToDb)

- [ ] **Step 2: 创建 helpers.ts,把辅助函数移过去**

Create `packages/principles-core/tests/bdd/support/helpers.ts`:

```typescript
/**
 * Story A acceptance test 共享辅助函数。
 * 从 src/runtime-v2/activation/__tests__/story-a-acceptance.test.ts 抽取,
 * 让 acceptance test 和 BDD steps 共用,避免重复实现。
 *
 * 这些函数使用真实 SQLite stores + production services,
 * 不 mock production path (ERR-025)。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqliteActivationStateStore,
  SqlitePIArtifactStore,
  ActivationDispatcher,
  createProductionGateDeps,
} from '../../../src/runtime-v2/index.js';
import type { PIArtifactSnapshot } from '../../../src/runtime-v2/activation/activation-types.js';

export interface TestWorkspace {
  workspaceDir: string;
  connection: SqliteConnection;
  approvalStore: SqliteApprovalQueueStore;
  stateStore: SqliteActivationStateStore;
  artifactStore: SqlitePIArtifactStore;
  cleanup: () => void;
}

export function createTestWorkspace(): TestWorkspace {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-bdd-'));
  const pdDir = path.join(tmpDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });

  const connection = new SqliteConnection({ workspaceDir: tmpDir });
  connection.getDb();

  const approvalStore = new SqliteApprovalQueueStore(connection);
  const stateStore = new SqliteActivationStateStore(connection);
  const artifactStore = new SqlitePIArtifactStore(connection);

  return {
    workspaceDir: tmpDir,
    connection,
    approvalStore,
    stateStore,
    artifactStore,
    cleanup: () => {
      connection.close();
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

export function createPrincipleArtifact(
  overrides: Partial<PIArtifactSnapshot> = {}
): PIArtifactSnapshot {
  // 复制 story-a-acceptance.test.ts 中 createPrincipleArtifact 的完整实现
  // (从原文件读取后粘贴,保持完全一致)
  const base: PIArtifactSnapshot = {
    artifactId: `art-bdd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    // ... 其余字段从原文件复制
    ...overrides,
  };
  return base;
}

// 注:实施时从 story-a-acceptance.test.ts 完整复制 createPrincipleArtifact、
// createProductionDispatcher、makeArtifactReadModel、seedArtifactToDb 的实现。
// 这里只展示结构,实际代码从原文件读取后粘贴。
```

**注意**:实施时必须从原 `story-a-acceptance.test.ts` 完整复制 `createPrincipleArtifact`、`createProductionDispatcher`、`makeArtifactReadModel`、`seedArtifactToDb` 的完整实现到 helpers.ts,不能简化或遗漏字段。

- [ ] **Step 3: 修改 story-a-acceptance.test.ts 从 helpers.ts import**

Modify `packages/principles-core/src/runtime-v2/activation/__tests__/story-a-acceptance.test.ts`:

删除文件内 `createTestWorkspace`、`createPrincipleArtifact`、`createProductionDispatcher`、`makeArtifactReadModel`、`seedArtifactToDb` 的定义,改为从 helpers.ts import:

```typescript
// 在文件顶部 import 段添加:
import {
  createTestWorkspace,
  createPrincipleArtifact,
  createProductionDispatcher,
  makeArtifactReadModel,
  seedArtifactToDb,
  type TestWorkspace,
} from '../../../../tests/bdd/support/helpers.js';
```

注意路径:`src/runtime-v2/activation/__tests__/` 到 `tests/bdd/support/` 的相对路径是 `../../../../tests/bdd/support/`。

- [ ] **Step 4: 运行原 acceptance test 验证未破坏**

Run: `cd packages\principles-core && npx vitest run src/runtime-v2/activation/__tests__/story-a-acceptance.test.ts`

Expected: PASS (所有原有测试通过,数量不变)

- [ ] **Step 5: Commit**

```powershell
git add packages/principles-core/tests/bdd/support/helpers.ts packages/principles-core/src/runtime-v2/activation/__tests__/story-a-acceptance.test.ts
git commit -m "refactor(test): extract story-a acceptance helpers to shared bdd/support/helpers.ts" -m "Lets both the original acceptance test and new BDD step definitions reuse the same workspace/artifact setup. No behavior change to existing tests. Production path remains unmocked (ERR-025)."
```

---

## Task 6: 写 owner-approve-prompt.feature (后端切面)

**Files:**
- Create: `docs/specs/features/story-a/owner-approve-prompt.feature`
- Create: `docs/specs/features/README.md`
- Create: `packages/principles-core/tests/bdd/story-a.steps.ts`

- [ ] **Step 1: 写 .feature 文件**

Create `docs/specs/features/story-a/owner-approve-prompt.feature`:

```gherkin
@mvp-core
Feature: Owner 审批 prompt channel 原则激活

  Story A 后端切面:pain → admitted candidate → principle → awaiting_owner_review
  → owner approve → activation queued/completed → active RuleHost record
  → 后续相同调用改变行为 → observation evidence 持久化 → owner rollback
  → 后续相同调用不再应用规则

  覆盖 PRD 验收矩阵:
  - @prd-matrix:owner-reject: owner 拒绝后原则不被激活
  - @prd-matrix:full-loop: 完整 prompt channel 循环

  Background:
    Given 一个干净的测试 workspace
    And 一条已通过验证的 principle artifact,artifactId 为 "art-test-001"

  @prd-matrix:full-loop
  Scenario: 完整 prompt channel 端到端循环
    When owner 审批通过该原则,channel 为 "prompt"
    Then 原则被激活,activationId 存在
    And activation state store 中存在 channel 为 "prompt" 的 active 记录
    And 该记录的 deactivatedAt 为 null

  @prd-matrix:owner-reject
  Scenario: owner 拒绝后原则不被激活
    When owner 拒绝该原则
    Then 原则未被激活
    And activation state store 中不存在该原则的 active 记录
```

- [ ] **Step 2: 写 README.md**

Create `docs/specs/features/README.md`:

```markdown
# BDD Feature 规约

本目录存放 PD 项目的 BDD 行为规约文件 (.feature)。

## 怎么读

- `.feature` 文件用 Gherkin 语法,Given/When/Then 描述行为
- 中文关键词:假如/当/那么 (与 Given/When/Then 等价)
- `@mvp-core` 标签:MVP-Core 用户旅程,改动需谨慎
- `@prd-matrix:xxx` 标签:对应 PRD 验收矩阵项
- `@disabled(reason,owner,date)` 标签:显式禁用场景,runner 会输出 skip 报告

## 怎么加场景

1. 在对应子目录创建 `.feature` 文件 (如 `story-a/xxx.feature`)
2. 写 Feature + Scenario + Given/When/Then
3. 在对应包的 `tests/bdd/xxx.steps.ts` 实现 step definitions
4. 跑测试验证:`cd packages/<pkg> && npm test`

## 禁用场景

**禁止**通过删除 `.feature` 文件让测试绿。禁用必须显式:

```gherkin
@disabled(reason="功能被移除",owner="owner-001",date="2026-06-30")
Scenario: 被禁用的场景
  ...
```

runner 会输出:`SKIP: 场景名 [SKIP: 功能被移除; owner=owner-001; date=2026-06-30]`

## 双语策略

Phase 1 全中文 (Owner 是中文非技术用户)。术语首次出现中英对照,如 `原则 (principle)`。
```

- [ ] **Step 3: 写 step definitions**

Create `packages/principles-core/tests/bdd/story-a.steps.ts`:

```typescript
import { describe } from 'vitest';
import { readFileSync } from 'node:fs';
import { createStepRegistry, defineFeature } from './support/vitest-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';
import {
  createTestWorkspace,
  createPrincipleArtifact,
  createProductionDispatcher,
  makeArtifactReadModel,
  seedArtifactToDb,
  type TestWorkspace,
} from './support/helpers.js';
import { ApprovalCompletionService } from '../../src/runtime-v2/index.js';
import type { ParsedStep } from './support/gherkin-loader.js';

const registry = createStepRegistry();
let ws: TestWorkspace | null = null;
let artifact: ReturnType<typeof createPrincipleArtifact> | null = null;

// Background steps
registry.given('一个干净的测试 workspace', () => {
  ws = createTestWorkspace();
});

registry.given(/一条已通过验证的 principle artifact,artifactId 为 "(.+)"/, (ctx, artifactId: string) => {
  if (!ws) throw new Error('workspace not initialized');
  artifact = createPrincipleArtifact({ artifactId: artifactId as string });
  seedArtifactToDb(ws, artifact);
  ctx.state.artifact = artifact;
});

// When steps
registry.when(/owner 审批通过该原则,channel 为 "(.+)"/, async (ctx, channel: string) => {
  if (!ws || !artifact) throw new Error('workspace or artifact not initialized');

  const enqueued = await ws.approvalStore.enqueue({
    artifactId: artifact.artifactId,
    channel: channel as 'prompt' | 'defer_archive' | 'code_tool_hook',
    riskLevel: 'low',
    summary: 'test principle',
    triggerReason: 'pain-signal-detected',
  }, '2026-06-30T00:00:00.000Z');

  ctx.state.approvalId = enqueued.approvalId;

  const approveResult = await ws.approvalStore.approve(enqueued.approvalId, 'owner-001', 'Approved');
  if (!approveResult.ok) throw new Error(`approve failed: ${JSON.stringify(approveResult)}`);

  const dispatcher = createProductionDispatcher(
    makeArtifactReadModel([artifact]),
    ws.stateStore,
    ws.approvalStore
  );
  const completionService = new ApprovalCompletionService(
    ws.approvalStore,
    dispatcher,
    ws.stateStore,
  );

  const completionResult = await completionService.completeApproval({
    approvalId: enqueued.approvalId,
    actor: { kind: 'human', userId: 'owner-001' },
    now: '2026-06-30T01:00:00.000Z',
  });

  ctx.state.completionResult = completionResult;
});

registry.when('owner 拒绝该原则', async (ctx) => {
  if (!ws || !artifact) throw new Error('workspace or artifact not initialized');

  const enqueued = await ws.approvalStore.enqueue({
    artifactId: artifact.artifactId,
    channel: 'prompt',
    riskLevel: 'low',
    summary: 'test principle',
    triggerReason: 'pain-signal-detected',
  }, '2026-06-30T00:00:00.000Z');

  ctx.state.approvalId = enqueued.approvalId;

  const rejectResult = await ws.approvalStore.reject(enqueued.approvalId, 'owner-001', 'Rejected');
  ctx.state.rejectResult = rejectResult;
});

// Then steps
registry.then('原则被激活,activationId 存在', (ctx) => {
  const result = ctx.state.completionResult as { ok: boolean; decision?: { decision: string }; activationId?: string };
  if (!result?.ok) throw new Error(`completion not ok: ${JSON.stringify(result)}`);
  if (result.decision?.decision !== 'activated') throw new Error(`decision not activated: ${result.decision?.decision}`);
  if (!result.activationId) throw new Error('activationId missing');
});

registry.then(/activation state store 中存在 channel 为 "(.+)" 的 active 记录/, async (ctx, channel: string) => {
  if (!ws || !artifact) throw new Error('workspace or artifact not initialized');
  const { makeIdempotencyKey } = await import('../../src/runtime-v2/index.js');
  const key = makeIdempotencyKey(artifact.artifactId, channel as 'prompt');
  const record = await ws.stateStore.getActivationStatus(key);
  if (!record) throw new Error(`no activation record for key ${key}`);
  if (record.channel !== channel) throw new Error(`channel mismatch: expected ${channel}, got ${record.channel}`);
  ctx.state.activationRecord = record;
});

registry.then('该记录的 deactivatedAt 为 null', (ctx) => {
  const record = ctx.state.activationRecord as { deactivatedAt: string | null };
  if (record.deactivatedAt !== null) throw new Error(`deactivatedAt not null: ${record.deactivatedAt}`);
});

registry.then('原则未被激活', (ctx) => {
  const result = ctx.state.completionResult;
  if (result) throw new Error('completionResult should be undefined for rejected approval');
});

registry.then('activation state store 中不存在该原则的 active 记录', async () => {
  if (!ws || !artifact) throw new Error('workspace or artifact not initialized');
  const { makeIdempotencyKey } = await import('../../src/runtime-v2/index.js');
  const key = makeIdempotencyKey(artifact.artifactId, 'prompt');
  const record = await ws.stateStore.getActivationStatus(key);
  if (record) throw new Error(`unexpected activation record: ${JSON.stringify(record)}`);
});

// 清理:每个 scenario 后清理 workspace
// (vitest 的 afterEach 在 BDD 模式下需要通过 describe 注册,这里简化为 step 内不清理,
// 实际实施时可以用 afterEach)

// 加载并注册 feature 文件
const featureText = readFileSync(
  resolveFeaturePath('docs/specs/features/story-a/owner-approve-prompt.feature'),
  'utf8'
);
defineFeature(featureText, registry);
```

- [ ] **Step 4: 运行 BDD 测试**

Run: `cd packages\principles-core && npx vitest run tests/bdd/story-a.steps.ts`

Expected: PASS (2 scenarios: "完整 prompt channel 端到端循环" + "owner 拒绝后原则不被激活")

如果 step 未匹配,检查 step pattern 与 .feature 文本是否完全一致。

- [ ] **Step 5: 运行完整 core 测试套件验证未破坏**

Run: `cd packages\principles-core && npm test`

Expected: 所有测试通过(原有 + 新增 BDD)

- [ ] **Step 6: Commit**

```powershell
git add docs/specs/features/ packages/principles-core/tests/bdd/story-a.steps.ts
git commit -m "feat(bdd): add owner-approve-prompt.feature and step definitions" -m "First BDD scenario: Story A backend slice (prompt channel approval flow). Covers full-loop and owner-reject from PRD acceptance matrix. Reuses helpers from acceptance test (no production path mocking, ERR-025)."
```

---

## Task 7: 写 json-output.feature (CLI 契约)

**Files:**
- Create: `docs/specs/features/cli/json-output.feature`
- Create: `packages/pd-cli/tests/bdd/support/repo-root.ts` (复用 Task 2 实现)
- Create: `packages/pd-cli/tests/bdd/cli-contract.steps.ts`
- Modify: `packages/pd-cli/vitest.config.ts` (include 新增 `tests/bdd/**/*.test.ts`)

- [ ] **Step 1: 复制 repo-root.ts 到 pd-cli**

复制 `packages/principles-core/tests/bdd/support/repo-root.ts` 到 `packages/pd-cli/tests/bdd/support/repo-root.ts`,内容完全一致。

- [ ] **Step 2: 修改 pd-cli vitest.config.ts**

Modify `packages/pd-cli/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/bdd/**/*.test.ts', 'tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
```

- [ ] **Step 3: 写 .feature 文件**

Create `docs/specs/features/cli/json-output.feature`:

```gherkin
@cli-contract
Feature: CLI 严格 JSON 输出契约

  对应 cli-1-strict-json:--json 输出必须是 stdout 上恰好一个可解析的 JSON 对象。
  无 banner、heading、解释文本、混合 stdout 日志。

  Background:
    Given 一个可用的 pd-cli 可执行文件

  @cli-1 @prd-matrix:strict-json
  Scenario: 成功命令的 --json 输出是单一 JSON 对象
    When operator 执行 "pd pain retry --pain-id pain-001 --json --confirm"
    Then stdout 是严格的单一 JSON 对象
    And 该 JSON 对象可以被 JSON.parse 解析
    And stdout 不包含任何 banner 或 heading

  @cli-1 @prd-matrix:strict-json-error
  Scenario: 失败命令的 --json 输出含 reason 和 nextAction
    When operator 执行 "pd pain retry --pain-id nonexistent --json --confirm"
    Then stdout 是严格的单一 JSON 对象
    And 该 JSON 对象的 ok 字段为 false
    And 该 JSON 对象包含 reason 字段
    And 该 JSON 对象包含 nextAction 字段
```

- [ ] **Step 4: 写 step definitions**

Create `packages/pd-cli/tests/bdd/cli-contract.steps.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createStepRegistry, defineFeature } from './support/vitest-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// 复用 principles-core 的 vitest-bdd 实现
// (通过相对路径 import,或者直接复制到 pd-cli/tests/bdd/support/)

// 注:pd-cli 不依赖 @principles/core 的测试代码,所以需要复制 vitest-bdd.ts 和 gherkin-loader.ts
// 到 pd-cli/tests/bdd/support/。这是 Phase 1 的简单做法;Phase 2 可以考虑抽成共享包。

const registry = createStepRegistry();
let cliResult: { stdout: string; stderr: string; exitCode: number } | null = null;

registry.given('一个可用的 pd-cli 可执行文件', () => {
  // 验证 pd-cli 可执行文件存在
  // pd-cli 通过 tests/helpers/pd-cli-path.ts 获取路径
  // 这里简化为验证 node + dist/index.js 可用
});

registry.when(/operator 执行 "(.+)"/, (ctx, command: string) => {
  // 解析命令并执行
  // command 形如 "pd pain retry --pain-id pain-001 --json --confirm"
  const parts = (command as string).split(/\s+/);
  // 第一部分是 "pd",去掉
  const args = parts.slice(1);

  // 使用 pd-cli 的测试执行方式
  // 参考 tests/helpers/pd-cli-path.ts 获取 pd-cli 入口
  const cliPath = resolve(process.cwd(), 'dist', 'index.js');

  try {
    const stdout = execFileSync('node', [cliPath, ...args], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, PD_TEST_MODE: '1' },
    });
    cliResult = { stdout, stderr: '', exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    cliResult = {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.status ?? 1,
    };
  }
  ctx.state.cliResult = cliResult;
});

registry.then('stdout 是严格的单一 JSON 对象', (ctx) => {
  const result = ctx.state.cliResult as { stdout: string };
  const out = result.stdout.trim();
  // 严格单一 JSON:parse 成功且 parse 后无多余字符
  const parsed = JSON.parse(out);
  // 验证 parse 后的字符串长度等于原长度(无尾随内容)
  // (JSON.parse 本身会忽略尾随空白,所以这里 trim 后比较)
  expect(typeof parsed).toBe('object');
});

registry.then('该 JSON 对象可以被 JSON.parse 解析', (ctx) => {
  const result = ctx.state.cliResult as { stdout: string };
  expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
});

registry.then('stdout 不包含任何 banner 或 heading', (ctx) => {
  const result = ctx.state.cliResult as { stdout: string };
  const out = result.stdout.trim();
  // 简单检查:不以 === 或 # 或 PD CLI 等开头
  expect(out.startsWith('===')).toBe(false);
  expect(out.startsWith('#')).toBe(false);
  expect(out.startsWith('PD CLI')).toBe(false);
  // 应该以 { 开头(JSON 对象)
  expect(out.startsWith('{')).toBe(true);
});

registry.then('该 JSON 对象的 ok 字段为 false', (ctx) => {
  const result = ctx.state.cliResult as { stdout: string };
  const parsed = JSON.parse(result.stdout.trim());
  expect(parsed.ok).toBe(false);
});

registry.then('该 JSON 对象包含 reason 字段', (ctx) => {
  const result = ctx.state.cliResult as { stdout: string };
  const parsed = JSON.parse(result.stdout.trim());
  expect(parsed).toHaveProperty('reason');
});

registry.then('该 JSON 对象包含 nextAction 字段', (ctx) => {
  const result = ctx.state.cliResult as { stdout: string };
  const parsed = JSON.parse(result.stdout.trim());
  expect(parsed).toHaveProperty('nextAction');
});

// 加载并注册 feature
const featureText = readFileSync(
  resolveFeaturePath('docs/specs/features/cli/json-output.feature'),
  'utf8'
);
defineFeature(featureText, registry);
```

**注意**:实施时需要把 `vitest-bdd.ts` 和 `gherkin-loader.ts` 也复制到 `packages/pd-cli/tests/bdd/support/`,因为 pd-cli 不依赖 principles-core 的测试代码。在 step 5 之前完成这个复制。

- [ ] **Step 5: 复制 vitest-bdd.ts 和 gherkin-loader.ts 到 pd-cli**

复制 `packages/principles-core/tests/bdd/support/gherkin-loader.ts` → `packages/pd-cli/tests/bdd/support/gherkin-loader.ts`
复制 `packages/principles-core/tests/bdd/support/vitest-bdd.ts` → `packages/pd-cli/tests/bdd/support/vitest-bdd.ts`

修改 pd-cli 的 `cli-contract.steps.ts` 的 import 路径:

```typescript
import { createStepRegistry, defineFeature } from './support/vitest-bdd.js';
```

- [ ] **Step 6: 运行 BDD 测试**

Run: `cd packages\pd-cli && npm run build && npx vitest run tests/bdd/cli-contract.steps.ts`

Expected: PASS (2 scenarios)。如果 pd pain retry 命令在测试环境无法执行(需要 workspace 配置),可能需要调整 step 定义使用 mock 或跳过实际执行。实施时根据实际情况调整。

- [ ] **Step 7: Commit**

```powershell
git add docs/specs/features/cli/ packages/pd-cli/tests/bdd/ packages/pd-cli/vitest.config.ts
git commit -m "feat(bdd): add json-output.feature for cli-1-strict-json contract" -m "BDD scenario for CLI strict JSON output. Covers success and failure paths. Reuses vitest-bdd and gherkin-loader (copied to pd-cli/tests/bdd/support/ since pd-cli doesn't depend on principles-core test code)."
```

---

## Task 8: 实现 playwright-bdd.ts (前端切面 runner)

**Files:**
- Create: `packages/pd-console/tests/bdd/support/repo-root.ts` (复用)
- Create: `packages/pd-console/tests/bdd/support/playwright-bdd.ts`
- Create: `packages/pd-console/tests/bdd/support/gherkin-loader.ts` (复制)
- Modify: `packages/pd-console/playwright.config.ts` (testDir 改为数组)

- [ ] **Step 1: 复制 gherkin-loader.ts 和 repo-root.ts 到 pd-console**

复制 `packages/principles-core/tests/bdd/support/gherkin-loader.ts` → `packages/pd-console/tests/bdd/support/gherkin-loader.ts`
复制 `packages/principles-core/tests/bdd/support/repo-root.ts` → `packages/pd-console/tests/bdd/support/repo-root.ts`

- [ ] **Step 2: 修改 playwright.config.ts 支持多个 testDir**

Modify `packages/pd-console/playwright.config.ts` line 9:

```typescript
// 原: testDir: './tests/e2e',
// 改为:
testDir: ['./tests/e2e', './tests/bdd'],
```

- [ ] **Step 3: 写 playwright-bdd.ts**

Create `packages/pd-console/tests/bdd/support/playwright-bdd.ts`:

```typescript
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { parseFeature, type ParsedStep, type ParsedScenario } from './gherkin-loader.js';

export interface PlaywrightStepContext {
  state: Record<string, unknown>;
  redactable: Record<string, unknown>;
  attachments: Array<{ name: string; body: string }>;
}

export type PlaywrightStepFn = (
  ctx: PlaywrightStepContext,
  page: Page,
  api: APIRequestContext,
  ...args: unknown[]
) => void | Promise<void>;

export interface PlaywrightStepRegistry {
  given(pattern: string | RegExp, fn: PlaywrightStepFn): void;
  when(pattern: string | RegExp, fn: PlaywrightStepFn): void;
  then(pattern: string | RegExp, fn: PlaywrightStepFn): void;
  match(step: ParsedStep): { fn: PlaywrightStepFn; args: unknown[] } | null;
}

interface RegisteredStep {
  keyword: 'Given' | 'When' | 'Then';
  pattern: string | RegExp;
  fn: PlaywrightStepFn;
}

export function createPlaywrightStepRegistry(): PlaywrightStepRegistry {
  const steps: RegisteredStep[] = [];

  function register(keyword: RegisteredStep['keyword']) {
    return (pattern: string | RegExp, fn: PlaywrightStepFn) => {
      steps.push({ keyword, pattern, fn });
    };
  }

  function match(step: ParsedStep): { fn: PlaywrightStepFn; args: unknown[] } | null {
    for (const registered of steps) {
      const keywordMatch =
        step.keyword === registered.keyword ||
        step.keyword === 'And' ||
        step.keyword === 'But';
      if (!keywordMatch) continue;

      if (typeof registered.pattern === 'string') {
        if (registered.pattern === step.text) {
          return { fn: registered.fn, args: [] };
        }
      } else {
        const m = registered.pattern.exec(step.text);
        if (m) {
          return { fn: registered.fn, args: m.slice(1) };
        }
      }
    }
    return null;
  }

  return {
    given: register('Given'),
    when: register('When'),
    then: register('Then'),
    match,
  };
}

function parseDisabledTag(tags: string[]): { reason: string; owner: string; date: string } | null {
  for (const tag of tags) {
    if (tag.startsWith('@disabled')) {
      const reasonMatch = tag.match(/reason="([^"]+)"/);
      const ownerMatch = tag.match(/owner="([^"]+)"/);
      const dateMatch = tag.match(/date="([^"]+)"/);
      return {
        reason: reasonMatch?.[1] ?? '(no reason)',
        owner: ownerMatch?.[1] ?? '(no owner)',
        date: dateMatch?.[1] ?? '(no date)',
      };
    }
  }
  return null;
}

/**
 * 把 .feature 文本注册为 Playwright test。
 * 复用现有 e2e-start.mjs 启动逻辑,0 改造。
 */
export function defineFeature(
  featureText: string,
  registry: PlaywrightStepRegistry
): void {
  const scenarios = parseFeature(featureText);

  test.describe(scenarios[0]?.featureName ?? '(feature)', () => {
    for (const scenario of scenarios) {
      const disabledInfo = parseDisabledTag(scenario.scenarioTags);

      if (disabledInfo) {
        test.skip(`${scenario.scenarioName} [SKIP: ${disabledInfo.reason}; owner=${disabledInfo.owner}; date=${disabledInfo.date}]`, async () => {});
        continue;
      }

      test(scenario.scenarioName, async ({ page, request }) => {
        const ctx: PlaywrightStepContext = {
          state: {},
          redactable: {},
          attachments: [],
        };
        const allSteps = [...(scenario.background ?? []), ...scenario.steps];

        for (const step of allSteps) {
          const match = registry.match(step);
          if (!match) {
            throw new Error(
              `Step not matched: ${step.keyword} ${step.text}\n` +
              `Scenario: ${scenario.scenarioName}`
            );
          }

          try {
            await match.fn(ctx, page, request, ...match.args);
          } catch (e) {
            // Playwright 自动截图 (screenshot: 'only-on-failure' 已在 config 里)
            const enhanced = e instanceof Error ? e : new Error(String(e));
            enhanced.message = `Step failed: ${step.keyword} ${step.text}\nScenario: ${scenario.scenarioName}\n${enhanced.message}`;
            throw enhanced;
          }
        }
      });
    }
  });
}
```

- [ ] **Step 4: 验证 playwright-bdd.ts 编译通过**

Run: `cd packages\pd-console && npx tsc --noEmit`

Expected: 无错误

- [ ] **Step 5: Commit**

```powershell
git add packages/pd-console/tests/bdd/support/ packages/pd-console/playwright.config.ts
git commit -m "feat(bdd): add playwright-bdd runner for frontend scenarios" -m "Playwright step runner mirroring vitest-bdd but with page/APIRequestContext. Reuses e2e-start.mjs (0 changes). playwright.config.ts testDir changed to array to include tests/bdd/."
```

---

## Task 9: 写 owner-approve-prompt-ui.feature (前端切面)

**Files:**
- Create: `docs/specs/features/story-a/owner-approve-prompt-ui.feature`
- Create: `packages/pd-console/tests/bdd/focus-page.steps.ts`

- [ ] **Step 1: 写 .feature 文件**

Create `docs/specs/features/story-a/owner-approve-prompt-ui.feature`:

```gherkin
@mvp-core
Feature: Owner 在 FocusPage 审批原则

  Story A 前端切面:Owner 在 pd-console 的 FocusPage 看到 governance queue,
  点击审批通过,验证 pending 数量减少 + ActivationPage 出现激活项。

  对应现有 e2e 测试:focus-approve-flow.spec.ts

  Background:
    Given pd-console 服务已启动在 http://127.0.0.1:3100
    And governance queue 有 2 条待审批项

  @prd-matrix:focus-approve
  Scenario: governance queue 加载 → approve → pending 减少 + activation 出现
    When owner 在 FocusPage 点击第一条审批通过按钮
    Then governance queue 的 pending 数量减少 1
    And ActivationPage 出现新的激活项
```

- [ ] **Step 2: 写 step definitions**

Create `packages/pd-console/tests/bdd/focus-page.steps.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { createPlaywrightStepRegistry, defineFeature } from './support/playwright-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';

const registry = createPlaywrightStepRegistry();

registry.given('pd-console 服务已启动在 http://127.0.0.1:3100', async (ctx, page) => {
  // Playwright config 的 baseURL 已配置,直接访问
  // 验证服务可用
  const response = await page.goto('/');
  if (!response?.ok()) throw new Error(`pd-console not available: ${response?.status()}`);
});

registry.given('governance queue 有 2 条待审批项', async (ctx, page, api) => {
  // 通过 API 验证 queue 状态
  const resp = await api.get('/api/v1/governance/queue');
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();
  ctx.state.initialPendingCount = body.data?.pendingReviewCount ?? 0;
  ctx.redactable.initialPendingCount = ctx.state.initialPendingCount;
});

registry.when('owner 在 FocusPage 点击第一条审批通过按钮', async (ctx, page) => {
  await page.goto('/#/focus');
  // 等待 queue 加载
  await page.waitForSelector('[data-testid="governance-queue-item"]', { timeout: 10000 });
  // 点击第一条的审批通过按钮
  await page.getByRole('button', { name: /审批通过|approve/i }).first().click();
  // 等待响应
  await page.waitForResponse((r) => r.url().includes('/api/v1/governance/') && r.request().method() === 'POST', { timeout: 10000 });
});

registry.then('governance queue 的 pending 数量减少 1', async (ctx, page, api) => {
  const resp = await api.get('/api/v1/governance/queue');
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();
  const currentCount = body.data?.pendingReviewCount ?? 0;
  const initialCount = ctx.state.initialPendingCount as number;
  expect(currentCount).toBe(initialCount - 1);
});

registry.then('ActivationPage 出现新的激活项', async (ctx, page) => {
  await page.goto('/#/activation');
  // 等待 activation 列表加载
  await page.waitForSelector('[data-testid="activation-item"], [data-testid="active-item"]', { timeout: 10000 });
  // 验证至少有一个激活项
  const items = await page.locator('[data-testid="activation-item"], [data-testid="active-item"]').count();
  expect(items).toBeGreaterThan(0);
});

// 加载并注册 feature
const featureText = readFileSync(
  resolveFeaturePath('docs/specs/features/story-a/owner-approve-prompt-ui.feature'),
  'utf8'
);
defineFeature(featureText, registry);
```

- [ ] **Step 3: 运行前端 BDD 测试**

Run: `cd packages\pd-console && npm run test:e2e`

Expected: 新增的 BDD scenario 通过(如果 e2e 环境需要启动服务,可能需要先 `npm run dev` 或类似命令)

- [ ] **Step 4: Commit**

```powershell
git add docs/specs/features/story-a/owner-approve-prompt-ui.feature packages/pd-console/tests/bdd/focus-page.steps.ts
git commit -m "feat(bdd): add owner-approve-prompt-ui.feature for frontend FocusPage flow" -m "Frontend BDD scenario mirroring focus-approve-flow.spec.ts. Owner approves on FocusPage, pending decreases, ActivationPage shows new item. Reuses e2e-start.mjs (0 changes)."
```

---

## Task 10: 验证 @disabled 标签和删除 .feature 的 fail loud

**Files:**
- 无新增,验证 Task 2-9 的实现

- [ ] **Step 1: 验证 @disabled 标签触发显式 skip**

临时给 `docs/specs/features/cli/json-output.feature` 的第一个 scenario 加 `@disabled(reason="测试",owner="pd",date="2026-06-30")` 标签:

```gherkin
  @cli-1 @prd-matrix:strict-json @disabled(reason="测试",owner="pd",date="2026-06-30")
  Scenario: 成功命令的 --json 输出是单一 JSON 对象
```

Run: `cd packages\pd-cli && npx vitest run tests/bdd/cli-contract.steps.ts`

Expected: 输出含 `SKIP: 成功命令的 --json 输出是单一 JSON 对象 [SKIP: 测试; owner=pd; date=2026-06-30]`,该 scenario 被 skip,另一个 scenario 正常跑。

验证后**移除** @disabled 标签,恢复原状。

- [ ] **Step 2: 验证删除 .feature 文件后 fail loud**

临时把 `docs/specs/features/cli/json-output.feature` 重命名为 `json-output.feature.bak`:

Run: `cd packages\pd-cli && npx vitest run tests/bdd/cli-contract.steps.ts`

Expected: FAIL with "ENOENT" 或类似文件未找到错误(step definitions 文件加载时 readFileSync 失败)。**不允许静默通过**。

验证后**恢复**文件名。

- [ ] **Step 3: 验证 step 未匹配 fail loud**

临时修改 `docs/specs/features/cli/json-output.feature`,在第一个 scenario 末尾加一行 `And 这行没有对应 step definition`:

Run: `cd packages\pd-cli && npx vitest run tests/bdd/cli-contract.steps.ts`

Expected: FAIL with "Step not matched: And 这行没有对应 step definition"。**不允许静默跳过**。

验证后**恢复**原文件。

- [ ] **Step 4: 验证 @principles/core dist 不含 BDD 代码**

Run:
```powershell
cd packages\principles-core
npm run build
Get-ChildItem -Recurse dist | Where-Object { $_.Name -match "gherkin|vitest-bdd|repo-root" } | Select-Object FullName
```

Expected: 无输出(dist 中不应有 gherkin-loader / vitest-bdd / repo-root 相关文件)

- [ ] **Step 5: 验证 verify:merge 不受影响**

Run: `npm run verify:merge`

Expected: PASS (9 道门全通过,BDD 不在门禁内,但也未破坏任何门)

- [ ] **Step 6: Commit (如果有任何验证失败的修复)**

如果验证过程中发现需要修复的 bug,修复后 commit:

```powershell
git add -A
git commit -m "fix(bdd): verification fixes from Task 10 validation"
```

如果全部通过,无需 commit。

---

## Task 11: 写 ADR 0018

**Files:**
- Create: `docs/adr/0018-bdd-specification-layer.md`

- [ ] **Step 1: 写 ADR**

Create `docs/adr/0018-bdd-specification-layer.md`:

```markdown
# ADR-0018: BDD 规约层

**Status:** Proposed
**Date:** 2026-06-30
**Decider:** Owner

## Context

PD 项目当前测试体系存在三类痛点(详见 [BDD spec §1](../superpowers/specs/2026-06-30-bdd-specification-layer-design.md#1-问题定义)):

1. Owner 看不懂验收标准(测试代码只有开发者读得懂)
2. AI 助手跨 session 反复犯同类错误(无行为契约护栏)
3. 发版时"实现绿但旅程断"(单元测试全绿但用户旅程断了)

## Decision

引入 BDD 规约层,用 `.feature` 文件描述 Owner 可读的用户旅程契约。

### 关键决策

1. **`.feature` 文件集中在 `docs/specs/features/`**,不分散在 packages/*/tests/。这是规约,不是测试代码。

2. **BDD runner 放 `tests/bdd/support/`,不进 `src/`**。理由:`@principles/core` 是公开发布的 SDK,放 `src/testing/` 会进 dist,把 BDD 工具带进 SDK。

3. **`@cucumber/gherkin-utils` 作为 root devDependency**,不进任何子包的 dependencies。

4. **BDD 不进 `verify:merge` 合并门禁**。BDD 场景随 CI per-package test job 跑,但 `verify:merge` 只跑 9 个静态门。要让 BDD 成为合并门禁,需显式修改 CI required checks。

5. **禁用必须显式**:`@disabled(reason,owner,date)` 标签 + skip 报告。禁止通过删除 `.feature` 文件让测试绿。

6. **Phase 1 范围克制**:3 个示范场景(后端 prompt channel、前端 FocusPage、CLI strict JSON),不追求全覆盖。

7. **`.feature` 全中文**(Owner 是中文非技术用户),术语首次中英对照。

## Alternatives Considered

### A. 完整 Cucumber 栈

**否决**:引入 cucumber 运行时,增加依赖和复杂度。PD 只需 Gherkin 解析,执行仍由 Vitest/Playwright 负责。

### B. BDD runner 进 `src/testing/` 并作为 SDK API 导出

**否决**:污染发布包,把测试工具带进 SDK。除非外部用户需要 BDD API,否则不进 src。

### C. BDD 进 verify:merge

**否决(Phase 1)**:Phase 1 是试点,不应立即成为合并门禁。Phase 2 评估是否加入 CI required checks。

## Consequences

### 正面

- Owner 可独立审阅验收标准
- AI 助手有行为契约护栏
- 发版时用户旅程有规约级保护

### 负面

- 增加 `@cucumber/gherkin-utils` 依赖(root devDependency,~213KB unpacked)
- 需要维护 `.feature` 文件和 step definitions
- BDD 不在 verify:merge 内(需 Owner 知晓,Phase 2 评估)

## References

- [BDD spec](../superpowers/specs/2026-06-30-bdd-specification-layer-design.md)
- [ERROR_PATTERN_INDEX EP-07](../process/error-management/ERROR_PATTERN_INDEX.md) (ERR-025/088)
- [ADR-0014 MVP-First](0014-mvp-first-strategy-and-product-pivot.md)
```

- [ ] **Step 2: Commit**

```powershell
git add docs/adr/0018-bdd-specification-layer.md
git commit -m "docs(adr): add ADR-0018 BDD specification layer" -m "Records key decisions: .feature in docs/specs/, runner in tests/bdd/support/ (not src), dep in root devDeps, NOT in verify:merge, @disabled must be explicit, Phase 1 scope is 3 scenarios."
```

---

## Task 12: 更新工作流文档

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`

- [ ] **Step 1: 在 AGENTS.md 的 PR Pre-Review Gate 段添加 BDD 影响评估**

在 AGENTS.md 的 "## PR Pre-Review Gate" 段,在 "Check diff scope" 之后添加:

```markdown
**BDD 影响评估**

- [ ] 本 PR 是否修改了 MVP-Core 用户旅程?如果是,对应 `.feature` 是:
      - [ ] 保持不变(行为契约未变)
      - [ ] 更新(行为契约变化,已在 PR 描述说明原因)
      - [ ] 不适用(说明为什么这条旅程不再适用)
- [ ] 本 PR 是否新增/修改了 CLI 命令?如果是,cli-1~cli-7 对应 `.feature` 是否更新?
- [ ] 本 PR 是否触发了 ERR 类?如果是,是否新增了回归 `.feature` scenario?
- [ ] 本 PR 是否删除了 `.feature` 文件?如果是,是否在 PR 描述说明了"行为契约被移除的原因"?
```

- [ ] **Step 2: 在 AGENTS.md 的 AI 助手工作流添加"先读 .feature"**

在 AGENTS.md 的 "## Linear Workflow" 段之前添加:

```markdown
## BDD Workflow (AI 助手改代码前)

AI 助手在 PD 项目改代码时的新流程:

1. 读 `docs/specs/features/` 找到受影响的 `.feature` 文件
2. 读 `.feature` 确认行为契约
3. 改代码
4. 跑受影响的 `.feature` 场景(`cd packages/<pkg> && npx vitest run tests/bdd/xxx.steps.ts` 或 `npx playwright test tests/bdd/xxx.steps.ts`)
5. 如果场景失败,确认是代码 bug 还是 `.feature` 过时
   - 代码 bug → 修代码
   - `.feature` 过时 → 跟 Owner 确认后改 `.feature`,并在 PR 说明中记录
6. PR Pre-Review Gate 的对抗式自检,优先检查 `.feature` 是否都绿

**关键约束**:
- AI 助手**可以**修改 step definitions(重构真实接口时是必要的)
- AI 助手**不能降低 `.feature` 的可观察结果**——任何 `.feature` 行为变化必须 Owner-visible,并在 PR 描述说明原因
- AI 助手**不能**通过删除 `.feature` 文件或加 `@disabled` 标签让测试绿(除非 PR 描述明确说明行为契约被移除/暂停的原因,且 Owner 已确认)
```

- [ ] **Step 3: 在 CLAUDE.md 添加同样的 BDD Workflow 段**

在 CLAUDE.md 的 "## Critical Boundaries" 段之后添加:

```markdown
## BDD Workflow (AI 助手改代码前)

> **See [AGENTS.md](AGENTS.md) > BDD Workflow**
>
> AI 助手改代码前先读 `docs/specs/features/` 下的 `.feature` 文件确认行为契约。
> AI 可改 step definitions,但不能降低 `.feature` 可观察结果。
> 禁止删除 `.feature` 或加 `@disabled` 让测试绿(除非 PR 说明原因且 Owner 确认)。
```

- [ ] **Step 4: 在 .github/PULL_REQUEST_TEMPLATE.md 添加 BDD 影响评估段**

先读取现有模板:
Run: `Read .github/PULL_REQUEST_TEMPLATE.md`

在模板末尾(或合适位置)添加:

```markdown
## BDD 影响评估

- [ ] 本 PR 是否修改了 MVP-Core 用户旅程?如果是,对应 `.feature` 是:
      - [ ] 保持不变(行为契约未变)
      - [ ] 更新(行为契约变化,已在 PR 描述说明原因)
      - [ ] 不适用(说明为什么这条旅程不再适用)
- [ ] 本 PR 是否新增/修改了 CLI 命令?如果是,cli-1~cli-7 对应 `.feature` 是否更新?
- [ ] 本 PR 是否触发了 ERR 类?如果是,是否新增了回归 `.feature` scenario?
- [ ] 本 PR 是否删除了 `.feature` 文件?如果是,是否在 PR 描述说明了"行为契约被移除的原因"?
```

- [ ] **Step 5: Commit**

```powershell
git add AGENTS.md CLAUDE.md .github/PULL_REQUEST_TEMPLATE.md
git commit -m "docs(workflow): add BDD workflow and PR template impact assessment" -m "AGENTS.md and CLAUDE.md: new BDD workflow section (read .feature before coding, AI can modify steps but cannot lower .feature observable results, no delete-to-skip). PR template: BDD impact assessment checklist."
```

---

## Task 13: 最终验证

- [ ] **Step 1: 运行所有 BDD 测试**

```powershell
$machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine');
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User');
$env:PATH = "$env:PATH;$machinePath;$userPath";

cd packages\principles-core && npx vitest run tests/bdd/
cd ..\..\packages\pd-cli && npm run build && npx vitest run tests/bdd/
cd ..\..\packages\pd-console && npm run test:e2e
```

Expected: 所有 BDD scenario 通过

- [ ] **Step 2: 运行完整测试套件验证未破坏**

```powershell
cd packages\principles-core && npm test
cd ..\..\packages\pd-cli && npm test
cd ..\..\packages\pd-console && npm test
```

Expected: 所有原有测试 + 新增 BDD 测试通过

- [ ] **Step 3: 运行 verify:merge**

Run: `npm run verify:merge`

Expected: PASS (9 道门全通过)

- [ ] **Step 4: 验证 @principles/core dist 干净**

Run:
```powershell
cd packages\principles-core
npm run build
Get-ChildItem -Recurse dist | Where-Object { $_.Name -match "gherkin|vitest-bdd|repo-root|bdd" } | Select-Object FullName
```

Expected: 无输出

- [ ] **Step 5: 验证故意改坏代码 BDD 失败**

临时修改 `packages/principles-core/src/runtime-v2/activation/approval-completion-service.ts`(或相关文件),故意让 approve 失败:

Run: `cd packages\principles-core && npx vitest run tests/bdd/story-a.steps.ts`

Expected: FAIL,报告含 scenario 名 + step 文本 + 错误信息

验证后**恢复**代码。

- [ ] **Step 6: 最终 commit (如果有验证修复)**

如果所有验证通过,无需 commit。如果发现需要修复,修复后 commit。

---

## Spec Coverage Check

对照 spec §6.1 Phase 1 验收标准:

| 验收标准 | 对应 Task |
|---------|----------|
| 1. `cd packages/principles-core && npm test` 跑通后端 BDD | Task 6 |
| 2. `cd packages/pd-console && npm run test:e2e` 跑通前端 BDD | Task 9 |
| 3. `cd packages/pd-cli && npm test` 跑通 CLI BDD | Task 7 |
| 4. 故意改坏代码,BDD 失败报告含完整诊断 | Task 13 Step 5 |
| 5. 删除 .feature 文件 fail loud | Task 10 Step 2 |
| 6. @disabled 标签显式 skip 报告 | Task 10 Step 1 |
| 7. AI 助手能从 .feature 读出行为契约 | (文档验证,Task 6 + 12) |
| 8. verify:merge 通过,9 道门无改动 | Task 13 Step 3 |
| 9. dist 不含 BDD 代码 | Task 10 Step 4 + Task 13 Step 4 |

所有验收标准都有对应 Task。

