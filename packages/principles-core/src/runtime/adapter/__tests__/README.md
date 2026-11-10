# Adapter-layer tests: default to the Pi faux provider

**Default.** A new or changed test in this directory that needs a model runs the
real `@earendil-works/pi-ai` stream against the Pi 1.2 **faux provider**. Do not
`vi.mock` the agent loop (`runAgentLoop`) or the stream entry (`completeSimple` /
`streamSimple`) just to get a model reply.

**This is a default, not a mandate.** Some contracts genuinely cannot be
observed through faux (see *Boundaries* and *Wire-level assertions* below). When
you bypass the whole chain, state the reason in the file with the exemption
marker so the next reader does not have to reconstruct your reasoning — and so
the guard in `check:repo-hygiene` stays quiet for the right reason.

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

## Wire-level assertions are the exception

Faux sits above the per-API HTTP adapters, so `onPayload`-level wire rewrites
(`tool_choice`, `response_format`, provider-specific body shapes) are **not**
observable through it. Assertions on those shapes need the real opt-in wire
tests that mock the HTTP transport instead
(`pi-ai-runtime-adapter-budget-wire.test.ts`, `pi12-ac6-*-real-llm.test.ts`);
whatever stays unreachable there is covered by source audit, not by faux.
Do not "fix" a wire assertion by routing it through faux — it would pass
vacuously.

## If you must bypass the chain

Mocking a chain module (`@earendil-works/pi-ai`,
`@earendil-works/pi-ai/compat`, `@earendil-works/pi-agent-core`) without the
faux harness factory requires one comment in the file:

```ts
// adapter-chain-mock-exempt: <injection-tested|structural-only> — <why faux cannot cover this contract>
```

The tag records **how the exemption was established**, and it is not decoration:

* `injection-tested` — a realistic defect was planted in production code and the
  old suite went red under it, so this file is *known* to catch what faux would
  catch;
* `structural-only` — no defect was planted; the reason is structural (the
  contract sits outside what faux observes).

A written reason is not evidence of verification. Readers must be able to tell
`injection-tested` from `structural-only` without asking anyone.

Current exemptions:

| File | Status | Why |
| --- | --- | --- |
| `pi-ai-runtime-adapter.test.ts` | `injection-tested` | PoV below: defect turned the old suite red, so faux adds no blind-spot coverage here. |
| `artificer-l2-adapter.test.ts` | `structural-only` | Asserts loop-orchestration branches (maxTurns, beforeToolCall, timeout); its model path is covered by `l2-adapters-g2-maxtokens.test.ts` on the real loop. |
| `l2-agent-loop-adapter.test.ts` | `structural-only` | Two cases need pathological transcripts a real loop cannot produce; the assertions need a redesign, not faux. |
| `pd-stream-simple.test.ts` | `structural-only` | Asserts per-API fetch binding, which sits below faux (wire-level exception above). |
| `runtime-config-contract.test.ts` | `structural-only` | Asserts provider/model/timeout precedence resolved before any model call; a scripted model never reaches it. |

`npm run check:repo-hygiene` (also the pre-commit hook) fails on an adapter test
that mocks a chain module without this marker, and reports a marker with an
empty reason as its own finding. The marker is not a waiver of judgement — it is
the place where the reason is written down.

## Reverting the guard (read before reverting either commit)

Revert `chore(repo-hygiene): flag adapter tests that mock the whole model chain`
**before** `test(adapter): record why five legacy suites still mock the model
chain`. Reverting the annotations first leaves five suites mocking a chain
module with no marker, so `check:repo-hygiene` (and therefore the next commit)
turns red.

If that already happened: restore the five marker lines, or revert the guard as
well, then run `node scripts/check-repo-hygiene.js all` — exit 0 means recovered.

## Deliberately not migrated

* `pi-ai-runtime-adapter.test.ts` — mocks `completeSimple`; proof below.
* `l2-agent-loop-adapter.test.ts` — mocks `runAgentLoop`. Two cases depend on a
  pathological transcript a real loop cannot produce (`content: null`, no
  assistant message at all). Faux cannot be made to yield such an input: the
  real loop always assembles a well-formed transcript, and fabricating one by
  hand would test the fixture instead of the adapter. Those assertions need a
  redesign, not a migration — so the file stays, assertions intact.

Do not migrate either file for coverage alone, and never delete or weaken an
existing assertion to make a migration pass. Both files carry the
`adapter-chain-mock-exempt` marker for that reason; the marker records the
decision, it does not schedule a migration.

## PoV archive: why `pi-ai-runtime-adapter.test.ts` stays on the mock

Run 2026-11-10. Protocol: plant one realistic defect in production code, run
the old suite and a faux-based suite covering the same contract, then restore
the code. Nothing in either suite was changed to make a step pass.

**Defect.** In `completeWithRetry`, `maxTokens: maxTokensBudget` was replaced by
`maxTokens: this.resolveMaxTokens()` — the per-request budget silently stops
being forwarded, the "a refactor dropped the field at the wrapper" class.

| Step | Suite | Result | Exit |
| --- | --- | --- | --- |
| old + defect | `pi-ai-runtime-adapter.test.ts` | 4 failed / 136 passed (re-run: 5 failed / 135 passed; the extra red is a timing-sensitive case) | 1 |
| new + defect | faux suite, same contract (2 cases) | 2 failed | 1 |
| restored + new | same faux suite | 2 passed | 0 |
| restored + old | `pi-ai-runtime-adapter.test.ts` | 140 passed | 0 |

The stable reds are the `output-budget downshift (PRI-1011)` cases:
`[32000, 32000]` vs expected `[32000, 16000]`, and
`[8192, 8192, 8192, 8192]` vs `[8192, 4096, 4096, 4096]`.

**Conclusion.** The old suite already asserts the exact object faux would
observe — what `completeSimple` receives. Faux adds no detection for
adapter-owned behaviour here; the only layers below it are pi-ai internals (not
this repository) and `onPayload` (invisible to faux by construction). Migrating
would add a second copy of the same assertions without closing a blind spot.
Revisit only if the adapter starts building its own request wrapper below
`completeSimple`.
