# Implementation Plan: 实现对openclaw框架的兼容 (TypeScript Rewrite)

## Phase 0: Deep Technical Research & Architecture Design
- [x] Task: Analyze OpenClaw Plugin API (`src/plugins/types.ts`) to map Claude hooks to OpenClaw native hooks (`before_prompt_build`, `before_tool_call`, `after_tool_call`).
- [x] Task: Analyze Evolver architecture (`src/gep/solidify.js`, `bridge.js`) to design the handoff mechanism for deep code repair.
- [ ] Task: Conductor - User Manual Verification 'Phase 0: Deep Technical Research & Architecture Design' (Protocol in workflow.md)

## Phase 1: Native Plugin Scaffolding
- [x] Task: Scaffold OpenClaw plugin directory structure and TS configuration (`packages/openclaw-plugin`) [c44b9f0]
    - [ ] Write Tests (Red Phase): Test that the build process and `vitest` are configured correctly.
    - [ ] Implement (Green Phase): Initialize `package.json`, `tsconfig.json`, `vitest.config.ts`, and core plugin file `src/index.ts`.
- [~] Task: Conductor - User Manual Verification 'Phase 1: Native Plugin Scaffolding' (Protocol in workflow.md)

## Phase 2: Core Logic Porting (TDD)
- [ ] Task: Port I/O, Path, and Parsing Utilities to TS
    - [ ] Write Tests (Red Phase): Write `vitest` suites for path normalization and JSON/KV parsing.
    - [ ] Implement (Green Phase): Implement `src/utils/io.ts`.
- [ ] Task: Port Profile and Pain Signal Logic
    - [ ] Write Tests (Red Phase): Write tests for risk path matching and pain score calculation.
    - [ ] Implement (Green Phase): Implement `src/core/profile.ts` and `src/core/pain.ts`.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Core Logic Porting (TDD)' (Protocol in workflow.md)

## Phase 3: OpenClaw Hook Integration (TDD)
- [ ] Task: Implement Prompt Context Injection (`before_prompt_build`)
    - [ ] Write Tests (Red Phase): Test that the hook appends `USER_CONTEXT` to the prompt.
    - [ ] Implement (Green Phase): Register the hook in `src/index.ts`.
- [ ] Task: Implement Pre-Write Gate (`before_tool_call`)
    - [ ] Write Tests (Red Phase): Test that risky un-planned tool calls return `{ block: true }`.
    - [ ] Implement (Green Phase): Implement the gating logic mapping to OpenClaw's tool context.
- [ ] Task: Implement Post-Write Checks & Pain (`after_tool_call`)
    - [ ] Write Tests (Red Phase): Test that tool failures trigger pain records.
    - [ ] Implement (Green Phase): Implement tests-on-change and daily log integration.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: OpenClaw Hook Integration (TDD)' (Protocol in workflow.md)

## Phase 4: Commands & Evolver Synergy (TDD)
- [ ] Task: Register Native Slash Commands
    - [ ] Write Tests (Red Phase): Test command dispatch logic.
    - [ ] Implement (Green Phase): Register `/init-strategy`, `/manage-okr` via `api.registerCommand`.
- [ ] Task: Implement Evolver Handoff interface
    - [ ] Write Tests (Red Phase): Test payload generation for `sessions_spawn` or `solidify.js` invocation.
    - [ ] Implement (Green Phase): Create the TS bridge to `evolver` for deep repairs.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Commands & Evolver Synergy (TDD)' (Protocol in workflow.md)