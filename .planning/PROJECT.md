# Principles - AI Agent Principle Evolution System

## What This Is

Principles is a principle-evolution system for AI coding agents. It detects pain signals, proposes candidate principles, gates them through trust and scoring, and promotes validated principles into active use. The repo also contains `ai-sprint-orchestrator`, a long-running multi-stage task runner.

## Core Value

AI agents improve their own behavior through a structured loop:

pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## Validated

- WebUI dashboard with overview, loop, feedback, and gate pages
- System health, evolution, feedback, and gate-monitoring APIs
- `ai-sprint-orchestrator` producer/reviewer/decision pipeline
- Contract enforcement and schema validation
- `outputQuality` decision scoring
- Nocturnal background reflection pipeline
- CLEAN-01: normalizePath naming collision eliminated (→ normalizePathPosix)
- CLEAN-02: PAIN_CANDIDATES legacy path removed (165 lines deleted)
- CLEAN-03: WorkflowManager base class extracted (~750 lines duplication removed)
- CLEAN-04: PrincipleStatus and PrincipleDetectorSpec unified to single source
- CLEAN-05: empathy-observer-workflow-manager confirmed LIVE (3 active imports)
- CLEAN-06: build artifacts (coverage/, *.tgz) added to .gitignore
- GATE-01/GATE-02: Gate Monitor `/api/gate/stats` and `/api/gate/blocks` data flows verified correct (getGateStats and getGateBlocks align with gate_blocks table)
- FE-01/FE-02: Gate Monitor frontend types (GateStatsResponse, GateBlockItem) and field accessors verified matching backend responses
- v1.9.1: WebUI数据源修复 — Phase 16-20完成，数据端点回归测试已添加
- v1.9.3: 剩余 Lint 修复 — CI green achieved, ~700 lint errors resolved through mechanical fixes and documented suppressions
  - prefer-destructuring: ~50 mechanically fixed
  - consistent-type-imports: ~13 converted to type-only imports
  - no-explicit-any: ~10 converted to unknown, ~53 suppressed with documented reasons
  - no-unused-vars: ~10 removed as dead code, ~79 suppressed
  - remaining categories: ~291 suppressed (max-params, class-methods-use-this, no-non-null-assertion, no-shadow, no-use-before-define, no-require-imports)
  - SUPPRESSION-LEDGER.md: Complete suppression inventory created
  - npm run lint exits 0 (0 errors, 0 warnings)

## Active

- acceptance checklist is readable and handoff-ready
- baseline tests and package-local validation runs define workflow readiness
- `packages/openclaw-plugin/templates/langs/{zh,en}/skills/ai-sprint-orchestration/` is the packaged delivery target
- another agent can start from the skill package instead of repo-root orchestrator paths
- validation runs stop after classification when they hit sample-side or product-side gaps
- workflow v1.3 focuses on internal usability first, then finer-grained work-unit architecture
- ARCH-01/ARCH-02: evolution-worker.ts and trajectory.ts splitting (P2, deferred)
- LINT-09: Inline helpers extraction (deferred to future phase)
- LINT-10: Complexity rules (deferred to v2)
- **THINKING_OS.md** is the single source of truth for thinking model definitions (10 directives T-01~T-10)
- WebUI thinking-models page (`/plugins/principles/thinking-models`) is the analysis UI for thinking model data

## Out of Scope

- `packages/openclaw-plugin` product-side fixes
- `D:/Code/openclaw` changes
- dashboard / stageGraph / self-optimizing sprint / parallel task scheduling
- PR2 / PD product loop closure
- Mobile responsive redesign (desktop-only admin tool)
- Real-time WebSocket updates (polling is sufficient)
- Backend schema changes (all needed data already exists)

## Context

- main workflow source of truth: `packages/openclaw-plugin/templates/langs/zh/skills/ai-sprint-orchestration`
- packaged release target: `packages/openclaw-plugin/templates/langs/{zh,en}/skills/ai-sprint-orchestration`
- baseline tests: `contract-enforcement`, `decision`, `run`
- package-local validation specs: `workflow-validation-minimal`, `workflow-validation-minimal-verify`
- complex task templates: `bugfix-complex-template`, `feature-complex-template`
- known product-side gaps remain documented but excluded from this milestone
- **Current codebase state:** ~52,138 LOC TypeScript in packages/openclaw-plugin/src
- **Tech stack:** TypeScript, Node.js, ESLint v10, Vitest
- **Lint status:** CI green (0 errors, 0 warnings) as of v1.9.3

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Package-local script closure | released agents will not have the full repo layout | Active |
| Package-local runtime root | packaged runs must not depend on `ops/ai-sprints` | Active |
| Minimal validation specs only | prove workflow behavior without product-side scope creep | Active |
| Classify-and-stop on sample-side issues | keep workflow-first boundary intact | Active |
| v1.3 prioritizes internal usability | use the skill ourselves before redesigning the orchestrator | Active |
| next architecture step is work-unit/tasklet | stage/round/role resets are not enough for very complex long tasks | Planned |
| ESLint suppression strategy for gap closure | achieve CI green without extensive architectural refactoring | ✓ Good — v1.9.3 |
| D-02 proof chain for no-explicit-any | convert to unknown first, suppress only if truly unavoidable | ✓ Good — v1.9.3 |
| Line-level suppression only with documented reasons | keep technical debt explicit for future phases | ✓ Good — v1.9.3 |
| LINT-09 deferred to future phase | inline helper extraction requires design work beyond gap closure scope | ⚠️ Revisit — v1.9.3 |

## Current Milestone

### v1.10: Thinking Models 页面优化

**Status:** 🚧 IN PROGRESS (started 2026-04-09)

**Goal:** 将 Thinking Models 页面从简单的列表/详情视图重构为功能完整的思维模型分析面板

**Key Features:**
- 数据可视化：覆盖率趋势图、使用趋势图、场景热力图
- 休眠模型可见性：展示从未触发的模型及其定义
- 推荐标签色彩编码 + 按类型过滤
- 事件上下文详情：toolContext、painContext、principleContext
- THINKING_OS.md 内容展示：trigger、must、antiPattern
- 模型对比模式：选择 2+ 模型并排比较
- 列表搜索/过滤
- THINKING_OS.md 模板补齐 10 个 directive

**Key Context:**
- 后端已有完整数据（scenarioMatrix、coverageTrend、usageTrend、事件上下文），前端从未渲染
- 当前页面是 2 列布局（左侧模型列表 + 右侧详情面板），无图表、无过滤、无分页
- 页面路由：`/plugins/principles/thinking-models`
- 页面组件：`ThinkingModelsPage.tsx`
- 已有 `charts.tsx` 基础组件（Sparkline、LineChart、BulletChart 等）可复用
- THINKING_OS.md 是 thinking model 定义的唯一真相源（10 directives T-01~T-10）

**Phases:** 8 (Phase 1~8)

---
### v1.9.1: WebUI 数据源修复

**Status:** Shipped

**Goal:** 排查并修复 WebUI 所有页面（Overview / Loop / Feedback / Gate Monitor）的数据源问题，确保展示数据正确

---
*Last updated: 2026-04-09 after v1.10 milestone started*
