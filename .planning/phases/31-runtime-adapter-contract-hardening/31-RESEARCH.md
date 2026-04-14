# Phase 31 Research - Runtime Adapter Contract Hardening

## Why This Phase Exists

Phase 30 established that the next production bottleneck is runtime contract fragility, not module decomposition. The system still makes assumptions about:

- how OpenClaw runtime invocation behaves
- how model/provider selection is resolved
- how session/workflow artifacts are identified and cleaned up
- which queue changes are safe after long-running async execution

These assumptions must be converted into explicit adapter contracts.

## Immediate Runtime Risks

### 1. Pain ingress is still baseline-critical
`PainFlagDetector.detect()` currently reads a handwritten path (`path.join(this.workspaceDir, 'PAIN_FLAG')`) instead of the canonical PD state path. This is both a merge-gate bug and a sign that ingress contracts are not centralized enough.

### 2. Queue update discipline is not yet runtime-safe
`EvolutionTaskDispatcher.dispatchQueue()` still performs broad save operations after async work. That can overwrite concurrent updates and violates the contract matrix requirement that long-running runtime flows update only from fresh state.

### 3. Sleep reflection enqueue is not yet atomic
The load-check-add path for `sleep_reflection` still spans separate lock scopes, which is incompatible with a trustworthy runtime trigger boundary.

### 4. Runtime semantics are not fully explicit
`NocturnalWorkflowManager` still contains fallback cleanup logic around session handling. That may be necessary operationally, but it must become an explicit, tested contract rather than an ad hoc recovery path.

## Planning Consequences

Phase 31 should split into two plans:

1. **Plan 31-01:** narrow and implement the runtime adapter and ingress contracts in production code
2. **Plan 31-02:** add contract tests and failure-class diagnostics so runtime drift is caught mechanically

This keeps the implementation phase aligned with the Phase 30 owner split and avoids mixing runtime hardening with export truth semantics.
