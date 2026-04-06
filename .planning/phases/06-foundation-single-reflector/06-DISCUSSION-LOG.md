# Phase 6: Foundation and Single-Reflector Mode - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-05
**Phase:** 06-foundation-single-reflector
**Mode:** discuss
**Areas discussed:** Transport type, NocturnalWorkflowSpec result type, Timeout/TTL values, sweepExpiredWorkflows behavior, WorkflowStore event types

## Transport type

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse runtime_direct | Use existing 'runtime_direct'. Consistent with Empathy/DeepReflect. RuntimeDirectDriver won't actually spawn sessions, but transport type stays uniform across all helper workflows. | ✓ |
| New runtime_adapter transport | Define new 'runtime_adapter' transport type. More explicit that nocturnal workflows call internal adapters rather than spawning subagent sessions directly. | |
| Skip SubagentWorkflowSpec | NocturnalWorkflowManager implements WorkflowManager directly without SubagentWorkflowSpec. Simpler but less uniform with other helpers. | |

**User's choice:** Reuse runtime_direct
**Notes:** —

---

## NocturnalWorkflowSpec result type

| Option | Description | Selected |
|--------|-------------|----------|
| Single NocturnalResult | Unified type with success flag + optional artifact + diagnostics. Like executeNocturnalReflectionAsync returns today. Simple, direct mapping. | ✓ |
| Discriminated union | NocturnalSuccess { artifact, diagnostics }  NocturnalFailure { reason, skipType }. Exhaustive matching in TypeScript. More type-safe but complex. | |

**User's choice:** Single NocturnalResult
**Notes:** —

---

## Timeout and TTL values

| Option | Description | Selected |
|--------|-------------|----------|
| 9min timeout / 15min TTL | 9min = 3×180s Trinity stages. 15min TTL gives buffer for snapshot extraction, artifact writing, and cleanup before orphan sweep. | |
| 15min timeout / 30min TTL | More generous. Accounts for possible model latency variance and concurrent load. 30min TTL before orphan sweep. | ✓ |
| Config-based | Accept timeoutMs/ttlMs as options to startWorkflow, with sensible defaults (9min/15min). Most flexible. | |

**User's choice:** 15min timeout / 30min TTL
**Notes:** —

---

## WorkflowStore event types

| Option | Description | Selected |
|--------|-------------|----------|
| Generic event types | Use 'workflow_started', 'workflow_completed', 'workflow_failed'. Consistent with Empathy/DeepReflect. Easier to query all workflows uniformly. | |
| Nocturnal-specific events | Use 'nocturnal_started', 'nocturnal_completed', 'nocturnal_failed', 'nocturnal_fallback'. More descriptive for debugging, but less uniform with other helpers. | ✓ |

**User's choice:** Nocturnal-specific events
**Notes:** —

---

## sweepExpiredWorkflows behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Mark expired only | Same as Empathy/DeepReflect. Mark state as 'expired' in WorkflowStore. TrinityRuntimeAdapter manages its own session cleanup internally — nothing extra needed. | |
| Clean partial artifacts | Mark expired + delete any partial artifact files in stateDir with workflowId prefix. Prevents artifact pollution from failed runs. | ✓ |
| Emit degrade signal | Mark expired + write degrade marker so evolution-worker knows to use stub fallback on next cycle. More robust than relying on phase completion. | |

**User's choice:** Clean partial artifacts
**Notes:** —

## Claude's Discretion

The following were left to Claude's judgment during implementation:
- Exact `NocturnalResult` field names and structure (mirrors `executeNocturnalReflectionAsync` return type)
- How to identify "partial artifacts" — file naming convention in stateDir
- Whether to include `nocturnal_expired` event or just mark state
- Internal organization of NocturnalWorkflowManager class (private methods, etc.)

## Deferred Ideas

- **Phase 7:** Trinity multi-stage chain — NocturnalWorkflowManager will need `runTrinityAsync` path in addition to single-reflector
- **Phase 9:** Degrade behavior — Trinity failure → stub fallback (not EmpathyObserver/DeepReflect)
