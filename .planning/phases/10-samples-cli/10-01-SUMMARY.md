---
phase: "10"
plan: "01"
subsystem: cli
tags: [commander, node, typescript, cli, trajectory, samples, sqlite]

# Dependency graph
requires:
  - phase: "08"
    provides: SDK primitives (WorkspaceResolver, atomicWriteFileSync, PainRecorder)
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
    - packages/principles-core/package.json (add trajectory-store export + better-sqlite3 dep)
    - packages/pd-cli/src/index.ts (register samples subcommands)

key-decisions:
  - "Extract TrajectoryDatabase.sample methods to @principles/core as standalone functions"
  - "CLI uses SQLite path resolution from workspaceDir/.state/.trajectory.db"
  - "review status enum: 'pending' | 'approved' | 'rejected'"
  - "decision arg uses 'approve'/'reject' (not 'approved'/'rejected') for ergonomic CLI"

patterns-established:
  - "SDK extraction: wrap openclaw-plugin TrajectoryDatabase methods as pure functions"
  - "CLI: Commander nested subcommand pattern with argument validation"

requirements-completed: [SAMPLES-01, SAMPLES-02]

# Metrics
duration: 15min
completed: 2026-04-20
---

# Phase 10: Samples CLI Summary

**`pd samples list` and `pd samples review` CLI commands — trajectory store primitives extracted into @principles/core SDK**

## Performance

- **Duration:** 15 min
- **Started:** 2026-04-20T09:30:00Z
- **Completed:** 2026-04-20T09:45:00Z
- **Tasks:** 6
- **Files modified:** 6

## Accomplishments
- Trajectory store primitives extracted from `TrajectoryDatabase` into `@principles/core/trajectory-store`
- `pd samples list [--status pending|approved|rejected]` — lists correction samples from SQLite
- `pd samples review <sample-id> approve|reject [note]` — updates review status
- Both commands work against `{workspaceDir}/.state/.trajectory.db` without openclaw-plugin dependency
- `better-sqlite3` added as dependency to `@principles/core`

## Task Commits

Each task was committed atomically:

1. **Task 1: Create trajectory-store.ts** - added better-sqlite3 dep + created trajectory-store.ts with listCorrectionSamples and reviewCorrectionSample
2. **Task 2: Export trajectory-store** - added exports to index.ts and package.json
3. **Task 3: Create samples-list command** - created samples-list.ts
4. **Task 4: Create samples-review command** - created samples-review.ts
5. **Task 5: Register samples subcommands** - wired into index.ts

**Plan metadata:** `8927c635` (docs: plan pd samples CLI)

## Files Created/Modified

- `packages/principles-core/src/trajectory-store.ts` - listCorrectionSamples and reviewCorrectionSample pure functions
- `packages/principles-core/src/index.ts` - exported trajectory-store functions and types
- `packages/principles-core/package.json` - added "./trajectory-store" export + better-sqlite3 dependency
- `packages/pd-cli/src/commands/samples-list.ts` - `handleSamplesList` implementation
- `packages/pd-cli/src/commands/samples-review.ts` - `handleSamplesReview` implementation
- `packages/pd-cli/src/index.ts` - registered `samples list` and `samples review` subcommands

## Decisions Made

- Used `approve`/`reject` as CLI decision values (normalized to `approved`/`rejected` for DB)
- Graceful fallback when DB doesn't exist yet (returns empty array, no error)
- Commander nested subcommand pattern — same as Phase 9 pain record

## Verification Results

All automated checks passed:
- `grep "export function listCorrectionSamples" packages/principles-core/src/trajectory-store.ts` ✓
- `grep "export function reviewCorrectionSample" packages/principles-core/src/trajectory-store.ts` ✓
- `grep '"./trajectory-store"' packages/principles-core/package.json` ✓
- `grep "handleSamplesList\|handleSamplesReview" packages/pd-cli/src/index.ts` ✓
- `pnpm build` principles-core ✓
- `pnpm build` pd-cli ✓
- `pd samples --help` shows list + review ✓
- `pd samples list --help` shows -s/--status option ✓
- `pd samples review --help` shows sample-id + approve|reject arguments ✓

## Next Phase Readiness

- `@principles/core/trajectory-store` is ready for Phase 11 (Evolution Tasks CLI)
- `pd samples list` and `pd samples review` work correctly
- No blockers for next phase

---
*Phase: 10-samples-cli*
*Completed: 2026-04-20*
