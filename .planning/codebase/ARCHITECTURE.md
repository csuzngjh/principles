# Architecture

**Analysis Date:** 2026-03-26

## Pattern Overview

**Overall:** Plugin-based extension architecture with centralized workspace management

**Key Characteristics:**
- **OpenClaw Plugin System** — Leverages OpenClaw lifecycle hooks to intercept agent behavior
- **Facade Pattern** — `WorkspaceContext` as central dependency hub for all services
- **Event Sourcing** — EvolutionReducerImpl uses event stream (`evolution.jsonl`) for state management
- **Service Location** — Singleton factory pattern: `XxxService.get(stateDir)`
- **File Locking** — Critical state operations use `withLock()` / `withLockAsync()`
- **Background Workers** — EvolutionWorkerService polls pain queue every 15 minutes
- **Multi-Tier Trust Model** — 4-stage permission system (Observer→Editor→Developer→Architect)
- **Multi-Layer Context Injection** — Prompt building hook injects identity, trust, evolution, principles, thinking OS

## Layers

**Plugin Registration Layer:**
- Purpose: Entry point and OpenClaw API integration
- Location: `packages/openclaw-plugin/src/index.ts`
- Contains: Hook registrations, slash command handlers, custom tools, background services
- Depends on: OpenClaw SDK (`openclaw-sdk.d.ts`)
- Used by: OpenClaw Gateway (loads plugin)

**Hook Layer:**
- Purpose: Intercept agent behavior at lifecycle moments
- Location: `packages/openclaw-plugin/src/hooks/`
- Contains: `gate.ts` (security), `pain.ts` (failure detection), `prompt.ts` (context injection), `lifecycle.ts`, `llm.ts`, `subagent.ts`, `message-sanitize.ts`, `trajectory-collector.ts`
- Depends on: Core services via `WorkspaceContext.fromHookContext(ctx)`
- Used by: OpenClaw runtime (invokes hooks during agent execution)

**Core Domain Layer:**
- Purpose: Business logic for trust, evolution, pain, configuration
- Location: `packages/openclaw-plugin/src/core/`
- Contains: Trust engine, evolution pipeline, pain scoring, config, trajectory DB, event log, hygiene tracking (27 files)
- Depends on: Utilities (`utils/`), Constants (`constants/`), Node.js stdlib
- Used by: Hooks, commands, services, background workers

**Command Layer:**
- Purpose: Slash command handlers for user interaction
- Location: `packages/openclaw-plugin/src/commands/`
- Contains: `trust.ts`, `pain.ts`, `context.ts`, `focus.ts`, `evolution-status.ts`, `evolver.ts`, `strategy.ts`, `thinking-os.ts`, `capabilities.ts`, `export.ts`, `samples.ts`, `rollback.ts`, `principle-rollback.ts`
- Depends on: Core services via `WorkspaceContext`
- Used by: OpenClaw CLI (invoked via `/pd-*` commands)

**Service Layer (Background):**
- Purpose: Long-running background workers and query services
- Location: `packages/openclaw-plugin/src/service/`
- Contains: `evolution-worker.ts` (pain queue polling), `central-database.ts` (multi-workspace aggregation), `control-ui-query-service.ts`, `evolution-query-service.ts`, `empathy-observer-manager.ts`, `runtime-summary-service.ts`, `phase3-input-filter.ts`, `trajectory-service.ts`
- Depends on: Core layer, SQLite (`better-sqlite3`)
- Used by: Evolution lifecycle, web UI queries

**HTTP/Web Layer:**
- Purpose: React-based web UI (Principles Console) for visualization and management
- Location: `packages/openclaw-plugin/ui/` and `packages/openclaw-plugin/src/http/`
- Contains: React SPA (`App.tsx`, `charts.tsx`), HTTP route handlers (`principles-console-route.ts`)
- Depends on: React, React Router, Lucide icons, query services
- Used by: Browser (accessed at `http://localhost:18789/plugins/principles/`)

**Tools Layer:**
- Purpose: Custom agent tools registered with OpenClaw
- Location: `packages/openclaw-plugin/src/tools/`
- Contains: `deep-reflect.ts`, `critique-prompt.ts`, `model-index.ts`
- Depends on: Core services, LLM prompts
- Used by: Agent (invoked during task execution)

## Data Flow

**Plugin Initialization:**
1. OpenClaw Gateway loads plugin → `index.ts: register(api)` called
2. `PathResolver.setExtensionRoot(api.rootDir)` — sets plugin root for path resolution
3. `api.registerHttpRoute()` — registers React web UI route
4. Hook registrations → `api.on('before_prompt_build')`, `api.on('before_tool_call')`, etc.
5. Command registrations → `api.registerCommand({ name: 'pd-*', handler: ... })`
6. Tool registrations → `api.registerTool(createDeepReflectTool(api))`
7. Service registrations → `api.registerService(EvolutionWorkerService)`, `api.registerService(TrajectoryService)`

**Agent Execution Flow:**
1. OpenClaw triggers `before_prompt_build` hook → `handleBeforePromptBuild()` in `prompt.ts`
2. Hook creates `WorkspaceContext.fromHookContext(ctx)` — lazy-loads services
3. Multi-layer injection: identity, trust status, evolution queue, pain signals, thinking OS, OKR focus
4. OpenClaw triggers `before_tool_call` hook → `handleBeforeToolCall()` in `gate.ts`
5. Gate checks trust stage, GFI score, risk paths, bash security (Cyrillic de-obfuscation)
6. If blocked: return `{ block: true, reason: ... }`
7. Tool executes → `after_tool_call` hook triggered → `handleAfterToolCall()` in `pain.ts`
8. Pain detection: tool failure, gate block → pain score calculation → write `.pain_flag`
9. `EvolutionWorkerService` (background, 15min polling) reads `.pain_flag` → enqueues to evolution queue
10. `/pd-evolve` command or auto-evolution processes queue → generates principles via LLM
11. Principles written to `evolution.jsonl` → `EvolutionReducerImpl` updates state

**State Management:**
- **WorkspaceContext** — Central facade, singleton per workspace dir, lazy service initialization
- **Event Sourcing** — Evolution events appended to `evolution.jsonl` → in-memory state rebuilt on load
- **Buffered Flush** — EventLog batches 20 entries or flushes every 30s
- **File Locking** — `withLock()` / `withLockAsync()` for critical writes (evolution, trajectory, trust)

## Key Abstractions

**WorkspaceContext:**
- Purpose: Centralized management of workspace-specific paths and services
- Examples: `packages/openclaw-plugin/src/core/workspace-context.ts`
- Pattern: Cached singleton per workspace directory, lazy getter methods for services (`config`, `eventLog`, `dictionary`, `trust`, `hygiene`, `evolutionReducer`, `trajectory`)
- Usage: `WorkspaceContext.fromHookContext(ctx)` in hooks, commands, services

**TrustEngine:**
- Purpose: 4-stage permission model with scoring system
- Examples: `packages/openclaw-plugin/src/core/trust-engine.ts`
- Pattern: Scorecard with history, stage thresholds, cold-start grace, success/failure streak tracking
- Stages: 1 (Observer, 0-30 EP), 2 (Editor, 31-60 EP), 3 (Developer, 61-80 EP), 4 (Architect, 81+ EP)

**EvolutionReducerImpl:**
- Purpose: Event sourcing for principle lifecycle
- Examples: `packages/openclaw-plugin/src/core/evolution-reducer.ts`
- Pattern: Append events → `evolution.jsonl`, update in-memory state, write state on flush
- Event types: `pain_detected`, `principle_generated`, `principle_approved`, `principle_rejected`, `principle_rollback`

**ConfigService:**
- Purpose: Configuration management with dot-notation access
- Examples: `packages/openclaw-plugin/src/core/config-service.ts`, `packages/openclaw-plugin/src/core/config.ts`
- Pattern: Singleton factory `ConfigService.get(stateDir)`, nested config via `config.get('trust.stages.stage_1_observer')`

**TrajectoryDatabase:**
- Purpose: SQLite analytics database for tool call tracking
- Examples: `packages/openclaw-plugin/src/core/trajectory.ts`
- Pattern: Registry pattern `TrajectoryRegistry.get(workspaceDir)`, better-sqlite3 with WAL mode
- Tables: `sessions`, `turns`, `tool_calls`, `blobs`, `focus_history`

## Entry Points

**Plugin Entry Point:**
- Location: `packages/openclaw-plugin/src/index.ts`
- Triggers: OpenClaw Gateway loads plugin on startup
- Responsibilities: Register hooks, commands, tools, services, HTTP routes
- Key function: `plugin.register(api: OpenClawPluginApi)`

**CLI Installer Entry Point:**
- Location: `packages/create-principles-disciple/src/index.ts`
- Triggers: User runs `npx create-principles-disciple`
- Responsibilities: Interactive prompt, plugin installation, workspace initialization

**Web UI Entry Point:**
- Location: `packages/openclaw-plugin/ui/src/main.tsx`
- Triggers: Browser accesses `http://localhost:18789/plugins/principles/`
- Responsibilities: React app mount, routing, data fetching via HTTP API

## Error Handling

**Strategy:** Fail-closed for security-critical paths (gate, bash validation), graceful degradation for non-critical operations (trajectory collection)

**Patterns:**
- **Gate hook**: Invalid regex patterns → block command (fail-closed), never allow on error
- **Pain hook**: Errors logged, not propagated (pain detection is best-effort)
- **Trajectory collection**: Non-critical, errors silently skipped
- **Service factories**: `XxxService.get()` throws on initialization failure (critical)
- **File locking**: Retry with exponential backoff, timeout after `LOCK_MAX_RETRIES`

## Cross-Cutting Concerns

**Logging:**
- Approach: `SystemLogger.log()` writes to `{stateDir}/logs/plugin.log`, structured JSONL events in `{stateDir}/logs/events.jsonl`
- Hook-level: `ctx.logger.info/warn/error` provided by OpenClaw
- Service-level: `api.logger` from OpenClaw plugin API

**Validation:**
- Approach: Gate hook validates tool calls before execution (bash security, risk paths, trust stage)
- Config validation: TypeScript strict mode, `PainConfig` type with dot-notation accessor

**Authentication:**
- Approach: No external auth — local file-based permissions via trust stages and risk paths
- Web UI: Served by OpenClaw Gateway, no authentication required (localhost-only)

---

*Architecture analysis: 2026-03-26*
