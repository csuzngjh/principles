# ADR-0004: L2 Auto-Correction & GoldenTrace Replay

> **Status**: Accepted
> **Date**: 2026-05-11 (revised)
> **Replaces**: ADR-0004 v1 (2026-05-11)
> **Related**: [ADR-0001](./0001-runtime-v2-service-boundaries.md), [ADR-0003](./0003-peer-agent-state-machine-orchestration.md), DOMAIN_MODEL.md

## 1. Context

L2 hard internalization (Code/Hook/Tool) compiles principles into sandboxed JS via `PrincipleCompiler` and executes them in `RuleHost`. Two core deficiencies exist:

1. **Passive Blocking**: `RuleHost` decisions are limited to `allow`, `block`, `requireApproval`. When an agent makes a minor syntax error (e.g. missing parameter), `block` disrupts the task flow and forces the LLM to burn context on reflection and retry.
2. **No Regression Protection**: `PrincipleCompiler` generates JS sandbox code in one LLM shot and enters `probation` directly against live traffic. If the generated logic has bugs (e.g. overly broad regex), it causes severe false-positive blocking.

L2 needs **residual auto-correction** capability, and its generation process must be **regression-testable**.

## 2. Decisions

### Decision 1: Correction Proposal Contract (not mutation)

The original ADR allowed RuleHost to **directly mutate** `event.params`. This is rejected as unsafe for production. Instead, we introduce a **proposed correction** contract where RuleHost proposes parameter changes but **never applies them directly**.

**Technical Contract**:

```typescript
// @principles/core — correction proposal (pure domain model)
export type CorrectionApplicationMode = 'shadow' | 'live';

export interface CorrectionProposal {
  /** The corrected parameter set — RuleHost proposes, does not apply */
  proposedParams: Record<string, unknown>;
  /** Which fields changed and why */
  correctedFields: Array<{
    field: string;
    original: unknown;
    proposed: unknown;
    reason: string;
  }>;
  /** Shadow mode = log only, no actual parameter replacement.
   *  Live mode = hook applies proposedParams before tool execution.
   *  Default: 'shadow' */
  applicationMode: CorrectionApplicationMode;
  /** Confidence in the correction (0–1) */
  confidence: number;
  /** Rule that produced this proposal */
  ruleId: string;
  principleId?: string;
}

export interface CorrectionAuditEvent {
  /** Unique event ID for replay */
  eventId: string;
  /** Timestamp (ISO 8601) */
  timestamp: string;
  /** The proposal that triggered this event */
  proposal: CorrectionProposal;
  /** Original tool call params (immutable snapshot) */
  originalParams: Record<string, unknown>;
  /** What actually happened */
  outcome: 'applied' | 'shadow_logged' | 'rejected_by_hook' | 'rejected_by_confidence';
  /** Session context for telemetry correlation */
  sessionId?: string;
  /** Tool name that was intercepted */
  toolName: string;
}
```

**Extended RuleHostResult** (in `rule-host-contracts.ts`):

```typescript
export type RuleHostDecision = 'allow' | 'block' | 'requireApproval' | 'propose_correction';

export interface RuleHostResult {
  decision: RuleHostDecision;
  matched: boolean;
  reason: string;
  diagnostics?: Record<string, unknown>;
  ruleId?: string;
  principleId?: string;
  /** Present when decision is 'propose_correction' */
  correctionProposal?: CorrectionProposal;
}
```

**Execution flow** (plugin hook layer ONLY):

1. RuleHost returns `propose_correction` with a `CorrectionProposal`.
2. The **plugin hook** (`hooks/gate.ts`) is the **only layer** allowed to apply corrections to OpenClaw `event.params`.
3. If `applicationMode === 'shadow'`, the hook **logs the CorrectionAuditEvent** but does NOT modify `event.params`. Tool executes with original params.
4. If `applicationMode === 'live'` AND the hook's local policy allows it, the hook replaces `event.params` with `proposedParams`, emits the audit event, and returns `allow`.
5. Every correction — shadow or live — emits a `CorrectionAuditEvent` for telemetry and replay.

**Safety invariants**:

| Invariant | Enforcement |
|-----------|-------------|
| Default mode is `shadow` | Hook MUST treat missing `applicationMode` as `'shadow'` |
| No silent production mutation | Audit event is emitted even in shadow mode |
| RuleHost never mutates params | `CorrectionProposal` is a read-only data structure |
| Only plugin hook applies corrections | Core has no OpenClaw event access |
| Confidence gate | Hook rejects proposals below configurable threshold |

### Decision 2: GoldenTrace as Independent L2 Artifact

GoldenTrace is an **L2 artifact and read model**, not a field in `DiagnosticianOutputV1`.

**Key decoupling**:
- `DiagnosticianOutputV1` is NOT modified. It continues to produce `recommendations` with `kind: 'rule'`.
- GoldenTrace extraction is a **separate pipeline step** that consumes pain signals and tool call history, not Diagnostician output directly.
- GoldenTrace has its own domain model (`GoldenTrace` / `GoldenTraceCase`) in `@principles/core`.

**GoldenTrace domain model** (defined in `@principles/core/runtime-v2/internalization/golden-trace.ts`):

```typescript
export interface GoldenTraceCase {
  /** Unique case ID */
  caseId: string;
  /** 'negative' = the original failure; 'positive' = a known-safe invocation */
  kind: 'negative' | 'positive';
  /** Captured tool call snapshot */
  toolName: string;
  params: Record<string, unknown>;
  /** What the compiled rule should decide for this case */
  expectedDecision: 'allow' | 'block' | 'propose_correction';
  /** When expectedDecision is 'propose_correction', the expected corrected params */
  expectedCorrectedParams?: Record<string, unknown>;
}

export interface GoldenTrace {
  traceId: string;
  /** Source references — traceability to pain/candidate/artifact */
  sourcePainId?: string;
  sourceCandidateId?: string;
  sourceArtifactId?: string;
  /** The test cases — must contain at least one negative and one positive */
  cases: GoldenTraceCase[];
  /** Metadata */
  createdAt: string;
  version: 1;
}
```

**Compiler validation loop**:
After `PrincipleCompiler` generates JS code, before writing to ledger:
1. **Test 1 (catch test)**: Input negative case, assert output is `block` or `propose_correction`.
2. **Test 2 (no-false-positive test)**: Input positive case, assert output is `allow`.

If the generated code fails validation, the compiler feeds errors back to the LLM for bounded self-correction. If retries exhaust, the rule is abandoned and the principle remains at L1 soft-prompt level.

### Decision 3: Shadow-First Rollout

Auto-correction MUST operate in **shadow mode by default** before any live activation:

1. **Phase 1 — Shadow only**: All `propose_correction` results are logged as `CorrectionAuditEvent` with `outcome: 'shadow_logged'`. No params are modified.
2. **Phase 2 — Graduated live**: After shadow metrics show acceptable precision/recall, individual rules can be promoted to `live` mode via operator configuration.
3. **Phase 3 — Audit & Replay**: Every `CorrectionAuditEvent` is replayable. Operators can replay shadow-mode corrections to verify correctness before promotion.

## 3. Explicit Non-Goals

This ADR does **NOT**:
- Implement live auto-correction immediately (shadow-first rollout)
- Modify `DiagnosticianOutputV1` schema
- Mutate the principle ledger
- Execute generated rule code in production (only in compiler sandbox)
- Require `notifyAgent` injection into LLM context (deferred to future ADR)

## 4. Consequences

### Positive

| Benefit | Mechanism |
|---------|-----------|
| Reduced token waste | L2 auto-corrects minor errors instead of blocking and forcing LLM retry |
| Regression safety | Every compiled rule passes GoldenTrace before entering probation |
| Audit trail | `CorrectionAuditEvent` ensures every correction is observable and replayable |
| Safe default | Shadow mode prevents silent production mutation |
| Architecture alignment | Follows ADR-0001 service boundaries (core proposes, plugin applies) |
| State machine alignment | Uses ADR-0003 peer runner pattern for GoldenTrace compilation |

### Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Agent confusion ("I wrote correct code") | `CorrectionAuditEvent` enables operator visibility; `notifyAgent` deferred to future work |
| Overly aggressive corrections | Confidence threshold + shadow-first rollout |
| GoldenTrace drift from real failures | GoldenTrace is versioned; operators can refresh from recent pain signals |

## 5. Implementation Sequence

| Step | Scope | ADR Section |
|------|-------|-------------|
| 1 | ADR-0004 revision (this document) | All |
| 2 | GoldenTrace domain model + validation + fixture | Decision 2 |
| 3 | CorrectionProposal + CorrectionAuditEvent core types | Decision 1 |
| 4 | Plugin hook shadow-mode integration | Decision 1, 3 |
| 5 | Compiler validation loop with GoldenTrace | Decision 2 |
| 6 | Live mode promotion + confidence gating | Decision 3 |
