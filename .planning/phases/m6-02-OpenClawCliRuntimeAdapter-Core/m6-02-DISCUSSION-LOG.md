# Phase m6-02: OpenClawCliRuntimeAdapter Core - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-24
**Phase:** m6-02-OpenClawCliRuntimeAdapter Core
**Areas discussed:** Execution model, CLI control, Error mapping

---

## Execution Model

| Option | Description | Selected |
|--------|-------------|----------|
| 1-shot async | startRun spawns, blocks until close, stores result for pollRun/fetchOutput | ✓ |
| Poll-based async | startRun spawns, returns immediately; pollRun checks state | |
| Synchronous completion | startRun completes synchronously | |

**User's choice:** 1-shot async
**Notes:** This matches the ROADMAP.md success criteria: "One-shot run without session management complexity"

---

## CLI Control

| Option | Description | Selected |
|--------|-------------|----------|
| Env vars | PD passes OPENCLAW_PROFILE/OPENCLAW_CONTAINER_HINT env vars | |
| CLI flags only | PD passes --local flag; explicit local mode | ✓ |
| cwd fixed path | cwd fixed to OpenClaw workspace path | |

**User's choice:** CLI flags only
**Notes:** HG-3: --local must be explicit, no silent fallback. Gateway/local mode is controlled by --local flag presence.

---

## Error Mapping

| Option | Description | Selected |
|--------|-------------|----------|
| Map all | ENOENT, timeout, non-zero exit, invalid JSON mapped to specific categories | ✓ |
| ENOENT only | Only ENOENT mapped to runtime_unavailable; others → execution_failed | |
| Delegate to runner | Adapter just wraps CLI result; runner handles error mapping | |

**User's choice:** Map all
**Notes:** Maps all 5 categories: ENOENT→runtime_unavailable, timeout→timeout, non-zero exit→execution_failed, invalid JSON→output_invalid

---

## Claude's Discretion

All decisions were user-specified. No areas deferred to Claude.

## Deferred Ideas

None — discussion stayed within m6-02 scope.
