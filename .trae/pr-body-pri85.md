## PRI-85: DreamerRunner Vertical Slice

### Changes
- **DreamerRunnerDeps** gains `artifactStore: PIArtifactStore` dependency
- **succeedTask()** writes PIArtifact via `upsertArtifact` (idempotent) after `updateRunOutput`
- **resolveLineageArtifactIds()** resolves predecessor artifacts from dependency tasks
- Artifact ID format: `pi-art-{taskId}-{runId}`, kind: `principle`, status: `pending`
- Existing `dreamer-runner.test.ts` updated with `MemoryPIArtifactStore` in deps

### Vertical Slice Tests (5 new)
1. Success path: creates PIArtifact + marks task succeeded with dreamer:// resultRef
2. Adapter failure: task retried, no artifact created
3. Validation failure: task retried, no artifact created
4. Idempotent execution: calling run() twice for same task does not create duplicate artifacts
5. Artifact lineage: artifact has lineageArtifactIds from predecessor context

### Verification
```bash
npx tsc --noEmit --project packages/principles-core/tsconfig.json  # pass
npx eslint packages/principles-core/src/runtime-v2/__tests__/dreamer-runner-vslice.test.ts packages/principles-core/src/runtime-v2/__tests__/dreamer-runner.test.ts packages/principles-core/src/runtime-v2/internalization/dreamer-runner.ts  # pass
cd packages/principles-core && npx vitest run src/runtime-v2/__tests__/dreamer-runner-vslice.test.ts src/runtime-v2/__tests__/dreamer-runner.test.ts --reporter=verbose  # 17/17 pass
```

### Dependencies
- Requires PRI-84 (PIArtifact durable store contract) to be merged first
