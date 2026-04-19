# Stack Research

**Domain:** TypeScript/Node.js YAML runtime integration (WorkflowFunnelLoader wiring)
**Researched:** 2026-04-19
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `js-yaml` | `^4.1.1` | YAML parsing (SSOT loader) | Already in deps; safe load (`DEFAULT_SCHEMA`) prevents arbitrary code execution; industry standard for Node.js YAML |
| `fs.watch()` (Node.js built-in) | — | File system watching | Native, no additional dependency; sufficient for single-file watch use cases |
| Node.js `fs` module | built-in | File I/O for workflows.yaml | Native API, already used throughout codebase |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `chokidar` | `^4.0.0` | Cross-platform FS watcher | Only if `fs.watch()` proves unreliable on Windows or macOS; not needed initially |

### Infrastructure

| Path | Purpose | Why |
|------|---------|-----|
| `.state/workflows.yaml` | Workflow funnel SSOT | Already defined in `WorkflowFunnelLoader` (D-02: `.state/` directory per workspace) |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `yaml` (npm) | Duplicate YAML library | `js-yaml` already in deps |
| `yaml` v2 | Different API surface | `js-yaml@^4.1.1` |
| `fs.watchFile()` | Polling-based, higher overhead | `fs.watch()` with debounce |
| `eval()`-enabled YAML schema | Security risk | `js-yaml DEFAULT_SCHEMA` (safe, no code execution) |
| `yaml.load()` with full schema | Allows arbitrary code execution | `yaml.load(content, { schema: yaml.DEFAULT_SCHEMA })` — already used |

## Integration Architecture

### Current State

| Component | Status | Notes |
|-----------|--------|-------|
| `WorkflowFunnelLoader` | Implemented | `src/core/workflow-funnel-loader.ts` (170 lines) |
| `js-yaml@^4.1.1` | In deps | Verified in `package.json` |
| `workflows.yaml` path in `PD_FILES` | **Missing** | Needs to be added to `paths.ts` |
| `WorkflowFunnelLoader` in `WorkspaceContext` | **Missing** | Not yet wired into context |
| `RuntimeSummaryService` using YAML | **Missing** | Still uses hardcoded funnel structure |

### Integration Steps

1. **Add `WORKFLOWS_YAML` to `PD_FILES`** in `src/core/paths.ts`:
   ```typescript
   WORKFLOWS_YAML: posixJoin(PD_DIRS.STATE, 'workflows.yaml'),
   ```

2. **Wire `WorkflowFunnelLoader` into `WorkspaceContext`**:
   - Add private `_workflowFunnelLoader?: WorkflowFunnelLoader` field
   - Initialize lazily on first access
   - Call `dispose()` in cleanup path

3. **Update `RuntimeSummaryService.getSummary()`** to use funnel stages from loader:
   - Pass loader instance as parameter OR access via context
   - Replace hardcoded `heartbeat/nocturnal/rulehost` funnel references
   - Derive funnel summary from `loader.getAllFunnels()` + event log data

4. **Add degraded state for YAML invalid/missing**:
   - On missing file: empty funnel map, warning in metadata
   - On parse/validation failure: preserve last valid, warning in metadata
   - **No silent fallback** — status must show explicit degraded state

## Stack Patterns

**Single config file watch (current scenario):**
- Use `fs.watch()` with debounce (100ms already implemented)
- No additional watcher library needed
- On Windows: `fs.watch()` may fire rename events; `eventType !== 'change'` guard already handles this

**Degraded/error state for invalid YAML:**
- Preserve last known-good in-memory config (already implemented in WorkflowFunnelLoader)
- Log warning with specific error message
- Clear to empty only on missing file, NOT on parse failure
- Report degraded state via `metadata.warnings` in RuntimeSummary

**Integration with RuntimeSummaryService (static method class):**
- Cannot inject via constructor; options:
  - Pass loader as parameter: `getSummary(workspaceDir, options?: { sessionId?, funnelLoader? })`
  - Instantiate inside `getSummary()` using `workspaceDir` to derive `stateDir`
  - Use context-level singleton via `WorkspaceContext` instance

## Version Compatibility

| Package | Compatible With | Notes |
|---------|----------------|-------|
| `js-yaml@^4.1.1` | Node.js 14+ | Works in ESM and CJS |
| `chokidar@^4.0.0` | Node.js 18+ | If needed later for cross-platform reliability |

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|------------------------|
| `js-yaml` | `yaml` (npm package) | If yaml v2 API is strongly preferred |
| `fs.watch()` | `chokidar` | Only if cross-platform watcher bugs surface in testing |
| `fs.watch()` | `fs.watchFile()` | Never — polling is less efficient |

## Sources

- `packages/openclaw-plugin/src/core/workflow-funnel-loader.ts` — existing implementation verified
- `packages/openclaw-plugin/src/core/paths.ts` — PD_FILES constant, `workflows.yaml` path not yet registered
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` — target integration point
- `packages/openclaw-plugin/package.json` — verified `js-yaml@^4.1.1` in deps

---
*Stack research for: YAML runtime integration*
*Researched: 2026-04-19*
