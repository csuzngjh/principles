# Implementation Plan: Directory Architecture Refactor (Phase 4)

## Phase 1: Foundation & Template Update
- [x] Task: Reorganize `packages/openclaw-plugin/templates/workspace` to follow the new hierarchy: `.principles/`, `.state/`, and root `PLAN.md`. [bd2ef73]
- [x] Task: Update `install-openclaw.sh` to correctly copy files from the new template structure. [1269a0d]
- [ ] Task: Write failing tests to verify that the installer handles the new paths correctly.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Foundation & Template Update' (Protocol in workflow.md)

## Phase 2: Core Logic Refactor (Path Anchoring)
- [ ] Task: Update `src/utils/io.ts` and `src/core/config.ts` to reflect the new directory constants.
- [ ] Task: Update `src/hooks/gate.ts` to point to `.principles/PROFILE.json` and root `PLAN.md`.
- [ ] Task: Update `src/hooks/prompt.ts` to point to `.principles/THINKING_OS.md`.
- [ ] Task: Update `src/service/evolution-worker.ts` to point to `.state/evolution_queue.json`.
- [ ] Task: Write failing tests for each component to verify they now expect files in the new locations.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Core Logic Refactor' (Protocol in workflow.md)

## Phase 3: Auto-Migration & Loop Closure
- [ ] Task: Implement `src/core/migration.ts` with logic to detect and move files from `docs/` to `.principles/` and `.state/`.
- [ ] Task: Integrate the migration trigger into `src/index.ts` during the plugin `register` or first `boot` hook.
- [ ] Task: Update `src/hooks/subagent.ts` to clean up the queue in `.state/`.
- [ ] Task: Write failing tests for the migration logic (simulating old workspace state).
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Auto-Migration & Loop Closure' (Protocol in workflow.md)

## Phase 4: Integration Testing & Purification
- [ ] Task: Perform a full build and run integration tests to ensure no regressions in the evolution loop.
- [ ] Task: Update documentation (`README.md`, `README_ZH.md`) to explain the new directory structure.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Integration Testing & Purification' (Protocol in workflow.md)
