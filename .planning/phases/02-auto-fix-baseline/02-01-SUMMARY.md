---
phase: 02-auto-fix-baseline
plan: '01'
subsystem: lint
tags: [eslint, typescript, lint-fix]

# Dependency graph
requires:
  - phase: 01-eslint-configuration
    provides: eslint v10 flat config with TypeScript support
provides:
  - ESLint v10 flat config with verified auto-fixable rules
  - 79 files auto-fixed with consistent-type-imports, array-type, prefer-destructuring, prefer-regexp-exec, prefer-readonly, no-inferrable-types
  - 3 eslint-disable comments with documented -- Reason: annotations
affects:
  - all TypeScript source files in packages/openclaw-plugin and packages/rules-core

# Tech tracking
tech-stack:
  added: [eslint v10 flat config]
  patterns: [type import splitting, array shorthand syntax, destructuring, readonly modifiers]

key-files:
  created: [eslint.config.js]
  modified: [package.json, 79 source files in packages/openclaw-plugin/src/]

key-decisions:
  - "Removed deprecated @typescript-eslint rules not in v10 (ban-types, no-parameter-properties, type-annotation-spacing)"
  - "Added vitest.config.ts to eslint ignores to resolve parsing error"
  - "Restored eslint-disable comments that ESLint auto-removed, with documented -- Reason: annotations per LINT-06"

patterns-established:
  - "eslint-disable comments must include -- Reason: annotation explaining necessity"
  - "auto-fix diffs must be reviewed before commit (LINT-07)"

requirements-completed: [LINT-05, LINT-06, LINT-07]

# Metrics
duration: 8min
completed: 2026-04-08
---

# Phase 02-01: Auto-fix Baseline Summary

**ESLint v10 auto-fix applied to 79 files: consistent type imports, array shorthand, destructuring, readonly modifiers, with 3 eslint-disable comments restored with documented reasons**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-08T13:02:40Z
- **Completed:** 2026-04-08T13:11:55Z
- **Tasks:** 2
- **Files modified:** 79 (+ 2 config files)

## Accomplishments
- Added `type: module` and `lint` script to package.json (Task 1)
- Ran `eslint --fix` on verified safe categories across all TypeScript source (Task 2)
- Restored 3 eslint-disable comments with documented -- Reason: annotations
- Fixed 3 deprecated ESLint rules in eslint.config.js (ban-types, no-parameter-properties, type-annotation-spacing)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add type:module and lint script to package.json** - `32cb4f1` (feat)
2. **Task 2: Run eslint --fix on auto-fixable categories** - `6d8c30a` (fix)

**Plan metadata:** `aee10ed` (docs: create auto-fix baseline plan)

## Files Created/Modified
- `package.json` - Added `"type": "module"` and `"lint": "eslint packages/**/*.ts..."` script
- `eslint.config.js` - Restored from git history, fixed deprecated rules, added vitest.config.ts ignore
- `packages/openclaw-plugin/src/core/evolution-logger.ts` - eslint-disable with documented reason restored
- `packages/openclaw-plugin/src/core/focus-history.ts` - eslint-disable with documented reason restored, array-type auto-fix
- `packages/openclaw-plugin/src/core/session-tracker.ts` - eslint-disable with documented reason restored, consistent-type-imports auto-fix
- `packages/openclaw-plugin/src/**/*.ts` - 76 additional files auto-fixed

## Decisions Made
- Removed deprecated @typescript-eslint rules (ban-types, no-parameter-properties, type-annotation-spacing) not present in ESLint v10
- Added vitest.config.ts to eslint ignores to eliminate project service parsing error
- Kept eslint-disable comments with -- Reason: even though no-console rule is not enabled in ESLint v10 (plan explicitly requires them)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed deprecated @typescript-eslint rules**
- **Found during:** Task 2 (eslint --fix execution)
- **Issue:** ESLint v10 flat config failed with "Could not find ban-types/no-parameter-properties/type-annotation-spacing" - rules removed in @typescript-eslint v8
- **Fix:** Removed the 3 deprecated rules from eslint.config.js
- **Files modified:** eslint.config.js
- **Verification:** `npx eslint --version` runs successfully after fix
- **Committed in:** 6d8c30a (part of Task 2 commit)

**2. [Rule 3 - Blocking] Added vitest.config.ts to eslint ignores**
- **Found during:** Task 2 (eslint --fix execution)
- **Issue:** vitest.config.ts caused "File not found by project service" error
- **Fix:** Added `**/vitest.config.ts` and `**/vitest.config.mts` to ignores array
- **Files modified:** eslint.config.js
- **Verification:** ESLint runs without parsing errors
- **Committed in:** 6d8c30a (part of Task 2 commit)

**3. [Rule 2 - Missing Critical] Restored eslint-disable comments**
- **Found during:** Task 2 (eslint --fix execution)
- **Issue:** ESLint auto-removed the eslint-disable comments from 3 files (evolution-logger.ts, focus-history.ts, session-tracker.ts) because no-console is not enabled in ESLint v10 flat config
- **Fix:** Restored all 3 eslint-disable comments with documented -- Reason: annotations per LINT-06 requirement
- **Files modified:** evolution-logger.ts, focus-history.ts, session-tracker.ts
- **Verification:** `grep -n "eslint-disable-next-line no-console -- Reason:"` shows all 3
- **Committed in:** 6d8c30a (part of Task 2 commit)

---

**Total deviations:** 3 auto-fixed (all blocking - necessary for ESLint to run at all)
**Impact on plan:** All deviations essential for plan completion. No scope creep.

## Issues Encountered
- ESLint v10 flat config had deprecated rules from original plan (cfb455e) - removed 3
- eslint --fix auto-removed eslint-disable comments - restored with reasons
- `no-console` is not enforced in ESLint v10 recommended config, making eslint-disable comments technically unnecessary but still required by plan

## Next Phase Readiness
- ESLint v10 flat config fully functional
- `npm run lint` script available for CI/CD integration
- All 3 eslint-disable comments documented per LINT-06
- Diffs reviewed before commit per LINT-07

## Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| `npm run lint -- --version` executes without error | PASS |
| `grep '"type": "module"' package.json` returns exactly one match | PASS |
| `grep '"lint":' package.json` returns lint script | PASS |
| `eslint --fix` applied to all auto-fixable categories | PASS |
| All diffs reviewed (git diff) | PASS |
| All 3 eslint-disable comments have inline -- Reason: explanations | PASS |

---
*Phase: 02-auto-fix-baseline*
*Completed: 2026-04-08*
