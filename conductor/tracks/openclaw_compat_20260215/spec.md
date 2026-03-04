# Specification: 实现对openclaw框架的原生兼容 (Native TypeScript Rewrite)

## Objective
Rewrite the core logic of the Principles Disciple framework in TypeScript to create a native, highly-optimized OpenClaw plugin. This ensures seamless integration with OpenClaw's event-driven architecture and Plugin API, avoiding the overhead and limitations of a Python-to-TypeScript bridge.

## Architecture & Integration Strategy
Based on the OpenClaw Plugin API (`src/plugins/types.ts`):
- **Prompt Injection:** Use the `before_prompt_build` hook to dynamically append `USER_CONTEXT.md` and `CURRENT_FOCUS.md` to the agent's system prompt before each run.
- **Pre-Write Gate (Sync & Async):** Use the `before_tool_call` hook. OpenClaw allows returning `{ block: true, blockReason: string }`. We will evaluate the `PLAN.md` status. If a write is risky and unplanned, we block the tool call natively. For Async HITL, we can leverage OpenClaw's `message_sending` or Gateway APIs to request owner approval.
- **Pain Signals & Reflection:** Use the `after_tool_call` hook. If a tool fails (e.g., shell command exit code != 0), we compute the pain score and append it to OpenClaw's `memory/YYYY-MM-DD.md` (Daily Logs) or a dedicated `.pain_flag` file.
- **Compaction Checkpointing:** Use the `before_compaction` hook to ensure unresolved pain flags trigger an urgent reflection warning before context is lost.
- **Commands:** Use `api.registerCommand` to register custom Slash Commands (`/init-strategy`, `/manage-okr`, `/evolve-task`).
- **Evolver Synergy:** Integrate with the `evolver` project (Genomic Evolutionary Programming) by exposing an API or command that triggers `evolver`'s `solidify` or `sessions_spawn` mechanics when deep, multi-file code repair is needed.

## Development Methodology (Strict TDD)
Every module must follow Test-Driven Development:
1. **Red Phase:** Write a failing test using `vitest` defining the expected behavior.
2. **Green Phase:** Write the minimal TypeScript code to make the test pass.
3. **Refactor:** Clean up the code while ensuring tests remain green.

## Non-Goals
- Abandoning the original Python framework. The TS rewrite will live alongside it in `packages/openclaw-plugin` to allow users on Claude Code to continue using Python.