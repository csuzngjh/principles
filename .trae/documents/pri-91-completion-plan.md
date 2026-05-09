# PRI-91: run-once Dispatcher for Successor Chain — Completion Plan

## Summary

Complete PRI-91 by adding missing test cases and fixing a broken existing test, then build, verify, and commit.

## Current State Analysis

**Branch**: `codex/pri-91-run-once-dispatcher` (on top of main with PRI-87/88/89/90 merged)

**Code changes already done (uncommitted)**:
- `runtime-internalization-run-once.ts`: PhilosopherRunner dispatch, `--enqueue-next`, `SUPPORTED_RUNNERS` set, `CommitNextTaskResult` import, successor fields in output
- `index.ts`: `--enqueue-next` option registration
- `runtime-internalization-run-once.test.ts`: Mock updates (PhilosopherRunner, DefaultPhilosopherValidator, commitNextTaskProposal)
- Infrastructure: `diagnosticJson` moved into `TaskRecord` proper (from PRI-88), SqliteConnection readonly mode

**What's missing**: New PRI-91 test cases + fixing one broken existing test

### Broken Test

Line 174 of `runtime-internalization-run-once.test.ts`:
```ts
it('unsupported runner kind: exits 1 with error', async () => {
    await handleRuntimeInternalizationRunOnce({ workspace: WS, runner: 'philosopher', runtime: 'test-double', allowTestDouble: true });
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy.mock.calls.some((c: string[]) => c[0].includes('unsupported runner kind'))).toBe(true);
});
```
This test passes `runner: 'philosopher'` expecting it to be unsupported. But with PRI-91, `'philosopher'` IS now supported. **Must change to a truly unsupported runner like `'scribe'`.**

## Proposed Changes

### 1. Fix broken test (line 174)

Change `runner: 'philosopher'` → `runner: 'scribe'` in the "unsupported runner kind" test. This ensures the test validates that truly unsupported runners fail closed.

### 2. Add new PRI-91 test cases

Add the following tests after the existing test cases in the describe block:

#### Test: `--runner philosopher dispatches PhilosopherRunner`
- Mock wakeOnce to return `{ decision: 'would_lease', taskId: 'task-phil-001', taskKind: 'philosopher' }`
- Mock run to return a succeeded PhilosopherRunnerResult
- Call with `{ workspace: WS, runner: 'philosopher', runtime: 'test-double', allowTestDouble: true, json: true }`
- Assert: PhilosopherRunner constructor was called, run was called with 'task-phil-001', output contains philosopher result

#### Test: `--runner philosopher with text output includes key IDs`
- Same setup as above but `json: false`
- Assert: text output contains taskId, status, runId, artifactId, resultRef

#### Test: `successful dreamer + --enqueue-next returns successorTaskId`
- Mock wakeOnce to return dreamer task
- Mock run to return succeeded
- Mock commitNextTaskProposal to return `{ decision: 'successor_created', sourceTaskId: 'task-dreamer-001', successorTaskId: 'task-phil-001', successorKind: 'philosopher' }`
- Call with `{ workspace: WS, runner: 'dreamer', runtime: 'test-double', allowTestDouble: true, enqueueNext: true, json: true }`
- Assert: output.enqueueDecision === 'successor_created', output.successorTaskId === 'task-phil-001', output.successorKind === 'philosopher'

#### Test: `repeated --enqueue-next returns existing successorTaskId`
- Same setup but commitNextTaskProposal returns `{ decision: 'successor_exists', sourceTaskId: 'task-dreamer-001', successorTaskId: 'task-phil-001', successorKind: 'philosopher' }`
- Assert: output.enqueueDecision === 'successor_exists', output.successorTaskId === 'task-phil-001'

#### Test: `--enqueue-next with no_successor does not set successorTaskId`
- commitNextTaskProposal returns `{ decision: 'no_successor', sourceTaskId: 'task-dreamer-001', reason: 'terminal runner' }`
- Assert: output.enqueueDecision === 'no_successor', output.successorTaskId is undefined

#### Test: `--enqueue-next with failed run does not call commitNextTaskProposal`
- Mock run to return failed result
- Call with enqueueNext: true
- Assert: commitNextTaskProposal was NOT called

#### Test: `--enqueue-next without --allow-test-double still blocked`
- Call with `{ runner: 'dreamer', runtime: 'test-double', enqueueNext: true }` (no allowTestDouble)
- Assert: exits 1, wakeOnce not called

#### Test: `test-double with --runner philosopher requires --allow-test-double`
- Call with `{ runner: 'philosopher', runtime: 'test-double' }` (no allowTestDouble)
- Assert: exits 1, error about test-double

#### Test: `JSON output includes runnerKind field`
- Actually, looking at the current code, `runnerKind` is not in the RunOnceOutput. The task has `taskKind` from wakeResult. Let me check the spec...
- The spec says: "JSON 输出包含 runnerKind、decision、taskId、runId、artifactId、resultRef、successorTaskId"
- Current RunOnceOutput has `taskKind` but not `runnerKind`. We should add `runnerKind` to the output.

Wait - let me re-read the code. The `taskKind` comes from `wakeResult.taskKind`, which should match `runnerKind` when the runner actually runs. But the spec explicitly says `runnerKind`. Let me add it.

### 3. Add `runnerKind` to RunOnceOutput

Add `runnerKind?: string` to `RunOnceOutput` interface and set it from `opts.runner ?? 'dreamer'` in the output building.

### 4. Verify

```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npx vitest run packages/pd-cli/tests/commands/runtime-internalization-run-once.test.ts
npx vitest run packages/pd-cli/tests/commands/runtime-internalization.test.ts
npx vitest run packages/principles-core/src/runtime-v2/__tests__/internalization-orchestrator.test.ts
npm run typecheck:openclaw-plugin
```

### 5. Commit

Only stage PRI-91 related files. The infrastructure changes (diagnosticJson in TaskRecord, SqliteConnection readonly) should also be included since they're needed for PRI-88/90 to work properly.

```bash
git add <specific files>
git commit -m "feat(cli): dispatch internalization run-once successor chain (PRI-91)"
```

## Assumptions & Decisions

1. **`runnerKind` in output**: Added to satisfy spec requirement. Set from the CLI `--runner` option.
2. **Existing "unsupported runner" test**: Changed from `'philosopher'` to `'scribe'` since philosopher is now supported.
3. **Infrastructure changes included**: The `diagnosticJson` in TaskRecord and SqliteConnection readonly changes are committed together since they're prerequisites for PRI-88/90 that were developed in the same session.
4. **No `--runner auto`**: Per spec, only implement if deterministic/testable/fail-closed. Not implementing for now.
