## PRI-86: Internalization Engine Worker Wake-and-Run CLI

### Changes
- **New command**: `pd runtime internalization run-once --workspace <path> [--json]`
- Orchestrator wakes next leasable PI task via `wakeOnce()` (non-dry-run)
- For dreamer tasks: constructs DreamerRunner with TestDoubleRuntimeAdapter and executes
- For non-dreamer tasks: reports `unsupported_runner_kind` skip
- Reports structured JSON or human-readable text output
- Exit code 1 for no_ready_tasks and lease_conflict

### CLI Handler Tests (7 new)
1. no_ready_tasks: reports no leasable task and exits 1
2. leased dreamer task: runs DreamerRunner and reports result
3. leased dreamer task with runner failure: reports failed result
4. leased non-dreamer task: reports leased without running (unsupported_runner_kind)
5. text output for succeeded dreamer run
6. lease_conflict: reports conflict and exits 1
7. orchestrator error: exits 1 with error message

### Barrel Exports Added
- `DreamerRunner`, `DreamerRunnerResult`, `DreamerRunnerOptions`, `ResolvedDreamerRunnerOptions`
- `PassThroughDreamerValidator`, `DreamerOutput`, `DreamerCandidate`, `DreamerValidationResult`, `DreamerValidator`
- `MemoryPIArtifactStore`, `PIArtifactRecord`, `PIArtifactStore`

### Verification
```bash
npm run build --workspace=@principles/core  # pass
npm run build --workspace=@principles/pd-cli  # pass
npx eslint packages/pd-cli/src/commands/runtime-internalization-run-once.ts  # pass
cd packages/pd-cli && npx vitest run tests/commands/runtime-internalization-run-once.test.ts --reporter=verbose  # 7/7 pass
cd packages/principles-core && npx vitest run src/runtime-v2/__tests__/dreamer-runner* --reporter=verbose  # 17/17 pass
```

### Dependencies
- Requires PRI-85 (DreamerRunner vertical slice) to be merged first
