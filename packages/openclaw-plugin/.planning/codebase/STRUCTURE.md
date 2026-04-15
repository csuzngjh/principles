# Codebase Structure

**Analysis Date:** 2026-04-15

## Directory Layout

```
openclaw-plugin/
├── src/                    # Main source code
│   ├── commands/           # Slash command implementations
│   ├── config/            # Configuration defaults and errors
│   ├── constants/          # Shared constants
│   ├── core/               # Core business logic
│   │   ├── hygiene/        # Hygiene tracking
│   │   ├── principle-internalization/  # Principle lifecycle
│   │   └── schema/         # Database schema and migrations
│   ├── hooks/              # OpenClaw hook handlers
│   ├── http/               # HTTP route handlers
│   ├── i18n/               # Internationalization
│   ├── service/            # Background services
│   │   └── subagent-workflow/  # Workflow managers
│   ├── tools/              # Plugin tools
│   ├── types/              # TypeScript type definitions
│   └── utils/              # Utility functions
├── ui/                     # React UI
│   └── src/
│       ├── components/     # React components
│       ├── context/        # React contexts
│       ├── hooks/          # React hooks
│       └── pages/          # Page components
├── tests/                  # Test suite
│   ├── commands/           # Command tests
│   ├── core/               # Core module tests
│   ├── fixtures/           # Test fixtures
│   ├── hooks/              # Hook tests
│   ├── integration/        # Integration tests
│   ├── service/            # Service tests
│   └── utils/              # Utility tests
├── templates/               # Workspace templates
│   ├── langs/              # Language-specific templates
│   └── workspace/           # Workspace structure templates
├── dist/                   # Build output
├── scripts/                # Build scripts
├── .state/                 # Runtime state (gitignored)
└── .tmp/                   # Temporary files (gitignored)
```

## Directory Purposes

**src/commands/:**
- Purpose: Slash command implementations
- Contains: 20+ command handlers (strategy, focus, pain, rollback, nocturnal-review, nocturnal-train, etc.)
- Key files: `strategy.ts`, `focus.ts`, `nocturnal-train.ts`, `nocturnal-rollout.ts`

**src/core/:**
- Purpose: Core business logic (evolution, trajectory, pain, training, rules)
- Contains: 70+ core modules including `evolution-engine.ts`, `trajectory.ts`, `nocturnal-trinity.ts`, `pain.ts`, `principle-tree-ledger.ts`
- Key files: `evolution-engine.ts`, `nocturnal-trinity.ts`, `rule-host.ts`

**src/hooks/:**
- Purpose: OpenClaw hook handlers for intercepting agent behavior
- Contains: `prompt.ts`, `gate.ts`, `pain.ts`, `llm.ts`, `lifecycle.ts`, `subagent.ts`, `trajectory-collector.ts`
- Key files: `gate.ts` (security), `prompt.ts` (context injection)

**src/service/:**
- Purpose: Background worker services
- Contains: `evolution-worker.ts` (main worker), `nocturnal-service.ts`, `trajectory-service.ts`, `central-database.ts`
- Key files: `evolution-worker.ts` (144KB, main async processor)

**src/service/subagent-workflow/:**
- Purpose: Workflow orchestration for complex subagent operations
- Contains: `nocturnal-workflow-manager.ts`, `deep-reflect-workflow-manager.ts`, `empathy-observer-workflow-manager.ts`
- Key files: `workflow-manager-base.ts`, `dynamic-timeout.ts`

**src/utils/:**
- Purpose: Shared utility functions
- Contains: `io.ts` (atomic writes), `plugin-logger.ts`, `retry.ts`, `hashing.ts`, `file-lock.ts`
- Key files: `io.ts` (critical for safe file operations)

**src/schema/:**
- Purpose: SQLite database schema and migrations
- Contains: `schema-definitions.ts`, `migration-runner.ts`, `migrations/*.ts`
- Migrations: 4 migrations (001-004)

**ui/src/:**
- Purpose: React-based plugin UI
- Contains: Pages (Overview, Evolution, Feedback, GateMonitor), components (Shell, ProtectedRoute)
- Key files: `App.tsx`, `pages/EvolutionPage.tsx`, `pages/FeedbackPage.tsx`

## Key File Locations

**Entry Points:**
- `src/index.ts`: Plugin entry point, registers all hooks/commands/tools

**Configuration:**
- `src/core/config.ts`: PainSettings defaults
- `src/core/paths.ts`: Directory and file path constants (PD_DIRS, PD_FILES)
- `openclaw.plugin.json`: Plugin manifest

**Core Logic:**
- `src/core/evolution-engine.ts`: Evolution processing (18KB)
- `src/core/nocturnal-trinity.ts`: Nocturnal training orchestration (87KB - largest file)
- `src/core/trajectory.ts`: Trajectory tracking (64KB)
- `src/core/principle-tree-ledger.ts`: Principle lifecycle management (22KB)
- `src/core/rule-host.ts`: Sandboxed rule execution (7KB)

**Service Layer:**
- `src/service/evolution-worker.ts`: Background evolution worker (144KB - largest file)
- `src/service/nocturnal-service.ts`: Nocturnal training service (59KB)
- `src/service/nocturnal-runtime.ts`: Runtime for nocturnal operations (24KB)

**Testing:**
- `tests/`: Test suite with unit and integration layers
- `vitest.config.ts`: Test configuration with unit/integration project separation

## Naming Conventions

**Files:**
- TypeScript: `kebab-case.ts` or `camelCase.ts` depending on module type
- Commands: `kebab-case.ts` (e.g., `nocturnal-review.ts`)
- Core modules: `camelCase.ts` (e.g., `evolutionEngine.ts`)
- React components: `PascalCase.tsx`

**Directories:**
- kebab-case: `subagent-workflow`, `principle-internalization`

**Types:**
- Interfaces: `PascalCase` (e.g., `PainSettings`, `EvolutionContext`)
- Type aliases: `PascalCase`
- Enums: `PascalCase`

## Where to Add New Code

**New Command:**
- Primary code: `src/commands/<name>.ts`
- Handler registration: `src/index.ts` in `registerCommandWithAlias()` or `api.registerCommand()`
- Tests: `tests/commands/<name>.test.ts`

**New Hook Handler:**
- Implementation: `src/hooks/<name>.ts`
- Registration: `src/index.ts` in `api.on('<hook_name>', ...)` call
- Tests: `tests/hooks/<name>.test.ts`

**New Core Service:**
- Implementation: `src/core/<name>.ts` or `src/service/<name>.ts`
- Registration: `src/index.ts` in `api.registerService()`
- Tests: `tests/core/<name>.test.ts` or `tests/service/<name>.test.ts`

**New Workflow Manager:**
- Implementation: `src/service/subagent-workflow/<name>-workflow-manager.ts`
- Base class: `src/service/subagent-workflow/workflow-manager-base.ts`
- Tests: `tests/service/subagent-workflow/<name>.test.ts`

**New Database Migration:**
- Implementation: `src/core/schema/migrations/<number>-<description>.ts`
- Registration: `src/core/schema/migrations/index.ts`
- Tests: Integration test in `tests/core/control-ui-db.test.ts`

**New Utility:**
- Shared: `src/utils/<name>.ts`
- Tests: `tests/utils/<name>.test.ts`

## Special Directories

**.state/:**
- Purpose: Runtime state (per workspace)
- Generated: Yes (created at runtime)
- Committed: No (gitignored)

**.tmp/:**
- Purpose: Temporary files during build/dev
- Generated: Yes
- Committed: No (gitignored)

**dist/:**
- Purpose: Build output
- Generated: Yes (by `npm run build`)
- Committed: Yes (in some branches)

**templates/:**
- Purpose: Workspace template files copied on init
- Generated: No
- Committed: Yes
- Contains: Language-specific templates (en, zh), workspace structure

**node_modules/:**
- Purpose: Dependencies
- Generated: Yes (by pnpm install)
- Committed: No

---

*Structure analysis: 2026-04-15*
