# History Retrieval and Context Assembly SPEC

> Status: Draft v1  
> Date: 2026-04-21  
> Scope: PD-owned historical trajectory retrieval, context assembly workflow, CLI contracts, bounded payload construction

## 1. Purpose

This document specifies how PD retrieves historical conversation and trajectory evidence and converts it into a structured context payload for reflective workflows.

This capability is foundational for:

- diagnostician
- replay
- nocturnal reflection
- principle extraction
- root cause analysis

## 2. Design Position

Historical retrieval is not a helper utility.

It is a PD core capability and must be owned by PD rather than improvised by host runtimes or left to prompt-side LLM behavior.

## 3. Problem Statement

PD must often answer questions like:

- what exact interaction led to this pain signal
- what surrounding tool calls or gate events matter
- what was the real user-assistant exchange window
- which of several session-like references is the right one

This cannot be reduced to:

- one SQL query
- one sessionId lookup
- one file read

In practice, evidence may be spread across:

- database rows
- session transcripts
- trajectory logs
- event logs
- artifacts
- workspace files

Therefore historical retrieval must be treated as a controlled workflow.

## 4. Goals

The history retrieval subsystem must:

1. locate likely trajectories from imperfect references
2. extract bounded evidence windows
3. correlate multiple evidence sources
4. return structured machine-readable output
5. be safe for agent use
6. reduce dependence on host-specific APIs

## 5. Non-Goals

This v1 spec does not define:

- every possible storage backend
- semantic memory retrieval beyond trajectory evidence
- ranking by embedding similarity
- web UI browsing

It focuses on deterministic and inspectable retrieval.

## 6. Core Commands

The minimum CLI surface is:

- `pd trajectory locate`
- `pd history query`
- `pd context build`

## 7. `pd trajectory locate`

### 7.1 Purpose

Find the most likely trajectory roots related to a pain/task/run/session reference.

### 7.2 Inputs

Supported selectors:

- `--pain-id`
- `--task-id`
- `--run-id`
- `--session-id`
- `--time-range`
- `--workspace`

At least one selector is required.

### 7.3 Search Responsibilities

The locator may internally inspect:

- task stores
- run stores
- event logs
- trajectory indices
- artifact registries
- session transcripts
- workspace metadata

### 7.4 Output Contract

```ts
export interface TrajectoryLocateResult {
  query: {
    painId?: string;
    taskId?: string;
    runId?: string;
    sessionId?: string;
    timeRange?: {
      start: string;
      end: string;
    };
    workspace?: string;
  };
  candidates: Array<{
    trajectoryRef: string;
    confidence: number;
    reasons: string[];
    sourceTypes: string[];
  }>;
}
```

### 7.5 Ranking Rule

Candidate ranking should use explicit heuristics, not opaque LLM ranking.

Examples:

- exact task-to-run link
- exact pain-to-event link
- session ID match
- time-window overlap
- artifact correlation

### 7.6 v1 Heuristic Guidance

The first implementation should define explicit weighted signals.

Illustrative v1 guidance:

- exact task or run linkage: highest weight
- exact pain-to-event linkage: high weight
- exact session match: high weight
- time-window overlap: medium weight
- artifact correlation: medium weight
- weaker filename or directory proximity signals: low weight

## 8. `pd history query`

### 8.1 Purpose

Extract a bounded interaction slice once a candidate trajectory or session has been identified.

### 8.2 Inputs

Supported selectors:

- `--trajectory-ref`
- `--session-id`
- `--limit`
- `--time-before-ms`
- `--time-after-ms`
- `--roles`
- `--include-tools`
- `--include-events`
- `--workspace`

### 8.3 Output Contract

```ts
export interface HistoryQueryEntry {
  ts: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text?: string;
  toolName?: string;
  toolResultSummary?: string;
  eventType?: string;
}

export interface HistoryQueryResult {
  sourceRef: string;
  entries: HistoryQueryEntry[];
  truncated: boolean;
}
```

### 8.4 Boundedness Rule

This command must enforce:

- max entry count
- max text size
- bounded event inclusion

It must not dump raw unbounded transcripts into the caller.

## 9. `pd context build`

### 9.1 Purpose

Build a reflection-ready `ContextPayload` for a target PD agent.

### 9.2 Inputs

Supported selectors:

- `--task-id`
- `--pain-id`
- `--run-id`
- `--session-id`
- `--agent`
- `--workspace`

### 9.3 Target Agents

Initial intended consumers:

- `diagnostician`
- `replay-judge`
- `explorer`
- nocturnal reflection stages

### 9.4 Output Contract

```ts
export interface ContextPayload {
  contextId: string;
  sourceRefs: string[];
  targetAgent: string;
  diagnosisTarget?: {
    reasonSummary?: string;
    source?: string;
    severity?: string;
  };
  conversationWindow: HistoryQueryEntry[];
  eventSummaries?: Array<Record<string, unknown>>;
  artifactRefs?: string[];
  ambiguityNotes?: string[];
  summary: string;
}
```

### 9.5 Assembly Rule

The command should internally perform:

1. locate
2. expand
3. verify
4. assemble

The caller receives only the assembled structured payload.

### 9.6 Summary Generation Rule

If `summary` is included in `ContextPayload`, it should be produced by deterministic PD-owned code or template logic in v1.

Baseline context assembly must not require an additional opaque LLM summarization step.

## 10. Retrieval Workflow

### 10.1 Phase 1: Candidate Discovery

Use provided selectors to locate plausible evidence roots.

### 10.2 Phase 2: Evidence Expansion

Expand around the best candidates by:

- nearby messages
- nearby tool calls
- nearby events
- related artifacts

### 10.3 Phase 3: Relevance Verification

Apply deterministic heuristics to confirm or downgrade candidates.

### 10.4 Phase 4: Payload Construction

Produce bounded structured output suitable for LLM consumption.

## 11. Why This Is a Workflow, Not a Query

This is the key rule of the spec.

The system must assume:

- IDs can be imperfect
- indexes can be incomplete
- evidence may be distributed
- relevance may require iterative confirmation

Therefore the interface must hide this complexity behind PD-owned retrieval commands rather than forcing agents to improvise against raw stores.

## 12. Use by Agents

### 12.1 Correct Usage Pattern

Agents should prefer:

1. `pd trajectory locate`
2. `pd history query`
3. `pd context build`

instead of:

- raw SQL guessing
- direct file archaeology
- direct host API assumptions

### 12.2 Why This Matters

This reduces:

- agent error rate
- retrieval inconsistency
- prompt length inflation
- dependence on very large models

It increases:

- repeatability
- auditability
- cross-runtime portability

## 13. Safety and Integrity Requirements

The retrieval layer must be:

- workspace-scoped
- schema-validated
- bounded
- explicit about ambiguity
- resilient to missing sources

### 13.2 Degradation Policy

Context assembly must support a bounded degradation path.

If retrieval exceeds time, complexity, or source-availability thresholds, the subsystem should return a partial but usable payload with explicit ambiguity notes instead of failing unboundedly.

Recommended degraded outputs may include:

- a recent bounded message window
- directly linked task metadata
- directly linked pain or event summaries
- ambiguity notes such as `retrieval_timeout` or `partial_context`

### 13.1 Ambiguity Rule

If evidence remains ambiguous, the system must say so explicitly in:

- `ambiguityNotes`
- candidate confidence

It must not pretend certainty.

## 14. Error Semantics

The following normalized errors apply:

- `history_not_found`
- `trajectory_ambiguous`
- `context_assembly_failed`
- `storage_unavailable`
- `workspace_invalid`
- `query_invalid`

## 15. Relationship to Diagnostician v2

Diagnostician v2 should consume `ContextPayload` from this subsystem rather than performing raw retrieval itself.

That means:

- better determinism
- smaller prompt surface
- cleaner runtime portability

## 16. Recommended Implementation Order

1. implement `pd trajectory locate`
2. implement `pd history query`
3. implement `pd context build`
4. plug diagnostician onto `pd context build`

This order is intentional because context quality is upstream of diagnosis quality.

## 17. Acceptance Criteria

This spec is minimally satisfied when:

1. PD can locate relevant trajectories without relying on one exact storage lookup assumption.
2. PD can extract bounded historical windows suitable for LLM input.
3. PD can assemble context payloads for diagnostician from PD-owned retrieval logic.
4. Agents no longer need to directly improvise against SQLite, raw session files, or host runtime APIs for basic reflection context.

## 18. One-Sentence Summary

History retrieval in PD Runtime v2 is a PD-owned, bounded, multi-step evidence workflow that standardizes how agents find and consume the right past conversation trace for reflection and diagnosis.
