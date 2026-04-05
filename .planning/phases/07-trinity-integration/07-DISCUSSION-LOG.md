# Phase 7: Trinity Integration with Event Recording - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-05
**Phase:** 07-trinity-integration
**Areas discussed:** Stage Event Recording Strategy, Stage Failure Handling, Async Execution Pattern

---

## Stage Event Recording Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Per-stage events (recommended) | Record trinity_dreamer_start/complete/failed, trinity_philosopher_*, trinity_scribe_* per stage. Enables progress tracking and partial result recovery. | ✓ |
| Final result only | Record only nocturnal_completed/nocturnal_failed with embedded stage metadata. Simpler but no progress visibility. | |
| Hybrid — key stages only | Record trinity_dreamer_complete and trinity_scribe_complete only. Philosopher transitions internal unless it fails. | |

**User's choice:** Per-stage events (recommended)

---

## Stage Failure Handling

| Option | Description | Selected |
|--------|-------------|----------|
| terminal_error immediately (recommended) | Workflow enters terminal_error state immediately. TrinityStageFailure[] embedded in nocturnal_failed event. No partial artifact. | ✓ |
| Try single-reflector fallback | On Philosopher failure, fall back to single-reflector path. Requires re-invoking executeNocturnalReflectionAsync with useTrinity=false. | |
| Preserve Dreamer output for debugging | Record Dreamer's output even on Philosopher failure. Enables debugging without full chain completion. | |

**User's choice:** terminal_error immediately (recommended)

---

## Async Execution Pattern

| Option | Description | Selected |
|--------|-------------|----------|
| Return handle immediately, report via notifyWaitResult | startWorkflow spawns workflow and returns immediately with state='active'. notifyWaitResult becomes the real async callback for stage completions. | ✓ |
| await full chain, return completed | startWorkflow awaits the full Trinity chain. Simpler model — no notifyWaitResult changes needed. Caller blocks until complete. | |
| Background execution with callback | startWorkflow returns immediately. Trinity runs in background. Executor provides a callback/EventEmitter for stage completion notifications. | |

**User's choice:** Return handle immediately, report via notifyWaitResult

---

## Stage Event Recording Implementation

| Option | Description | Selected |
|--------|-------------|----------|
| Record events AFTER Trinity completes (recommended) | Let runTrinityAsync complete. Then parse TrinityResult (telemetry, failures[]) and record all stage events in a batch. Simpler — no callback infrastructure needed. | ✓ |
| Extend runTrinityAsync to accept callback hooks | Modify runTrinityAsync to accept onStageComplete callbacks. Each stage emits an event as it completes. More complex but provides true per-stage progress. | |
| Hybrid — major stages only via polling | Poll/wait between Dreamer and Philosopher, between Philosopher and Scribe. Not true async but gives coarse-grained progress. | |

**User's choice:** Record events AFTER Trinity completes (recommended)
