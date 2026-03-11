# Implementation Plan: WorkspaceContext Refactor (Governance Skeleton)

## Phase 1: Core Context Infrastructure [checkpoint: 69e51f0]
- [x] Task: Create `src/core/workspace-context.ts` with basic metadata extraction, `WeakMap` based cached singleton management, and `invalidate()` logic. [85635b8]
- [x] Task: Implement `resolve(key)` in `WorkspaceContext` using `PD_FILES` mappings. [e8ea878]
- [x] Task: Implement `createTestContext()` factory in `tests/test-utils.ts` for consistent testing. [98c7a90]
- [x] Task: Write unit tests for `WorkspaceContext` factory, path resolution, and cache eviction. [ac51d5c]
- [x] Task: Conductor - User Manual Verification 'Phase 1: Core Context Infrastructure' (Protocol in workflow.md) [69e51f0]

## Phase 2: Service Integration & Compatibility Layer [checkpoint: 8d81226]
- [x] Task: Integrate `ConfigService` and `EventLogService` as lazy getters in `WorkspaceContext`. [249b1e7]
- [x] Task: Integrate `TrustEngine` and `DictionaryService` as lazy getters in `WorkspaceContext`. [249b1e7]
- [x] Task: Refactor `src/core/trust-engine.ts` and `src/core/dictionary.ts` to expose methods compatible with the context while maintaining legacy function exports as wrappers. [ad6f240]
- [x] Task: Write unit tests to verify service encapsulation, lazy loading, and backward compatibility of functional APIs. [ad6f240]
- [x] Task: Conductor - User Manual Verification 'Phase 2: Service Integration & Compatibility' (Protocol in workflow.md) [8d81226]

## Phase 3: Incremental Hook & Command Migration (Strangler Fig)
- [x] Task: Phase 3.1: Refactor `src/hooks/pain.ts` and `src/hooks/llm.ts` (High frequency, simple state dependency). [95c7b90]
- [x] Task: Phase 3.2: Refactor `src/hooks/gate.ts` (Complexity high, critical for security). [85635b8]
- [x] Task: Phase 3.3: Refactor `src/hooks/prompt.ts`, `src/hooks/subagent.ts`, and `src/hooks/lifecycle.ts`. [ad6f240]
- [~] Task: Phase 3.4: Refactor all slash commands in `src/commands/*.ts`.
- [ ] Task: Write failing tests for each sub-phase to ensure they correctly consume the context and meet performance targets.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Incremental Migration' (Protocol in workflow.md)

## Phase 4: Final Cleanup & Performance Validation
- [ ] Task: Remove all legacy `workspaceDir` and `stateDir` manual calculations from business logic.
- [ ] Task: Perform a "Path Vacuum Audit" to ensure zero hardcoded strings remain.
- [ ] Task: Run benchmark tests to verify < 0.01ms cache hit latency.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Final Cleanup & Validation' (Protocol in workflow.md)
