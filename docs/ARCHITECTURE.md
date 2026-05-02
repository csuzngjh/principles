<!-- generated-by: gsd-doc-writer -->
# Architecture

**Principles Disciple** is an OpenClaw plugin that transforms AI assistants from simple task-executors into self-improving teammates. The system captures failures ("pain signals"), distills them into reusable principles, and applies this learned wisdom to avoid repeating mistakes.

## System Overview

Principles Disciple is built as an OpenClaw plugin using an event-driven architecture. It intercepts the agent lifecycle through plugin hooks (prompt building, tool calls, LLM output) and runs background services for evolution processing. The system operates at two levels: per-workspace SQLite databases for local state, and an optional central SQLite database for cross-workspace analytics.

**Primary inputs:** Tool execution results, LLM outputs, user corrections, evolution tasks
**Primary outputs:** Modified prompts with injected wisdom, blocked/modified tool calls, evolution data for training

## Component Diagram

```
                          OpenClaw Gateway
                                  │
                    ┌─────────────┴─────────────┐
                    │    Principles Disciple    │
                    │       Plugin Core         │
                    │     (index.ts)            │
                    └─────────────┬─────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
    ┌─────▼─────┐          ┌──────▼──────┐        ┌─────▼─────┐
    │   Hooks   │          │  Commands   │        │  Services │
    │           │          │             │        │           │
    │ prompt.ts │          │ pd-status   │        │ Evolution │
    │ gate.ts   │          │ pd-pain     │        │ Worker    │
    │ pain.ts   │          │ pd-rollback │        │           │
    │ llm.ts    │          │ thinking-os │        │ Trajectory│
    │ lifecycle │          │ ...         │        │ Service   │
    └─────┬─────┘          └─────────────┘        └─────┬─────┘
          │                                            │
    ┌─────▼────────────────────────────────────────────▼─────┐
    │                      Core Modules                        │
    │                                                          │
    │  EvolutionEngine   PainContext   LocalWorkerRouting    │
    │  Trajectory        PromotionGate  ModelDeploymentReg    │
    │  ShadowObservation FocusHistory  EventLog              │
    └─────┬────────────────────────────────────────────┬─────┘
          │                                            │
    ┌─────▼─────┐                              ┌──────▼──────┐
    │  SQLite   │                              │   SQLite    │
    │ (Workspace)│                              │  (Central)  │
    └───────────┘                              └─────────────┘
```

## Data Flow

### 1. Tool Call Gate (before_tool_call)
```
User Request → OpenClaw → Gate Hook (gate.ts)
                              │
                    ┌────────▼────────┐
                    │ Risk Assessment │
                    │ - Path checking │
                    │ - Plan approval │
                    │ - Trust level   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │ Allow         │ Block        │ Modify
              ▼              ▼               ▼
          Execute      Return Error     Adjust Params
```

### 2. Pain Detection (after_tool_call) — Runtime V2
```
Tool Result → Pain Hook (hooks/pain.ts)
                    │
          ┌─────────▼──────────┐
          │ Error Classification │
          │ - Tool failures     │
          │ - Risk detections  │
          │ - Empathy signals   │
          └─────────┬──────────┘
                    │
          ┌─────────▼──────────┐
          │ Pain Score Compute │
          │ - Severity         │
          │ - Category         │
          │ - Context hash     │
          └─────────┬──────────┘
                    │
          ┌─────────▼──────────────────────────┐
          │ PainToPrincipleService (core)       │
          │ - Bridge creation + invocation       │
          │ - Latency measurement               │
          │ - Failure category mapping          │
          │ - Observability write               │
          └────────────────────────────────────┘
```

> **Note:** Runtime V1 wrote `{stateDir}/pain/` files. Runtime V2 routes all pain signals through `PainToPrincipleService` (core), which owns bridge lifecycle, latency, and failure classification. The plugin retains GFI gate, cooldown, `PainDiagnosticGate`, and trajectory/event-log writes.

### 3. Prompt Injection (before_prompt_build)
```
LLM Request → Prompt Hook (hooks/prompt.ts)
                         │
           ┌─────────────┼─────────────┐
           │             │             │
    ┌──────▼─────┐ ┌────▼────┐ ┌──────▼─────┐
    │ Thinking   │ │ Pain    │ │ Evolution   │
    │ OS Models  │ │ Signals │ │ Status     │
    └──────┬─────┘ └────┬────┘ └──────┬─────┘
           │             │             │
           └─────────────┼─────────────┘
                         │
               ┌─────────▼──────────┐
               │ Prompt Augmentation │
               └────────────────────┘
```

### 4. Evolution Loop
```
Pain Signals → EvolutionWorker (background)
                       │
           ┌───────────┼───────────┐
           ▼           ▼           ▼
      Extract      Generate    Validate
      Principles   Rules       Hypotheses
           │           │           │
           └───────────┼───────────┘
                       ▼
              ┌─────────────────┐
              │ Training Data   │
              │ Export (ORPO)   │
              └─────────────────┘
```

## Key Abstractions

### EvolutionEngine (`src/core/evolution-engine.ts`)
The core engine managing evolution points and tier progression. Tracks successful task completions and assigns points based on task difficulty and context.

**Key interface:**
- `getPoints()`, `getTier()`, `getStatusSummary()`
- `recordSuccess()`, `recordFailure()`

### PainContext (`src/core/pain-context-extractor.ts`)
Extracts and processes pain signals from tool failures and user feedback. Computes pain scores and categorizes failures for principle extraction.

### LocalWorkerRouting (`src/core/local-worker-routing.ts`)
Policy module that decides whether to delegate tasks to local-worker profiles (`local-reader`, `local-editor`) or keep them on the main agent.

**Key interface:**
- `classifyTask(routingInput)` - Returns routing decision with `targetProfile`, `reason`, `blockers[]`

### PromotionGate (`src/core/promotion-gate.ts`)
Controls when trained model checkpoints can be promoted to production. Manages shadow observation and deployment state transitions.

### TrajectoryCollector (`src/hooks/trajectory-collector.ts`)
Captures behavior data during tool calls and LLM output for offline training. Stores trajectory samples for principle generation.

### EvolutionWorkerService (`src/service/evolution-worker.ts`)
Background service that periodically scans for pain signals and queues evolution tasks. Runs every 90 seconds.

### PainToPrincipleService (`@principles/core/runtime-v2/pain-to-principle-service.ts`)
Core-owned facade for the pain-to-principle pipeline. Single write-side entry point for all pain signals.

**Key interface:**
- `recordPain(input: PainToPrincipleInput): Promise<PainToPrincipleOutput>`
- Owns: bridge lifecycle, latency measurement, failure category mapping, observability write

### PainChainReadModel (`@principles/core/runtime-v2/pain-chain-read-model.ts`)
Core-owned read model for pain-chain queries. Single read-side entry point for trace and health.

**Key interface:**
- `traceByPainId(painId: string): Promise<PainChainTrace>`
- `getLastSuccessfulChain(): Promise<PainChainTrace | undefined>`
- `close(): Promise<void>`

### ShadowObservationRegistry (`src/core/shadow-observation-registry.ts`)
Tracks shadow routing observations for local-worker delegation. Records task fingerprints and outcomes for later analysis.

## Directory Structure

```
packages/openclaw-plugin/src/
├── index.ts           # Plugin entry point - registers hooks, commands, services
├── core/              # Business logic
│   ├── evolution-engine.ts      # Points/tier system
│   ├── pain-context-extractor.ts # Pain signal processing
│   ├── local-worker-routing.ts  # Task delegation policy
│   ├── promotion-gate.ts        # Checkpoint deployment control
│   ├── trajectory.ts            # Behavior trajectory storage
│   ├── shadow-observation-registry.ts
│   ├── focus-history.ts         # File edit history
│   ├── model-deployment-registry.ts
│   └── model-training-registry.ts
├── hooks/             # OpenClaw lifecycle hooks
│   ├── prompt.ts      # before_prompt_build handler
│   ├── gate.ts        # before_tool_call security gate
│   ├── pain.ts        # after_tool_call pain detection
│   ├── llm.ts         # LLM output analysis
│   ├── lifecycle.ts   # before/after compaction
│   └── subagent.ts    # Subagent lifecycle
├── commands/          # Slash commands (/pd-status, /pd-pain, etc.)
├── service/           # Background services
│   ├── evolution-worker.ts      # Periodic evolution processing
│   ├── trajectory-service.ts    # Trajectory storage service
│   ├── health-query-service.ts
│   └── nocturnal-service.ts      # Nightly training pipeline
├── utils/             # Utilities (I/O, hashing, glob matching)
├── types/             # TypeScript type definitions
├── config/            # Configuration management
└── constants/         # Tool definitions, thresholds

packages/create-principles-disciple/
├── src/index.ts       # CLI installer entry
├── src/prompts.ts     # Installation prompts
└── src/uninstaller.ts # Removal script
```

## Hook Architecture

| Hook | Handler | Purpose |
|------|---------|---------|
| `before_prompt_build` | `hooks/prompt.ts` | Injects Thinking OS, pain signals, OKR context |
| `before_tool_call` | `hooks/gate.ts` | Security gate - blocks risky operations without approval |
| `after_tool_call` | `hooks/pain.ts` | Detects failures → PainToPrincipleService (Runtime V2) |
| `llm_output` | `hooks/llm.ts` | Analyzes LLM reasoning patterns |
| `before_message_write` | `hooks/message-sanitize.ts` | Sanitizes output |
| `subagent_spawning` | `hooks/subagent.ts` | Shadow routing for local workers |
| `subagent_ended` | `hooks/subagent.ts` | Completes shadow observations |
| `before_compaction` | `hooks/lifecycle.ts` | State checkpoint before context loss |
| `after_compaction` | `hooks/lifecycle.ts` | Cleanup after compaction |

## Storage Architecture

**Per-workspace SQLite databases:**
- `{workspaceDir}/.principles/evolution-scorecard.json` - Evolution points and tier
- `{workspaceDir}/.principles/pain/` - Pain signal flags
- `{workspaceDir}/.principles/trajectories/` - Behavior trajectory data

**Central database (Principles Console):**
- `~/.openclaw/principles-console.db` - Cross-workspace analytics
- Aggregates data from all workspaces for unified dashboard

## See Also

- [USER_GUIDE.md](./USER_GUIDE.md) - Usage documentation
- [EVOLUTION_POINTS_GUIDE.md](./EVOLUTION_POINTS_GUIDE.md) - Evolution system details
