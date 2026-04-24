# Phase m6-03: DiagnosticianPromptBuilder + Workspace Boundary - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

**Domain:** DiagnosticianPromptBuilder transforms `DiagnosticianContextPayload` into a JSON message + optional system prompt for the OpenClaw agent. Explicit workspace boundary control (HG-2, HG-3).

**Scope anchor:** Produces the `--message <json>` input for `OpenClawCliRuntimeAdapter.startRun()` (m6-02). Does NOT call the CLI itself.
</domain>

<decisions>
## Implementation Decisions

### Prompt Output (LOCKED by ROADMAP)

- **DPB-01:** `DiagnosticianPromptBuilder.buildPrompt(context: DiagnosticianContextPayload): PromptResult` — output is JSON message for `--message` arg
- **DPB-02:** Prompt outputs ONLY JSON (no markdown, no file ops, no tool calls) — already locked
- **DPB-03:** JSON must conform to `DiagnosticianOutputV1Schema` — already locked
- **DPB-04:** Prompt includes `contextHash`, `taskId`, `diagnosisTarget`, `conversationWindow` summary, `sourceRefs` — already locked
- **DPB-05:** LLM only analyzes; code handles PD database commits — already locked

### Workspace Boundary (LOCKED by HG-2, HG-3)

- **HG-02:** OpenClaw CLI has NO `--workspace` flag. Two distinct boundaries:
  1. **PD workspace**: `.pd/` directory, SQLite state, principle artifacts
  2. **OpenClaw workspace**: `D:\.openclaw\workspace\`, OpenClaw's own state
- **HG-03:** `--openclaw-local`/`--openclaw-gateway` must be explicit; no silent fallback — already locked

### Prompt Message Structure

- **DPB-06:** `DiagnosticianPromptBuilder.buildPrompt()` outputs a `PromptInput` object with explicit top-level fields (`taskId`, `contextHash`, `diagnosisTarget`, `conversationWindow`, `sourceRefs`) plus `context: DiagnosticianContextPayload` — not raw pass-through.
  - Rationale: Explicit fields at top level make LLM's job clearer and easier to validate
  - The `DiagnosticianContextPayload` is nested under `context` for backward compatibility with existing payloads

### Extra System Prompt

- **DPB-07:** `DiagnosticianPromptBuilder.buildPrompt()` does NOT produce an `extraSystemPrompt` field.
  - System prompt is controlled by the OpenClaw agent profile/configuration
  - PD does not inject extra system prompt content — HG-3 satisfied by explicit `--local` flag on the CLI side
  - Rationale: Avoids fighting with agent's own system prompt; agent config/profile is the source of truth

### Workspace Control Mechanism

- **DPB-08:** Workspace boundaries are controlled via:
  1. `cwd` passed to `CliProcessRunner` — controls which directory the CLI executes in (PD workspace)
  2. Environment variables derived from config — `OPENCLAW_PROFILE`, `OPENCLAW_CONTAINER_HINT`, etc.
  3. Agent config/settings applied via profile or container hint
  - Rationale: Three-layer control allows PD to explicitly hand off to OpenClaw's workspace without sharing state

### Local/Gateway Mode Selection

- **DPB-09:** `OpenClawCliRuntimeAdapter` receives `runtimeMode: 'local' | 'gateway'` via constructor/config injection.
  - When `'local'`: adapter passes `--local` flag to `openclaw agent`
  - When `'gateway'`: adapter omits `--local` (or passes `--gateway` if supported)
  - No silent fallback — explicit configuration required
  - Rationale: Clear, testable, explicit — fits HG-3 requirement

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Schema & Protocol
- `packages/principles-core/src/runtime-v2/context-payload.ts` — DiagnosticianContextPayload schema (contextId, contextHash, taskId, workspaceDir, sourceRefs, diagnosisTarget, conversationWindow)
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — DiagnosticianOutputV1Schema (what the prompt asks LLM to produce)
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter interface (m6-02 adapter consumes this)
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory

### Prior Phases
- `.planning/phases/m6-02-OpenClawCliRuntimeAdapter-Core/m6-02-CONTEXT.md` — OpenClawCliRuntimeAdapter decisions (D-01~D-06), OCRA-06 workspace boundary
- `.planning/M6-OpenClaw-CLI-CONTRACT.md` — OpenClaw agent CLI contract (output structure, no --workspace flag, two-workspace boundary)

### M6 Roadmap
- `.planning/ROADMAP.md` §Phase m6-03 — Success criteria (DPB-01~DPB-05, HG-2, HG-3, OCRA-06, OCRA-07)
- `.planning/REQUIREMENTS.md` — DPB-01~DPB-05, OCRA-06, OCRA-07

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `DiagnosticianContextPayloadSchema` (context-payload.ts) — already defined with contextId, contextHash, taskId, workspaceDir, sourceRefs, diagnosisTarget, conversationWindow
- `DiagnosticianOutputV1Schema` (diagnostician-output.ts) — the JSON output format the LLM must produce
- `OpenClawCliRuntimeAdapter.startRun()` (m6-02) — receives inputPayload as StartRunInput.inputPayload
- `CliProcessRunner.runCliProcess()` (utils/cli-process-runner.ts) — accepts cwd, env, timeoutMs

### Integration Points
- `DiagnosticianPromptBuilder.buildPrompt()` output → `StartRunInput.inputPayload` → OpenClawCliRuntimeAdapter.startRun()
- Workspace boundaries: CliProcessRunner `cwd` + env vars control workspace

</code_context>

<deferred>
## Deferred Ideas

None yet — scope creep redirected to backlog.
</deferred>

---

*Phase: m6-03-DiagnosticianPromptBuilder-Workspace*
*Context gathered: 2026-04-24*