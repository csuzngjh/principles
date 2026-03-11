# Implementation Plan: WorkspaceContext Refactor (Governance Skeleton)

## Phase 1: Core Context Infrastructure
- [x] Task: Create `src/core/workspace-context.ts` with basic metadata extraction, `WeakMap` based cached singleton management, and `invalidate()` logic. [85635b8]
- [x] Task: Implement `resolve(key)` in `WorkspaceContext` using `PD_FILES` mappings. [e8ea878]
- [ ] Task: Implement `createTestContext()` factory in `tests/test-utils.ts` for consistent testing.
- [ ] Task: Write unit tests for `WorkspaceContext` factory, path resolution, and cache eviction.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Core Context Infrastructure' (Protocol in workflow.md)

## Phase 2: Service Integration & Compatibility Layer
- [ ] Task: Integrate `ConfigService` and `EventLogService` as lazy getters in `WorkspaceContext`.
- [ ] Task: Integrate `TrustEngine` and `DictionaryService` as lazy getters in `WorkspaceContext`.
- [ ] Task: Refactor `src/core/trust-engine.ts` and `src/core/dictionary.ts` to expose methods compatible with the context while maintaining legacy function exports as wrappers.
- [ ] Task: Write unit tests to verify service encapsulation, lazy loading, and backward compatibility of functional APIs.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Service Integration & Compatibility' (Protocol in workflow.md)

## Phase 3: Incremental Hook & Command Migration (Strangler Fig)
- [ ] Task: Phase 3.1: Refactor `src/hooks/pain.ts` and `src/hooks/llm.ts` (High frequency, simple state dependency).
- [ ] Task: Phase 3.2: Refactor `src/hooks/gate.ts` (Complexity high, critical for security).
- [ ] Task: Phase 3.3: Refactor `src/hooks/prompt.ts`, `src/hooks/subagent.ts`, and `src/hooks/lifecycle.ts`.
- [ ] Task: Phase 3.4: Refactor all slash commands in `src/commands/*.ts`.
- [ ] Task: Write failing tests for each sub-phase to ensure they correctly consume the context and meet performance targets.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Incremental Migration' (Protocol in workflow.md)

## Phase 4: Final Cleanup & Performance Validation
- [ ] Task: Remove all legacy `workspaceDir` and `stateDir` manual calculations from business logic.
- [ ] Task: Perform a "Path Vacuum Audit" to ensure zero hardcoded strings remain.
- [ ] Task: Run benchmark tests to verify < 0.01ms cache hit latency.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Final Cleanup & Validation' (Protocol in workflow.md)
