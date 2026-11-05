# PRI-606 / PRI-607 修复实施计划 — CORE_PRINCIPLES 注入断裂 + THINKING_OS 内容漂移

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent 系统上下文稳定注入 registry 权威定义的 T-01~T-10 核心公理（PRI-606），并消除 THINKING_OS 模板与 registry 的内容漂移（PRI-607）。

**Architecture:** prompt 注入通道改为直读 `@principles/core` 的 `CORE_PRINCIPLES` registry（复用已实现的 `formatCorePrinciplesList()`），彻底解耦「内置公理」（`<core_principles>`，always-on）与「Owner 批准的学习原则」（`<evolution_principles>`，现有 reducer 逻辑不动）。模板侧以 registry 为唯一权威（SSOT），升级 drift test 为 name 严格断言，补齐 workspace 分发模板。

**Tech Stack:** TypeScript (strict) · vitest · pnpm/npm workspaces monorepo (`principles-core` 纯逻辑 / `openclaw-plugin` I/O 边界)

---

## 0. 背景与根因（核实结论，2026-08-26）

### PRI-606（P1）— 注入断裂，已逐条证实

| # | 断裂环节 | 证据 |
|---|---|---|
| 1 | 权威定义在 `packages/principles-core/src/runtime-v2/core-principles/core-principle-registry.ts`（T-01~T-10 双语，frozen） | L42-113 |
| 2 | 唯一注入通道 `prompt.ts` L383-386 只读 `evolutionReducer.getActivePrinciples()` | 逐字匹配 |
| 3 | `getActivePrinciples()` 数据 100% 来自 `memory/evolution.jsonl` 事件流重放（`applyEvent` 是 `principles` Map 唯一写入方） | evolution-reducer.ts L121/L651 |
| 4 | `ensureCorePrinciples()`（init.ts L173-235）只写 training store + ledger tree，**零事件写入** | init.ts 全函数无 emit |
| 5 | ledger 的 `status:'active'` 只被 `bootstrapRules()`（RuleHost）消费，与 prompt 注入无关 | init.ts L201 注释 |

→ 结果：除非 Owner 手动走过诊断→晋升流程，`<core_principles>` 块永远为空。

### PRI-607（P2）— 模板漂移，已逐条证实

- drift test（`tests/core/core-principle-registry-drift.test.ts` L40-53）只比对 id 数组 + 非空检查；实测内容完全不同仍 **5 passed**。
- `templates/langs/{zh,en}` = 10 条但命名全为旧版 SCREAMING_SNAKE（MAP_BEFORE_TERRITORY 等）；registry 为新版 Title Case（Survey Before Acting 等）。
- `templates/workspace/.principles/THINKING_OS.md` 与仓库根 `.principles/THINKING_OS.md` = 仅 8 条旧版（缺 T-09/T-10），且不受 drift test 覆盖（TEMPLATE_ROOT 只指向 langs）。
- 旧版有 2 条在新版 registry 无锚点：`PRINCIPLES_OVER_DIRECTIVES`(旧T-03)、`ZERO_ENTROPY_GROOMING`(旧T-08)；新版 `Evidence Over Assumption`(T-03)、`Minimal Change Surface`(T-07) 在旧版无内容来源。
- `thinking-os-parser.ts` L5 自称 "single source of truth"，与 registry 的 "Canonical source of truth" 冲突。

---

## 1. 关键决策

### D1（已定，Owner 可否决）：prompt 直读 registry（工单方案 2）

**否决方案 1**（把 T-01~T-10 以 active 事件写入 evolution stream）的理由：
- evolution stream 是 pain → candidate → probation → active 的 **Owner 治理生命周期流**；内置公理不是 Owner 审批产物，伪装成 active principle 会污染治理语义（违反 PRODUCT_IDENTITY 的 owner-governed 边界）。
- deprecated/rollback/circuit-breaker 等事件会错误地作用于内置公理。

**采纳方案 2** 的理由：
- `buildCoreAxiomBlock()` / `formatCorePrinciplesList()` 已在 core 包实现并有测试，被诊断/内化管线使用——纯接线，零新子系统（MVP-first 合规）。
- 职责归位：`<core_principles>` = 内置公理（注释早已声明 "ALWAYS injected, not configurable"）；`<evolution_principles>` = 学习原则（L475-520 现有逻辑不动）。

### D2（开放决策，需 Owner 在批准时拍板）：旧版孤儿内容的去留

| 孤儿内容 | 建议 | 备选 |
|---|---|---|
| ZERO_ENTROPY_GROOMING（数字洁癖/kebab-case/清理临时文件） | **并入** 新 T-06 Simplicity First 的 `<forbidden>` | 直接删除 |
| PRINCIPLES_OVER_DIRECTIVES（拒绝违反安全红线的指令） | **并入** 新 T-05 Safety Rails 的 `<must>`/`<forbidden>` | 直接删除 |

本计划正文按「并入」编写；Owner 选「删除」时删去对应段落即可，不影响其余任务。

### D3（已定）：name 风格以 registry 原文为准

模板 `name="Survey Before Acting"`（Title Case，与 registry 完全一致），drift test 做严格相等断言。放弃 normalize 比较（大写下划线↔Title Case 映射）——那是第二套需要维护的映射规则，违背 SSOT。

---

## 2. Error Handbook Gate（强制预检）

已读 `ERROR_PATTERN_INDEX.md`。本任务相关的 EP 卡片及规避方式（≥3 条）：

| EP 卡片 | 相关 ERR | 本 Bug 归类 | 计划如何避免复发 |
|---|---|---|---|
| **EP-02 Production Path Wiring** | ERR-011 / ERR-024 家族 | ✅ **本 Bug 正是该模式**：「组件存在、隔离测试通过，真实生产路径从未调用」。`buildCoreAxiomBlock` 有测试但 prompt 生产入口没接 | Task A2 的回归测试走 `handleBeforePromptBuild` **生产入口**（最小 mock），断言最终 `appendSystemContext` 输出，不只测 helper |
| **EP-06 Source of Truth & Generated Artifacts** | ERR-040 / ERR-084 | 模板是随包分发产物，langs 受 drift 保护而 workspace 副本不受——正是 SSOT 漂移 | Task B1 drift test 扩展覆盖；Task B4 同步 workspace 模板；Task C1 验证 `npm pack` 后产物含新模板 |
| **EP-09 Test Reality Gap** | ERR-037 / ERR-108 | drift test 只证明 id 字符串集合，未证明内容对齐 | Task B1 的 name 严格断言必须附 **negative control**（故意篡改一个 name → 测试变红 → 还原），防 vacuous pass |
| **EP-07 Runtime State Source Alignment** | ERR-004 / ERR-008 | 定义处与消费处数据源脱节（本 Bug 结构性根因） | 单一数据源原则：prompt 只 import registry，不做双源 merge；drift test 锁死模板↔registry 对齐 |
| **EP-03 Fail Loud and Observable Degradation** | ERR-002 | 现有 catch 降级已有 `logger.warn` | 保持该模式；新代码不加空 catch |

Bug 归类说明：PRI-606 属于 **ERR-011/ERR-024 类（production wiring gap）** 的再现——修复 PR 需在 Error Handbook 对应条目的 Recurrence 字段追加本次日期与 issue 号（Task C2）。

---

## 3. MVP Three Questions + Emotional Value（AGENTS.md 强制）

- **mvp-q-1-what-if-skip**：Agent 永远看不到 10 条基础公理，PD「原则内化」价值主张的最底层失效；种子客户第一天问"你的原则是什么"就会暴露。30 天内必然被再次提出。
- **mvp-q-2-how-observed**：开启 PD 后询问 Agent "PD 的核心原则有哪些"应能列出 T-01~T-10；`/pd-context` 相关测试与新增 production-path 回归测试证明注入发生。
- **mvp-q-3-how-disabled**：本修复恢复既有 always-on 设计意图（prompt.ts L376 注释 "Principles is ALWAYS injected (not configurable)"），属 bug fix 而非新子系统，按 AGENTS.md 不新造 flag；disable 路径 = PR revert。THINKING_OS 部分维持既有 `thinkingOs` 开关（default off）不变。
- **mvp-q-4-emotional-value**：**失控感 → 掌控感**（Owner 确知 Agent 带着 10 条公理工作，而非裸奔）；**不信任感 → 安心感**（注入内容与权威定义逐字一致，不再语义漂移）；**疲惫感 → 沉淀感**（无需每次口头重复基础原则）。

---

## 4. File Structure

| 操作 | 文件 | 职责 |
|---|---|---|
| Modify | `packages/openclaw-plugin/src/hooks/prompt.ts` (L380-389) | 注入数据源切换为 registry 直读 |
| Create | `packages/openclaw-plugin/tests/hooks/core-principles-injection.test.ts` | PRI-606 production-path 回归测试 |
| Modify | `packages/openclaw-plugin/tests/core/core-principle-registry-drift.test.ts` | name 严格断言 + workspace 模板纳入守护 |
| Modify | `packages/openclaw-plugin/templates/langs/en/principles/THINKING_OS.md` | 10 条新版内容重写 |
| Modify | `packages/openclaw-plugin/templates/langs/zh/principles/THINKING_OS.md` | 同上（中文） |
| Overwrite | `packages/openclaw-plugin/templates/workspace/.principles/THINKING_OS.md` | 8 条旧版 → 与新 zh 版一致（10 条） |
| Overwrite | `.principles/THINKING_OS.md`（仓库根，dogfood 实例） | 同上同步 |
| Modify | `packages/openclaw-plugin/src/core/thinking-os-parser.ts` (L5) | SSOT 表述修正指向 registry |
| Update | golden fixtures（`tests/hooks/__fixtures__/` 或同目录） | UPDATE_GOLDEN=1 再生成 |
| 不动 | `evolution-reducer.ts`、`init.ts`、`assembleAppendSystemContext`、`formatEvolutionPrinciples` | evolution 链路职责不变 |

---

## 5. Tasks

### Phase A — PRI-606（P1，先行）

### Task A0: 流程启动

- [ ] **Step 1**: 在 PRI-606 评论修复计划要点（本计划链接/摘要），状态置 `In Progress`
- [ ] **Step 2**: 从最新 main 切分支 `fix/pri-606-core-principles-injection`

### Task A1: 红 — production-path 回归测试

**Files:**
- Create: `packages/openclaw-plugin/tests/hooks/core-principles-injection.test.ts`

- [ ] **Step 1: 写失败测试**

复用 `prompt-golden.test.ts` 的 mock 模式（mock `workspace-context.js` / `diagnostician-task-store.js` / `event-log.js` / `session-tracker.js`，`PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED='true'`），关键差异：**evolutionReducer 显式返回空数组**（模拟全新安装现场）：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
// ... mocks 同 prompt-golden.test.ts 模式 ...
const mockWctx = {
  workspaceDir: '/fake/workspace',
  stateDir: '/fake/state',
  resolve: (key: string) => `/fake/${key}`,
  trajectory: { recordSession: vi.fn() },
  config: { get: vi.fn() },
  // 关键：reducer 空 —— 全新安装的真实状态
  evolutionReducer: {
    getActivePrinciples: vi.fn().mockReturnValue([]),
    getProbationPrinciples: vi.fn().mockReturnValue([]),
  },
};

describe('PRI-606: core principles injection (production path)', () => {
  it('injects T-01..T-10 from registry even when evolution reducer is empty', async () => {
    const result = await handleBeforePromptBuild(buildUserTriggerEvent(), ctx);
    const append = result?.appendSystemContext ?? '';
    for (let i = 1; i <= 10; i++) {
      expect(append).toContain(`T-${String(i).padStart(2, '0')}`);
    }
    // registry 权威语句抽查（防止只注入了 id 壳）
    expect(append).toContain('Understand the structure first before making changes.');
    expect(append).toContain('Treat failures and friction as clues');
  });

  it('wraps them in <core_principles> block', async () => {
    const result = await handleBeforePromptBuild(buildUserTriggerEvent(), ctx);
    expect(result?.appendSystemContext).toContain('<core_principles>');
  });
});
```

（`buildUserTriggerEvent`/`ctx` 构造照抄 prompt-golden.test.ts 的 scenario fixture；若其导出不可复用则在本文件内联同构构造。）

- [ ] **Step 2**: 运行验证变红
  Run: `cd packages/openclaw-plugin && npx vitest run tests/hooks/core-principles-injection.test.ts`
  Expected: FAIL — `appendSystemContext` 不含 `T-01`（当前 bug 现场）

### Task A2: 绿 — prompt.ts 接线

**Files:**
- Modify: `packages/openclaw-plugin/src/hooks/prompt.ts:380-389`

- [ ] **Step 1: 确认语言配置字段**

Run: `grep -n "language" packages/openclaw-plugin/src/core/pd-config-effective.ts packages/principles-core/src/**/pd-config*.ts 2>/dev/null; grep -rn "resolvedContextInjection" packages/openclaw-plugin/src/core/*.ts | head -20`
- 若 `effective.resolvedContextInjection`（或同级 effective 配置）存在 language 字段 → 用它；
- 否则回退常量：`const outputLanguage: OutputLanguage = 'zh-CN';`（与 `DEFAULT_OUTPUT_LANGUAGE` 一致，后续单独 issue 接语言开关——不在本 PR 扩scope）。

- [ ] **Step 2: 替换数据源**

将 L380-389 替换为：

```typescript
  // Core principles: ALWAYS inject the canonical T-01..T-10 axioms directly
  // from the @principles/core registry (PRI-606). These are built-in axioms,
  // NOT owner-approved learned principles — those flow via <evolution_principles>.
  let principlesContent = '';
  try {
    principlesContent = formatCorePrinciplesList(outputLanguage);
  } catch (e) {
    logger?.warn?.(`[PD:Prompt] Failed to format core principles from registry: ${String(e)}`);
  }
```

顶部新增 import（与 drift test 同 barrel）：

```typescript
import { formatCorePrinciplesList } from '@principles/core/runtime-v2';
import type { OutputLanguage } from '@principles/core/runtime-v2';
```

（若 runtime-v2 顶层 barrel 未再导出 `formatCorePrinciplesList`，则在 `packages/principles-core/src/runtime-v2/index.ts` 补一行 re-export —— core-principles/index.ts L14 已导出，只需透传。同时删除原 L383-386 的 reducer 调用与 `formatCorePrinciples(activePrinciples)` 引用；若 `formatCorePrinciples` 因此不再被引用，保留 prompt-helpers.ts 导出不动（其他测试可能引用）。）

- [ ] **Step 3**: 运行验证变绿
  Run: `npx vitest run tests/hooks/core-principles-injection.test.ts`
  Expected: PASS

- [ ] **Step 4**: Commit
  ```bash
  git add packages/openclaw-plugin/src/hooks/prompt.ts packages/openclaw-plugin/tests/hooks/core-principles-injection.test.ts
  git commit -m "fix(prompt): inject canonical T-01..T-10 core axioms from registry (PRI-606)"
  ```

### Task A3: golden/characterization 快照更新

- [ ] **Step 1**: `cd packages/openclaw-plugin && UPDATE_GOLDEN=1 npx vitest run tests/hooks/prompt-golden.test.ts tests/hooks/prompt-characterization.test.ts`
- [ ] **Step 2**: `git diff` 审阅 fixture 变更——预期且仅预期 `<core_principles>` 块从空变为含 T-01~T-10 十行；任何其他区块变化都要停下查明原因
- [ ] **Step 3**: Commit `test(prompt): update golden fixtures for registry-sourced core principles (PRI-606)`

### Task A4: 插件全量回归

- [ ] `cd packages/openclaw-plugin && npm run build && npm run test` → exit 0
- [ ] 重点观察：`prompt-size-guard`（10 行 ≈ <1KB，远低于 MAX_INJECTION_SIZE=9000）、`prompt-diet`、`prompt-intent-injection`、`runtime-v2-prompt-activation` 是否仍绿；若有红，逐一判断是「快照需更新」还是「真回归」，禁止删测试

---

### Phase B — PRI-607（P2）

### Task B1: 红 — drift test 升级（含 negative control）

**Files:**
- Modify: `packages/openclaw-plugin/tests/core/core-principle-registry-drift.test.ts`

- [ ] **Step 1: 增加 name 严格断言 + workspace 模板守护**

在现有 `directive ids match` 用例后追加：

```typescript
      it('every directive name matches the registry name exactly', () => {
        const directives = loadTemplateDirectives(lang);
        const byId = new Map(CORE_PRINCIPLES.map(p => [p.id, p.name]));
        for (const d of directives) {
          const expected = byId.get(d.id);
          expect(d.name, `${lang} ${d.id} name drift`).toBe(expected);
        }
      });
```

并将 `TEMPLATE_ROOT` 守护扩展到 workspace 模板（数量断言：id 集合 == registry id 集，即必须 10 条）：

```typescript
      it('workspace template ships the same id set (no 8-entry legacy)', () => {
        const wsPath = path.resolve(__dirname, '..', '..', 'templates', 'workspace', '.principles', 'THINKING_OS.md');
        const directives = parseThinkingOsMd(fs.readFileSync(wsPath, 'utf-8'));
        expect(directives.map(d => d.id).sort()).toEqual([...CORE_PRINCIPLE_IDS].sort());
      });
```

- [ ] **Step 2**: 运行 → Expected: FAIL（现状 langs name 全为旧版、workspace 只有 8 条）
- [ ] **Step 3: negative control（EP-09 强制）**：临时把任一模板某 name 改错 → 确认新用例变红 → 还原。（此步不改文件提交，仅验证断言有效性）
- [ ] **Step 4**: 暂不 commit（等 B2-B4 一起变绿后统一提交）

### Task B2: 绿 — langs/en 模板重写

**Files:**
- Modify: `packages/openclaw-plugin/templates/langs/en/principles/THINKING_OS.md`

- [ ] **Step 1: 整文件替换为下述内容**（registry statement 作为每条 `<must>` 核心句；旧版可迁移的行为细节就近安置；D2 两项按「并入」处理）：

```markdown
<!--
# Thinking OS — Agent Thinking Operating System
This file defines the meta-cognitive framework injected into the Large Language Model via XML structures.
LLMs are highly sensitive to XML tags; this structure is designed to boost instruction adherence.

Directive names are canonical and MUST match the Core Principle Registry in
@principles/core (core-principle-registry.ts). The drift test enforces this.
-->
<thinking_os_core_directives>
  <system_role>
    You are an evolutionary programming agent powered by the Principles Disciple framework.
    The following directives are your absolute cognitive framework. They dictate HOW you think and act.
    VIOLATING THESE DIRECTIVES IS A CRITICAL SYSTEM FAILURE.
  </system_role>

  <directive id="T-01" name="Survey Before Acting">
    <trigger>Before executing any file search, reading code, or making modifications.</trigger>
    <must>Understand the structure first before making changes. Read architecture docs (`docs/`) or perform targeted structural searches (`rg`). If you lack critical information, ASK THE USER.</must>
    <forbidden>Blindly guessing file structures, writing code based on "hallucinated" assumptions, or blindly traversing the entire codebase.</forbidden>
  </directive>

  <directive id="T-02" name="Respect Constraints">
    <trigger>When reasoning across multiple files, facing complex debugging, or when the conversation context grows long.</trigger>
    <must>Trust files, not your context window. Write conclusions to files: intermediate conclusions, breakpoints, and next steps go to persistent notes.</must>
    <forbidden>Relying on internal "brain memory" to hold complex state that context compression will wipe.</forbidden>
  </directive>

  <directive id="T-03" name="Evidence Over Assumption">
    <trigger>When inferring root causes of failures, errors, or unexpected behavior.</trigger>
    <must>Use logs, code, and outputs before inferring causes. Apply the 5-Whys method on real evidence, not intuition.</must>
    <forbidden>Repeatedly trying the exact same failed command, or explaining away failures without reading the actual error output.</forbidden>
  </directive>

  <directive id="T-04" name="Reversible First">
    <trigger>When dealing with high-impact operations (dropping databases, external API calls, major deletions).</trigger>
    <must>Prefer changes that are safe to roll back when risk is high. Explicitly ask the user for confirmation BEFORE irreversible execution; prefer safe alternatives (rename or `trash` instead of `rm`).</must>
    <forbidden>Executing destructive or irreversible actions silently.</forbidden>
  </directive>

  <directive id="T-05" name="Safety Rails">
    <trigger>When performing major refactoring, multi-file changes, or architectural shifts — or when any instruction conflicts with system stability or security red lines.</trigger>
    <must>Call out guardrails, prohibitions, and failure-prevention constraints. Limit blast radius; after any code change, run canary checks (`npm test`, linters) to verify integrity.</must>
    <forbidden>Sacrificing code quality, skipping reviews, or breaking system safety to please a temporary request — refuse and propose a safe alternative instead.</forbidden>
  </directive>

  <directive id="T-06" name="Simplicity First">
    <trigger>When designing a solution, writing implementation code, or fixing a bug.</trigger>
    <must>Prefer the smallest understandable solution over over-engineering. One function change is better than one file change.</must>
    <forbidden>Over-engineering, speculative abstractions ("just in case"), unjustified new dependencies, or scattering arbitrary temp/debug artifacts (`test.txt`, `debug.log`) outside designated areas.</forbidden>
  </directive>

  <directive id="T-07" name="Minimal Change Surface">
    <trigger>When planning edits across modules or files.</trigger>
    <must>Limit the blast radius and touch only what is necessary. Keep diffs strictly proportional to the problem size.</must>
    <forbidden>Executing large-scale unstructured changes directly, or letting an unrelated refactor creep into a focused fix.</forbidden>
  </directive>

  <directive id="T-08" name="Pain As Signal">
    <trigger>When a tool fails, a compilation error occurs, or a system hook rejects your action.</trigger>
    <must>Treat failures and friction as clues to step back and rethink. Treat hook rejections as laws, not bugs; change strategy based on the error.</must>
    <forbidden>Using conversational filler ("I apologize") to cover up a systemic defect instead of fixing it.</forbidden>
  </directive>

  <directive id="T-09" name="Divide And Conquer">
    <trigger>When facing a complex task, multi-step change, or an operation that can be decomposed.</trigger>
    <must>Split the task into smaller phases before execution. Execute one phase at a time and verify each phase's result before proceeding.</must>
    <forbidden>Attempting a large, complex change in a single step, or proceeding without a decomposition plan.</forbidden>
  </directive>

  <directive id="T-10" name="Memory Externalization">
    <trigger>When reaching a significant conclusion, making a decision, or planning across sessions.</trigger>
    <must>Write intermediate conclusions to files for persistence (plan.md, scratchpad) so they survive context compression and session boundaries.</must>
    <forbidden>Relying solely on conversation context to retain important state.</forbidden>
  </directive>
</thinking_os_core_directives>
```

- [ ] **Step 2**: `npx vitest run tests/core/core-principle-registry-drift.test.ts` → en 的全部用例 PASS（zh/workspace 用例仍红，正常）

### Task B3: langs/zh 模板重写

**Files:**
- Modify: `packages/openclaw-plugin/templates/langs/zh/principles/THINKING_OS.md`

- [ ] **Step 1: 整文件替换**——结构与 B2 完全一致（同一批 id/name），文案使用 `statementZh`/`nameZh`（先梳理再行动/尊重约束/证据优先于假设/可逆优先/安全护栏/简单优先/最小变更面/痛苦即信号/分而治之/记忆外部化），`<must>` 首句逐字采用 registry `statementZh`，B2 各条 trigger/forbidden 的行为细节翻译迁移，D2 并入项同 B2 位置。
- [ ] **Step 2**: drift test → zh 用例 PASS

### Task B4: workspace 分发模板补齐

- [ ] **Step 1**: 用 B3 产出物整体覆盖 `packages/openclaw-plugin/templates/workspace/.principles/THINKING_OS.md`（该文件是随插件分发的模板，非用户数据，可直接覆盖）
- [ ] **Step 2**: drift test 全绿（含 B1 新增的 workspace 守护用例）
- [ ] **Step 3**: Commit `fix(templates): align THINKING_OS templates with core principle registry (PRI-607)`

### Task B5: dogfood 同步 + SSOT 表述修正

- [ ] **Step 1**: 用 B4 同内容覆盖仓库根 `.principles/THINKING_OS.md`
- [ ] **Step 2**: `thinking-os-parser.ts` L5 注释改为：`* THINKING_OS.md templates carry the canonical directive ids/names defined in @principles/core core-principle-registry.ts (the single source of truth); the drift test enforces alignment.`
- [ ] **Step 3**: Commit `docs(principles): sync repo-root THINKING_OS; point parser doc to registry SSOT (PRI-607)`

---

### Phase C — 收尾

### Task C1: 全量验证矩阵

- [ ] `cd packages/principles-core && npm run build && npm run test`
- [ ] `cd packages/openclaw-plugin && npm run build && npm run test`
- [ ] `npm run lint`（根目录）
- [ ] `npm run verify:merge`（如存在）
- [ ] 打包冒烟：`cd packages/openclaw-plugin && npm pack --dry-run` 确认 tarball 含更新后的 `templates/workspace/.principles/THINKING_OS.md` 与 `templates/langs/*`（EP-06 产物完整性）

### Task C2: 交付与治理收尾

- [ ] 读 `.github/PULL_REQUEST_TEMPLATE.md`，填全 agent 段落后创建 PR（标题 `fix: PRI-606/PRI-607 core principles injection + template drift`）；PR body 必含：
  - ERR 清单（EP-02/06/07/09/03 → 如何规避，见 §2）
  - golden fixture 变更说明（行为契约变化：`<core_principles>` 由空变为恒含 10 条——Owner-visible）
  - BDD 影响评估：`docs/specs/features/` 经 grep 确认无 prompt 注入/thinking_os 相关 `.feature`，本 PR 不触碰行为契约文件
  - MVP 三问 + emotional value（§3）
- [ ] Error Handbook 更新：在 ERR-011（或 ERR-024，以 handbook 实际归属为准）Recurrence 字段追加 `2026-08-26 PRI-606`；运行 `npm run check:error-handbook`
- [ ] PRI-606 / PRI-607 各留 summary comment（核实结论 + 修复内容 + 测试证据），状态置 `In Review`，PRI-607 打 `lesson-learned` 判定交由 review 结果决定
- [ ] **不合并**：遵守项目规则，PR 由 Owner 手动合并

---

## 6. 回归风险与对策

| 风险 | 对策 |
|---|---|
| golden/characterization 大面积快照变更掩盖真回归 | A3 Step 2 强制人工审阅 diff，仅允许 `<core_principles>` 块变化 |
| system prompt 增大触发 size guard | 10 行 ≈ 0.9KB ≪ 9000 上限；A4 观察 prompt-size-guard/prompt-diet |
| 语言字段缺失导致编译错误 | A2 Step 1 先探测，fallback 固定 `'zh-CN'`（DEFAULT_OUTPUT_LANGUAGE），语言开关另开 issue |
| workspace 模板覆盖影响已安装用户 | 分发模板仅在初始化时复制；已有 workspace 文件不被运行时覆盖（现状即如此，本 PR 不改变该行为） |
| evolution 链路误伤 | 本计划零改动 `evolution-reducer.ts` / `init.ts` / Block L；A4 全量测试兜底 |

## 7. 明确不做（YAGNI / MVP-first）

- ❌ 不把 T-01~T-10 写入 evolution stream（污染治理语义）
- ❌ 不做 prompt 注入的语言动态开关（fallback 固定 zh-CN，另立 issue）
- ❌ 不给 init/post-install 增加「覆盖已有 workspace THINKING_OS.md」的同步逻辑（覆盖用户文件高风险，且 thinkingOs 默认关闭，收益低）
- ❌ 不动 `formatEvolutionPrinciples` / Block L / diagnostician 管线对 `buildCoreAxiomBlock` 的既有使用

## 8. Self-Review 记录

- Spec coverage：工单 PRI-606 修复方向 2 ✓（A1-A4）；PRI-607 修复方向 1-4 ✓（B1-B5）；方向 5（init 同步）经评估降级为「明确不做」并给出理由 ✓
- Placeholder scan：无 TBD/TODO；所有代码块为完整可用内容；A2 语言字段探测含确切 grep 命令与两条明确分支 ✓
- Type consistency：`formatCorePrinciplesList(outputLanguage?: OutputLanguage)`、`OutputLanguage = 'zh-CN'|'en'`（language-directive.ts L32-33）与调用代码一致 ✓
