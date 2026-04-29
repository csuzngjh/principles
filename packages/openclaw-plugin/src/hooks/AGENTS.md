# src/hooks/ — OpenClaw Lifecycle Hooks

**8 TypeScript files.** Intercepts agent behavior at key moments: prompt building, tool calls, session lifecycle.

## WHERE TO LOOK

| Hook Event | File | What It Does |
|------------|------|--------------|
| `before_prompt_build` | `prompt.ts` | Multi-layer context injection: identity, trust, evolution, principles, thinking OS |
| `before_tool_call` | `gate.ts` | Security gate: trust stage checks, risk path blocking, bash security (Cyrillic de-obfuscation, command tokenization) |
| `after_tool_call` | `pain.ts` | Pain detection: failure → pain score → Runtime V2 `PainSignalBridge` |
| `before_compaction` | `lifecycle.ts` | Checkpoints state before context loss |
| `after_compaction` | `lifecycle.ts` | State recovery |
| `before_reset` / `session_*` | `lifecycle.ts` | Session lifecycle management |
| `llm_output` | `llm.ts` | Analyzes LLM responses for pain signals |
| `subagent_*` | `subagent.ts` | Ensures sub-agents inherit mental models |
| `before_message_write` | `message-sanitize.ts` | Strips sensitive data from messages |
| — | `trajectory-collector.ts` | Collects tool call trajectories for SQLite analytics |

## CONVENTIONS

- All hooks receive `HookContext` → use `WorkspaceContext.fromHookContext(ctx)` for services
- Gate hook is the most security-critical — handles trust stages 1-4, risk paths, bash security
- Pain hook feeds into EvolutionReducer event sourcing
- Prompt hook is the main injection point for agent context

## ANTI-PATTERNS

- ❌ Gate hook must fail-closed (invalid regex → block, not allow)
- ❌ Never modify hook return values after they're computed
- ❌ Pain hook must not throw — errors are logged, not propagated
