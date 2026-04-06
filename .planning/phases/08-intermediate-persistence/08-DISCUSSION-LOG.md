# Phase 8: Intermediate Persistence and Idempotency - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-06
**Phase:** 08-intermediate-persistence
**Areas discussed:** Stage output storage, Idempotency key placement, Crash recovery trigger

---

## Stage output storage

| Option | Description | Selected |
|--------|-------------|----------|
| New stage_outputs table (Recommended) | New SQLite table: workflow_id, stage, output_json, idempotency_key, created_at. Clean separation, easy queries by workflowId+stage, supports schema evolution. | ✓ |
| payload_json in existing events | Store outputs as payload of a new event type (e.g., trinity_dreamer_output). Reuses existing table, no migration. | |
| File-based in stateDir | Write outputs as JSON files under stateDir/nocturnal/stage_outputs/. Native fs performance, but outside SQLite transaction scope. | |

**User's choice:** New stage_outputs table (Recommended)
**Notes:** New table keeps clean separation and indexed queries by workflowId+stage.

---

## Idempotency key placement

| Option | Description | Selected |
|--------|-------------|----------|
| Check stage_outputs table (Recommended) | On startWorkflow, query stage_outputs for existing outputs. If found with matching idempotency_key, skip that stage. Clean, co-located with outputs. | ✓ |
| Workflow metadata lookup | Store idempotency_key in workflow metadata_json. Check metadata before running each stage. No new table needed for the key itself. | |
| On-the-fly derivation only | Compute hash(workflowId+stage+inputDigest) on-the-fly from current TrinityResult. If output exists at expected path, skip. Minimal storage, deterministic. | |

**User's choice:** Check stage_outputs table (Recommended)
**Notes:** Idempotency key stored alongside outputs in stage_outputs table, enabling co-located lookup.

---

## Crash recovery trigger

| Option | Description | Selected |
|--------|-------------|----------|
| On startWorkflow (Recommended) | At the start of each workflow run, query stage_outputs for prior outputs with matching workflowId. If found, skip completed stages. Aligns with idempotency check. | ✓ |
| On manager construction | In NocturnalWorkflowManager constructor, scan WorkflowStore for workflows in 'active' state and recover them. Runs once per manager instantiation. | |
| Background sweep | Extend sweepExpiredWorkflows to detect 'active' workflows with stage outputs and complete them. Separate from normal start path. | |

**User's choice:** On startWorkflow (Recommended)
**Notes:** Recovery check at startWorkflow aligns with idempotency check — both query stage_outputs before running stages.

---

## Claude's Discretion

No areas deferred to Claude — all decisions made by user.

## Deferred Ideas

None.

