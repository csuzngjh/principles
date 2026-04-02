# Codebase Structure

**Analysis Date:** 2026-04-02

## Directory Layout

```
principles/                                    # Monorepo root
├── packages/
│   ├── openclaw-plugin/                       # Main plugin package
│   │   ├── src/
│   │   │   ├── agents/                        # Agent role definitions (nocturnal Dreamer/Philosopher/Scribe)
│   │   │   ├── commands/                      # Slash command handlers (15 files)
│   │   │   ├── config/                        # Config defaults and error types
│   │   │   ├── constants/                     # Tool name sets, diagnostician protocol
│   │   │   ├── core/                          # Domain core (46 files)
│   │   │   │   └── hygiene/                   # Hygiene tracking submodule
│   │   │   ├── hooks/                         # OpenClaw lifecycle hooks (15 files)
│   │   │   ├── http/                        # HTTP route for Principles Console
│   │   │   ├── i18n/                          # Internationalization (en/zh)
│   │   │   ├── service/                       # Background workers (12 files)
│   │   │   │   └── subagent-workflow/          # Subagent workflow orchestration
│   │   │   ├── tools/                         # Custom tools (deep-reflect)
│   │   │   ├── types/                         # Shared type definitions
│   │   │   ├── utils/                         # Utility modules (7 files)
│   │   │   ├── index.ts                       # Plugin entry point (640 lines)
│   │   │   ├── openclaw-sdk.d.ts              # OpenClaw SDK type shims
│   │   │   └── types.ts                       # Top-level type exports
│   │   ├── tests/                             # Vitest test files (mirrors src/)
│   │   ├── ui/                                # React web UI (Principles Console)
│   │   │   └── src/                           # 6 files: App, api, charts, main, styles, types
│   │   ├── templates/                         # Workspace templates (zh/en)
│   │   ├── package.json                       # Plugin package config
│   │   └── tsconfig.json                      # TypeScript config
│   └── create-principles-disciple/            # CLI installer package
│       ├── src/                               # 5 files: index, installer, prompts, uninstaller, utils/
│       ├── templates/                         # Template files for installation
│       ├── package.json                       # CLI package config
│       └── tsconfig.json                      # TypeScript config
├── conductor/                                 # Conductor project management
│   ├── tracks/                                # Work track definitions
│   ├── product.md                             # Product definition
│   ├── tech-stack.md                          # Technology stack docs
│   ├── workflow.md                            # Development workflow
│   └── code_styleguides/                      # Code style guides
├── docs/                                      # Documentation (28 entries)
│   ├── spec/                                # Feature specifications
│   ├── design/                                # Design documents
│   ├── architecture-governance/               # Architecture governance docs
│   ├── diagnosis/                             # Diagnostic documentation
│   ├── operator/                              # Operator guides
│   ├── user/                                # User-facing documentation
│   ├── okr/                                # OKR documentation
│   └── maps/                                # Codebase maps
├── scripts/                                   # Build, release, migration scripts
├── tests/                                    # E2E integration tests
├── .planning/                                 # GSD planning directory
│   └── codebase/                              # Codebase analysis documents
├── package.json                               # Root package config
├── AGENTS.md                                  # Project knowledge base
└── README.md                                  # Project README
```

## Directory Purposes

### `packages/openclaw-plugin/src/core/`

- **Purpose:** Domain core — all business logic for pain, evolution, configuration, trajectory, detection
- **Contains:** 46 TypeScript files + 1 hygiene subdirectory
- **Key files:**
  - `workspace-context.ts` — Central facade, dependency hub
  - `evolution-engine.ts` — EP point system, 5-tier model (612 lines)
  - `evolution-reducer.ts` — Event sourcing, principle lifecycle (597 lines)
  - `evolution-types.ts` — Type definitions for evolution domain
  - `pain.ts` — Pain score computation (77 lines)
  - `config.ts` — `PainConfig` interface with dot-notation access (317 lines)
  - `config-service.ts` — Singleton factory for config
  - `trajectory.ts` — SQLite trajectory database (1762 lines)
  - `event-log.ts` — JSONL buffered event log (530 lines)
  - `session-tracker.ts` — In-memory session state with persistence (504 lines)
  - `dictionary.ts` / `dictionary-service.ts` — Pain pattern rules + singleton factory
  - `detection-funnel.ts` / `detection-service.ts` — Text input queue for semantic pain detection
  - `paths.ts` / `path-resolver.ts` — Path constants and normalization
  - `focus-history.ts` — Working memory management, version history, injection
  - `nocturnal-trinity.ts` — Three-stage reflection chain (Dreamer→Philosopher→Scribe)
  - `nocturnal-service.ts` — Nocturnal reflection orchestrator
  - `nocturnal-runtime.ts` — Idle check, cooldown management
  - `nocturnal-target-selector.ts` — Target selection
  - `nocturnal-arbiter.ts` - Artifact validation
  - `nocturnal-paths.ts` / `nocturnal-trajectory-extractor.ts` / `nocturnal-dataset.ts` / `nocturnal-executability.ts` / `nocturnal-compliance.ts` / `nocturnal-candidate-scoring.ts` / `nocturnal-export.ts` — Nocturnal submodules

  - `local-worker-routing.ts` — Task classification and routing policy (737 lines)
  - `shadow-observation-registry.ts` — Runtime shadow evidence tracking (534 lines)
  - `model-deployment-registry.ts` / `model-training-registry.ts` / `promotion-gate.ts` — Worker profile and promotion management
  - `system-logger.ts` / `evolution-logger.ts` — Structured logging utilities
  - `risk-calculator.ts` / `profile.ts` / `adaptive-thresholds.ts` / `thinking-models.ts` / `init.ts` / `migration.ts` / `evolution-migration.ts` / `external-training-contract.ts` / `training-program.ts` / `principle-training-state.ts` / `control-ui-db.ts` / `dictionary-service.ts` / `detection-service.ts`

### `packages/openclaw-plugin/src/hooks/`
- **Purpose:** OpenClaw lifecycle hook handlers — the orchestration layer
- **Contains:** 15 TypeScript files
- **Key files:**
  - `prompt.ts` — Multi-layer context injection (1042 lines) — largest hook
  - `gate.ts` — Security gate chain (210 lines)
  - `pain.ts` — Pain detection (344 lines)
  - `lifecycle.ts` — Reset/compaction handlers (326 lines)
  - `llm.ts` — LLM response analysis (457 lines)
  - `subagent.ts` — Subagent lifecycle (481 lines)
  - `message-sanitize.ts` — Message sanitization
  - `trajectory-collector.ts` — Trajectory data collection
  - `bash-risk.ts` — Bash command risk assessment
  - `edit-verification.ts` — Edit operation verification
  - `gate-block-helper.ts` — Shared block recording helper
  - `gfi-gate.ts` — GFI-based gate logic
  - `progressive-trust-gate.ts` — EP tier-based gate logic
  - `thinking-checkpoint.ts` — Thinking OS checkpoint enforcement

  - `detection-funnel.ts` — Detection pipeline for pain signals (not a hooks/)

### `packages/openclaw-plugin/src/commands/`
- **Purpose:** Slash command handlers
- **Contains:** 15 TypeScript files
- **Key files:**
  - `strategy.ts` — `/pd-init`, `/pd-okr`
  - `capabilities.ts` — `/pd-bootstrap`, `/pd-research`
  - `thinking-os.ts` — `/pd-thinking`
  - `evolver.ts` — `/pd-evolve`
  - `pain.ts` — `/pd-status`
  - `context.ts` — `/pd-context`
  - `focus.ts` — `/pd-focus`
  - `evolution-status.ts` — `/pd-evolution-status`
  - `rollback.ts` — `/pd-rollback`
  - `principle-rollback.ts` — `/pd-principle-rollback`
  - `export.ts` — `/pd-export`
  - `samples.ts` — `/pd-samples`
  - `nocturnal-review.ts` — `/pd-nocturnal-review`
  - `nocturnal-train.ts` — `/nocturnal-train`
  - `nocturnal-rollout.ts` — `/nocturnal-rollout`

### `packages/openclaw-plugin/src/service/`
- **Purpose:** Background workers and long-running services
- **Contains:** 12 TypeScript files + subagent-workflow subdirectory
- **Key files:**
  - `evolution-worker.ts` — Main evolution background worker (1167 lines)
  - `trajectory-service.ts` — Trajectory DB lifecycle (15 lines)
  - `nocturnal-service.ts` — Nocturnal reflection orchestrator (1015 lines)
  - `nocturnal-runtime.ts` — Idle check, cooldown management
  - `nocturnal-target-selector.ts` — Target selection for reflection
  - `central-database.ts` — Cross-workspace aggregation (831 lines)
  - `control-ui-query-service.ts` / `evolution-query-service.ts` — Web UI query services
  - `empathy-observer-manager.ts` — Empathy detection subagent manager (511 lines)
  - `phase3-input-filter.ts` — Phase 3 input filtering
  - `runtime-summary-service.ts` — Runtime summary generation

  - `subagent-workflow/` — Subagent workflow orchestration

### `packages/openclaw-plugin/src/utils/`
- **Purpose:** Shared utility modules
- **Contains:** 7 TypeScript files
- **Key files:**
  - `file-lock.ts` — `withLock()` / `withLockAsync()` for concurrent state access
  - `io.ts` — File I/O helpers: `isRisky()`, `normalizePath()`, `serializeKvLines()`
  - `hashing.ts` — `computeHash()`, `denoiseError()` for deduplication
  - `glob-match.ts` — Glob pattern matching for risk paths
  - `nlp.ts` — NLP utilities: `extractCommonSubstring()`
  - `plugin-logger.ts` — Plugin-specific logging
  - `subagent-probe.ts` — Subagent runtime availability check

### `packages/openclaw-plugin/src/http/`
- **Purpose:** HTTP route for Principles Console web UI
- **Contains:** 1 file
- **Key files:**
  - `principles-console-route.ts` — Serves React UI static assets + REST API endpoints (606 lines)

### `packages/openclaw-plugin/src/constants/`
- **Purpose:** Shared constants and tool classifications and protocols
- **Contains:** 2 files
- **Key files:**
  - `tools.ts` — Tool name sets (`READ_ONLY_TOOLS`, `WRITE_TOOLS`, `BASH_TOOLS_SET`, etc.)
  - `diagnostician.ts` — Diagnostician prompt protocol text

### `packages/openclaw-plugin/ui/src/`
- **Purpose:** React web UI for Principles Console dashboard
- **Contains:** 6 files
- **Key files:**
  - `App.tsx` — Main React application component
  - `api.ts` — API client for backend communication
  - `charts.tsx` — Chart components for data visualization
  - `main.tsx` — React entry point
  - `styles.css` — CSS styles
  - `types.ts` — UI type definitions
### `packages/create-principles-disciple/src/`
- **Purpose:** CLI installer for plugin setup
- **Contains:** 5 files + utils subdirectory
- **Key files:**
  - `index.ts` — CLI entry point
  - `installer.ts` — Installation logic
  - `prompts.ts` — Interactive prompts
  - `uninstaller.ts` — Uninstallation logic
  - `utils/` — CLI utility functions

### `conductor/`
- **Purpose:** Conductor project management artifacts
- **Key files:**
  - `product.md` — Product definition
  - `tech-stack.md` — Technology stack
  - `workflow.md` — Development workflow
  - `tracks.md` — Work tracks index
  - `tracks/` — Track definitions
  - `code_styleguides/` — Code style guides

  - `archive/` — Archived tracks
### `docs/`
- **Purpose:** Project documentation (28 entries)
- **Key subdirectories:**
  - `spec/` — Feature specifications
  - `design/` — Design documents
  - `architecture-governance/` — Architecture governance docs
  - `diagnosis/` — Diagnostic documentation
  - `operator/` — Operator guides
  - `user/` — User-facing documentation
  - `okr/` — OKR documentation
  - `maps/` — Codebase maps
  - `archive/` — Archived docs
  - `analysis/` — Analysis documents
  - `superpowers/` — Superpowers documentation

## Key File Locations

### Entry Points
- `packages/openclaw-plugin/src/index.ts`: Plugin registration — hooks, commands, services, tools, HTTP routes
 `packages/create-principles-disciple/src/index.ts`: CLI installer entry point
 `packages/openclaw-plugin/ui/src/main.tsx`: React web UI entry

### Configuration
- `packages/openclaw-plugin/src/core/paths.ts`: All workspace path constants (`PD_DIRS`, `PD_FILES`)
- `packages/openclaw-plugin/src/core/path-resolver.ts`: Path resolution with Windows/POSIX normalization
 `packages/openclaw-plugin/src/core/config.ts`: `PainConfig` interface with all settings
 `packages/openclaw-plugin/src/core/config-service.ts`: Config singleton factory
- `packages/openclaw-plugin/src/constants/tools.ts`: Tool name classifications (READ_ONLY, WRITE, BASH, etc.)
- `packages/openclaw-plugin/src/openclaw-sdk.d.ts`: OpenClaw SDK type shims (465 lines)

### Core Logic
- `packages/openclaw-plugin/src/core/workspace-context.ts`: Central facade for all services
- `packages/openclaw-plugin/src/core/evolution-engine.ts`: EP point system, tier-gated permissions
- `packages/openclaw-plugin/src/core/evolution-reducer.ts`: Event sourcing, principle lifecycle
- `packages/openclaw-plugin/src/core/trajectory.ts`: SQLite analytics database
- `packages/openclaw-plugin/src/core/session-tracker.ts`: Session state management
### Testing
- `packages/openclaw-plugin/tests/`: Test directory mirroring `src/` structure
- `packages/openclaw-plugin/tests/test-utils.ts`: `createTestContext()` helper for isolated workspaces

## Naming Conventions

### Files
- **kebab-case**: All TypeScript source files: `evolution-engine.ts`, `session-tracker.ts`, `file-lock.ts`
- **Test files**: Match source files with `.test.ts` suffix: `evolution-engine.test.ts`
- **Agent definitions**: kebab-case markdown: `nocturnal-dreamer.md`
### Directories
- **kebab-case**: All source directories: `subagent-workflow/`
- **Test mirror**: `tests/` directory mirrors `src/` structure: `tests/core/`, `tests/hooks/`
### Commands
- **Prefixed `pd-`**: All slash commands: `/pd-init`, `/pd-status`, `/pd-evolve`
- **Exceptions**: `/nocturnal-train`, `/nocturnal-rollout` (not `pd-` prefixed)
### Constants
- **UPPER_SNAKE_CASE**: `PD_DIRS`, `PD_FILES`, `BASH_TOOLS_SET`, `WRITE_TOOLS`
- **PascalCase types**: `EvolutionTier`, `PainRule`, `TaskKind`, `QueueStatus`
## Where to Add New Code
### New Hook Handler
- **Implementation**: `packages/openclaw-plugin/src/hooks/{hook-name}.ts`
- **Registration**: Add `api.on()` call in `packages/openclaw-plugin/src/index.ts`
- **Test**: `packages/openclaw-plugin/tests/hooks/{hook-name}.test.ts`
### New Slash Command
- **Implementation**: `packages/openclaw-plugin/src/commands/{command-name}.ts`
- **Registration**: Add `api.registerCommand()` call in `packages/openclaw-plugin/src/index.ts`
- **i18n**: Add description in `packages/openclaw-plugin/src/i18n/commands.ts`
- **Test**: `packages/openclaw-plugin/tests/commands/{command-name}.test.ts`
### New Core Module
- **Implementation**: `packages/openclaw-plugin/src/core/{module-name}.ts`
- **Service factory**: Use `XxxService.get(stateDir)` singleton pattern
- **WorkspaceContext integration**: Add lazy getter in `packages/openclaw-plugin/src/core/workspace-context.ts`
- **Test**: `packages/openclaw-plugin/tests/core/{module-name}.test.ts`
### New Background Service
- **Implementation**: `packages/openclaw-plugin/src/service/{service-name}.ts`
- **Registration**: Add `api.registerService()` call in `packages/openclaw-plugin/src/index.ts`
- **Test**: `packages/openclaw-plugin/tests/service/{service-name}.test.ts`
### New Custom Tool
- **Implementation**: `packages/openclaw-plugin/src/tools/{tool-name}.ts`
- **Registration**: Add `api.registerTool()` call in `packages/openclaw-plugin/src/index.ts`
- **Test**: `packages/openclaw-plugin/tests/tools/{tool-name}.test.ts`
### New Web UI Page
- **Component**: `packages/openclaw-plugin/ui/src/{page-name}.tsx`
- **API endpoint**: Add handler in `packages/openclaw-plugin/src/http/principles-console-route.ts`
- **Query service**: Add methods in `packages/openclaw-plugin/src/service/control-ui-query-service.ts`
### New Workspace Path
- **Definition**: Add to `PD_DIRS` or `PD_FILES` in `packages/openclaw-plugin/src/core/paths.ts`
- **Resolution**: Use `resolvePdPath(workspaceDir, 'NEW_KEY')` or `wctx.resolve('NEW_KEY')`
## Special Directories
### `.principles/` (Workspace Identity)
- **Purpose:** Workspace identity — profile, principles, thinking OS, kernel
- **Key files:** `PROFILE.json`, `PRINCIPLES.md`, `THINKING_OS.md`, `00-kernel.md`
- **Generated:** By `ensureWorkspaceTemplates()` during first run
- **Committed:** Per workspace, not to plugin repo
### `.state/` (Workspace Runtime State)
- **Purpose:** Runtime state — evolution queue, scorecard, pain flag, sessions, trajectory DB
- **Key files:** `evolution_queue.json`, `AGENT_SCORECARD.json`, `.pain_flag`, `trajectory.db`
- **Generated:** During plugin operation
- **Committed:** Per workspace, contains mutable state
### `memory/` (Workspace Memory)
- **Purpose:** Workspace memory — event logs, OKR data, pain samples, reflection log
- **Key files:** `MEMORY.md`, `reflection-log.md`, `evolution.jsonl`
- **Generated:** During plugin operation
- **Committed:** Per workspace
### `packages/openclaw-plugin/templates/`
- **Purpose:** Template files for workspace initialization
- **Structure:** `templates/langs/{zh,en}/` — language-specific templates
- **Generated:** No — these are source templates
- **Committed:** Yes — part of plugin source
### `conductor/`
- **Purpose:** Conductor project management artifacts
- **Key files:** `product.md`, `tech-stack.md`, `workflow.md`, `tracks.md`
- **Generated:** Partially — `setup_state.json` is runtime state
- **Committed:** Yes — tracks and product definitions are versioned

---

*Structure analysis: 2026-04-02*
