# Phase m9-01: PiAiRuntimeAdapter Core - Research

**Researched:** 2026-04-29
**Domain:** Runtime adapter implementation using @mariozechner/pi-ai
**Confidence:** HIGH

## Summary

Phase m9-01 implements `PiAiRuntimeAdapter` — a `PDRuntimeAdapter` implementation that uses `@mariozechner/pi-ai` for direct LLM completion, bypassing the OpenClaw CLI. This solves the m8-03 UAT blocker where the main agent takes >300s to respond.

**Key findings:**
- `@mariozechner/pi-ai` v0.70.6 is already declared as a dependency in `packages/principles-core/package.json`
- `RuntimeKindSchema` already includes the `'pi-ai'` literal (line 24 of `runtime-protocol.ts`)
- Barrel exports in `adapter/index.ts` and `runtime-v2/index.ts` already export `PiAiRuntimeAdapter` and `PiAiRuntimeAdapterConfig`
- The actual implementation file `pi-ai-runtime-adapter.ts` does NOT exist yet — must be created
- The `complete()` function returns `Promise<AssistantMessage>` — perfect for one-shot mode
- `UserMessage` requires a `timestamp` field (number, epoch ms)
- `KnownProvider` type includes `'openrouter'`, `'anthropic'`, `'openai'`, etc.

**Primary recommendation:** Follow the OpenClawCliRuntimeAdapter one-shot pattern exactly, replacing CLI process spawning with pi-ai `getModel()` + `complete()` calls.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| LLM invocation | API / Backend | — | pi-ai calls external LLM providers |
| Output validation | API / Backend | — | TypeBox schema validation in adapter |
| Run state management | API / Backend | — | In-memory Map for one-shot runs |
| Telemetry emission | API / Backend | — | StoreEventEmitter integration |
| Error classification | API / Backend | — | PDRuntimeError mapping |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @mariozechner/pi-ai | ^0.70.6 | Direct LLM completion | Already in package.json, provides getModel/complete API |
| @sinclair/typebox | ^0.34.48 | Schema validation | Already used for DiagnosticianOutputV1Schema |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pi-ai complete() | pi-ai stream() | Streaming not needed for one-shot mode; complete() is simpler |

## Architecture Patterns

### One-Shot Run Flow

```
startRun(input)
  ├─ Read apiKeyEnv from process.env
  ├─ getModel(provider, modelId)
  ├─ Build Context (systemPrompt + UserMessage with timestamp)
  ├─ complete(model, context, { signal, apiKey, timeoutMs })
  ├─ Parse AssistantMessage.content[0].text as JSON
  ├─ Validate with DiagnosticianOutputV1Schema
  ├─ Store output in memory Map
  └─ Return RunHandle { runId, runtimeKind: 'pi-ai', startedAt }

pollRun(runId)
  └─ Return stored RunStatus (always terminal for one-shot)

fetchOutput(runId)
  └─ Return stored StructuredRunOutput
```

### Recommended Implementation Structure

```
packages/principles-core/src/runtime-v2/adapter/
├── pi-ai-runtime-adapter.ts     # NEW — main implementation
├── __tests__/
│   └── pi-ai-runtime-adapter.test.ts  # NEW — unit tests
├── openclaw-cli-runtime-adapter.ts  # Reference implementation
└── index.ts                     # Already exports PiAiRuntimeAdapter
```

### Pattern: Error Mapping

Map pi-ai errors to PDRuntimeError categories:

| pi-ai Error | PDRuntimeError Category |
|-------------|------------------------|
| AbortError (signal.abort()) | `timeout` |
| JSON.parse failure | `output_invalid` |
| Schema validation failure | `output_invalid` |
| API key missing | `runtime_unavailable` |
| Network/API error | `execution_failed` |
| Retries exhausted | `execution_failed` |

### Anti-Patterns to Avoid

- **Don't use streaming:** `complete()` returns a Promise, not a stream. Use it directly.
- **Don't forget UserMessage.timestamp:** pi-ai requires `timestamp: number` on UserMessage.
- **Don't cast provider unsafely:** Use `as KnownProvider` with a runtime check or explicit cast.
- **Don't hardcode API keys:** Always read from `process.env[apiKeyEnv]`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| LLM completion | Custom HTTP client | pi-ai `complete()` | Handles provider quirks, retries, streaming |
| Schema validation | Manual field checks | TypeBox `Value.Check()` | Already used in codebase, type-safe |
| AbortSignal timeout | Custom timeout logic | `AbortSignal.timeout()` | Built-in, clean API |

## Code Examples

### Constructor Config (AD-06)

```typescript
export interface PiAiRuntimeAdapterConfig {
  provider: string;       // KnownProvider value (e.g., 'openrouter')
  model: string;          // Model ID (e.g., 'anthropic/claude-sonnet-4')
  apiKeyEnv: string;      // Environment variable name for API key
  maxRetries?: number;    // Default: 2
  timeoutMs?: number;     // Default: 300_000
  workspace?: string;     // Optional workspace directory
  eventEmitter?: StoreEventEmitter;
}
```

### getModel + complete (AD-02, AD-03)

```typescript
import { getModel, complete } from '@mariozechner/pi-ai';
import type { KnownProvider, Context, UserMessage } from '@mariozechner/pi-ai';

// getModel requires KnownProvider, config has string
const model = getModel(config.provider as KnownProvider, config.model);

// Build context with UserMessage.timestamp
const userMessage: UserMessage = {
  role: 'user',
  content: messagePayload,
  timestamp: Date.now(),
};

const context: Context = {
  messages: [userMessage],
};

// complete with AbortSignal + apiKey
const signal = AbortSignal.timeout(config.timeoutMs ?? 300_000);
const response = await complete(model, context, {
  signal,
  apiKey,
  timeoutMs: config.timeoutMs,
  maxRetries: config.maxRetries,
});
```

### DiagnosticianOutputV1 Validation (AD-04)

```typescript
import { Value } from '@sinclair/typebox/value';
import { DiagnosticianOutputV1Schema } from '../diagnostician-output.js';

// Extract text from AssistantMessage
const textContent = response.content.find(c => c.type === 'text');
if (!textContent || textContent.type !== 'text') {
  throw new PDRuntimeError('output_invalid', 'No text content in LLM response');
}

let parsed: unknown;
try {
  parsed = JSON.parse(textContent.text);
} catch {
  throw new PDRuntimeError('output_invalid', 'LLM response is not valid JSON');
}

if (!Value.Check(DiagnosticianOutputV1Schema, parsed)) {
  throw new PDRuntimeError('output_invalid', 'LLM output does not match DiagnosticianOutputV1 schema');
}
```

### Retry with Exponential Backoff (AD-08)

```typescript
async function completeWithRetry(
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions,
  maxRetries: number,
): Promise<AssistantMessage> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await complete(model, context, options);
    } catch (err) {
      lastError = err;
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new PDRuntimeError('timeout', 'LLM request timed out');
      }
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new PDRuntimeError('execution_failed', `LLM completion failed after ${maxRetries + 1} attempts: ${lastError}`);
}
```

## Common Pitfalls

### Pitfall 1: UserMessage.timestamp Missing
**What goes wrong:** pi-ai throws if UserMessage lacks `timestamp` field.
**Why it happens:** The field is required in pi-ai's type system but easy to forget.
**How to avoid:** Always include `timestamp: Date.now()` when constructing UserMessage.
**Warning signs:** Runtime error from pi-ai about missing timestamp.

### Pitfall 2: Provider Type Cast
**What goes wrong:** TypeScript error when passing `string` to `getModel()`.
**Why it happens:** `getModel()` expects `KnownProvider` union, config has `string`.
**How to avoid:** Cast with `as KnownProvider` — the cast is safe because config values come from workflows.yaml which should use valid provider names.
**Warning signs:** TypeScript compile error.

### Pitfall 3: AbortSignal.timeout Not Available
**What goes wrong:** `AbortSignal.timeout()` may not be available in all Node.js versions.
**Why it happens:** Requires Node.js >= 17.3.0.
**How to avoid:** Check Node.js version or use a polyfill. The project likely uses a recent Node.js version.
**Warning signs:** Runtime error `AbortSignal.timeout is not a function`.

### Pitfall 4: AssistantMessage Content Array
**What goes wrong:** Accessing `response.content[0].text` without checking type.
**Why it happens:** Content array can contain TextContent, ThinkingContent, or ToolCall.
**How to avoid:** Use `.find(c => c.type === 'text')` and check for null.
**Warning signs:** Runtime error accessing undefined properties.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| @mariozechner/pi-ai | Core implementation | ✓ | ^0.70.6 | — |
| @sinclair/typebox | Schema validation | ✓ | ^0.34.48 | — |
| Node.js AbortSignal.timeout | Timeout control | ✓ | >=17.3.0 | Manual AbortController |

**No missing dependencies.** All required packages are already declared in package.json.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.0 |
| Config file | vitest.config.ts (or inline in package.json) |
| Quick run command | `cd packages/principles-core && npm test` |
| Full suite command | `cd packages/principles-core && npm run test:coverage` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AD-01 | All PDRuntimeAdapter methods implemented | unit | `vitest run src/runtime-v2/adapter/__tests__/pi-ai-runtime-adapter.test.ts` | No — Wave 0 |
| AD-02 | getModel uses pi-ai | unit | Same as above | No — Wave 0 |
| AD-03 | complete returns AssistantMessage | unit | Same as above | No — Wave 0 |
| AD-04 | DiagnosticianOutputV1 validation | unit | Same as above | No — Wave 0 |
| AD-05 | AbortSignal.timeout works | unit | Same as above | No — Wave 0 |
| AD-06 | Config accepted | unit | Same as above | No — Wave 0 |
| AD-07 | Missing apiKeyEnv throws runtime_unavailable | unit | Same as above | No — Wave 0 |
| AD-08 | Retry with exponential backoff | unit | Same as above | No — Wave 0 |
| AD-09 | startRun returns terminal RunHandle | unit | Same as above | No — Wave 0 |
| AD-10 | pollRun returns terminal status | unit | Same as above | No — Wave 0 |
| AD-11 | fetchOutput returns stored output | unit | Same as above | No — Wave 0 |
| AD-12 | fetchArtifacts returns empty array | unit | Same as above | No — Wave 0 |
| AD-13 | healthCheck validates apiKey + getModel | unit | Same as above | No — Wave 0 |
| AD-14 | getCapabilities returns correct shape | unit | Same as above | No — Wave 0 |
| AD-15 | Telemetry events emitted | unit | Same as above | No — Wave 0 |
| RS-01 | RuntimeKindSchema has 'pi-ai' | existing | Already verified in runtime-protocol.ts | Yes |
| RS-02 | kind() returns 'pi-ai' | unit | Same as above | No — Wave 0 |

### Wave 0 Gaps

- [ ] `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` — main implementation
- [ ] `packages/principles-core/src/runtime-v2/adapter/__tests__/pi-ai-runtime-adapter.test.ts` — unit tests
- [ ] Mock setup for `@mariozechner/pi-ai` (getModel, complete) in test file

## Open Questions (RESOLVED)

1. **pi-ai getModel type safety** — RESOLVED
   - What we know: `getModel()` requires `KnownProvider` union type, config has `string`
   - What's unclear: Whether to add a runtime validation of provider value
   - Recommendation: Use `as KnownProvider` cast with a comment explaining the safety assumption (config comes from workflows.yaml)
   - **Resolution:** Plan 01 Task 2 implements `as KnownProvider` cast. Config validation is handled by workflows.yaml policy layer.

2. **pi-ai complete() retry behavior** — RESOLVED
   - What we know: `ProviderStreamOptions` has `maxRetries` field
   - What's unclear: Whether pi-ai's built-in retry conflicts with our custom retry logic
   - Recommendation: Set pi-ai's `maxRetries: 0` and handle retries in the adapter to avoid double-retry
   - **Resolution:** Plan 01 Task 2 passes `maxRetries: 0` to `complete()`. Adapter handles retries with exponential backoff.

3. **DiagnosticianPromptBuilder integration** — RESOLVED
   - What we know: `DiagnosticianPromptBuilder.buildPrompt()` returns `{ message, promptInput }`
   - What's unclear: Whether to use this builder or construct the context directly
   - Recommendation: Use `DiagnosticianPromptBuilder` for consistency with OpenClawCliRuntimeAdapter, but the pi-ai adapter receives `inputPayload` as a pre-built message string from the runner
   - **Resolution:** Plan 01 Task 2 uses `inputPayload` directly as the prompt content (no DiagnosticianPromptBuilder). Consistent with one-shot mode where the runner pre-builds the message.

## Sources

### Primary (HIGH confidence)
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter interface, RuntimeKindSchema
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDRuntimeError, PDErrorCategory
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — DiagnosticianOutputV1Schema
- `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` — Reference implementation
- `node_modules/@mariozechner/pi-ai/dist/types.d.ts` — KnownProvider, UserMessage, AssistantMessage, Context
- `node_modules/@mariozechner/pi-ai/dist/stream.d.ts` — complete(), getModel()

### Secondary (MEDIUM confidence)
- `packages/principles-core/src/runtime-v2/adapter/index.ts` — Barrel exports already configured
- `packages/principles-core/src/runtime-v2/index.ts` — Runtime-v2 barrel exports already configured

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — pi-ai already in package.json, API verified from type definitions
- Architecture: HIGH — OpenClawCliRuntimeAdapter provides clear reference pattern
- Pitfalls: HIGH — Known pi-ai quirks documented from type definitions

**Research date:** 2026-04-29
**Valid until:** 2026-05-29 (stable — pi-ai API is mature)
