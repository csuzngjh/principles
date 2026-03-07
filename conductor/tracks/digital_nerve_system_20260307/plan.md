# Implementation Plan: Digital Nerve System (v1.2.0)

## Phase 1: Foundation & Dictionary Migration
- [ ] Task: Migrate hardcoded regex to `pain_dictionary.json`
    - [ ] Write tests for dictionary loader and hit counter
    - [ ] Create `src/core/dictionary.ts` and `pain_dictionary.json` template
    - [ ] Refactor `llm.ts` to use the new dictionary
- [ ] Task: Implement async persistence for dictionary hits
    - [ ] Write tests for async flush logic
    - [ ] Update `EvolutionWorker` to handle dictionary syncing
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Foundation & Dictionary Migration' (Protocol in workflow.md)

## Phase 2: Generalized Friction Index (GFI)
- [ ] Task: Implement GFI tracking in session state
    - [ ] Write tests for GFI accumulation and identical error multiplier
    - [ ] Update `src/core/session-tracker.ts` with GFI fields
    - [ ] Implement `after_tool_call` sensor with denoised hashing
- [ ] Task: Implement GFI-based System Override
    - [ ] Write tests for prompt injection on GFI > 100
    - [ ] Update `src/hooks/prompt.ts` or `index.ts` to inject override message
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Generalized Friction Index (GFI)' (Protocol in workflow.md)
