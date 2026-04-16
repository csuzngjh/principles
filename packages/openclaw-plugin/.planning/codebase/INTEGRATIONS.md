# External Integrations

**Analysis Date:** 2026-04-15

## APIs & External Services

**Plugin Framework:**
- OpenClaw - Host application
  - SDK/Client: `@openclaw/plugin-kit` (peer dependency, bundled as external)
  - Communication: Plugin hook events (`before_prompt_build`, `before_tool_call`, `after_tool_call`, `llm_output`, `subagent_spawning`, `subagent_ended`, `before_reset`, `before_compaction`, `after_compaction`)
  - Registration: Commands, tools, HTTP routes, background services

## Data Storage

**Databases:**
- SQLite (better-sqlite3 12.9.0)
  - Connection: File-based at `.state/trajectory.db`
  - Schema managed via migration runner in `src/core/schema/migrations/`
  - Migrations: 4 migrations (001-init-trajectory, 002-init-central, 003-init-workflow, 004-add-thinking-and-gfi)

**File Storage:**
- Local filesystem (workspace-relative paths)
- Templates copied to workspace on init (`templates/` directory)
- State persisted to `.state/` directory
- Pain samples stored in `memory/pain/`

**Caching:**
- None detected (in-memory caching only)

## Authentication & Identity

**Auth Provider:**
- OpenClaw native (session-based)
  - Implementation: Session key extraction via `extractAgentIdFromSessionKey()` in `src/utils/session-key.ts`
  - Agent identification via `agentId` from OpenClaw context

## Monitoring & Observability

**Error Tracking:**
- Plugin logger (`src/utils/plugin-logger.ts`)
- System logger (`src/core/system-logger.ts`)
- Hook execution recording via `WorkspaceContext.eventLog.recordHookExecution()`

**Logs:**
- File-based logs: `.state/memory/logs/SYSTEM.log`
- Console output for errors during build/dev

## CI/CD & Deployment

**Hosting:**
- OpenClaw plugin ecosystem
- Published as npm package `principles-disciple`

**CI Pipeline:**
- Not detected (no GitHub Actions or similar)

## Environment Configuration

**Required env vars:**
- None required (configuration via OpenClaw plugin config API)

**Secrets location:**
- OpenClaw plugin configuration (not file-based)

## Webhooks & Callbacks

**Incoming (via OpenClaw hooks):**
- `before_prompt_build` - Prompt building stage
- `before_tool_call` - Security gate before tool execution
- `after_tool_call` - Pain/trust tracking after tool execution
- `llm_output` - LLM response analysis
- `subagent_spawning` - Subagent lifecycle
- `subagent_ended` - Subagent completion
- `before_reset` / `before_compaction` / `after_compaction` - Workspace lifecycle

**Outgoing:**
- HTTP routes registered via `api.registerHttpRoute()` in `src/http/principles-console-route.ts`

---

*Integration audit: 2026-04-15*
