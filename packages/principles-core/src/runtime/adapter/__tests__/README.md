# Adapter-layer tests: default to the Pi faux provider

**Rule.** A test in this directory that needs a model must run the real
`@earendil-works/pi-ai` stream against the Pi 1.2 **faux provider**. Do not
`vi.mock` the agent loop (`runAgentLoop`) or the stream entry (`completeSimple`)
just to get a model reply.

**Why.** Mocking those layers asserts the config object the adapter *built*, not
the options the provider *received*. A wrapper that narrows the option bag
(`pdStreamSimple`) or a host that stops forwarding a field stays invisible.
This is not hypothetical: dropping `maxTokens` in `pdStreamSimple` left the old
loop-mock test 8/8 green.

## Usage

Two header lines replace the old compat mock block:

```ts
vi.mock('@earendil-works/pi-ai/compat', async (importActual) =>
  (await import('./fixtures/faux-pi-ai-harness.js')).fauxCompatMockFactory(importActual));

import { setFauxCompatModel } from './fixtures/faux-pi-ai-harness.js';
```

The helper keeps the real compat module and redirects only `getModel` /
`getProviders` to the registered faux model. It lives in
`__tests__/fixtures/faux-pi-ai-harness.ts` because vitest hoists `vi.mock`
factories above the test file's imports; it is test-only and not exported from
the package entry.

## Minimal example

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-ai/compat', async (importActual) =>
  (await import('./fixtures/faux-pi-ai-harness.js')).fauxCompatMockFactory(importActual));

import { registerFauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/compat';
import { setFauxCompatModel } from './fixtures/faux-pi-ai-harness.js';

let registration: ReturnType<typeof registerFauxProvider> | undefined;
const seen: Array<{ maxTokens?: number }> = [];

beforeEach(() => {
  seen.length = 0;
  process.env.SOME_KEY = 'offline-dummy-not-a-credential';
  registration = registerFauxProvider({ models: [{ id: 'faux-1', maxTokens: 32_000 }] });
  setFauxCompatModel(registration.getModel('faux-1'));
});

afterEach(() => {
  registration?.unregister();
  registration = undefined;
});

it('forwards the budget to the provider', async () => {
  const budget = 1234;
  registration?.setResponses([
    (_context: unknown, options?: { maxTokens?: number }) => {
      seen.push({ maxTokens: options?.maxTokens });
      return fauxAssistantMessage('done');
    },
  ]);

  // ... drive the real adapter here with `budget` ...

  expect(seen.map((call) => call.maxTokens)).toEqual([budget]);
});
```

`setResponses` is a queue consumed with `shift()`, one entry per provider call,
so script one responder per expected turn. Each responder is
`(context, options) => fauxAssistantMessage(...)`; return
`fauxAssistantMessage([fauxToolCall('some_tool', {})], { stopReason: 'toolUse' })`
to keep the loop running.

## Boundaries — what faux does NOT prove

1. **Model quality.** Faux returns scripted text. It cannot judge whether a real
   model would produce a better answer.
2. **Real host behavior.** It proves PD's own layers (adapter → `pdStreamSimple`
   → compat stream → provider) forward what they claim. It does not prove a real
   provider or host does.
3. **Cost.** `usage`/cost is synthesised (cost is always 0). Never assert billing
   amounts from a faux run.

Additionally, faux bypasses the per-API HTTP adapters, so `onPayload`-level wire
rewrites (`tool_choice`, `response_format`) are **not** observable here; those
remain source-audited.

## Deliberately not migrated

* `pi-ai-runtime-adapter.test.ts` — mocks `completeSimple`; its streaming-
  aggregation gap is already covered by `pi12-spike-oneshot.test.ts`.
* `l2-agent-loop-adapter.test.ts` — mocks `runAgentLoop`; two cases depend on
  pathological transcripts a real loop cannot produce (`content: null`, no
  assistant message). Those assertions need a redesign, not fabricated input.

Do not migrate either file for coverage alone, and never delete or weaken an
existing assertion to make a migration pass.
