# INTEGRATIONS.md - External Services & APIs

## Host Platform

- **OpenClaw** (peerDependency >=2026.4.4)
  - Plugin registration via `packages/openclaw-plugin/src/index.ts`
  - Hooks: `before_prompt_build`, `before_tool_call`, `after_tool_call`, `llm_output`, `subagent_spawning`, `subagent_ended`, `before_reset`, `before_compaction`, `after_compaction`
  - Services: Background worker registration
  - Commands: CLI command registration
  - HTTP routes: Web console API routes

## Database

- **SQLite** via `better-sqlite3` ^12.8.0
  - Embedded, file-based database
  - Used for evolution tracking, session state, and local persistence
  - No external database server required

## External APIs

- **No external API dependencies** in the core plugin
  - All AI model communication handled by OpenClaw host platform
  - Plugin operates entirely locally with SQLite storage

## Authentication

- **No custom auth** — authentication delegated to OpenClaw host
  - Plugin runs within OpenClaw's security context
  - Access control via OpenClaw's session management

## Webhooks & Events

- **Event-driven architecture** via OpenClaw hooks:
  - `before_prompt_build` — Injects system prompts, principles, empathy optimization
  - `before_tool_call` — Safety gating, risk analysis, edit verification
  - `after_tool_call` — Pain detection, trust tracking, event logging
  - `llm_output` — LLM output analysis
  - `subagent_spawning` / `subagent_ended` — Subagent lifecycle management
  - `before_reset` / `before_compaction` / `after_compaction` — Session lifecycle

## Internal Service Communication

- **Central Sync Service** (`src/service/central-sync-service.ts`)
- **Central Health Service** (`src/service/central-health-service.ts`)
- **Central Database** (`src/service/central-database.ts`)
- **Central Overview Service** (`src/service/central-overview-service.ts`)

## Web Console

- **React 19** based UI in `packages/openclaw-plugin/src/ui/src/`
- **API routes** via `src/http/principles-console-route.ts`
- Served through OpenClaw's HTTP routing
