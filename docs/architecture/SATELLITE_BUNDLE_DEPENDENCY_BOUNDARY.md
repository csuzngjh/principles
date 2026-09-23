# Satellite Bundle Dependency Boundary — satellite 禁带 LLM 依赖图

> Status: living contract. Enforced by `scripts/build/check-satellite-purity.mjs`
> (OPT-002 fix, OPT-003 guard hardening). Origin: docs/release/artifact-hygiene-audit.md
> lineage + OPT-002 metafile forensics (PR #1850).

## The boundary

The OpenClaw plugin package emits three esbuild outputs:

| Artifact | Role | LLM runtime graph |
| --- | --- | --- |
| `bundle.js` | main plugin entry; hosts the agent/repair pipeline | **required** — legitimately carries pi-ai / anthropic / openai / genai / undici |
| `governance-audit.js` | read-only governance audit CLI entry | **forbidden** |
| `rulehost-evidence.js` | RuleHost evidence assembly | **forbidden** |

`governance-audit.js` and `rulehost-evidence.js` ("satellites") never call an
LLM at runtime: they read state, redact, and assemble evidence. They must stay
small (~60–70 KB) because they are loaded by tools and install paths where
multi-megabyte payloads are pure overhead.

## Why the ban is mechanical, not stylistic

Before OPT-002 both satellites carried ~2.7–2.8 MB of vendored LLM SDK code.
The root cause was never the dependencies themselves — it was **VALUE imports
of the `@principles/core/runtime-v2` barrel** on code reachable from a
satellite entry. The barrel re-exports host adapters, so esbuild propagated
the whole transitive graph into the satellite. `import type` / `export type`
are erased and do not propagate.

The failure mode is silent: re-adding a single
`import { X } from '@principles/core/runtime-v2'` line compiles and tests
green while quadrupling satellite size. Engineering discipline alone cannot
hold this boundary, so the build asserts it.

## How it is enforced

`scripts/build/check-satellite-purity.mjs` inspects the **esbuild metafile
inputs** (never minified-byte string grep — source maps and comments produce
false positives) on every official bundle build:

1. both satellite outputs must exist in the metafile (absence fails loud);
2. any input under `node_modules/<forbidden>/` in a satellite output fails the
   build, listing the SDK, bounded examples, and the fix;
3. on success it logs the positive evidence line
   `Forbidden dependency count: 0` with the per-satellite breakdown.

Forbidden list (current): `@earendil-works/pi-ai`,
`@earendil-works/pi-agent-core`, `@anthropic-ai` (scope: any package below
it), `openai`, `@google/genai`, `undici`.

Integration points — every path that can emit a satellite runs the guard at
generation time:

- `packages/openclaw-plugin/esbuild.config.js` (dev `build:bundle`,
  `build:production`, `prepack` → npm tarball, installer release workflows);
- `npm run check-satellite-bundle-deps` (root; drives the official guarded
  bundle build on demand);
- tail of `npm run verify:merge` (local merge gate);
- `scripts/__tests__/check-satellite-purity.test.ts` via `npm run test:scripts`
  (CI "Test scripts"), including fixture-based negative tests.

## How to fix a violation

Import the specific runtime-v2 **leaf subpath** instead of the barrel — e.g.
`@principles/core/runtime-v2/trajectory-schema` — and, if the leaf is not yet
an explicit `exports` entry in `packages/principles-core/package.json`, add an
additive subpath entry (the approved OPT-002 mechanism). Do NOT solve it by
removing LLM dependencies from the tree or by weakening the guard.
