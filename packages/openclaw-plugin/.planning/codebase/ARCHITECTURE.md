# Architecture

**Analysis Date:** 2026-04-15

## Pattern Overview

**Overall:** Event-driven plugin architecture with hook-based interception

**Key Characteristics:**
- OpenClaw plugin framework with hook-based integration
- Background worker services for async evolution processing
- SQLite-based trajectory and state persistence
- Multi-layer security gates (GFI gate, empathy engine, pain tracking)
- Workflow managers for complex subagent orchestration

## Layers

**Plugin Entry Point:**
- Purpose: Initialize plugin, register hooks, commands, tools, and services
- Location: `src/index.ts`
- Contains: Plugin registration, hook handlers, command registration
- Depends on: OpenClaw SDK, all core modules

**Hooks Layer:**
- Purpose: Intercept and modify OpenClaw agent behavior
- Location: `src/hooks/`
- Contains: `prompt.ts` (before_prompt_build), `gate.ts` (before_tool_call), `pain.ts` (after_tool_call), `llm.ts` (llm_output), `lifecycle.ts` (before_reset, compaction), `subagent.ts` (subagent lifecycle)
- Depends on: Core services, workspace context
- Used by: OpenClaw event system

**Core Services:**
- Purpose: Business logic for evolution, pain tracking, trajectory, nocturnal training
- Location: `src/core/` and `src/service/`
- Contains: `evolution-engine.ts`, `trajectory.ts`, `nocturnal-trinity.ts`, `pain.ts`, `training-program.ts`, `pd-task-service.ts`
- Depends on: Database, workspace context, config

**Command Handlers:**
- Purpose: Implement slash commands (e.g., `/pd-init`, `/pd-status`, `/pd-nocturnal-review`)
- Location: `src/commands/`
- Contains: 20+ command implementations
- Depends on: Core services, workspace context

**Workflow Managers (Subagent Workflow):**
- Purpose: Orchestrate complex subagent workflows
- Location: `src/service/subagent-workflow/`
- Contains: `nocturnal-workflow-manager.ts`, `deep-reflect-workflow-manager.ts`, `empathy-observer-workflow-manager.ts`, `correction-observer-workflow-manager.ts`
- Depends on: Evolution worker, core services

**Database Layer:**
- Purpose: Persist trajectory data, evolution state, workflow state
- Location: `src/core/schema/` (migrations), `src/service/central-database.ts`
- Contains: SQLite schema, migration runner, query services
- Depends on: better-sqlite3

**UI Layer:**
- Purpose: React-based plugin UI for monitoring and control
- Location: `ui/src/`
- Contains: Pages (Overview, Evolution, Feedback, GateMonitor, Samples, ThinkingModels), components (Shell, ProtectedRoute), context (auth, theme)
- Depends on: React, React Router, lucide-react

**Utils:**
- Purpose: Shared utilities (I/O, logging, retry, hashing, file locking)
- Location: `src/utils/`
- Contains: `io.ts` (atomic writes), `plugin-logger.ts`, `retry.ts`, `hashing.ts`, `file-lock.ts`

## Data Flow

**Agent Execution Flow:**
1. OpenClaw fires `before_prompt_build` hook
2. `hooks/prompt.ts` builds context injection (principles, thinking OS, focus, reflection log)
3. OpenClaw generates response
4. `hooks/llm.ts` analyzes LLM output for signals
5. User triggers tool call
6. `hooks/gate.ts` intercepts `before_tool_call` - evaluates risk, may block
7. Tool executes
8. `hooks/pain.ts` intercepts `after_tool_call` - tracks pain signals, empathy penalties

**Evolution Flow:**
1. `EvolutionWorkerService` polls `pain_candidates.json` periodically
2. For each candidate, `evolution-engine.ts` evaluates and derives improvements
3. `trajectory.ts` records behavior patterns
4. Nocturnal training (`nocturnal-trinity.ts`) synthesizes improvements into rule updates
5. `principle-tree-ledger.ts` manages principle lifecycle

**Nocturnal Training Flow:**
1. Candidate scoring via `nocturnal-candidate-scoring.ts`
2. Target selection via `nocturnal-target-selector.ts`
3. Rule implementation validation via `nocturnal-rule-implementation-validator.ts`
4. Promotion via `promotion-gate.ts`

## Key Abstractions

**WorkspaceContext:**
- Purpose: Encapsulates all state and services for a single workspace
- Examples: `src/core/workspace-context.ts`
- Pattern: Factory method `WorkspaceContext.fromHookContext()`

**EvolutionEngine:**
- Purpose: Core evolution processing logic
- Examples: `src/core/evolution-engine.ts`
- Pattern: Reducer pattern with typed actions

**NocturnalTrinity:**
- Purpose: Three-phase nocturnal training (dataset, training, evaluation)
- Examples: `src/core/nocturnal-trinity.ts`
- Pattern: Phase orchestration with contract validation

**PainConfig:**
- Purpose: Plugin configuration management
- Examples: `src/core/config.ts`
- Pattern: Singleton per workspace with file persistence

**RuleHost:**
- Purpose: Secure rule execution environment
- Examples: `src/core/rule-host.ts`
- Pattern: Sandboxed evaluation with permission checks

## Entry Points

**Plugin Entry:**
- Location: `src/index.ts`
- Triggers: OpenClaw loads plugin
- Responsibilities: Register all hooks, commands, tools, services; initialize workspace

**Command Entry:**
- Location: `src/commands/*.ts`
- Triggers: User invokes slash command (e.g., `/pd-init`)
- Responsibilities: Validate input, delegate to core services, return formatted result

**Service Entry:**
- Location: `src/service/evolution-worker.ts`
- Triggers: `before_prompt_build` fires (starts background worker)
- Responsibilities: Process evolution queue, track pain signals, trigger training

## Error Handling

**Strategy:** Graceful degradation with logging

**Patterns:**
- Try-catch blocks in all hook handlers with error logging
- `SystemLogger.log()` for critical errors
- Workspace context error recording via `eventLog.recordHookExecution()`
- Non-critical errors caught silently (trajectory collection)

## Cross-Cutting Concerns

**Logging:** `src/utils/plugin-logger.ts` - OpenClaw logger abstraction

**Validation:** Schema validation via `@sinclair/typebox` for config and event types

**Authentication:** OpenClaw session-based, agent ID extracted from session key

**I/O Safety:** Atomic file writes via `atomicWriteFileSync()` in `src/utils/io.ts`

---

*Architecture analysis: 2026-04-15*
