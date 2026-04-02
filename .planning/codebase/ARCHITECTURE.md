# Architecture

**Analysis Date:** 2026-04-02

## Pattern Overview

**Overall:** Event-Driven Plugin with Hook/Service/Reducer Pipeline

The codebase is an OpenClaw plugin that intercepts agent lifecycle events through hooks, processes them through a layered domain core, and drives self-evolution through an event-sourcing reducer pattern. It follows a Facade + Singleton factory architecture where `WorkspaceContext` acts as the central dependency hub.

**Key Characteristics:**
- **Hook-driven entry** — All behavior is triggered by OpenClaw lifecycle hooks registered in `src/index.ts`
- **Event sourcing** — `EvolutionReducerImpl` appends events to `evolution.jsonl` and replays to reconstruct state
- **Singleton factories** — Core services use `XxxService.get(stateDir)` cached-per-directory pattern
- **Central facade** — `WorkspaceContext` lazy-initializes and provides access to all domain services
- **Fail-closed security** — The gate hook blocks on any ambiguity; invalid regex → block, not allow
- **Growth-over-punishment** — `EvolutionEngine` uses an additive scoring model (0-start, only increase)

## Layers

### Layer 1: Plugin Registration (Entry)

- **Purpose:** Connect the plugin to OpenClaw runtime, register hooks, commands, services, tools, and HTTP routes
- **Location:** `packages/openclaw-plugin/src/index.ts`
- **Contains:** Plugin definition object, hook registrations, command registrations, service registrations, tool registrations
- **Depends on:** OpenClaw Plugin SDK (`openclaw-sdk.d.ts`), all hook handlers, command handlers, services, tools
- **Used by:** OpenClaw Gateway runtime

### Layer 2: Hook Handlers (Orchestration)

- **Purpose:** Intercept agent lifecycle events and route them to core domain logic
- **Location:** `packages/openclaw-plugin/src/hooks/`
- **Contains:** 15 files — one per lifecycle event plus supporting modules
- **Depends on:** `WorkspaceContext`, core domain modules (`pain.ts`, `session-tracker.ts`, `evolution-engine.ts`)
- **Used by:** Plugin entry point (`index.ts`)

**Hook Event Map:**

| Hook Event | Handler File | Purpose |
|------------|-------------|---------|
| `before_prompt_build` | `hooks/prompt.ts` | Multi-layer context injection: identity, trust, evolution, principles, thinking OS, focus |
| `before_tool_call` | `hooks/gate.ts` | Security gate chain: thinking checkpoint → GFI gate → bash detection → progressive trust → edit verification |
| `after_tool_call` | `hooks/pain.ts` | Pain detection: tool failure → score computation → pain flag → evolution queue → GFI tracking |
| `llm_output` | `hooks/llm.ts` | LLM response analysis: empathy detection, thinking model matching, semantic pain signals |
| `before_message_write` | `hooks/message-sanitize.ts` | Strip sensitive data from agent messages |
| `subagent_spawning` | `index.ts` (inline) | Shadow routing for local worker profiles |
| `subagent_ended` | `hooks/subagent.ts` | Complete shadow observations, emit evolution events, record success/failure |
| `before_reset` | `hooks/lifecycle.ts` | Session reset: extract pain from transcript, auto-summarize |
| `before_compaction` | `hooks/lifecycle.ts` | Checkpoint state before context loss |
| `after_compaction` | `hooks/lifecycle.ts` | State recovery after compaction |
| (trajectory) | `hooks/trajectory-collector.ts` | Collects tool call + LLM output trajectories into SQLite |

### Layer 3: Core Domain (Business Logic)

- **Purpose:** Encapsulate all domain concepts: pain, evolution, configuration, trajectory, session state, dictionary, detection
- **Location:** `packages/openclaw-plugin/src/core/` (46 files)
- **Contains:** Domain models, service factories, state management, file persistence
- **Depends on:** `utils/`, `constants/`, `config/`, `types/`
- **Used by:** Hook handlers, command handlers, services

**Key Core Modules:**

| Module | File | Responsibility |
|--------|------|---------------|
| Workspace Context | `core/workspace-context.ts` | Central facade — lazy-loads config, eventLog, dictionary, hygiene, evolutionReducer, trajectory |
| Evolution Engine | `core/evolution-engine.ts` | EP point system: 5 tiers (Seed→Forest), double-reward after recovery, tier-gated permissions |
| Evolution Reducer | `core/evolution-reducer.ts` | Event sourcing: append to `evolution.jsonl`, principle lifecycle (candidate→probation→active→deprecated) |
| Evolution Types | `core/evolution-types.ts` | Type definitions for tiers, events, scorecards, principles |
| Pain Scoring | `core/pain.ts` | `computePainScore()` — combines exit code, spiral, missing test penalties |
| Config | `core/config.ts`, `core/config-service.ts` | `PainConfig` with dot-notation `get()`, singleton factory |
| Trajectory DB | `core/trajectory.ts` | SQLite (better-sqlite3): sessions, turns, tool_calls, pain_events, correction_samples |
| Event Log | `core/event-log.ts` | JSONL buffered writes (20 entries or 30s flush), daily statistics |
| Session Tracker | `core/session-tracker.ts` | In-memory session state: GFI, token usage, stuck loop detection, persistence |
| Dictionary | `core/dictionary.ts`, `core/dictionary-service.ts` | Pain pattern rules: regex + exact_match, singleton factory |
| Detection Funnel | `core/detection-funnel.ts`, `core/detection-service.ts` | Text input queue for semantic pain detection |
| Thinking Models | `core/thinking-models.ts` | T-01 through T-10 mental model matching and usage tracking |
| Path Resolution | `core/paths.ts`, `core/path-resolver.ts` | `PD_DIRS` and `PD_FILES` constants, `resolvePdPath()`, Windows/POSIX normalization |
| Focus History | `core/focus-history.ts` | Working memory management: auto-compress, version history, injection |
| Profile | `core/profile.ts` | `PROFILE.json` normalization with defaults |
| Risk Calculator | `core/risk-calculator.ts` | Line change estimation for gate decisions |
| Hygiene Tracker | `core/hygiene/tracker.ts` | Workspace cleanliness tracking |
| Init / Migration | `core/init.ts`, `core/migration.ts` | First-run template setup, directory structure migration |
| Nocturnal Modules | `core/nocturnal-*.ts` (8 files) | Trinity chain, arbiter, compliance, trajectory extraction, dataset management |
| Shadow Observation | `core/shadow-observation-registry.ts` | Runtime shadow evidence for promotion gate |
| Local Worker Routing | `core/local-worker-routing.ts` | Task classification and routing policy for local worker profiles |
| Model Deployment | `core/model-deployment-registry.ts` | Model checkpoint deployment state |
| Model Training | `core/model-training-registry.ts` | Training state and checkpoint management |
| Promotion Gate | `core/promotion-gate.ts` | Promotion decision logic for model checkpoints |

### Layer 4: Background Services

- **Purpose:** Long-running background workers that poll for tasks and execute asynchronous operations
- **Location:** `packages/openclaw-plugin/src/service/`
- **Contains:** 12 files + `subagent-workflow/` subdirectory
- **Depends on:** Core domain modules
- **Used by:** Plugin registration (registered via `api.registerService()`)

**Key Services:**

| Service | File | Purpose |
|---------|------|---------|
| Evolution Worker | `service/evolution-worker.ts` | Polls every 90s for pain queue items; processes `pain_diagnosis`, `sleep_reflection`, `model_eval` tasks |
| Trajectory Service | `service/trajectory-service.ts` | Initializes/disposes trajectory SQLite database |
| Nocturnal Service | `service/nocturnal-service.ts` | Orchestrates nocturnal reflection pipeline (trinity chain) |
| Nocturnal Runtime | `service/nocturnal-runtime.ts` | Workspace idle check, cooldown management |
| Nocturnal Target Selector | `service/nocturnal-target-selector.ts` | Selects principle + session for nocturnal reflection |
| Central Database | `service/central-database.ts` | Aggregates data from all workspaces into `~/.openclaw/.central/aggregated.db` |
| Control UI Query | `service/control-ui-query-service.ts` | Query service for Principles Console web UI |
| Evolution Query | `service/evolution-query-service.ts` | Query service for evolution status commands |
| Empathy Observer | `service/empathy-observer-manager.ts` | Manages empathy observer subagent sessions for emotional signal detection |
| Runtime Summary | `service/runtime-summary-service.ts` | Runtime state summary aggregation |
| Phase3 Input Filter | `service/phase3-input-filter.ts` | Input filtering for Phase 3 training pipeline |

### Layer 5: Commands & Tools (User Interface)

- **Purpose:** Slash command handlers and custom tools exposed to the agent
- **Location:** `packages/openclaw-plugin/src/commands/`, `packages/openclaw-plugin/src/tools/`
- **Contains:** 15 command files + 3 tool files
- **Depends on:** Core domain modules, services
- **Used by:** Plugin registration (registered via `api.registerCommand()`, `api.registerTool()`)

### Layer 6: Web UI (Principles Console)

- **Purpose:** Browser-based dashboard for monitoring and managing the evolution system
- **Location:** `packages/openclaw-plugin/ui/src/`, `packages/openclaw-plugin/src/http/`
- **Contains:** React app (6 files) + HTTP route handler
- **Depends on:** Services (control-ui-query-service, evolution-query-service, central-database)
- **Used by:** OpenClaw Gateway HTTP server

### Supporting Layers

| Layer | Location | Purpose |
|-------|----------|---------|
| Constants | `src/constants/` | Tool name sets, diagnostician protocol strings |
| Config | `src/config/` | Default configs, error classes, config index |
| Types | `src/types/` | Shared type definitions (event types, hygiene, runtime summary) |
| I18n | `src/i18n/` | Internationalized command descriptions (en/zh) |
| Agent Roles | `src/agents/` | Markdown role definitions for nocturnal subagents |
| Utils | `src/utils/` | Cross-cutting utilities: file-lock, IO, hashing, glob-match, NLP, logging |
| SDK Types | `src/openclaw-sdk.d.ts` | Type shims for OpenClaw Plugin SDK |

## Data Flow

### Flow 1: Tool Call → Pain → Evolution

The primary feedback loop that drives agent self-improvement.

1. Agent executes a tool (edit, bash, write, etc.)
2. OpenClaw fires `after_tool_call` event → `hooks/pain.ts`
3. `handleAfterToolCall()` checks tool result:
   - Success → `recordEvolutionSuccess()` in `evolution-engine.ts`
   - Failure → `computePainScore()` in `pain.ts` → `writePainFlag()` → enqueue to `evolution_queue.json`
4. Pain score tracked in session GFI via `session-tracker.ts`
5. If GFI exceeds threshold → gate blocks future operations (feedback loop)
6. Pain event emitted to `EvolutionReducerImpl` for principle tracking

### Flow 2: Tool Call → Security Gate

The security chain that prevents unsafe operations.

1. Agent requests tool execution
2. OpenClaw fires `before_tool_call` → `hooks/gate.ts`
3. Gate chain runs in priority order (short-circuits on first block):
   - **Thinking Checkpoint** — Force deep reflection before risky ops
   - **GFI Gate** — Block if friction index too high
   - **Bash Risk** — Detect file mutations via bash commands
   - **Progressive Trust Gate** — EP tier-based access control
   - **Edit Verification** — Exact/fuzzy match for edit operations
4. Any block → `recordGateBlockAndReturn()` persists block to event log
5. Gate block feeds back into pain system (contributes to GFI)

### Flow 3: Evolution Cycle

Background pipeline that processes accumulated pain into reusable principles.

1. `EvolutionWorkerService` polls every 90s
2. Reads `evolution_queue.json` → picks highest-priority `pending` task
3. For `pain_diagnosis`: invokes diagnostician subagent
4. For `sleep_reflection`: runs nocturnal trinity pipeline (Dreamer → Philosopher → Scribe)
5. Diagnostician output → `EvolutionReducerImpl.createPrincipleFromDiagnosis()`
6. Principle created in `candidate` status → appended to `evolution.jsonl`
7. After 3 consecutive successes → promoted to `probation`
8. After 3 more successes → promoted to `active`
9. Active principles injected into agent context via `before_prompt_build` hook

### Flow 4: Context Injection Pipeline

How the agent receives its accumulated wisdom and personality.

1. **New conversation starts** → OpenClaw fires `before_prompt_build`
2. `hooks/prompt.ts` → `handleBeforePromptBuild()` receives event
3. Multi-layer injection builds system prompt:
   - Identity layer: role definition from `AGENTS.md`
   - Strategy layer: OKR focus from `memory/okr/CURRENT_FOCUS.md`
   - Trust layer: evolution tier and permissions from `evolution-scorecard.json`
   - Principles layer: active principles from `evolution.jsonl` replay
   - Thinking OS layer: T-01 through T-10 from `.principles/THINKING_OS.md`
   - Pain layer: recent pain signals from `.state/.pain_flag`
4. Prompt returned to OpenClaw → injected into LLM context

### State Management

**Persistent State (Filesystem):**
- `.principles/` — Identity: `PROFILE.json`, `PRINCIPLES.md`, `THINKING_OS.md`
- `.state/` — Runtime state: evolution queue, scorecard, pain flag, sessions, trajectory DB
- `memory/` — Long-term memory: evolution stream, logs, OKR, pain samples
- All file writes use `withLock()` / `withLockAsync()` for concurrency safety

**Database State (SQLite):**
- Per-workspace trajectory: `.state/trajectory.db` — sessions, turns, tool_calls, pain_events, correction_samples
- Central aggregation: `~/.openclaw/.central/aggregated.db` — cross-workspace analytics
- Both use WAL journal mode, managed by `TrajectoryRegistry` singleton

**In-Memory State:**
- `WorkspaceContext` — cached singleton per workspace directory
- `session-tracker.ts` — `Map<sessionId, SessionState>` in process memory
- `EvolutionReducerImpl` — in-memory principle map replayed from JSONL
- `ConfigService`, `EventLogService`, `DictionaryService`, `DetectionService` — cached singletons
- `TrajectoryRegistry` — cached `TrajectoryDatabase` (SQLite) per workspace

## Key Abstractions

### WorkspaceContext

- **Purpose:** Centralized facade for all workspace-specific services
- **Files:** `packages/openclaw-plugin/src/core/workspace-context.ts`
- **Pattern:** Cached singleton per workspace directory (via `static instances` Map)
- **Creation:** `WorkspaceContext.fromHookContext(ctx)` — normalizes paths, creates instance
- **Provides:** `config`, `eventLog`, `dictionary`, `hygiene`, `evolutionReducer`, `trajectory`, `resolve()`

### EvolutionReducer

- **Purpose:** Event-sourced principle lifecycle management
- **Files:** `packages/openclaw-plugin/src/core/evolution-reducer.ts`
- **Pattern:** Event sourcing with JSONL append-only log + in-memory state
- **Interface:** `emit()`, `emitSync()`, `getCandidatePrinciples()`, `getActivePrinciples()`, `promote()`, `deprecate()`, `rollbackPrinciple()`, `createPrincipleFromDiagnosis()`

### EvolutionEngine

- **Purpose:** Growth-driven EP point system
- **Files:** `packages/openclaw-plugin/src/core/evolution-engine.ts`
- **Pattern:** State machine with tier transitions, additive scoring only
- **Key concepts:** 5 tiers (Seed 0, Sprout 50, Sapling 200, Tree 500, Forest 1000), double-reward after recovery, tier-gated permissions

### EvolutionQueueItem

- **Purpose:** Task descriptor for background evolution processing
- **Files:** `packages/openclaw-plugin/src/service/evolution-worker.ts`
- **Pattern:** Priority queue with V2 schema supporting `pain_diagnosis`, `sleep_reflection`, `model_eval` task kinds
- **State machine:** `pending` → `in_progress` → `completed` / `failed` (with retry support)

### PainConfig

- **Purpose:** Unified configuration with dot-notation access
- **Files:** `packages/openclaw-plugin/src/core/config.ts`
- **Pattern:** JSON config with typed defaults and dot-notation `get('scores.exit_code_penalty')`

### TrajectoryDatabase

- **Purpose:** Historical analytics storage for sessions, turns, tool calls, pain events, correction samples
- **Files:** `packages/openclaw-plugin/src/core/trajectory.ts`
- **Pattern:** SQLite (better-sqlite3) with schema versioning, blob storage for large content
- **Key constraint:** NOT used for control decisions — runtime truth comes from queue state and scorecards

### Nocturnal Trinity

- **Purpose:** Three-stage reflection chain for high-quality decision-point samples
- **Files:** `packages/openclaw-plugin/src/core/nocturnal-trinity.ts`, `packages/openclaw-plugin/src/agents/*.md`
- **Pattern:** Pipeline: Dreamer (generate candidates) → Philosopher (critique + rank) → Scribe (final artifact)
- **Validation:** Arbiter validates output, executability check before persistence

## Entry Points

### Plugin Entry

- **Location:** `packages/openclaw-plugin/src/index.ts`
- **Triggers:** OpenClaw Gateway loads the plugin
- **Responsibilities:**
  - Registers all lifecycle hooks via `api.on()`
  - Registers 20+ slash commands via `api.registerCommand()`
  - Registers 2 background services via `api.registerService()`
  - Registers 1 custom tool (`deep_reflect`) via `api.registerTool()`
  - Registers HTTP route for Principles Console via `api.registerHttpRoute()`
  - Performs first-run workspace initialization and migration

### CLI Installer Entry

- **Location:** `packages/create-principles-disciple/src/index.ts`
- **Triggers:** `npx create-principles-disciple`
- **Responsibilities:** Interactive/non-interactive installation, workspace template generation, plugin configuration

### Web UI Entry

- **Location:** `packages/openclaw-plugin/src/http/principles-console-route.ts`
- **Triggers:** HTTP request to `/plugins/principles/`
- **Responsibilities:** Serves React static assets, provides REST API for overview/evolution/samples/thinking models

## Error Handling

**Strategy:** Fail-closed for security, fail-open for analytics

**Patterns:**
- **Gate hook** (`hooks/gate.ts`): Invalid regex → block. Missing profile → safe defaults. Any exception → log and return undefined.
- **Pain hook** (`hooks/pain.ts`): Must not throw — errors logged via `SystemLogger`, never propagated.
- **Evolution worker**: Failed tasks retried up to `maxRetries` (default 3), then marked `failed`.
- **Nocturnal pipeline**: Malformed stage output fails entire chain closed; single-reflector fallback available.
- **General hooks**: All wrapped in try/catch at registration site (`index.ts`), errors logged to `api.logger`.

## Cross-Cutting Concerns

**Logging:**
- `core/system-logger.ts` — Structured log to `.state/logs/SYSTEM.log`
- `core/evolution-logger.ts` — Evolution trace logging with `traceId` for lifecycle correlation
- `core/event-log.ts` — JSONL buffered event log (20 entries / 30s flush) with daily statistics
- `utils/plugin-logger.ts` — Plugin-specific logging utilities

**Validation:**
- Bash command tokenization, edit content matching, risk path glob matching in gate chain
- Nocturnal arbiter validates artifact structure before persistence
- Config normalization via `normalizeProfile()` with safe defaults

**Authentication/Authorization:**
- Evolution tier system gates access: Seed (basic ops) → Forest (unlimited)
- Profile-based risk path protection (requires `PLAN.md` with `STATUS: READY`)
- GFI rate-limits operations during high-error sessions

**Internationalization:**
- `src/i18n/commands.ts` — Command descriptions in en/zh
- Templates in `templates/langs/{zh,en}/`

**File Locking:**
- `utils/file-lock.ts` provides `withLock()` / `withLockAsync()` for all critical state writes
- Lock targets: evolution stream, trajectory DB, evolution queue, shadow registry

**Path Resolution:**
- `core/paths.ts` defines all workspace paths as constants (`PD_DIRS`, `PD_FILES`)
- `core/path-resolver.ts` handles Windows/POSIX path normalization
- `resolvePdPath(workspaceDir, fileKey)` is the canonical path resolution function

---

*Architecture analysis: 2026-04-02*
