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

### Gray Areas (to discuss)

These are the remaining implementation choices NOT yet locked:

1. **Prompt message structure**: How is the JSON for `--message` actually formatted? Is it the raw DiagnosticianContextPayload, or a transformed prompt object?
2. **Extra system prompt**: Does DiagnosticianPromptBuilder produce an `extraSystemPrompt` string in addition to the JSON message? If so, what goes in it?
3. **Workspace control mechanism**: How exactly are the two workspaces controlled? Via `cwd` in CliProcessRunner, via env vars, or both?
4. **Local vs Gateway mode**: How does the adapter know which mode to use? CLI flag, env var, or config?

</decisions>

<canonical_refs>
## Canonical References

### Schema & Protocol
- `packages/principles-core/src/runtime-v2/context-payload.ts` — DiagnosticianContextPayload schema (contextId, contextHash, taskId, workspaceDir, sourceRefs, diagnosisTarget, conversationWindow)
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — DiagnosticianOutputV1Schema (what the prompt asks LLM to produce)
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter interface (m6-02 adapter consumes this)
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory

### Prior Phases
- `.planning/phases/m6-02-OpenClawCliRuntimeAdapter-Core/m6-02-CONTEXT.md` — OpenClawCliRuntimeAdapter decisions (D-01~D-06), OCRA-06 workspace boundary
- `.planning/M6-OpenClaw-CLI-CONTRACT.md` — OpenClaw agent CLI contract (output structure, no --workspace flag)

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

### Integration Points
- `DiagnosticianPromptBuilder.buildPrompt()` output → `StartRunInput.inputPayload` → OpenClawCliRuntimeAdapter.startRun()
- Workspace boundaries: CliProcessRunner `cwd` + env vars control workspace

</code_context>

<deferred>
## Deferred Ideas

None yet — scope creep redirected to backlog.
</deferred>
