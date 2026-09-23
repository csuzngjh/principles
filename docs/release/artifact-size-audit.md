# Artifact Size Audit

> Phase: Artifact Size Optimization — Phase 1 (read-only audit)
> Date: 2026-09-23 · Base commit: `620d54e1` (main) · Predecessors: RAH-1 / RAH-2 / RAH-3 (test-asset leakage already closed)
> Method: local rebuild of official production paths (`build:production` → `bundle-plugin.mjs` → `npm pack`), esbuild metafile temporary analysis, npm-registry historical tarball sampling, GitHub release asset (`pd-assets`) streaming inspection. **No build config, bundler, package.json, installer or dependency file was modified.**

---

## Executive Summary

1. The installer npm tarball is **7.34 MiB** (gzip), whose uncompressed payload is **33.3 MiB**. The self-contained per-platform release assets are far larger: **≈255 MiB download / ≈1.04 GiB unpacked**, of which **≈0.9 GiB is node_modules** materialized once per component.
2. Three independent root causes explain most of the size:
   - **The console web bundle ships in dev mode** (unminified + inline sourcemap): 8.64 MiB where production mode is 1.07 MiB. The official build chain (`release-metadata.yml:443`, `bundle-plugin.mjs` console build step) invokes `npm run build --workspace=@principles/pd-console`, and `build-ui.mjs` only minifies with a `--production` flag that **no caller passes**.
   - **The `@principles/core/runtime-v2` barrel drags the full LLM SDK stack into every plugin bundle.** `src/core/event-log.ts` / `src/types/event-types.ts` import the barrel → `runtime-v2/adapter/index` → `@earendil-works/pi-ai` → anthropic/openai/@google/genai/undici/google-auth-library/aws-bedrock…. Result: `governance-audit.js` is 2.65 MiB of which only **13 KB is its own code** (79% is the LLM stack, duplicated from `bundle.js`); `rulehost-evidence.js` the same (2.70 MiB, own code 45 KB).
   - **Self-contained assets multiply shared dependencies ×6–7.** npm `--install-links` materializes a *full copy* of `@principles/core` — including core's own 111 MiB node_modules — into each consumer (mechanism: `bundle-plugin.mjs:628-630`); `better-sqlite3` (26 MiB per copy × 7 sites) ships **all 8 platform prebuilds in every platform asset**; `@earendil-works/chord` pulls **esbuild (~11 MiB/copy × 4 components) into the runtime** dependency tree.
3. Highest-priority, lowest-risk levers: build console with `--production` (−7.6 MiB payload / −1.6 MiB tar), and narrow the two satellite plugin entries' imports away from the runtime-v2 barrel (−5.0 MiB payload). Together they cut ~38% of the npm payload with no dependency removal and no bundler change.

---

## Current Size (Step 1 — rebuilt baseline)

Rebuilt today from `620d54e1` via the official chain: plugin `build:production` + `build:types`, installer `bundle-plugin.mjs` (non-self-contained), `npm pack`.

### npm installer artifact (`create-principles-disciple@1.144.1`)

| Artifact | Size (MiB, uncompressed) |
|-|-|
| plugin/dist/bundle.js | 3.96 |
| plugin/dist/governance-audit.js | 2.65 |
| plugin/dist/rulehost-evidence.js | 2.70 |
| **plugin/** (payload total, 241 files) | **9.72** |
| **core/** | **7.98** |
| **pd-cli/** | **2.11** |
| **console/** | **10.81** |
| host-runtime/ | 0.43 |
| codex-adapter/ | 0.12 |
| install-layout/ | 0.01 |
| release-manager/ | 1.08 |
| dist/ (installer's own) | 1.08 |
| trust/ | ~0.00 |
| **total payload (files field)** | **33.34** |
| **npm tarball (gzip)** | **7.34** (7,699,504 B) |

Sanity check against the live registry: `principles-disciple@2.0.2` tarball contains bundle.js = 4,143,683 B vs local 4,149,016 B (0.13% drift from version stamping) — the rebuild faithfully reproduces the shipped composition.

### Self-contained platform release asset (`pd-assets`, win32-x64 abi137 sample)

| Slice | Size |
|-|-|
| tarball (gzip, download size) | 255.5 MiB |
| unpacked total | ≈1,058 MiB |
| node_modules (all components, incl. nested) | ≈985 MiB (≈93%) |
| `_release/manifest.json` (single file) | 29.3 MiB |

Per-component unpacked: plugin 250.9 · console 234.1 · pd-cli 142.5 · codex-adapter 129.9 · host-runtime 129.8 · core 129.3 · release-manager 12.3 MiB.

---

## Bundle Composition (Step 2 — esbuild metafile, top 20 by bytes-in-output)

Measured with a temporary out-of-tree esbuild run replicating the exact production options (metafile JSON; no repo file touched). Numbers are minified bytes contributed to `dist/bundle.js` (total 4,149,016 B).

| # | Module | Bytes | % |
|-|-|-|-|
| 1 | npm:@earendil-works/pi-ai | 854,325 | 20.6% |
| 2 | npm:undici | 528,475 | 12.7% |
| 3 | npm:@google/genai | 284,586 | 6.9% |
| 4 | npm:@anthropic-ai/sdk | 209,651 | 5.1% |
| 5 | npm:openai | 139,688 | 3.4% |
| 6 | npm:yaml | 115,884 | 2.8% |
| 7 | npm:@sinclair/typebox | 107,914 | 2.6% |
| 8 | npm:google-auth-library | 103,258 | 2.5% |
| 9 | npm:@earendil-works/pi-agent-core | 98,721 | 2.4% |
| 10 | npm:typebox | 81,770 | 2.0% |
| 11 | npm:web-streams-polyfill | 61,474 | 1.5% |
| 12 | npm:js-yaml | 57,621 | 1.4% |
| 13 | core runtime-v2/internalization/evaluator-runner.js | 48,795 | 1.2% |
| 14 | npm:ws | 47,186 | 1.1% |
| 15 | src/core/trajectory.ts | 34,727 | 0.8% |
| 16 | core runtime-v2/internalization/rollout-reviewer-runner.js | 33,736 | 0.8% |
| 17 | npm:node-fetch | 24,564 | 0.6% |
| 18 | core runtime-v2/activation/sqlite-activation-safety-store.js | 24,057 | 0.6% |
| 19 | core runtime-v2/store/sqlite-connection.js | 23,421 | 0.6% |
| 20 | src/index.ts | 22,209 | 0.5% |

Category roll-up (minified bytes in output):

| Output | Total | npm deps | of which LLM stack¹ | embedded @principles/core | plugin own src |
|-|-|-|-|-|-|
| bundle.js | 4,149,016 | 2,835,561 (68%) | 2,341,493 (56%) | 884,063 (21%) | 426,905 (10%) |
| governance-audit.js | 2,783,013 | 2,641,842 (95%) | 2,186,222 (79%) | 125,598 (4.5%) | **13,413 (0.5%)** |
| rulehost-evidence.js | 2,826,401 | 2,641,856 (93%) | 2,186,234 (77%) | 137,549 (4.9%) | 44,831 (1.6%) |

¹ LLM stack = pi-ai, pi-agent-core, undici, @google/genai, @anthropic-ai/sdk, openai, google-auth-library, gaxios, bignumber.js, node-fetch, web-streams-polyfill (+ aws/protobufjs transitive).

**Import chain (verified via metafile `inputs.imports`):** `src/core/event-log.ts` and `src/types/event-types.ts` → `../principles-core/dist/runtime-v2/index.js` (barrel) → `runtime-v2/adapter/index.js` → `@earendil-works/pi-ai` (and through it every provider SDK). No source-map files are emitted in production (fine); the bloat is dependency breadth, not maps, in the plugin bundles.

---

## Duplication Findings (Step 3)

| # | Duplication | Evidence | Magnitude |
|-|-|-|-|
| D1 | LLM SDK stack bundled **3×** inside the plugin payload (bundle.js + governance-audit + rulehost-evidence) | metafile category roll-up above; gov/rulehost own code is 13–45 KB | ~4.4 MiB redundant per payload copy |
| D2 | Same plugin bundles ship a 3rd copy of ~all core code that also exists standalone as `core/` | `bundle-plugin.mjs` copies `openclaw-plugin/dist` **and** `principles-core/dist` | by design (OpenClaw self-containment), but multiplies in assets |
| D3 | Two YAML libraries bundled together: `yaml` (115,884 B) + `js-yaml` (57,621 B) | metafile top-20; both reachable through core/pi-ai graph | ~170 KB |
| D4 | Two TypeBox packages bundled: `@sinclair/typebox` + `typebox` (both declared in core deps) | core package.json deps; metafile #7/#10 | ~190 KB |
| D5 | `@principles/core` materialized **6×** in a self-contained asset (standalone + in 5 component node_modules); the plugin's copy embeds core's **entire 111 MiB node_modules** (nested re-copy) | asset listing: plugin/node_modules/@principles/core = 129.3 MiB; mechanism `bundle-plugin.mjs:628-630` | ~201 MiB total core bytes per asset |
| D6 | `better-sqlite3` × 7 sites, each carrying **all 8 platform prebuilds** (only the asset's own platform is loadable) | 26 MiB/copy; prebuilds `.node` ×8 per site; win32 asset contains darwin/linux/arm64 binaries | ~156 MiB per asset, ~137 MiB unreachable code |
| D7 | `esbuild` runtime binary (pulled by `@earendil-works/chord`, a pi-ai transitive) × 4 components | release-lock: `esbuild required by: ['node_modules/@earendil-works/chord']` | ~45 MiB per asset |
| D8 | Installer's own `dist/` fully re-shipped as the `release-manager/` component | both are 1.08 MiB, identical largest files (`installer.js` 171 KB…) | ~1.0 MiB per tarball |
| D9 | `console/dist/ui/**` (1.22 MiB tsc output) has no consumer: server code contains zero `../ui/` imports; browser loads `dist/web/app.js` only | grep over `dist/server` (0 hits) | 1.22 MiB per payload |
| D10 | Console UI npm deps (lucide-react 33.4 MiB, react-dom, @earendil-works/chord 12.1 MiB, lightningcss 9.1 MiB…) vendored into console node_modules although the UI is pre-bundled | asset per-component node_modules table | ~60 MiB per asset (verify before removal) |

Also minor: plugin payload ships `templates/` twice (top-level and inside `dist/templates`, 0.09 MiB each) because esbuild copies statics into `dist/` and `bundle-plugin.mjs` then copies both.

---

## Historical Comparison (Step 5)

`dist/` is gitignored, so the timeline is built from npm-registry tarballs of `principles-disciple` (340 versions sampled, 14 pulled) plus git archaeology:

| Plugin version | bundle.js | gov-audit.js | tarball | Event |
|-|-|-|-|-|
| ≤1.182.0 | absent | absent | 0.42 MiB | pre-bundler layout |
| **1.197.14** | **5.03 MiB** | — | 1.14 MiB | **first esbuild bundle, unminified** (esbuild.config.js introduced 2026-03-10 `9bcc1bcef`) |
| 1.209.1 | 4.46 MiB | — | 1.17 MiB | feature growth |
| **1.222.5** | 3.25 MiB | **2.00 MiB** | 1.77 MiB | **`--production` minify lands (2026-07, `5744cd2bd`)**; second entry `governance-audit` starts duplicating the barrel-pulled LLM stack |
| 1.239.0 | 3.79 MiB | 2.51 MiB | 2.25 MiB | growth resumes |
| 2.0.0 | 3.94 MiB | 2.65 MiB | 2.36 MiB | **`rulehost-evidence` third entry added 2026-08-26 (`8eefee1e1`, ERR-090)**; **pi-ai migration 2026-08-29 (`0fdedd2e7`)** |
| 2.0.2 (current) | 3.95 MiB | 2.65 MiB | 2.36 MiB | **undici dedicated transport 2026-09-05 (`f09f11537`)** adds +0.53 MiB ×3 bundles |

Reading: the 2026-07 minify fix removed 27%; everything after that (Aug 25 → Sep) added ~22% back, driven by the multi-entry barrel problem (D1), the pi-ai provider expansion, and undici. The 5 MiB "growth" since 1.197 is therefore mostly *solved once by minify and re-imported by duplication*.

Self-contained assets first appear as a release concept 2026-08-25 (`59f57ee00` "deliver self-contained runtime assets") — the ×6 node_modules multiplication is a design property of that mechanism, not a regression from a specific dependency bump.

---

## Optimization Candidates (prioritized)

### P1 — Build the console web UI in production mode
| | |
|-|-|
| Evidence | `build-ui.mjs` supports `--production` (minify + no sourcemap) but no caller passes it: neither `bundle-plugin.mjs` console step nor `release-metadata.yml:443`. Measured: dev app.js **9,061,589 B (gz 1,962,839)** vs prod **1,125,290 B (gz 301,576)** |
| Expected saving | npm payload −7.6 MiB (−23%); tarball −1.6 MiB (−22%); assets −7.6 MiB |
| Risk | **Low.** React `NODE_ENV` flips to production (define already wired); needs the flag threaded through the two call sites + smoke/e2e console verification. UI behavior change: dev-mode React warnings disappear (desirable) |

### P2 — Stop the runtime-v2 barrel from entering `governance-audit.js` / `rulehost-evidence.js`
| | |
|-|-|
| Evidence | metafile: gov-audit is 79% LLM SDK with 13 KB own code; chain `src/core/event-log.ts → runtime-v2/index.js barrel → adapter → pi-ai`. Both satellites are consumed by pd-cli/console (which have core in node_modules); their logic (event-log write / evidence) needs only specific core submodules |
| Expected saving | plugin payload −5.0 MiB (bundles shrink ~2.7 → ~0.4 MiB each if tree-shaking cooperates); also −5 MiB in every asset; removes LLM SDK from two more resolution graphs |
| Risk | **Low–medium.** Pure import-path narrowing in plugin src (no bundler/deps change). Must verify the remaining graph still tree-shakes (esbuild can't shake through barrel side-effects) and run the plugin parity tests. `bundle.js` itself keeps the LLM stack (its own hooks reference pi-ai types via `correction-observer-service` — genuine use) |

### P3 — De-duplicate self-contained platform assets
| | |
|-|-|
| Evidence | D5/D6/D7: one core copy nests another's 111 MiB node_modules (`bundle-plugin.mjs:628-630` + `--install-links`); each of 7 sqlite copies carries 8 platform binaries; chord→esbuild puts ~45 MiB of build tooling into runtime |
| Expected saving | asset unpacked ≈1,058 → 350–450 MiB (prune foreign prebuilds −137 MiB; single shared dependency store / hoist instead of ×6 materialization −~450 MiB; esbuild −45 MiB via upstream or lock exclusion) — 255 MiB download could reach ~80–120 MiB |
| Risk | **High — this is release-architecture work, not a flag.** Shared node_modules changes the install/upgrade transaction and the reproducibility gate (compare-release-archives / digests in `_release/manifest.json`); platform-prebuild pruning needs per-platform lock handling. Recommend a dedicated SPEC (Phase 2) before touching. Upstream esbuild question (D7) can be filed against `@earendil-works/chord` independently |

### P4 — Drop `.map` / `.d.ts` from installed payload components
| | |
|-|-|
| Evidence | core: 2.44 MiB `.map` + 2.50 MiB `.d.ts`; pd-cli 0.86 `.map`; installer dist + release-manager 0.41 each. The installed runtime is plain node ESM; declarations matter only at compile time, which happens in the repo, not on user machines |
| Expected saving | npm payload −5.7 MiB (−17%); assets −~12 MiB |
| Risk | **Medium.** Several guards assert artifact presence (`check-dist-hygiene`, parity gates list `.d.ts` export targets, e.g. ERR-090 history). Requires an inventory of which gates inspect the *payload* vs the *source dist*, and a payload filter distinct from the build output. Also loses user-side stack-map readability — decide deliberately |

### P5 — Exclude `console/dist/ui/` from the console payload
| | |
|-|-|
| Evidence | D9: 1.22 MiB tsc-compiled UI modules; zero importers in `dist/server`; browser path uses `dist/web/app.js` |
| Expected saving | −1.22 MiB payload; assets −1.2 MiB |
| Risk | **Low** once CONSOLE_REQUIRED is adjusted, but verify the console server truly has no dynamic `../ui/` reference (grep found none) and that update-flow e2e still passes |

### P6 — Ship only the update seam in `release-manager/`, not the installer's whole `dist/`
| | |
|-|-|
| Evidence | D8: `CREATE_PRINCIPLES_DISCIPLE_REQUIRED` lists the two `dist/update/*` entries **plus** the whole `dist` dir (installer.js 171 KB, uninstaller, maps…) |
| Expected saving | −0.9 MiB payload |
| Risk | **Medium-low**: must confirm which modules the console's `update-console` seam actually resolves at runtime (comments say the authority graph stays inside `dist/update/*`) and keep the parity gate honest |

### Not worth doing alone
- D3/D4 (`yaml` vs `js-yaml`, dual typebox): ~360 KB total; only falls out naturally if core consolidates YAML usage — follow-up candidate, not Phase 1.
- `templates` double copy: 90 KB.

### Recommended order
**P1 → P2** (both small, no boundary change, −12.6 MiB ≈ 38% of npm payload), then **P5/P6** (payload filters, small), then **P4** (needs gate inventory), with **P3 as its own SPEC** (biggest absolute win — ~200 MiB download — but it changes the release transaction and must go through Owner approval and reproducibility re-baselining).

---

## Not Included

Explicitly out of scope for this phase (per mission constraints):

- **No implementation** — nothing in build config, bundler, installer scripts, package manifests or dependencies was modified; the only writes were gitignored build outputs (`packages/*/dist`, installer payload dirs), a temp metafile script under `D:/tmp`, and this report.
- **No dependency removal** and no externalization decision — candidate classifications below are inputs for a later decision, not actions taken.
- No changes to the ERR/RAH hygiene gates (RAH-1/2/3 remain intact; this audit builds on them).
- No PR was created.

### Candidate classification (Step 4, for the decision phase)

| Class | Items |
|-|-|
| **A. Must inline** (runtime requirement) | plugin's own `src/**`; `@principles/core` code inside `bundle.js` (OpenClaw loads a single setupEntry without installed node_modules on ClawHub path — the reason esbuild exists); `better-sqlite3` stays `external` (native, already correct); LLM stack **in bundle.js specifically** (hooks use pi-ai) |
| **B. Can be removed / externalized** | LLM stack in governance-audit/rulehost-evidence (P2 — via import narrowing, no external config); console dev-mode app.js (P1); `console/dist/ui` (P5); `.map`/`.d.ts` in payload (P4, needs gate inventory); foreign-platform sqlite prebuilds, esbuild (chord), console UI-only deps in assets (P3) |
| **C. Don't touch (for now)** | `bundle.js` self-containment contract (single-file OpenClaw load + setupEntry verification in `bundle-plugin.mjs:815`); release-locks reproducibility machinery; `--install-links` materialization until P3 has a designed replacement; `_release/manifest.json` digests |

---

## Reproduction notes

```bash
npm run build:production --workspace=principles-disciple
npm run build:types --workspace=principles-disciple        # console tsc needs plugin .d.ts
node packages/create-principles-disciple/scripts/bundle-plugin.mjs
cd packages/create-principles-disciple && npm pack --ignore-scripts
# bundle composition: temp esbuild run with metafile (script not kept in repo)
# asset composition: gh release download pd-assets (one platform) + `tar -tzvf` aggregation
```

Baseline drift note: local rebuild vs published 2.0.2 bundle.js differs by 5,333 B (version stamping + commit delta since 2026-09-22); all conclusions are byte-share level, unaffected.
