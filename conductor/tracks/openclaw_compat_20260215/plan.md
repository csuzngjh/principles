# Implementation Plan: 实现对openclaw框架的兼容

## Phase 1: Infrastructure and Bridge Setup
- [ ] Task: Scaffold OpenClaw plugin directory structure
    - [ ] Write Tests (Red Phase): Test that the plugin structure and entry points exist.
    - [ ] Implement (Green Phase): Create `handler.ts` and `HOOK.md`.
- [ ] Task: Implement Python/TypeScript bridge
    - [ ] Write Tests (Red Phase): Test that TS can successfully spawn `hook_runner.py` with mock payload.
    - [ ] Implement (Green Phase): Use `child_process.spawnSync` to call Python and return results.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Infrastructure and Bridge Setup' (Protocol in workflow.md)

## Phase 2: Event Mapping and Gates
- [ ] Task: Map OpenClaw events to Claude Code hooks
    - [ ] Write Tests (Red Phase): Unit test the event mapping configuration.
    - [ ] Implement (Green Phase): Map `agent:run:start` to `user_prompt_context` and `tool_result_persist` to `pre_write_gate`/`post_write_checks`.
- [ ] Task: Implement Async HITL Gatekeeper
    - [ ] Write Tests (Red Phase): Test the async message notification logic.
    - [ ] Implement (Green Phase): Implement WhatsApp/Telegram approval flow for `pre_write_gate` blockages.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Event Mapping and Gates' (Protocol in workflow.md)

## Phase 3: Memory Integration and Deployment
- [ ] Task: Integrate with OpenClaw Daily Logs
    - [ ] Write Tests (Red Phase): Test that pain signals are written to the daily log format.
    - [ ] Implement (Green Phase): Adapt `precompact_checkpoint` to trigger on `onCompaction`.
- [ ] Task: Create OpenClaw Installer
    - [ ] Write Tests (Red Phase): Test `install_openclaw.sh` file creation and copy logic.
    - [ ] Implement (Green Phase): Write the shell script to deploy the plugin to `~/.openclaw/hooks/`.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Memory Integration and Deployment' (Protocol in workflow.md)