# Implementation Plan: WorkspaceContext Refactor (Governance Skeleton)

## Phase 1: Core Context Infrastructure
- [ ] Task: Create `src/core/workspace-context.ts` with basic metadata extraction and cached singleton management.
- [ ] Task: Implement `resolve(key)` in `WorkspaceContext` using `PD_FILES` mappings.
- [ ] Task: Write unit tests for `WorkspaceContext` factory and path resolution logic.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Core Context Infrastructure' (Protocol in workflow.md)

## Phase 2: Service Integration & Lazy Loading
- [ ] Task: Integrate `ConfigService` and `EventLogService` as lazy getters in `WorkspaceContext`.
- [ ] Task: Integrate `TrustEngine` and `DictionaryService` as lazy getters in `WorkspaceContext`.
- [ ] Task: Refactor `src/core/trust-engine.ts` and `src/core/dictionary.ts` to be more context-aware (optional internal cleanup).
- [ ] Task: Write unit tests to verify service encapsulation and lazy loading behavior.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Service Integration & Loading' (Protocol in workflow.md)

## Phase 3: Hook & Command Migration
- [ ] Task: Refactor `src/hooks/gate.ts` to use `WorkspaceContext`.
- [ ] Task: Refactor `src/hooks/pain.ts` and `src/hooks/llm.ts` to use `WorkspaceContext`.
- [ ] Task: Refactor `src/hooks/prompt.ts` and `src/hooks/subagent.ts` to use `WorkspaceContext`.
- [ ] Task: Refactor slash commands (`src/commands/*`) to use `WorkspaceContext`.
- [ ] Task: Write failing tests for each hook to ensure they correctly consume the context.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Hook & Command Migration' (Protocol in workflow.md)

## Phase 4: Final Cleanup & Regression Testing
- [ ] Task: Remove all legacy `workspaceDir` and `stateDir` manual calculations from business logic.
- [ ] Task: Run full test suite regression and perform a manual "Stress Test" of the progressive gatekeeper.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Final Cleanup & Regression Testing' (Protocol in workflow.md)
