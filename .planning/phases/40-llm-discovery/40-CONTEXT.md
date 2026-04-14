# Phase 40: Failure Classification & Cooldown Recovery - Context

**Gathered:** 2026-04-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Classify nocturnal pipeline task failures (sleep_reflection, keyword_optimization, deep_reflect) as transient or persistent, with tiered cooldown escalation. Transient failures use existing retry.ts infrastructure. Persistent failures (3 consecutive failures) trigger stepped cooldowns (30min → 4h → 24h) persisted to nocturnal-runtime.json.

This phase does NOT: create new failure types for LLM calls or file operations (covered by retry.ts), modify retry.ts internals, or handle startup reconciliation (Phase 41).

</domain>

<decisions>
## Implementation Decisions

### Failure Classification Scope
- **D-01:** Scope limited to nocturnal pipeline tasks: `sleep_reflection`, `keyword_optimization`, `deep_reflect`
- **D-02:** Existing `retry.ts` + `isRetryableError()` handles transient fault retry — Phase 40 does NOT modify retry logic
- **D-03:** Classification applies at the task level in evolution-worker.ts, not at individual LLM call or file operation level

### Transient vs Persistent Determination
- **D-04:** "Persistent failure" = 3 consecutive failures of the same task kind (e.g., 3 consecutive sleep_reflection failures)
- **D-05:** Counter resets to 0 on any successful task completion (simple, predictable)
- **D-06:** Counter tracked per task kind — sleep_reflection, keyword_optimization, deep_reflect each have independent counters
- **D-07:** `isRetryableError()` classification informs the initial retry (existing behavior); consecutive failure counter tracks across retries

### Cooldown Escalation Architecture
- **D-08:** New independent modules: `failure-classifier.ts` (classification logic) and `cooldown-strategy.ts` (escalation logic) — do NOT extend existing modules
- **D-09:** Three-tier stepped escalation: 30min → 4h → 24h
  - Tier 1 (1st persistent detection): 30min cooldown
  - Tier 2 (2nd persistent detection): 4h cooldown
  - Tier 3 (3rd+ persistent detection): 24h cooldown (cap)
- **D-10:** Cooldown state persisted to nocturnal-runtime.json — survives process restarts
- **D-11:** Phase 41 (Startup Reconciliation) responsible for clearing stale/expired cooldowns on startup

### Integration Points
- **D-12:** `failure-classifier.ts` reads task outcomes from evolution-worker.ts task state machine
- **D-13:** `cooldown-strategy.ts` integrates with existing `checkCooldown()` in nocturnal-runtime.ts for enforcement
- **D-14:** Cooldown tiers stored in config (nocturnal-config.ts or new config section) for tuning without code changes

### Claude's Discretion
- Exact file structure and module boundaries within the new modules
- How to integrate failure counters with the existing task state machine in evolution-worker.ts
- Whether cooldown-strategy.ts extends or wraps existing checkCooldown()
- Logging and diagnostic output format

</decisions>

<specifics>
## Specific Ideas

- Phase 30 decision "name failure classes explicitly" (e.g., `runtime_unavailable`, `invalid_runtime_request`) should inform the classifier design
- Phase 31 decision "unsupported runtime states fail explicitly" — same philosophy for persistent failure handling
- Phase 39 code review CR-01: shared heartbeatCounter between keyword_optimization and sleep_reflection — the new failure classifier should have independent counters per task kind
- Phase 39 code review WR-01: daily throttle quota shared between runs — cooldown strategy should NOT share quota slots with normal operation throttles

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Error Classification & Retry Infrastructure
- `packages/openclaw-plugin/src/config/errors.ts` — Existing PdError hierarchy with semantic error codes
- `packages/openclaw-plugin/src/utils/retry.ts` — isRetryableError(), retryAsync(), retry presets (DO NOT modify, use as reference)

### Cooldown & State Management
- `packages/openclaw-plugin/src/service/nocturnal-runtime.ts` — checkCooldown(), recordCooldown(), nocturnal state file format
- `packages/openclaw-plugin/src/service/nocturnal-config.ts` — Config defaults (cooldown_ms, period_heartbeats, trigger_mode)

### Task Lifecycle
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — Task state machine, heartbeat cycle, task outcome handling (primary integration point)

### Prior Phase Contexts
- `.planning/phases/39-learning-loop/39-CONTEXT.md` — Keyword optimization throttle decisions (checkCooldown patterns)
- `.planning/phases/30-runtime-truth-contract-framing/30-CONTEXT.md` — Explicit failure class naming decision
- `.planning/phases/31-runtime-adapter-contract-hardening/31-CONTEXT.md` — Explicit failure philosophy

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `checkCooldown()` in nocturnal-runtime.ts: Per-workspace and per-principle cooldown with quota windows — reuse for enforcement
- `recordCooldown()` in nocturnal-runtime.ts: Persists cooldown events — extend for tiered cooldown recording
- `PdError` hierarchy in config/errors.ts: Semantic error codes — reference for failure type naming
- `isRetryableError()` in retry.ts: Pattern-based retryable classification — do NOT modify, use as input

### Established Patterns
- Cooldown state stored in nocturnal-runtime.json as plain JSON with timestamps
- Per-task-kind configuration via dedicated config objects (e.g., kwOptConfig, sleepConfig)
- Phase 31 adapter pattern: explicit failure handling behind typed interfaces

### Integration Points
- evolution-worker.ts heartbeat cycle (lines 2385-2430): where task outcomes are processed — failure classifier hooks in here
- nocturnal-runtime.ts state file: where cooldown state is persisted
- nocturnal-config.ts: where new cooldown tier config would live

</code_context>

<deferred>
## Deferred Ideas

- LLM call failure classification beyond retry.ts scope — belongs in a future LLM resilience phase
- File operation failure classification — atomic writes (Phase 38-39) already handle most cases
- Adaptive cooldown based on failure rate trends — may be added after Phase 41 startup reconciliation proves the foundation works
- Global failure dashboard/monitoring — out of scope, production observability concern

</deferred>

---

*Phase: 40-llm-discovery*
*Context gathered: 2026-04-14*
