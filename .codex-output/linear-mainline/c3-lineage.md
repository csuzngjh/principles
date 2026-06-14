# Runtime Mainline C3: preserve diagnostician lineage into dreamer tasks and context

## Why this matters
Current candidates contain useful lineage (`task_id`, `artifact_id`, `source_run_id`), but `IntakeToInternalizationBridge` seeds dreamer tasks with `dependencyTaskIds: []` and `candidate://...` refs. Dreamer therefore builds `contextHash: "empty"` and creates generic principles. This breaks the core MVP promise: behavior evidence should produce grounded, reviewable principles.

## MVP gate
- What happens if we do not do this? The chain may appear to run, but the internalized principle is ungrounded and low quality.
- How is it observed? Dreamer tasks created from candidates include the diagnosis task dependency and diagnostician artifact ref; DreamerRunner context has non-empty refs/hash.
- How is it disabled? This is a correctness fix to lineage propagation. Rollback is PR revert.

## Scope
Fix candidate -> dreamer seeding across real product paths:
- Extend `IntakeToInternalizationBridgeInput` with source lineage from candidate rows: sourceTaskId, sourceArtifactId, sourceRunId, and best-effort sourcePainId if available.
- Update call sites such as `pd candidate internalize`, pain retry, diagnosis/candidate intake path.
- `dependencyTaskIds` must include the diagnosis task id.
- `inputArtifactRefs` must reference the diagnostician artifact, not only `candidate://...`.
- Dreamer context must be able to hydrate source context from those refs.

## Non-goals
- Do not invent a new lineage table.
- Do not use `sourcePainId` as source of truth if schema does not have it; it is best-effort only.
- Do not hand-write task JSON in tests to pass the contract.

## ERR checklist
- ERR-004 / ERR-008: lineage fields must come from the same source.
- EP-02: production path wiring must use the real candidate internalize flow.
- EP-07: diagnosis task/artifact/candidate/dreamer must agree.
- EP-09: no mocked context that hides empty-context regressions.

## Acceptance criteria
- New dreamer tasks created from existing candidates have non-empty `dependencyTaskIds` and diagnostician artifact refs.
- `DreamerRunner.buildContext` for the seeded task returns `contextHash !== "empty"` and `contextRefs.length > 0` unless explicitly marked as manual empty input.
- Product-path regression covers candidate intake -> dreamer seed -> buildContext.
- Existing malformed/historical chains are not silently rewritten unless explicitly repaired by a repair command.
- `npm run verify:merge` passes.
