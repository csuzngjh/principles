# Implementation Plan: Directory Architecture Refactor (Phase 4)

## Phase 1: Foundation & Template Update [checkpoint: ceffdd2]
- [x] Task: Reorganize `packages/openclaw-plugin/templates/workspace` to follow the new hierarchy: `.principles/`, `.state/`, and root `PLAN.md`. [bd2ef73]
- [x] Task: Update `install-openclaw.sh` to correctly copy files from the new template structure. [1269a0d]
- [x] Task: Write failing tests to verify that the installer handles the new paths correctly. [0e66a59]
- [x] Task: Conductor - User Manual Verification 'Phase 1: Foundation & Template Update' (Protocol in workflow.md) [ceffdd2]

## Phase 2: Core Logic Refactor (Path Anchoring) [checkpoint: ff45960]
- [x] Task: Update `src/utils/io.ts` and `src/core/config.ts` to reflect the new directory constants. [b9a608c]
- [x] Task: Update `src/hooks/gate.ts` to point to `.principles/PROFILE.json` and root `PLAN.md`. [ccc5d94]
- [x] Task: Update `src/hooks/prompt.ts` to point to `.principles/THINKING_OS.md`. [2b0e087]
- [x] Task: Update `src/service/evolution-worker.ts` to point to `.state/evolution_queue.json`. [bf82896]
- [x] Task: Write failing tests for each component to verify they now expect files in the new locations. [2449737]
- [x] Task: Conductor - User Manual Verification 'Phase 2: Core Logic Refactor' (Protocol in workflow.md) [ff45960]

## Phase 3: Auto-Migration & Loop Closure [checkpoint: dc70664]
- [x] Task: Implement `src/core/migration.ts` with logic to detect and move files from `docs/` to `.principles/` and `.state/`. [d211e4a]
- [x] Task: Integrate the migration trigger into `src/index.ts` during the plugin `register` or first `boot` hook. [5ce0ef4]
- [x] Task: Update `src/hooks/subagent.ts` to clean up the queue in `.state/`. [c733e6a]
- [x] Task: Write failing tests for the migration logic (simulating old workspace state). [fde8055]
- [x] Task: Conductor - User Manual Verification 'Phase 3: Auto-Migration & Loop Closure' (Protocol in workflow.md) [dc70664]

## Phase 4: Integration Testing & Purification [checkpoint: 53574b8]
- [x] Task: Perform a full build and run integration tests to ensure no regressions in the evolution loop. [56fb5dd]
- [x] Task: Update documentation (`README.md`, `README_ZH.md`) to explain the new directory structure. [562ba4b]
- [x] Task: Conductor - User Manual Verification 'Phase 4: Integration Testing & Purification' (Protocol in workflow.md) [53574b8]

## Phase: Review Fixes
- [x] Task: Apply review suggestions 189010c
