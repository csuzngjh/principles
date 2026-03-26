# External Integrations

**Analysis Date:** 2026-03-26

## APIs & External Services

**Package Registry:**
- npm registry (https://registry.npmjs.org) - Package distribution
  - Auth: NPM_TOKEN secret in GitHub Actions
  - Packages: principles-disciple, create-principles-disciple

**GitHub:**
- GitHub API (via actions/setup-node@v4, actions/checkout@v6) - CI/CD
  - Auth: GITHUB_TOKEN (automatically provided)
  - Used for: Repository checkout, Node.js setup, releases

**OpenClaw Ecosystem:**
- OpenClaw Gateway - Plugin runtime environment
  - SDK: openclaw >= 1.0.0 (peer dependency, optional)
  - SDK types: @openclaw/sdk, @openclaw/plugin-kit (external, bundled by esbuild)
  - Integration: Plugin hooks (before_prompt_build, before_tool_call, after_tool_call, subagent_spawning, before_compaction)

## Data Storage

**Databases:**
- SQLite (better-sqlite3 12.8.0)
  - Connection: Local file-based databases
  - Client: better-sqlite3 (synchronous API)
  - Locations:
    - Workspace trajectory DB: `{stateDir}/trajectory.db` (per workspace)
    - Control UI DB: `{stateDir}/control-ui.db` (per workspace)
    - Central aggregation DB: Centralized multi-workspace database (in `src/service/central-database.ts`)
  - Schema: Tables for events, principles, pain samples, evolution tasks
  - Query service: `EvolutionQueryService`, `ControlUiQueryService`

**File Storage:**
- Local filesystem only
  - Templates: `templates/` directory (bundled with plugin)
  - Workspace state: `.state/` directory in each workspace
  - Principles files: `.principles/` directory (PLAN.md, DECISION_POLICY.json, etc.)
  - No cloud storage, no S3, no external file services

**Caching:**
- None detected (no Redis, no external cache)

## Authentication & Identity

**Auth Provider:**
- None (plugin runs locally, no user authentication)
  - Implementation: No auth logic in codebase
  - OpenClaw Gateway handles authentication at gateway level
  - Plugin trusts gateway-provided context

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry, no external error tracking)
  - Errors logged to local files in `{stateDir}/logs/`
  - Runtime logs: `plugin.log`
  - Event logs: `events.jsonl` (structured JSONL format)
  - Daily stats: `daily-stats.json`

**Logs:**
- Local file-based logging
  - Location: Workspace `.state/logs/` directory
  - Format: Plain text (plugin.log), JSONL (events.jsonl)
  - No remote logging service (no ELK, no CloudWatch, no Papertrail)

## CI/CD & Deployment

**Hosting:**
- GitHub (https://github.com/csuzngjh/principles)
  - Repository hosting
  - Release management via GitHub Releases

**CI Pipeline:**
- GitHub Actions (`.github/workflows/`)
  - `ci.yml` - Continuous integration (lint, test, build)
  - `publish-npm.yml` - Automated publishing to npm
  - `pr-checks.yml` - Pull request validation
  - `ai-review.yml` - AI code review
  - `stale.yml` - Issue management
  - `issue-management.yml` - Issue automation
  - Test matrix: Node.js 18, 20, 22
  - OS: ubuntu-latest

**Deployment:**
- npm registry (public packages)
  - Packages: principles-disciple (plugin), create-principles-disciple (CLI)
  - Access: public (npm publish --access public)
  - Versioning: semantic-release (Conventional Commits)
  - Trigger: Merged PRs, manual workflow dispatch, tag pushes
  - Provenance: Enabled (npm publish --provenance)

## Environment Configuration

**Required env vars:**
- None (plugin uses file-based configuration)
- Runtime: OpenClaw Gateway provides plugin context
- Build: GitHub Actions injects NPM_TOKEN, GITHUB_TOKEN

**Secrets location:**
- GitHub Secrets (for CI/CD only)
  - NPM_TOKEN - npm registry authentication
  - GITHUB_TOKEN - GitHub API authentication (auto-provided)
- No local secrets in repository
- No .env files (forbidden)

## Webhooks & Callbacks

**Incoming:**
- Plugin HTTP routes (via OpenClaw Gateway)
  - Route: `/plugins/principles/` - Principles Console UI
  - API: `/plugins/principles/api/*` - REST API for console
  - Assets: `/plugins/principles/assets/*` - Static assets
  - Implementation: `src/http/principles-console-route.ts`
  - Framework: Node.js native http module (IncomingMessage, ServerResponse)

**Outgoing:**
- None (no external webhook calls)
  - Plugin does not make HTTP requests to external services
  - No webhooks to third-party services
  - No outbound API calls (except npm registry for dependencies)

## CLI Tools & Scripts

**Root Scripts:**
- `scripts/release.sh` - Manual release helper
- `scripts/sync-version.sh` - Version synchronization
- `scripts/cleanup_backups.sh` - Backup cleanup
- `scripts/collect-control-plane-snapshot.sh` - Data collection for control plane
- `scripts/migrate-to-evolution-points.ts` - Migration script
- `scripts/evolution_daemon.py` - Legacy evolution daemon (Python)

**Plugin Scripts:**
- `packages/openclaw-plugin/scripts/build-web.mjs` - UI bundling (esbuild)
- `packages/openclaw-plugin/scripts/install-dependencies.cjs` - Post-install dependency setup
- `packages/openclaw-plugin/scripts/sync-plugin.mjs` - Plugin file synchronization
- `packages/openclaw-plugin/scripts/verify-build.mjs` - Build verification

**CLI:**
- `create-principles-disciple` (npm package)
  - Interactive installer: `npx create-principles-disciple`
  - Non-interactive: `npx create-principles-disciple --yes`
  - Uninstaller: `create-principles-disciple uninstall`
  - Status check: `create-principles-disciple status`

## Build Output Targets

**Plugin Package:**
- `dist/index.js` - Main entry point (ESM)
- `dist/index.d.ts` - TypeScript declarations
- `dist/bundle.js` - Production bundle (esbuild, minified)
- `dist/types.js`, `dist/types.d.ts` - Type exports
- `dist/web/assets/app.js` - Bundled React UI
- `dist/web/assets/app.js.map` - Source maps (dev)
- `dist/templates/` - Workspace templates (copied)
- `dist/agents/` - Agent definitions (copied if exists)
- `dist/openclaw.plugin.json` - Plugin manifest

**CLI Package:**
- `dist/index.js` - CLI entry point (ESM)
- `dist/**/*.d.ts` - TypeScript declarations
- `plugin/` - Plugin files bundled with CLI

**Distribution:**
- npm packages: principles-disciple, create-principles-disciple
- No Docker images
- No serverless deployments
- No CDN distribution

---

*Integration audit: 2026-03-26*
