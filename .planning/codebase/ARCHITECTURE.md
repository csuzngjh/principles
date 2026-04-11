# ARCHITECTURE.md - System Design & Patterns

## Entry Points

- **Plugin entry**: `packages/openclaw-plugin/src/index.ts` (777 lines)
  - Exports OpenClaw plugin object, registers all hooks, services, commands, HTTP routes
  - Production build bundles to `dist/bundle.js`

- **CLI installer entry**: `packages/create-principles-disciple/src/index.ts`
  - Interactive installation/uninstallation wizard

## Module Structure (`packages/openclaw-plugin/src/`)

```
src/
  index.ts              -- Plugin registration entry point
  types.ts              -- Global type definitions

  core/                 -- Core domain logic (73 files)
    evolution-engine.ts       -- Evolution scoring engine (tier system)
    evolution-reducer.ts      -- Evolution state reducer
    evolution-types.ts        -- Evolution type definitions
    evolution-logger.ts       -- Evolution logging
    pain.ts                   -- Pain detection
    pain-context-extractor.ts -- Pain context extraction
    empathy-keyword-matcher.ts-- Empathy keyword matching
    focus-history.ts          -- Focus history
    session-tracker.ts        -- Session tracking
    event-log.ts              -- Event logging
    principle-tree-ledger.ts  -- Principle tree ledger
    principle-training-state.ts -- Principle training state
    path-resolver.ts          -- Path resolution
    paths.ts                  -- Path constants
    config.ts                 -- Configuration
    workspace-context.ts      -- Workspace context
    workspace-dir-service.ts  -- Workspace directory service
    workspace-dir-validation.ts -- Workspace validation
    local-worker-routing.ts   -- Local worker routing
    promotion-gate.ts         -- Promotion gating
    risk-calculator.ts        -- Risk calculation
    rule-host.ts              -- Rule host
    rule-implementation-runtime.ts -- Rule implementation runtime
    nocturnal-*.ts            -- Nocturnal training system (14 files)
    principle-internalization/  -- Principle internalization subsystem
    hygiene/                  -- Hygiene tracking
    schema/                   -- JSON Schema definitions

  hooks/                -- OpenClaw lifecycle hooks (16 files)
    prompt.ts                 -- before_prompt_build (1049 lines, largest hook)
    gate.ts                   -- before_tool_call (safety gating)
    pain.ts                   -- after_tool_call (pain/trust)
    llm.ts                    -- llm_output (LLM analysis)
    subagent.ts               -- subagent_ended (subagent lifecycle)
    lifecycle.ts              -- before_reset/before_compaction/after_compaction
    trajectory-collector.ts   -- Behavior trajectory collection
    thinking-checkpoint.ts    -- Thinking checkpoint
    progressive-trust-gate.ts -- Progressive trust gate
    gfi-gate.ts               -- GFI gate
    edit-verification.ts      -- Edit verification
    bash-risk.ts              -- Bash risk analysis
    gate-block-helper.ts      -- Gate block helper
    message-sanitize.ts       -- Message sanitization
    lifecycle-routing.ts      -- Lifecycle routing

  service/              -- Background services (17 files)
    evolution-worker.ts       -- Background evolution worker (2133 lines, largest file)
    evolution-query-service.ts-- Evolution query
    nocturnal-runtime.ts      -- Nocturnal runtime
    nocturnal-service.ts      -- Nocturnal service
    nocturnal-target-selector.ts -- Nocturnal target selection
    central-sync-service.ts   -- Central sync
    central-health-service.ts -- Central health
    central-overview-service.ts -- Central overview
    central-database.ts       -- Central database
    monitoring-query-service.ts -- Monitoring query
    health-query-service.ts   -- Health query
    control-ui-query-service.ts -- Control UI query
    trajectory-service.ts     -- Trajectory service
    runtime-summary-service.ts-- Runtime summary
    event-log-auditor.ts      -- Event log auditor
    phase3-input-filter.ts    -- Phase 3 input filter
    subagent-workflow/        -- Subagent workflow management
      workflow-manager-base.ts
      workflow-store.ts
      empathy-observer-workflow-manager.ts
      deep-reflect-workflow-manager.ts
      nocturnal-workflow-manager.ts
      runtime-direct-driver.ts
      types.ts
      dynamic-timeout.ts
      subagent-error-utils.ts
      index.ts

  commands/             -- CLI commands (20 files)
    strategy.ts, pain.ts, context.ts, focus.ts, export.ts, samples.ts,
    evolution-status.ts, pd-reflect.ts, thinking-os.ts, capabilities.ts,
    nocturnal-review.ts, nocturnal-train.ts, nocturnal-rollout.ts,
    workflow-debug.ts, rollback.ts, rollback-impl.ts, promote-impl.ts,
    disable-impl.ts, archive-impl.ts, principle-rollback.ts

  tools/                -- Tool definitions
    deep-reflect.ts, critique-prompt.ts, model-index.ts

  http/                 -- HTTP routes
    principles-console-route.ts -- Console API routes

  utils/                -- Utilities
    retry.ts (546 lines), file-lock.ts, io.ts, nlp.ts, plugin-logger.ts,
    subagent-probe.ts

  constants/            -- Constants
    tools.ts, diagnostician.ts

  config/               -- Config & errors
    errors.ts (PdError hierarchy), index.ts

  i18n/                 -- Internationalization
    commands.ts (zh/en bilingual)

  types/                -- Type definitions

  ui/src/               -- Web console frontend (React)
    App.tsx, main.tsx, api.ts, types.ts, styles.css, charts.tsx
    components/, pages/, hooks/, context/, i18n/
```

## Data Flow

```
OpenClaw Host
  |
  +-- before_prompt_build (prompt.ts)
  |     -> Inject system prompts, principles, focus, empathy optimization
  |
  +-- before_tool_call (gate.ts)
  |     -> Safety gating, risk analysis, edit verification
  |
  +-- after_tool_call (pain.ts)
  |     -> Pain detection, trust tracking, event logging
  |
  +-- llm_output (llm.ts)
  |     -> LLM output analysis
  |
  +-- subagent_spawning / subagent_ended (subagent.ts)
  |     -> Subagent lifecycle, shadow observation
  |
  +-- before_reset / before_compaction / after_compaction (lifecycle.ts)
  |     -> Session lifecycle management
  |
  +-- EvolutionWorkerService (background service)
        -> Scheduled heartbeats, evolution queue processing, pain flag checks, workflow management
```

## Design Patterns

1. **Hook Pattern**: All interaction with OpenClaw through event hooks
2. **Service Registry Pattern**: `EvolutionWorkerService`, `TrajectoryService`, `PDTaskService`, `CentralSyncService` registered as background services
3. **Workflow Manager Pattern**: `WorkflowManagerBase` abstract class, derived into `EmpathyObserverWorkflowManager`, `DeepReflectWorkflowManager`, `NocturnalWorkflowManager`
4. **File Lock Pattern**: `withLock` / `withLockAsync` prevent concurrent file write corruption
5. **Retry Pattern**: `retryAsync`, `withRetry`, `retryWithAdaptiveTimeout` with exponential backoff
6. **Error Hierarchy**: `PdError` base class with 8 semantic error types
7. **State Machine Pattern**: Nocturnal workflows use explicit state transitions
8. **Shadow Observation Pattern**: Shadow observation for canary deployment validation

## Workspace Directory Resolution Chain

```
resolveRequiredWorkspaceDir()
  -> ctx.workspaceDir (most reliable)
  -> resolveWorkspaceDirFromApi() (OpenClaw API)
  -> env vars
  -> config file
  -> throws error (no silent fallback)
```
