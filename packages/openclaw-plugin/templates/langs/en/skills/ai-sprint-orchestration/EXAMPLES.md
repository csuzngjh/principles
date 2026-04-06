# AI Sprint Orchestration Examples

## Example 1: baseline + validation

```powershell
node scripts/run.mjs --self-check
node scripts/run.mjs --help
node scripts/run.mjs --task workflow-validation-minimal
node scripts/run.mjs --task workflow-validation-minimal-verify
```

## Example 2: custom runtime root

```powershell
node scripts/run.mjs --task workflow-validation-minimal --runtime-root D:/Temp/ai-sprint-runtime
```

## Example 3: classify a failure

- `workflow bug`: package-local script still writes to repo-root `ops/ai-sprints`
- `agent behavior issue`: reviewer omits `VERDICT` or malformed `DIMENSIONS`
- `environment issue`: `acpx` missing or workspace not writable
- `sample-spec issue`: validation spec asks for a field that the current product sample does not implement

## Example 4: when to stop

Stop the iteration after classification if:

- the issue belongs to `packages/openclaw-plugin`
- the issue depends on `D:/Code/openclaw`
- the fix would require dashboard/stageGraph/self-optimization sprint expansion
- the problem is a sample-side or product-side gap rather than workflow plumbing

## Example 5: start from a complex bugfix template

1. Copy `references/specs/bugfix-complex-template.json`
2. Replace every placeholder in `taskContract`
3. Narrow `executionScope` to the smallest useful round
4. Run the packaged entrypoint with the edited spec:

```powershell
node scripts/run.mjs --task custom-bugfix --task-spec D:/path/to/your-bugfix-spec.json
```

## Example 6: start from a complex feature template

1. Copy `references/specs/feature-complex-template.json`
2. Fill `Goal`, `In scope`, `Out of scope`, `Validation commands`, and `Expected artifacts`
3. Confirm the spec does not require product-side closure outside this milestone
4. Run:

```powershell
node scripts/run.mjs --task custom-feature --task-spec D:/path/to/your-feature-spec.json
```

## Example 7: inspect checkpoint summary before continuation

When a round ends in `revise`, inspect:

- `stages/<stage>/checkpoint-summary.md`
- `stages/<stage>/handoff.json`

The next round should use the checkpoint summary as the primary carry-forward context and only fall back to full prior decision text when needed.
