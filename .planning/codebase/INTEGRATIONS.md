# External Integrations

**Analysis Date:** 2026-04-02

## External APIs

**No external REST/HTTP API integrations exist.** The plugin operates entirely within the OpenClaw Gateway runtime. All API calls are internal to the Gateway's plugin host system.

**Internal HTTP Routes (provided BY the plugin, not consumed):**
- The plugin registers HTTP routes via `api.registerHttpRoute()` in `packages/openclaw-plugin/src/index.ts`
- Route handler: `packages/openclaw-plugin/src/http/principles-console-route.ts`
- Route prefix: `/plugins/principles/`
- API prefix: `/plugins/principles/api/`
- Static assets: `/plugins/principles/assets/`
- These serve the Principles Console web UI and provide JSON API endpoints for the React dashboard

**Gateway Token Auth:**
- The web UI uses Bearer token authentication with the OpenClaw Gateway
- Token management in `packages/openclaw-plugin/ui/src/api.ts`
- Token sources (priority order): URL parameter → PD localStorage → OpenClaw shared settings
- Authorization header: `Authorization: Bearer {token}`

## Databases

**SQLite via better-sqlite3 (embedded, local only):**

All data is stored in local SQLite databases — no remote database connections, no database servers required.

### 1. Trajectory Database
- **Purpose:** Historical task outcomes, trust changes, evolution progress analytics
- **Location:** `{workspaceDir}/.state/trajectory.db`
- **Client:** `better-sqlite3` (^12.8.0)
- **Implementation:** `packages/openclaw-plugin/src/core/trajectory.ts`
- **Schema:** sessions, assistant_turns, user_turns, tool_calls, pain_events, gate_blocks, correction_samples, blobs
- **WAL mode:** Enabled (`journal_mode = WAL`)
- **Busy timeout:** 5000ms
- **File locking:** `withLock()` for critical writes

### 2. Control UI Database
- **Purpose:** Analytics read models for dashboard visualization
- **Location:** `{workspaceDir}/.state/control_ui.db`
- **Implementation:** `packages/openclaw-plugin/src/core/control-ui-db.ts`
- **Schema:** thinking_model_events, daily model usage aggregates

### 3. Central Aggregation Database
- **Purpose:** Aggregates data from ALL agent workspaces into unified view
- **Location:** `~/.openclaw/.central/aggregated.db`
- **Implementation:** `packages/openclaw-plugin/src/service/central-database.ts`
- **Schema:** workspaces, daily_stats (cross-workspace), various aggregated tables
- **Auto-discovery:** Discovers up to 10 default workspaces (builder, diagnostician, explorer, hr, main, pm, repair, research, resource-scout, verification)
- **Sync:** On-demand via `/api/central/sync` POST endpoint

### 4. Subagent Workflow Database
- **Purpose:** Persistent workflow state for multi-step subagent orchestration
- **Location:** `{workspaceDir}/.state/subagent_workflows.db`
- **Implementation:** `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts`
- **Schema:** workflows, workflow_events
- **Foreign keys:** Enabled

## File-Based Data Storage

**JSON/JSONL Files (no external services):**

| File | Location | Purpose |
|------|----------|---------|
| Evolution queue | `.state/evolution_queue.json` | Task queue for evolution worker |
| Evolution state | `.state/evolution.jsonl` | Event-sourced evolution state stream |
| Event log | `memory/logs/events.jsonl` | Structured event log (buffered, 20 entries or 30s flush) |
| Daily stats | `memory/logs/daily-stats.json` | Aggregated daily statistics |
| Plugin log | `memory/logs/plugin.log` | Runtime log file |
| Trust scorecard | `.state/trust_scorecard.json` | Trust stage and score |
| Config | `.state/pain_config.json` | Runtime configuration |
| Pain dictionary | `.state/pain_dictionary.json` | Pain detection rules |
| Session state | `.state/sessions/*.json` | Per-session GFI and token tracking |
| Profile | `.principles/PROFILE.json` | User expertise profile |
| Decision policy | `.principles/DECISION_POLICY.json` | Decision rules |
| Deployment registry | `.state/nocturnal/deployment-registry.json` | Model deployment bindings |

**No remote file storage.** Everything is local filesystem only.

## Authentication & Identity

**No external auth providers.** Authentication is handled entirely within the OpenClaw ecosystem:

**Trust Engine (Internal):**
- Implementation: `packages/openclaw-plugin/src/core/trust-engine.ts`
- 4-stage model: Observer → Editor → Developer → Architect
- Score range: 30-100 (floor of 30, cold-start grace period)
- Stage determines file modification permissions and risk path access
- NOT an external identity provider — this is an internal permission model

**Gateway Token (OpenClaw):**
- The web UI reuses OpenClaw Gateway authentication tokens
- Token stored in browser localStorage (`pd_gateway_token`)
- Cross-origin token sharing from OpenClaw main control panel
- No OAuth, no JWT, no external identity service

**Plugin Security Gate:**
- Implementation: `packages/openclaw-plugin/src/hooks/gate.ts`
- `before_tool_call` hook intercepts risky operations
- Requires `PLAN.md` with `STATUS: READY` for protected path modifications
- Progressive gating based on trust stage and audit level
- Bash command risk assessment: `packages/openclaw-plugin/src/hooks/bash-risk.ts`

## Third-party Services

**No third-party cloud services.** The plugin has zero external service dependencies:

- No email/SMS/notification services
- No payment processing
- No cloud storage (S3, GCS, etc.)
- No monitoring/observability (Datadog, Sentry, etc.)
- No CI/CD webhooks
- No social media integrations
- No analytics platforms (Google Analytics, Mixpanel, etc.)
- No caching layer (Redis, Memcached, etc.)

**All computation is local.** The plugin runs entirely within the OpenClaw Gateway process on the developer's machine.

## Internal Event System

**OpenClaw Plugin Hooks (Lifecycle Events):**

The plugin subscribes to these OpenClaw runtime hooks:

| Hook | Handler | Purpose |
|------|---------|---------|
| `before_prompt_build` | `src/hooks/prompt.ts` | Inject Thinking OS, OKR, pain context into AI prompts |
| `before_tool_call` | `src/hooks/gate.ts` | Security gate — block risky operations without approved plan |
| `after_tool_call` | `src/hooks/pain.ts` | Detect tool failures, record pain signals |
| `llm_output` | `src/hooks/llm.ts` | Analyze LLM output for empathy signals, corrections |
| `before_message_write` | `src/hooks/message-sanitize.ts` | Sanitize messages before writing |
| `subagent_spawning` | `src/index.ts` | Shadow routing observation recording |
| `subagent_ended` | `src/hooks/subagent.ts` | Complete shadow observations, cleanup |
| `before_reset` | `src/hooks/lifecycle.ts` | Checkpoint before session reset |
| `before_compaction` | `src/hooks/lifecycle.ts` | Checkpoint before context compaction |
| `after_compaction` | `src/hooks/lifecycle.ts` | Restore state after compaction |

**Background Services (registered via `api.registerService()`):**

| Service | Implementation | Purpose |
|---------|---------------|---------|
| Evolution Worker | `src/service/evolution-worker.ts` | Polls pain queue, processes evolution tasks, runs nocturnal reflection |
| Trajectory Service | `src/service/trajectory-service.ts` | Manages trajectory DB lifecycle |

**Custom Tools (registered via `api.registerTool()`):**

| Tool | Implementation | Purpose |
|------|---------------|---------|
| Deep Reflect | `src/tools/deep-reflect.ts` | Triggered before complex tasks for structured self-reflection |

## External Training Integration (Nocturnal)

**Architecture: Plugin produces training artifacts; external backends consume them.**

The Nocturnal system generates training data and experiment specs for ORPO fine-tuning, but the plugin does NOT execute training itself.

**Contract:** `packages/openclaw-plugin/src/core/external-training-contract.ts`
- Defines experiment spec schema (backend-agnostic)
- Supported backends: `peft-trl-orpo`, `unsloth-orpo`, `dry-run`
- Training mode: ORPO (Orthogonal Preference Optimization) for production

**Data Flow:**
1. Plugin extracts trajectory samples → `src/core/nocturnal-trajectory-extractor.ts`
2. Nocturnal Trinity (Dreamer → Philosopher → Scribe) generates reflection artifacts → `src/core/nocturnal-trinity.ts`
3. Arbiter validates executability → `src/core/nocturnal-arbiter.ts`, `src/core/nocturnal-executability.ts`
4. Approved samples exported as ORPO dataset → `src/core/nocturnal-export.ts`
5. External trainer (Python script) consumes the dataset — `scripts/nocturnal/trainer/` (separate process, no npm dependencies)
6. Training results imported back via `/nocturnal-train import-result` command
7. Promotion gate evaluates checkpoints → `src/core/promotion-gate.ts`
8. Deployment registry binds checkpoints to worker profiles → `src/core/model-deployment-registry.ts`

**Shadow Routing (Phase 5):**
- Runtime shadow observation recording: `src/core/shadow-observation-registry.ts`
- Task classification for routing: `src/core/local-worker-routing.ts`
- Worker profiles: `local-reader`, `local-editor`

## Webhooks & Events

**No incoming or outgoing webhooks.** All events are internal to the OpenClaw runtime.

**Internal Event Flow:**
- Event sourcing via `EvolutionReducerImpl` — appends events to `.state/evolution.jsonl`
- Buffered event logging — batches 20 entries or flushes every 30 seconds
- Daily statistics aggregation in `EventLog` class

---

*Integration audit: 2026-04-02*
