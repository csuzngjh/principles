# @principles/pd-cli

PD CLI — Pain recording, sample management, and evolution tasks for the Principles system.

## Installation

```bash
npm install -g @principles/pd-cli
```

## Commands

### `pd pain record`

Record a pain signal to the workspace's `.pain_flag` file.

```bash
pd pain record --reason "edited file without reading first" --score 75
```

Options:
- `--reason, -r` — Pain reason (required)
- `--score, -s` — Pain score 0-100 (default: 80)
- `--session-id` — Session ID (default: auto-generated)

## Production Canary Validation

Operator-facing runbook for validating PD runtime health in production. All commands below are read-only and safe to run against a live workspace.

### Validation Sequence

Run these three commands in order to assess runtime health:

```bash
# 1. Full canary — runs 7 health checks across schema, candidates, GFI, queue, and runtime
node packages/pd-cli/dist/index.js runtime canary --workspace "D:\.openclaw\workspace" --json

# 2. Internalization queue snapshot — inspect PI task pipeline state
node packages/pd-cli/dist/index.js runtime internalization queue --workspace "D:\.openclaw\workspace" --json

# 3. Internalization chain integrity — verify candidate→dreamer→philosopher→artifact links
node packages/pd-cli/dist/index.js runtime internalization integrity --workspace "D:\.openclaw\workspace" --json
```

Omit `--json` for human-readable text output.

### Interpreting Canary Status

The canary runs 7 checks and reports an `overallStatus`:

| Status | Meaning |
|--------|---------|
| `healthy` | All checks pass. No action needed. |
| `degraded` | Non-critical issues found (orphan candidates, queue blockers, stale GFI sessions). Review `checks` for details. |
| `error` | Schema conformance failure or check threw an exception. Investigate before proceeding. |

Each check in the `checks` array has its own `status` field. The `recommendedNextActions` array provides targeted remediation suggestions.

### Identifying the Next Internalization Blocker

After a healthy canary, check the queue and integrity for the next PI task to resolve:

**Queue** — look at the `readyTasks` array. If empty, check `noReadyTasks.reason`:
- `all_tasks_blocked` — examine `blockedSummary.samples` for dependency chains
- `all_tasks_dependency_failed` — examine `dependencyFailedSummary.samples` for failed dependencies
- `all_tasks_retry_wait` — tasks are in backoff; check `retryWaitPendingSummary.samples` for retry timers

**Integrity** — look at `brokenLinks`:
- `severity: "error"` — a broken link in the chain (e.g., missing artifact). This blocks internalization for that candidate.
- `severity: "warning"` — a data quality issue that may need attention but doesn't block immediately.

Each broken link includes a `recommendedAction` field. The `chainsWithBrokenLinks` count tells you how many candidate chains are affected.

### Remediation

Remediation commands (e.g., `pd candidate audit --repair`, `pd runtime pruning orphans`) should **always** be run with `--dry-run` first:

```bash
node packages/pd-cli/dist/index.js runtime pruning orphans --workspace "D:\.openclaw\workspace" --dry-run
```

Only add `--confirm` after reviewing the dry-run output. Never run remediation without understanding what it will change.

## Migration from openclaw tools

The `pd pain record` CLI and the existing `write_pain_flag` tool write to the same pain flag file (`.state/.pain_flag`). They can coexist safely:

- **Concurrency**: `recordPainSignal` in the SDK uses an in-process async queue lock to serialize writes within a single process. For cross-process safety (e.g., simultaneous tool + CLI calls), both paths rely on atomic file rename via `atomicWriteFileSync`.
- **Progressive migration**: Agents using openclaw tools can migrate to `pd pain record` incrementally — both paths write the same format and are processed identically by the evolution system.
- **No dual-write data loss**: The pain flag is a point-in-time snapshot; each write is atomic. Conflicting concurrent writes result in last-write-wins on the flag content, which is acceptable for pain signals.
