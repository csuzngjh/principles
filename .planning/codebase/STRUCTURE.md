# Codebase Structure

**Analysis Date:** 2026-03-26

## Directory Layout

```
D:\Code\principles/
├── .claude/                # Claude Code plugin configuration
├── .githooks/              # Git hook scripts
├── .github/                # GitHub Actions workflows
├── .kiro/                  # Kiro project state
├── .learnings/              # Session learnings and audits
├── .planning/              # Planning artifacts (GSD workflow)
├── .sisyphus/              # Sisyphus planning system state
├── .state/                 # Workspace state files
├── AGENTS.md               # Multi-agent team configuration (for AI agents)
├── README.md               # Project overview and quick start
├── packages/               # Monorepo packages
│   ├── openclaw-plugin/    # Main plugin package
│   └── create-principles-disciple/  # CLI installer
├── conductor/              # Product definitions and tracks
├── docs/                  # Documentation
├── memory/                # Knowledge base and OKRs
├── myagents/              # Multi-agent team configs
├── scripts/               # Build and release scripts
└── tests/                 # E2E integration tests
```

## Directory Purposes

**`.claude/`**
- Purpose: Claude Code plugin configuration and state
- Contains: Plugin settings, skill definitions
- Key files: `config/`, `skills/`

**`.githooks/`**
- Purpose: Git lifecycle hooks for automated checks
- Contains: Pre-commit, post-merge scripts
- Key files: `pre-commit`, `commit-msg`

**`.github/`**
- Purpose: GitHub Actions CI/CD workflows
- Contains: Workflow definitions for automated testing and releases
- Key files: `workflows/*.yml`

**`.kiro/`**
- Purpose: Kiro project management state
- Contains: Task tracking, workspace metadata

**`.learnings/`**
- Purpose: Cross-session learnings and audit records
- Contains: Audit logs, improvement suggestions
- Key files: `audit/YYYY-MM-DD/*.md`

**`.planning/`**
- Purpose: GSD (Get Shit Done) workflow planning artifacts
- Contains: Codebase mapping documents, project plans
- Key files: `codebase/ARCHITECTURE.md`, `codebase/STRUCTURE.md`

**`.sisyphus/`**
- Purpose: Sisyphus planning system state
- Contains: Task queues, project plans

**`.state/`**
- Purpose: Runtime state and logs for current workspace
- Contains: Logs, events, pain flags, evolution state
- Key files: `logs/events.jsonl`, `logs/plugin.log`, `.pain_flag`

**`packages/openclaw-plugin/`**
- Purpose: Main OpenClaw plugin implementation
- Contains: Plugin source, tests, templates, web UI
- Key files: `src/index.ts` (plugin entry point), `src/core/`, `src/hooks/`, `ui/`, `templates/`

**`packages/create-principles-disciple/`**
- Purpose: CLI installer for creating new workspaces
- Contains: Installer logic, prompts, workspace templates
- Key files: `src/index.ts` (CLI entry point), `src/installer.ts`, `templates/`

**`conductor/`**
- Purpose: Product definitions, code styleguides, and feature tracks
- Contains: Track specifications, architecture decisions
- Key files: `code_styleguides/`, `tracks/`

**`docs/`**
- Purpose: User guides, architecture docs, specs
- Contains: Markdown documentation organized by category
- Key files: `USER_GUIDE.md`, `EVOLUTION_POINTS_GUIDE.md`, `ADVANCED_EVOLUTION_CONFIG.md`

**`memory/`**
- Purpose: Knowledge base and OKR tracking
- Contains: Strategic documents, objectives, key results
- Key files: `okr/*.md`, `PRINCIPLES.md`, `AGENTS.md`

**`myagents/`**
- Purpose: Multi-agent team configuration files
- Contains: Agent role definitions for specialized agents
- Key files: `main/`, `pm/`, `repair/`, `scout/`, `verification/`

**`scripts/`**
- Purpose: Build automation and release management
- Contains: Build scripts, migration scripts
- Key files: `build.mjs`, `release.mjs`, `sync-plugin.mjs`

**`tests/`**
- Purpose: End-to-end integration tests
- Contains: Feature testing scenarios
- Key files: `feature-testing/`

## Key File Locations

**Entry Points:**
- `packages/openclaw-plugin/src/index.ts`: Plugin registration, hook setup, command registration
- `packages/create-principles-disciple/src/index.ts`: CLI installer entry point
- `packages/openclaw-plugin/ui/src/main.tsx`: React web UI entry point

**Configuration:**
- `packages/openclaw-plugin/src/core/config.ts`: Configuration schema and defaults
- `packages/openclaw-plugin/src/core/config-service.ts`: Config service factory
- `packages/openclaw-plugin/openclaw.plugin.json`: Plugin manifest

**Core Logic:**
- `packages/openclaw-plugin/src/core/trust-engine.ts`: Permission model and scoring
- `packages/openclaw-plugin/src/core/evolution-engine.ts`: Evolution task lifecycle
- `packages/openclaw-plugin/src/core/evolution-reducer.ts`: Principle event sourcing
- `packages/openclaw-plugin/src/core/workspace-context.ts`: Central service facade
- `packages/openclaw-plugin/src/core/trajectory.ts`: SQLite analytics database

**Testing:**
- `packages/openclaw-plugin/tests/`: Vitest test suites (69 .test.ts files)
- `packages/openclaw-plugin/tests/test-utils.ts`: Test helper utilities (`createTestContext()`)

**Templates:**
- `packages/openclaw-plugin/templates/langs/en/`: English workspace templates
- `packages/openclaw-plugin/templates/langs/zh/`: Chinese workspace templates
- `packages/create-principles-disciple/templates/`: CLI installer templates

## Naming Conventions

**Files:**
- Plugin source: PascalCase for classes (`TrustEngine.ts`), kebab-case for utilities (`file-lock.ts`)
- Test files: `*.test.ts` (Vitest), `*.integration.test.ts` (E2E)
- Templates: `*.md` or `*.json` (workspace templates)

**Directories:**
- Feature/module: kebab-case (`evolution-worker`, `control-ui-query-service`)
- Domain: lowercase (`core`, `hooks`, `commands`, `service`, `tools`, `utils`)

## Where to Add New Code

**New Hook:**
- Implementation: `packages/openclaw-plugin/src/hooks/{hook-name}.ts`
- Registration: `packages/openclaw-plugin/src/index.ts` → `api.on('{event_name}', ...)`
- Tests: `packages/openclaw-plugin/tests/hooks/{hook-name}.test.ts`

**New Slash Command:**
- Implementation: `packages/openclaw-plugin/src/commands/{command-name}.ts`
- Registration: `packages/openclaw-plugin/src/index.ts` → `api.registerCommand({ name: 'pd-*', handler: ... })`
- Tests: `packages/openclaw-plugin/tests/commands/{command-name}.test.ts`

**New Custom Tool:**
- Implementation: `packages/openclaw-plugin/src/tools/{tool-name}.ts`
- Registration: `packages/openclaw-plugin/src/index.ts` → `api.registerTool(createXxxTool(api))`
- Tests: `packages/openclaw-plugin/tests/tools/{tool-name}.test.ts`

**New Core Service:**
- Implementation: `packages/openclaw-plugin/src/core/{service-name}.ts`
- Access: `packages/openclaw-plugin/src/core/workspace-context.ts` → add getter method
- Factory: Use singleton pattern `XxxService.get(stateDir)`
- Tests: `packages/openclaw-plugin/tests/core/{service-name}.test.ts`

**New Background Service:**
- Implementation: `packages/openclaw-plugin/src/service/{service-name}.ts`
- Registration: `packages/openclaw-plugin/src/index.ts` → `api.registerService(XxxService)`
- Tests: `packages/openclaw-plugin/tests/service/{service-name}.test.ts`

**New Web UI Page:**
- Implementation: `packages/openclaw-plugin/ui/src/{page-name}.tsx`
- Routing: `packages/openclaw-plugin/ui/src/App.tsx` → React Router routes
- API: `packages/openclaw-plugin/src/http/{route-handler}.ts` → HTTP endpoint

**New Workspace Template:**
- Implementation: `packages/openclaw-plugin/templates/langs/{en|zh}/{template-file}`
- Copy logic: `packages/openclaw-plugin/src/core/init.ts` → `ensureWorkspaceTemplates()`
- Usage: Workspace initialization in `{workspace}/.principles/`

## Special Directories

**`node_modules/`**
- Purpose: NPM dependencies (not committed)
- Generated: Yes
- Committed: No

**`dist/`**
- Purpose: Compiled JavaScript output from TypeScript
- Generated: Yes (by `npm run build`)
- Committed: No

**`.git/`**
- Purpose: Git repository metadata
- Generated: Yes
- Committed: No

**`packages/openclaw-plugin/.state/`**
- Purpose: Plugin runtime state per workspace
- Generated: Yes
- Committed: No

**`packages/openclaw-plugin/dist/`**
- Purpose: Plugin distribution build (bundled with esbuild)
- Generated: Yes
- Committed: Yes (published to npm)

**`packages/openclaw-plugin/node_modules/`**
- Purpose: Plugin dependencies
- Generated: Yes
- Committed: No

**`packages/create-principles-disciple/dist/`**
- Purpose: CLI installer distribution build
- Generated: Yes
- Committed: Yes (published to npm)

---

*Structure analysis: 2026-03-26*
