# Implementation Plan: Semantic Pain Detection (v1.3.0)

## Phase 1: Semantic Infrastructure
- [x] Task: Set up `pain_memory` directory and seed files
    - [x] **Write Tests**: Verify directory initialization and seed file presence.
    - [x] **Implement**: Update `src/core/init.ts` to create `workspaceDir/memory/pain/00_seed_samples.md`.
- [x] Task: Implement L1-L2-L3 Detection Funnel
    - [x] **Write Tests**: Verify LRU cache logic and async queue enqueuing.
    - [x] **Implement**: Add `LRUCache` utility and `AsyncDetectionQueue` manager.
    - [x] **Implement**: Integrate `createMemorySearchTool` into the queue worker.
- [x] Task: Conductor - User Manual Verification 'Phase 1: Semantic Infrastructure' (Protocol in workflow.md)

## Phase 2: Promotion Pipeline
- [x] Task: Implement Candidate Pool Tracking
    - [x] **Write Tests**: Verify hits are recorded in `pain_candidates.json` and similarity threshold logic.
    - [x] **Implement**: Create `src/core/candidates.ts` to manage the pool.
- [x] Task: Implement Automated Rule Promotion
    - [x] **Write Tests**: Verify N-gram extraction and rule generation.
    - [x] **Implement**: Update `EvolutionWorkerService` to evaluate candidates and promote `exact_match` rules to `pain_dictionary.json`.
- [x] Task: Conductor - User Manual Verification 'Phase 2: Promotion Pipeline' (Protocol in workflow.md)

## Phase 3: Compaction & Pre-emptive Hooks
- [x] Task: Implement `before_compaction` Hook
    - [x] **Write Tests**: Verify error extraction from discarded messages.
    - [x] **Implement**: Add `src/hooks/compaction.ts` to extract and write to `pain_memory/`.
- [x] Task: Implement `before_prompt_build` Warning Injection
    - [x] **Write Tests**: Verify warning injection based on memory search hits.
    - [x] **Implement**: Update `src/hooks/prompt.ts` to perform a quick semantic search on intent and inject warnings.
- [x] Task: Conductor - User Manual Verification 'Phase 3: Compaction & Pre-emptive Hooks' (Protocol in workflow.md)