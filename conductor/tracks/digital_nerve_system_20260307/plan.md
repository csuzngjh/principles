# Implementation Plan: Digital Nerve System (v1.2.0)

## Phase 1: Foundation & Dictionary Migration
- [x] Task: Externalize pain signals to `pain_dictionary.json`
    - [x] **Write Tests**: Verify dictionary loading, schema validation, and memory-safe matching.
    - [x] **Implement**: Create `src/core/dictionary.ts` to manage the in-memory cache and hit tracking.
    - [x] **Implement**: Add `pain_dictionary.json` template to `templates/workspace/docs/`.
- [x] Task: Externalize Hyperparameters
    - [x] **Write Tests**: Verify that thresholds and scores are loaded from config.
    - [x] **Implement**: Create `src/core/config.ts` to manage global PD settings.
    - [x] **Implement**: Add `pain_settings.json` template.
- [x] Task: Refactor `llm.ts` for Track B
    - [x] **Write Tests**: Ensure `handleLlmOutput` correctly triggers hits without hardcoded regex.
    - [x] **Implement**: Replace hardcoded logic in `llm.ts` with calls to the new `Dictionary` core.
- [x] Task: Implement Async Persistence
    - [x] **Write Tests**: Verify that hit counters are flushed to disk without blocking.
    - [x] **Implement**: Update `EvolutionWorkerService` to call `Dictionary.flush()` on its interval.
- [x] Task: Conductor - User Manual Verification 'Phase 1: Foundation & Dictionary Migration' (Protocol in workflow.md)

## Phase 2: Generalized Friction Index (GFI)
- [x] Task: Implement Session GFI Tracking
    - [x] **Write Tests**: Verify GFI accumulation, identical error detection, and success-based reset.
    - [x] **Implement**: Update `src/core/session-tracker.ts` to store `frictionState`.
- [x] Task: Implement Denoised Hashing & Sensor
    - [x] **Write Tests**: Verify that errors with different timestamps produce the same hash.
    - [x] **Implement**: Add `denoiseError` utility and hook into `after_tool_call` in `pain.ts`.
- [x] Task: Implement GFI-based System Override
    - [x] **Write Tests**: Verify that when GFI exceeds 100, the next prompt contains the override message.
    - [x] **Implement**: Update `src/hooks/prompt.ts` to check GFI and inject the `<reflection>` mandate.
- [x] Task: Conductor - User Manual Verification 'Phase 2: Generalized Friction Index (GFI)' (Protocol in workflow.md)

## Phase 3: Lifecycle & Audit
- [x] Task: Implement /pain status command
    - [x] **Write Tests**: Verify formatting of the pain report.
    - [x] **Implement**: Add subcommand to `/thinking-os` or a new command to view dictionary stats and current GFI.
- [x] Task: Conductor - User Manual Verification 'Phase 3: Lifecycle & Audit' (Protocol in workflow.md)

## Phase: Review Fixes
- [x] Task: Apply review suggestions 08511c9
