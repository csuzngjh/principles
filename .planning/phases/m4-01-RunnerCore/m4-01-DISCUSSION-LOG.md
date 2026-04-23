# Phase m4-01: RunnerCore - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-23
**Phase:** m4-01-RunnerCore
**Areas discussed:** Runner State Machine, Adapter I/O, Context Failure, Write Boundary

---

## Runner State Machine

| Option | Description | Selected |
|--------|-------------|----------|
| Phase-based step pipeline | RunnerPhase enum + independent methods per phase | ✓ |
| Linear async function | Single run() with sequential awaits | |
| State pattern | Explicit transition table + handler functions | |

**User's choice:** Phase-based step pipeline
**Notes:** Each phase independently testable, fine-grained error recovery

---

## Adapter I/O Pattern

| Option | Description | Selected |
|--------|-------------|----------|
| Polling loop | while + sleep, pollRun() until terminal | ✓ |
| Synchronous await | Assume startRun() blocks until done | |
| Event/callback | Adapter fires callback on completion | |

**User's choice:** Polling loop
**Notes:** Matches PDRuntimeAdapter interface exactly. Default 5s interval, configurable timeout via cancelRun()

---

## Context Build Failure

| Option | Description | Selected |
|--------|-------------|----------|
| Retry with backoff | retry_wait + context_assembly_failed, let RetryPolicy decide | ✓ |
| Degraded mode | Empty context, continue invocation | |
| Fail immediately | Mark task failed, no retry | |

**User's choice:** Retry with backoff
**Notes:** Distinguish transient (DB connection) vs permanent (task not found). Latter fails immediately.

---

## Write Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Via RuntimeStateManager | Encapsulate all store ops through integration layer | ✓ |
| Direct store access | Runner calls SqliteTaskStore/RunStore directly | |
| New result writer | Dedicated DiagnosticianResultWriter component | |

**User's choice:** Via RuntimeStateManager
**Notes:** DiagnosticianOutputV1 JSON → RunRecord.outputPayload. No independent artifact files in M4.

---

## Deferred Ideas

- TestDoubleRuntimeAdapter implementation → m4-02
- OpenClaw production adapter → M6
- Artifact file writes / principle candidates → M5
