# Phase 30 Research - Runtime & Truth Contract Framing

## Diagnosis Freeze

The current production instability is no longer best described as only "workspace/file boundary bugs". That was the dominant problem in v1.13. After v1.14 decomposition, the next failure layer is:

1. **Runtime contract gaps**
   The system still relies on inferred OpenClaw behavior at key execution boundaries, especially around embedded runtime invocation, session ownership, workflow/session cleanup, and model/provider selection.

2. **Truth contract gaps**
   Artifacts used for training, export, promotion, and evaluation can still overstate facts when evidence is incomplete. Missing evidence is not yet consistently represented as `unknown`, `not_observed`, or omission.

## Why v1.14 Must Be Preserved

v1.14 created the structural seams that make the next hardening round possible:

- `EvolutionQueueStore`
- `PainFlagDetector`
- `EvolutionTaskDispatcher`
- `WorkflowOrchestrator`
- `TaskContextBuilder`
- `fallback-audit.ts`

Without these seams, runtime and truth contracts would have to be layered back onto a monolith. That would recreate the same maintenance risk that v1.14 removed.

## Why PR #243 Is Not a Second Merge Target

`PR #243` contains useful repairs, especially around `/pd-reflect` workspace resolution and diagnostics, but it is not a clean successor to `PR #245`. The two lines have diverged. Treating them as two independent merge targets would reintroduce duplicated semantics and conflict-heavy integration. Therefore:

- `PR #245` remains the structural baseline
- `PR #243` is a repair source only
- valuable fixes from `PR #243` should be re-applied or cherry-picked onto the `PR #245` line

## Production-Path Boundaries Still Relying on Inference

- Runtime adapter behavior for background or embedded model execution
- Model/provider resolution and fallback semantics
- Session artifact lookup and ownership assumptions
- Workflow/session cleanup behavior when gateway calls fail
- Queue persistence assumptions after long-running dispatch work
- Sleep-reflection enqueue dedup semantics under concurrency

## Export and Dataset Boundaries Still At Risk

- ORPO export serialization currently maps `prompt/chosen/rejected` mechanically but does not itself enforce an evidence contract
- Training-facing and promotion-facing narratives still need explicit rules for how to represent absent pain/failure/violation evidence
- Missing or partial metadata is not yet consistently downgraded to `unknown`

## Planning Consequences

This diagnosis implies a clean split:

- **Phase 31** owns runtime adapter contracts and runtime drift tests
- **Phase 32** owns evidence-bound export and dataset truth semantics
- **Phase 33** owns machine-checkable invariants and merge-gate verification

Phase 30 therefore exists to freeze the diagnosis once, establish shared vocabulary, and stop the team from re-solving the same framing problem during implementation.
