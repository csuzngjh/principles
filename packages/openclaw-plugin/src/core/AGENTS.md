# src/core/ — Domain Core

**27 TypeScript files.** Trust engine, evolution pipeline, pain calculation, config, trajectory DB, event log, hygiene tracking.

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Trust permissions | `trust-engine.ts` | 4-stage model, score floor=30, cold-start grace |
| Evolution points | `evolution-engine.ts` | 5-tier EP system (Seed→Forest), double-reward after recovery |
| Principle lifecycle | `evolution-reducer.ts` | Event sourcing → `evolution.jsonl` stream |
| Pain scoring | `pain.ts` | Tool failures + gate blocks → pain score |
| Config management | `config.ts`, `config-service.ts` | PainConfig, dot-notation `get()`, singleton factory |
| Trajectory analytics | `trajectory.ts` | SQLite (better-sqlite3), sessions/turns/tool_calls |
| Event logging | `event-log.ts` | JSONL buffered writes (20 entries or 30s flush) |
| Pain patterns | `dictionary.ts`, `dictionary-service.ts` | Regex + exact_match rules |
| Detection funnel | `detection-funnel.ts`, `detection-service.ts` | Text input queue |
| Session state | `session-tracker.ts` | GFI, token usage, stuck loop detection |
| Central facade | `workspace-context.ts` | `WorkspaceContext.fromHookContext(ctx)` — all services flow through here |
| Path resolution | `paths.ts`, `path-resolver.ts` | `api.resolvePath()` is the only compliant entry |

## CONVENTIONS

- **Singleton factory**: `XxxService.get(stateDir)` — cached per stateDir
- **WorkspaceContext facade**: lazy-initializes config, trust, eventLog, dictionary, hygiene, evolutionReducer, trajectory
- **Event sourcing**: EvolutionReducerImpl appends events → in-memory state update
- **File locking**: `withLock()` / `withLockAsync()` for critical state (evolution, trajectory, trust)
- **Buffered flush**: EventLog batches 20 entries or flushes every 30s

## ANTI-PATTERNS

- ❌ Never bypass WorkspaceContext — always go through the facade
- ❌ Never write to `.state/` files directly — use the service layer
- ❌ Never hardcode paths — use `paths.ts` / `path-resolver.ts`
