---
phase: "10"
plan: "01"
subsystem: cli
tags: [commander, node, typescript, cli, trajectory, samples, sqlite]

# Dependency graph
requires:
  - phase: "08"
    provides: SDK primitives (atomicWriteFileSync, WorkspaceResolver, recordPainSignal pattern)
provides:
  - pd-cli: pd samples list command
  - pd-cli: pd samples review command
  - principles-core: trajectory store primitives for samples
affects: [phase-11]

# Tech tracking
tech-stack:
  added: [better-sqlite3, @principles/core trajectory primitives]
  patterns: [SDK extraction pattern from openclaw-plugin, CLI subcommand with option parsing]

key-files:
  created:
    - packages/principles-core/src/trajectory-store.ts (listCorrectionSamples, reviewCorrectionSample)
    - packages/pd-cli/src/commands/samples-list.ts
    - packages/pd-cli/src/commands/samples-review.ts
  modified:
    - packages/principles-core/src/index.ts (export trajectory primitives)
    - packages/principles-core/package.json (add trajectory-store export)
    - packages/pd-cli/src/index.ts (register samples subcommands)

key-decisions:
  - "Extract TrajectoryDatabase.sample methods to @principles/core as standalone functions"
  - "CLI uses SQLite path resolution from workspaceDir/.state/.trajectory.db"
  - "review status enum: 'pending' | 'approved' | 'rejected'"

patterns-established:
  - "SDK extraction: wrap openclaw-plugin TrajectoryDatabase methods as pure functions"
  - "CLI: Commander nested subcommand pattern (already proven in Phase 9)"

requirements-completed: [SAMPLES-01, SAMPLES-02]

# Metrics
duration: 10min
completed: 2026-04-20
---

# Phase 10: Samples CLI Research

## Domain Understanding

### What are correction samples?

Correction samples are user corrections detected during trajectory replay. When a GFI score drops below threshold, the system records a "correction sample" with:
- The assistant turn that triggered the correction
- The user correction cue that followed
- A diff excerpt showing what was wrong
- Quality score at time of detection
- Review status (pending/approved/rejected)

### Existing implementation

`TrajectoryDatabase` class in `openclaw-plugin/src/core/trajectory.ts`:
- `listCorrectionSamples(status: CorrectionSampleReviewStatus): CorrectionSampleRecord[]` — SQL query on `correction_samples` table
- `reviewCorrectionSample(sampleId: string, decision: 'approved' | 'rejected', note?: string): CorrectionSampleRecord` — UPDATE query

SQLite database path: `{workspaceDir}/.state/.trajectory.db`

### CLI command pattern (from openclaw-plugin samples.ts)

```
/openclaw samples review approve <sample-id> [note]
/openclaw samples review reject <sample-id> [note]
/openclaw samples list
```

For pd-cli, we'll use:
```
pd samples list [--status pending|approved|rejected]
pd samples review <sample-id> approve|reject [note]
```

## Technical Approach

### Option A: Extract TrajectoryStore to principles-core (RECOMMENDED)

Mirror the Phase 8 extraction pattern:
1. Create `packages/principles-core/src/trajectory-store.ts`
2. Wrap `TrajectoryDatabase.listCorrectionSamples` and `reviewCorrectionSample` as pure functions
3. Use `better-sqlite3` for SQLite access (same as openclaw-plugin)
4. Export from `@principles/core` package
5. CLI imports from `@principles/core` SDK

**Pros**: Consistent with Phase 8 pattern, testable in isolation, clean separation
**Cons**: Need to keep in sync with openclaw-plugin's schema

### Option B: Import directly from openclaw-plugin

Have pd-cli import from `openclaw-plugin`'s trajectory module.

**Cons**: Defeats the purpose of CLI extraction — CLI would still depend on plugin

### Option C: Implement new SQLite schema

Define a minimal schema just for CLI use.

**Cons**: Would diverge from openclaw-plugin's schema, potential sync issues

## Decision

**Option A** — Extract TrajectoryStore to principles-core. This follows the established Phase 8 pattern and maintains the CLI as a proper standalone tool.

## Implementation Notes

### TrajectoryStore API

```typescript
// listCorrectionSamples
export function listCorrectionSamples(
  workspaceDir: string,
  status: 'pending' | 'approved' | 'rejected' = 'pending'
): CorrectionSampleRecord[]

// reviewCorrectionSample
export function reviewCorrectionSample(
  sampleId: string,
  decision: 'approved' | 'rejected',
  note?: string,
  workspaceDir?: string
): CorrectionSampleRecord
```

### SQLite Schema (from trajectory.ts)

```sql
CREATE TABLE IF NOT EXISTS correction_samples (
  sample_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  bad_assistant_turn_id INTEGER NOT NULL,
  user_correction_turn_id INTEGER NOT NULL,
  recovery_tool_span_json TEXT,
  diff_excerpt TEXT,
  principle_ids_json TEXT,
  quality_score REAL,
  review_status TEXT DEFAULT 'pending',
  export_mode TEXT DEFAULT 'raw',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### Dependencies

- `better-sqlite3` — already used by openclaw-plugin for trajectory DB
- No new runtime dependencies beyond what's already in the stack

## Files to Create/Modify

### packages/principles-core/src/trajectory-store.ts (NEW)
- `listCorrectionSamples(workspaceDir, status)` — query correction_samples table
- `reviewCorrectionSample(sampleId, decision, note, workspaceDir)` — update review_status
- Types: `CorrectionSampleRecord`, `CorrectionSampleReviewStatus`

### packages/principles-core/src/index.ts (MODIFY)
- Add `export { listCorrectionSamples, reviewCorrectionSample } from './trajectory-store.js'`
- Add type exports for `CorrectionSampleRecord`, `CorrectionSampleReviewStatus`

### packages/principles-core/package.json (MODIFY)
- Add `"./trajectory-store"` to exports map

### packages/pd-cli/src/commands/samples-list.ts (NEW)
- `handleSamplesList(opts)` — calls `listCorrectionSamples(workspaceDir, opts.status)`
- Output format: table with sample_id, session, score, status

### packages/pd-cli/src/commands/samples-review.ts (NEW)
- `handleSamplesReview(opts)` — calls `reviewCorrectionSample(sampleId, decision, note, workspaceDir)`
- Validates decision is 'approve' or 'reject'

### packages/pd-cli/src/index.ts (MODIFY)
- Add `samples list` and `samples review` subcommands

## Verification Strategy

1. Build principles-core with new trajectory-store
2. Run `pd samples list` — should show pending samples from trajectory DB
3. Run `pd samples review <id> approve` — should update review_status
4. Re-run `pd samples list` — approved sample should no longer appear in pending list

## Open Questions

1. Should we use `better-sqlite3` or a pure JS SQLite alternative? (better-sqlite3 is already in openclaw-plugin)
2. How to handle the case where trajectory DB doesn't exist yet? (graceful empty state vs error)
3. Should we support `--all` flag to show all statuses in list command?
