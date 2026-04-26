# Phase m6-03: DiagnosticianPromptBuilder + Workspace Boundary - Research

**Researched:** 2026-04-24
**Domain:** Prompt construction for OpenClaw agent + explicit workspace boundary control
**Confidence:** HIGH

## Summary

Phase m6-03 builds the `DiagnosticianPromptBuilder` component (consumed by m6-02's `OpenClawCliRuntimeAdapter`) and establishes the workspace boundary controls required by HG-2 and HG-3. The builder transforms `DiagnosticianContextPayload` into a JSON message conforming to `DiagnosticianOutputV1Schema` instructions, with explicit top-level fields (`taskId`, `contextHash`, `diagnosisTarget`, `conversationWindow`, `sourceRefs`) and the nested `context` payload. The OpenClaw CLI has no `--workspace` flag, so the two-workspace boundary is enforced by injecting `cwd` and environment variables into `CliProcessRunner` rather than by any CLI flag. Runtime mode (`local` | `gateway`) is passed to the adapter via constructor injection — no silent fallback.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Prompt construction from DiagnosticianContextPayload | API/Backend (principles-core) | — | Pure data transformation, no I/O |
| JSON-only output (no markdown/file ops) | API/Backend (principles-core) | — | Builder outputs string, CLI handles execution |
| DiagnosticianOutputV1 schema instructions in prompt | API/Backend (principles-core) | — | Prompt tells LLM what to produce; code validates |
| Workspace boundary: PD vs OpenClaw workspace | API/Backend + CliProcessRunner | — | cwd + env injected at spawn time |
| Runtime mode selection (local/gateway) | API/Backend (OpenClawCliRuntimeAdapter) | — | Constructor config, passed as CLI flags |

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **DPB-01:** `DiagnosticianPromptBuilder.buildPrompt(context: DiagnosticianContextPayload): PromptResult` — output is JSON message for `--message` arg
- **DPB-02:** Prompt outputs ONLY JSON (no markdown, no file ops, no tool calls) — already locked
- **DPB-03:** JSON must conform to `DiagnosticianOutputV1Schema` — already locked
- **DPB-04:** Prompt includes `contextHash`, `taskId`, `diagnosisTarget`, `conversationWindow` summary, `sourceRefs` — already locked
- **DPB-05:** LLM only analyzes; code handles PD database commits — already locked
- **DPB-06:** `buildPrompt()` outputs a `PromptInput` object with explicit top-level fields + nested `context`
- **DPB-07:** NO `extraSystemPrompt` field — system prompt controlled by OpenClaw agent config
- **DPB-08:** Workspace boundaries via `cwd` + env vars + agent config (three-layer control)
- **DPB-09:** `OpenClawCliRuntimeAdapter` receives `runtimeMode: 'local' | 'gateway'` via constructor/config injection — no silent fallback
- **HG-02:** OpenClaw CLI has NO `--workspace` flag. Two distinct boundaries: PD workspace (`.pd/` dir) vs OpenClaw workspace (`D:\.openclaw\workspace\`)
- **HG-03:** `--openclaw-local`/`--openclaw-gateway` must be explicit; no silent fallback

### Scope

- Produces the `--message <json>` input for `OpenClawCliRuntimeAdapter.startRun()` (m6-02)
- Does NOT call the CLI itself
- Does NOT handle CLI routing (m6-04)

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DPB-01 | Input `DiagnosticianContextPayload`, output message for OpenClaw agent | `DiagnosticianContextPayloadSchema` fully understood; `buildPrompt()` signature defined by DPB-06 |
| DPB-02 | Prompt outputs only JSON, no markdown/file ops/tool calls | Builder produces string; constraint enforced by output format |
| DPB-03 | JSON must conform to `DiagnosticianOutputV1Schema` | Schema fully read; required fields: valid, diagnosisId, taskId, summary, rootCause, violatedPrinciples, evidence, recommendations, confidence |
| DPB-04 | Prompt includes contextHash, taskId, diagnosisTarget, conversationWindow summary, sourceRefs | All fields present in `DiagnosticianContextPayload`; builder adds top-level `taskId`, `contextHash`, `diagnosisTarget`, `sourceRefs` per DPB-06 |
| DPB-05 | LLM only analyzes; code handles PD database commits | No write operations in prompt; commit handled by downstream `DiagnosticianCommitter` |
| OCRA-06 | Two workspace boundaries explicitly controlled | `cwd` + `env` injection into `CliProcessRunner`; PD workspace vs OpenClaw workspace separation |
| OCRA-07 | `--openclaw-local`/`--openclaw-gateway` explicit, no silent fallback; both failure paths tested | Runtime mode via constructor injection |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@sinclair/typebox` + `Value.Check()` | (from existing runtime-v2) | Schema validation for `DiagnosticianOutputV1` | Already used in m6-02 for schema validation |
| `DiagnosticianContextPayloadSchema` | (existing) | Input schema for `buildPrompt()` | Canonical schema already defined |
| `DiagnosticianOutputV1Schema` | (existing) | Target schema LLM must produce | Canonical schema already defined |

### No New Dependencies
This phase is pure data transformation. No new npm packages are required beyond what is already in `principles-core`.

**Installation:** None — no new packages.

## Architecture Patterns

### System Architecture Diagram

```
DiagnosticianContextPayload
        │
        ▼
DiagnosticianPromptBuilder.buildPrompt()
        │
        │  (produces PromptInput — stringified to JSON for --message arg)
        ▼
OpenClawCliRuntimeAdapter.startRun()
        │  (serializes PromptInput as --message JSON)
        ▼
CliProcessRunner.runCliProcess()
        │  (cwd=PD workspace, env with OPENCLAW_PROFILE etc.)
        ▼
openclaw agent --agent <id> --message <json> --json --local
        │
        ▼
CliOutput.text (JSON) → fetchOutput() → DiagnosticianOutputV1
```

### Recommended Project Structure
```
packages/principles-core/src/runtime-v2/
├── diagnostician/
│   ├── DiagnosticianPromptBuilder.ts   # NEW: main builder class
│   ├── PromptInput.ts                 # NEW: PromptInput output type
│   └── __tests__/
│       └── diagnostician-prompt-builder.test.ts
└── (existing adapter/ and utils/ unchanged)
```

### Pattern 1: DiagnosticianPromptBuilder

**What:** Transforms `DiagnosticianContextPayload` into a `PromptInput` object (serialized as JSON string for `--message`).

**When to use:** When OpenClaw agent needs structured context to perform diagnosis.

**Source:** Locked decisions DPB-01, DPB-06.

```typescript
// PromptInput type (per DPB-06)
interface PromptInput {
  taskId: string;                    // from DiagnosticianContextPayload.taskId
  contextHash: string;              // from DiagnosticianContextPayload.contextHash
  diagnosisTarget: DiagnosisTarget;  // from DiagnosticianContextPayload.diagnosisTarget
  conversationWindow: HistoryQueryEntry[]; // summary from DiagnosticianContextPayload
  sourceRefs: string[];             // from DiagnosticianContextPayload.sourceRefs
  context: DiagnosticianContextPayload; // nested for backward compatibility
}

// buildPrompt() returns stringified PromptInput
function buildPrompt(context: DiagnosticianContextPayload): string {
  const promptInput: PromptInput = {
    taskId: context.taskId,
    contextHash: context.contextHash,
    diagnosisTarget: context.diagnosisTarget,
    conversationWindow: summarizeConversationWindow(context.conversationWindow),
    sourceRefs: context.sourceRefs,
    context, // full payload nested per DPB-06
  };
  return JSON.stringify(promptInput);
}
```

### Pattern 2: ConversationWindow Summarization

**What:** `conversationWindow` from `DiagnosticianContextPayload` (full `HistoryQueryEntry[]`) is passed directly — no summarization needed at build time. The prompt instructs the LLM to analyze the window.

**When to use:** Always for this phase — the full array is included per DPB-04.

### Pattern 3: Workspace Boundary via CliProcessRunner

**What:** Three-layer workspace control injected into `CliProcessRunner`:

1. `cwd` — directory the CLI process executes in (PD workspace)
2. `env` — `OPENCLAW_PROFILE`, `OPENCLAW_CONTAINER_HINT` derived from config
3. Agent config/profile — applied via OpenClaw agent profile settings

**Source:** DPB-08, HG-2.

```typescript
// In m6-02 OpenClawCliRuntimeAdapter.startRun() (existing pattern)
const cliOutput = await runCliProcess({
  command: 'openclaw',
  args: ['agent', '--agent', agentId, '--message', jsonPayload, '--json', '--local', ...],
  cwd: pdWorkspaceDir,          // PD workspace — where .pd/ state lives
  env: {
    OPENCLAW_PROFILE: 'some-profile',    // Controls which OpenClaw profile/workspace
    OPENCLAW_CONTAINER_HINT: containerId,
  },
  timeoutMs: input.timeoutMs,
});
```

### Anti-Patterns to Avoid

- **Including extraSystemPrompt in PromptInput:** DPB-07 explicitly forbids this. System prompt is controlled by OpenClaw agent config only.
- **Silent fallback for local/gateway mode:** DPB-09 requires explicit config; the adapter constructor must receive `runtimeMode` as a required parameter.
- **Passing `--workspace` flag to OpenClaw CLI:** OpenClaw CLI contract explicitly does not support this flag. Two-workspace boundary must be enforced via `cwd` + env injection only.
- **Including file operation instructions in prompt:** DPB-02 requires JSON-only output from the prompt. The prompt tells the LLM what to analyze, not what files to write.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON schema validation | Manual field-by-field validation | `Value.Check(DiagnosticianOutputV1Schema, parsed)` from `@sinclair/typebox/value` | Already used in m6-02; consistent, typed |
| CLI process execution | Custom spawn wrapper | `CliProcessRunner.runCliProcess()` | Already implemented in m6-01 with timeout, tree-kill, env-merge |
| Prompt construction | String templating with markdown | Pure JSON serialization of `PromptInput` | DPB-02 requires JSON-only output |

## Common Pitfalls

### Pitfall 1: PromptInput serialization producing non-JSON output
**What goes wrong:** If `DiagnosticianContextPayload` contains non-serializable fields (e.g., circular refs, functions), `JSON.stringify` throws or produces invalid JSON.
**Why it happens:** The payload includes `eventSummaries` (optional `Record<string, unknown>[]`) and `ambiguityNotes` which could contain complex objects.
**How to avoid:** Use a safe JSON serialization approach — validate or sanitize any potentially problematic fields before stringification.
**Warning signs:** `JSON.stringify` throws in unit tests with complex payload inputs.

### Pitfall 2: ConversationWindow too large for token limit
**What goes wrong:** Full `HistoryQueryEntry[]` array passed directly could exceed context window for large conversations.
**Why it happens:** `DiagnosticianContextPayload.conversationWindow` is typed as `HistoryQueryEntry[]` with no length limit in the schema.
**How to avoid:** The phase scope defines this as the LLM's problem — the prompt should include the full window and the LLM handles truncation. Document the risk. (This is acceptable per DPB-04 which says "conversationWindow summary" — the builder may need to truncate.)
**Warning signs:** Token count warnings in integration tests with large conversation histories.

### Pitfall 3: No extraSystemPrompt field but LLM needs additional context
**What goes wrong:** The prompt (JSON-only message) does not include any behavioral instructions — just data. The OpenClaw agent's system prompt must carry all the "how to analyze" instructions.
**Why it happens:** DPB-07 explicitly forbids `extraSystemPrompt`. The agent config is the only place for behavioral instructions.
**How to avoid:** Ensure the OpenClaw agent profile for the diagnostician agent includes the system prompt instructions. The builder only provides data context.
**Warning signs:** LLM produces generic output because it lacks analysis instructions — this is an agent config problem, not a builder problem.

## Code Examples

### DiagnosticianPromptBuilder (stub implementation)

```typescript
// Source: locked decisions DPB-01, DPB-06, DPB-07
import type { DiagnosticianContextPayload } from '../context-payload.js';

export interface PromptInput {
  taskId: string;
  contextHash: string;
  diagnosisTarget: DiagnosticianContextPayload['diagnosisTarget'];
  conversationWindow: DiagnosticianContextPayload['conversationWindow'];
  sourceRefs: DiagnosticianContextPayload['sourceRefs'];
  context: DiagnosticianContextPayload;
}

// No extraSystemPrompt field per DPB-07
export interface PromptResult {
  message: string;  // JSON string for --message arg
}

export class DiagnosticianPromptBuilder {
  buildPrompt(context: DiagnosticianContextPayload): PromptResult {
    const input: PromptInput = {
      taskId: context.taskId,
      contextHash: context.contextHash,
      diagnosisTarget: context.diagnosisTarget,
      conversationWindow: context.conversationWindow,
      sourceRefs: context.sourceRefs,
      context, // nested per DPB-06
    };

    return {
      message: JSON.stringify(input),
    };
  }
}
```

### Error mapping integration (from m6-02 adapter, for OCRA-06 context)

```typescript
// Source: openclaw-cli-runtime-adapter.ts (existing m6-02)
// OCRA-04 error mapping — applies to m6-03 workspace boundary context
if (cliOutput.exitCode === null && cliOutput.stderr.startsWith('ENOENT:')) {
  throw new PDRuntimeError('runtime_unavailable', 'openclaw binary not found');
}
if (cliOutput.timedOut) {
  throw new PDRuntimeError('timeout', 'CLI timeout exceeded');
}
if (cliOutput.exitCode !== null && cliOutput.exitCode !== 0) {
  throw new PDRuntimeError('execution_failed', `CLI exited with code ${cliOutput.exitCode}`);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Raw `DiagnosticianContextPayload` passed as `--message` | `DiagnosticianPromptBuilder` wraps payload with explicit top-level fields per DPB-06 | m6-03 | LLM receives clearer, validated structure |
| Implicit workspace via shared state | Explicit `cwd` + env vars via `CliProcessRunner` per DPB-08, HG-2 | m6-03 | Two-workspace boundary enforced without `--workspace` flag |
| Local/gateway mode implicit or fallback-based | Explicit `runtimeMode` constructor injection per DPB-09, HG-3 | m6-03 | No silent fallback; both modes tested |

**Deprecated/outdated:**
- Agent config injected via `--extra-system-prompt` flag: No longer supported by OpenClaw CLI contract; system prompt must come from agent profile only.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `DiagnosticianPromptBuilder.buildPrompt()` returns a `PromptResult` with a `message: string` field (JSON string) — not the raw object | Architecture Patterns | If m6-02 expects the raw object instead of a string, integration breaks. Verify: `startRun()` calls `JSON.stringify(inputPayload)` in m6-02 adapter |
| A2 | Runtime mode ('local' | 'gateway') is passed to `OpenClawCliRuntimeAdapter` constructor, not to `DiagnosticianPromptBuilder` | Architecture Patterns | DPB-09 says it's the adapter's constructor concern. If the builder needs to know the mode, plan scope changes |
| A3 | The `--local` flag is always passed when `runtimeMode === 'local'`; for `gateway` mode, the flag is omitted or `--gateway` is used | Architecture Patterns | m6-02 adapter currently hardcodes `--local` flag; need to verify gateway-mode flag handling |

## Open Questions

1. **Does the `--local` flag work for all gateway-mode scenarios?**
   - What we know: `M6-OpenClaw-CLI-CONTRACT.md` says `--local` and gateway mode are two different execution paths
   - What's unclear: Whether gateway mode is triggered by omitting `--local`, or by a different flag like `--gateway`
   - Recommendation: Check OpenClaw agent CLI help/docs; if `--gateway` is supported, m6-02 adapter needs conditional flag injection based on `runtimeMode`

2. **Should the builder truncate `conversationWindow` if it exceeds a size limit?**
   - What we know: Schema has no length limit; `DiagnosticianContextPayload.conversationWindow` is a full array
   - What's unclear: Whether the LLM context window or token limit requires truncation before the prompt is built
   - Recommendation: Start without truncation; if token limits become an issue, add a `maxConversationEntries` config option

3. **Is `OPENCLAW_PROFILE` / `OPENCLAW_CONTAINER_HINT` the correct env var names for workspace control?**
   - What we know: DPB-08 says env vars derived from config; names not confirmed against OpenClaw source
   - What's unclear: Whether these exact env var names are read by the OpenClaw CLI
   - Recommendation: Verify against OpenClaw SDK or source; if wrong, use correct names per OpenClaw docs

## Environment Availability

Step 2.6: SKIPPED (no external dependencies beyond existing OpenClaw CLI; no new tools required for this phase).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (from existing runtime-v2 test suite) |
| Config file | `packages/principles-core/vitest.config.ts` |
| Quick run command | `cd packages/principles-core && npx vitest run src/runtime-v2/diagnostician/` |
| Full suite command | `cd packages/principles-core && npx vitest run src/runtime-v2/` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DPB-01 | `buildPrompt()` returns `PromptResult` with `message` field containing valid JSON | unit | `vitest run diagnostician-prompt-builder.test.ts -t "returns PromptResult with message"` | NEW file |
| DPB-02 | Output is JSON-only string (no markdown, no file ops) | unit | `vitest run diagnostician-prompt-builder.test.ts -t "JSON-only"` | NEW file |
| DPB-03 | JSON conforms to PromptInput structure with top-level fields | unit | `vitest run diagnostician-prompt-builder.test.ts -t "conforms to PromptInput"` | NEW file |
| DPB-04 | Prompt includes taskId, contextHash, diagnosisTarget, conversationWindow, sourceRefs | unit | `vitest run diagnostician-prompt-builder.test.ts -t "includes required fields"` | NEW file |
| DPB-05 | Prompt does NOT instruct LLM to write to PD database | unit (inspect prompt content) | `vitest run diagnostician-prompt-builder.test.ts -t "no write instructions"` | NEW file |
| DPB-06 | Output has top-level fields + nested context | unit | `vitest run diagnostician-prompt-builder.test.ts -t "DPB-06"` | NEW file |
| DPB-07 | PromptResult has NO extraSystemPrompt field | unit | `vitest run diagnostician-prompt-builder.test.ts -t "DPB-07"` | NEW file |
| OCRA-06 | Adapter integration: cwd and env passed to CliProcessRunner | integration | `vitest run openclaw-cli-runtime-adapter.test.ts -t "workspace boundary"` | existing |
| OCRA-07 | Adapter integration: local/gateway mode explicit, no silent fallback | integration | `vitest run openclaw-cli-runtime-adapter.test.ts -t "OCRA-07"` | existing |

### Wave 0 Gaps
- [ ] `packages/principles-core/src/runtime-v2/diagnostician/diagnostician-prompt-builder.ts` — covers DPB-01~DPB-07
- [ ] `packages/principles-core/src/runtime-v2/diagnostician/__tests__/diagnostician-prompt-builder.test.ts` — unit tests for DPB-01~DPB-07
- [ ] `packages/principles-core/src/runtime-v2/diagnostician/PromptInput.ts` — PromptInput type definition

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | N/A — no auth in prompt builder |
| V3 Session Management | no | N/A — builder is stateless |
| V4 Access Control | yes | Workspace boundary: PD workspace vs OpenClaw workspace enforced via `cwd` injection |
| V5 Input Validation | yes | `DiagnosticianContextPayload` is already schema-validated at assembly time; builder is pass-through but should handle invalid payloads gracefully |

### Known Threat Patterns for this Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| JSON injection via conversationWindow | Tampering | LLM output validated against `DiagnosticianOutputV1Schema` by m6-02 adapter |
| Workspace boundary confusion (PD state vs OpenClaw state) | Elevation of Privilege | `cwd` strictly set to PD workspace; OpenClaw reads its own config from its own workspace |

## Sources

### Primary (HIGH confidence)
- `packages/principles-core/src/runtime-v2/context-payload.ts` — `DiagnosticianContextPayloadSchema` (fully read)
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — `DiagnosticianOutputV1Schema` (fully read)
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — `PDRuntimeAdapter`, `StartRunInput` (fully read)
- `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` — m6-02 adapter (fully read)
- `packages/principles-core/src/runtime-v2/utils/cli-process-runner.ts` — `runCliProcess()` (fully read)
- `.planning/M6-OpenClaw-CLI-CONTRACT.md` — OpenClaw CLI contract (fully read)
- `m6-03-CONTEXT.md` — locked decisions (fully read)

### Secondary (MEDIUM confidence)
- `packages/principles-core/src/runtime-v2/adapter/__tests__/openclaw-cli-runtime-adapter.test.ts` — adapter test patterns (read)

### Tertiary (LOW confidence)
- None — all primary sources verified

## Metadata

**Confidence breakdown:**
- Standard Stack: HIGH — all schemas, types, and patterns confirmed from canonical source files
- Architecture: HIGH — DPB-01~DPB-09, HG-2, HG-3 all read from CONTEXT.md and confirmed against existing m6-02 adapter
- Pitfalls: MEDIUM — conversationWindow truncation risk identified but not yet validated against real token limits

**Research date:** 2026-04-24
**Valid until:** 2026-05-24 (30 days — schema and protocol types are stable)
