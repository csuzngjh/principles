# Release Asset Deduplication — Feasibility Audit (Phase 0)

> Mission: Self-contained Installer Asset Architecture Audit — read-only assessment of whether
> the duplicated node_modules / runtime assets in the installer's self-contained payload are
> worth deduplicating, and at what risk.
> Date: 2026-09-23 · Base commit: `d743b303` (2.0.4 version merge) · Predecessor: `artifact-size-audit.md`
> (its D5/D6/D7 findings and the 255 MiB / 1.04 GiB / ≈93% baseline motivated this audit).
> Method: byte-measured inventory of the **live installed runtime** (`~/.pd/runtime`, read-only),
> the committed asset-assembly and installer source, and the release-lock/manifest/rollback contracts.
> **No implementation, no architecture change**: installer, package.json, lockfiles, build scripts,
> bundle logic and dependency layout were not modified; nothing under an installer-owned path was written.

---

## Executive Summary

1. **The duplication is real and large, and it is mechanical, not organic.** The installed runtime
   holds 1,112.3 MiB across 9 components, of which 1,035.2 MiB (93%) is per-component
   `node_modules`. 222 package names appear in ≥2 components; naive redundancy (keep one copy,
   delete the rest) is **656.4 MiB — 59% of the installed footprint**. 220 of the 222 duplicated
   packages are at *identical versions* everywhere (only `commander` and `retry` differ).
2. **Root cause is one build-time rewrite plus one deploy-time bypass.** `bundle-plugin.mjs` rewrites
   every `@principles/*` dependency to a `file:../<component>` ref and then runs
   `npm ci --install-links` per component (`bundle-plugin.mjs:507-557, 588`). npm materializes each
   sibling **and hoists its whole third-party graph into every consumer** — the LLM stack
   (pi-ai → genai/openai/anthropic/aws/google, ≈350 MiB wasted) exists 6× even though **only
   `@principles/core` declares it**. At deploy time the installer *has* canonical symlink logic
   (`syncPdCli`, installer.ts:2031-2096) but creates each link only `if (!existsSync(link))` —
   the materialized copies always exist, so the links never fire, except in codex-adapter where
   `ensureCodexAdapterResolution` (PRI-711, installer.ts:2384-2439) explicitly **replaces stale
   physical copies with symlinks**. That mechanism is the audit's key finding: it already works,
   in production, for one component.
3. **Worth implementing — yes, in stages.** ≈188 MiB of intra-PD duplication (`@principles/core`
   ×4 incl. a full 130.6 MiB nested copy inside `plugin`, `principles-disciple` ×2) can be reclaimed
   by *extending the existing symlink pass* — no dependency-layer redesign. ≈350-390 MiB more
   (third-party hoisted graph + build-tooling payloads) requires the Option B shared layer, which
   is genuine release-architecture work: it changes the per-file asset manifest, the release-locks
   SSoT, and the reproducibility baseline. Option C (externalize deps to the user's npm) is
   rejected: it regresses the offline/platform-binary/isolation design goals that created
   self-contained assets (`59f57ee00`, 2026-08-25).

---

## 1. Current Payload Model (Q1)

### 1.1 Two artifacts, one topology

- **Self-contained platform asset** (download): ≈255.5 MiB tar.gz / ≈1,058 MiB unpacked per
  platform+arch+nodeAbi triple (predecessor audit; unchanged since — no dependency-layout commit
  landed after `620d54e1`).
- **Installed runtime** (`~/.pd/runtime`, measured here byte-exact via directory walk, symlinks
  not followed): **1,112.3 MiB total** — same topology plus bin shims. The two numbers corroborate
  each other; all figures below are from the live install (ground truth for what resolution really does).

### 1.2 Per-component breakdown (MiB, this machine: win32-x64, cohort `bundled-2.1.0-69115f70496e`)

| Component | Total | node_modules | nm share | Largest packages (depth-1 in its node_modules) |
|-|-|-|-|-|
| plugin | 284.0 | 242.3 | 85% | **@principles/core 130.6 (nested full copy)** · better-sqlite3 26.0 · @google/genai 13.7 · chord 12.1 · openai 9.3 |
| console | 267.3 | 256.0 | 96% | principles-disciple 41.6 · lucide-react 33.4 · better-sqlite3 26.0 · @principles/core 19.2 · genai 13.7 |
| host-runtime | 131.1 | 130.5 | 99.5% | better-sqlite3 26.0 · @principles/core 19.2 · genai 13.7 · @esbuild/win32-x64 11.1 · openai 9.3 |
| pd-cli | 175.4 | 172.9 | 99% | principles-disciple 41.5 · better-sqlite3 26.0 · @principles/core 19.2 · genai 13.7 · esbuild 11.1 |
| core | 130.6 | 111.2 | 85% | better-sqlite3 26.0 · genai 13.7 · esbuild 11.1 · openai 9.3 · web-streams-polyfill 8.6 |
| codex-adapter | 111.5 | 111.2 | 99.7% | better-sqlite3 26.0 · genai 13.7 · esbuild 11.1 · openai 9.3 · anthropic 8.3 |
| release-manager | 12.4 | 11.1 | 89% | tar 2.2 · js-yaml 1.5 (tuf chain only — clean) |
| bin, install-layout | ~0 | 0 | — | shims / zero-dep |

`node_modules` total: **1,035.2 MiB (93%)**; 993 real package dirs vs **3 symlinks** — the only
links in the whole tree are codex-adapter's `@principles/{core,host-runtime,install-layout}`.

### 1.3 Where the bytes come from (declared vs materialized)

Only `core` declares the LLM stack (`pi-ai`, `pi-agent-core`, `undici`, typeboxes);
`plugin`/`pd-cli`/`console`/`host-runtime`/`codex-adapter` declare `@principles/*` file-refs +
`better-sqlite3`/`js-yaml`/`commander`. Everything else in those five `node_modules` trees is the
**transitive graph of `core`, hoisted per consumer by `--install-links` materialization** — or the
graph of `principles-disciple`, re-hoisted (console and pd-cli each carry a 41 MiB plugin copy with
its own nested core). Console additionally carries its **UI build chain** (lucide-react 33.4,
tailwind/vite/radix) as `dependencies`; the UI is pre-bundled into `dist/web/app.js` at build time.

---

## 2. Duplicate Dependency Map (Q2)

Naive waste = total copies minus the largest copy (what sharing would reclaim if each package kept
one live instance). Sum over all 222 duplicated packages: **656.4 MiB**.

| Package | Duplicate count | Waste | Reason | Safe to deduplicate |
|-|-|-|-|-|
| better-sqlite3 | 6× (v13.0.3 all) | 130.2 MiB | **A** — declared directly by 5 components; each needs its own resolution point today. (×5 of these copies also carry 8 platform prebuilds — see §6) | **C after B** — shareable via runtime-level hoisted layer; same ABI guaranteed by the per-ABI asset identity (§5) |
| @google/genai | 6× (1.52.0) | 68.7 MiB | **B** — transitive of pi-ai, which only core declares; 5 copies exist purely because core was materialized per component | **C** — one copy under core's resolution scope suffices |
| @principles/core | 4× + canonical (1.287.1) | 57.7 MiB naive; **188.3 MiB true** (the plugin copy is the *entire* core component incl. its 111 MiB node_modules, `bundle-plugin.mjs:628-630`) | **B** — historical mechanism: `file:../core` + `--install-links` + `!existsSync` symlink bypass | **C now** — canonical `runtime/core` exists; `ensureCodexAdapterResolution` proves the symlink replacement works |
| openai | 6× (6.40.0) | 46.5 | B (same chain as genai) | C |
| web-streams-polyfill | 6× (3.3.3) | 43.1 | B (transitive of openai/genai) | C |
| @anthropic-ai/sdk | 6× (0.123.0) | 41.6 | B | C |
| principles-disciple (plugin) | 2× (console, pd-cli) | 41.5 | B — same materialization; canonical `runtime/plugin` exists | C now (symlink) |
| @esbuild/win32-x64 (+ esbuild js) | 4× (0.28.1) | 33.4 | B — build tooling dragged into *runtime* by pi-agent-core→chord→esbuild@0.28.1 (prod dep of chord, verified in installed manifests) | C (shared) / B (prune: nothing in the runtime calls esbuild; upstream question for chord) |
| @earendil-works/pi-ai | 6× (0.85.1) | 27.4 | B | C |
| @earendil-works/pi-agent-core | 6× | 24.3 | B | C |
| @earendil-works/chord | 6× | 15.6 | B | C |
| protobufjs | 6× | 14.6 | B | C |
| @types/node | 6× (26.5.1) | 12.1 | B — reached via `protobufjs` (legit prod dep `>=13.7.0`) and `@types/better-sqlite3` (a type package in a runtime tree); the *copies* are shareable, the *presence* is mostly upstream-declared | C (share); pruning only via upstream changes |
| @sinclair/typebox, typebox, js-yaml(7×), undici, smithy/aws-sdk/google chains, yaml, diff, tar, gaxios… | 6-7× | ≈80 combined | B (transitive tail) | C |
| **Version skew across copies** | — | — | only `commander` (v12/v14) and `retry` differ | forces the shared layer to carry the union or resolve — small, but it proves naive global hoist is **not** automatically safe |

Class tally: **A (design-required)**: better-sqlite3's per-component entry points (and even those
collapse under a shared layer). **B (historical residue of the `file:` + `--install-links`
mechanism, plus build-time-only payloads in runtime)**: ~350-390 MiB. **C (safely shareable once
linked)**: the rest, contingent on §5's ABI/uniformity evidence.

**Do not read the classes as "delete now."** Every C row is shareable *through a designed
resolution topology* (Option B), not by deleting a component's copy — Node's upward resolution
would then find nothing (there is no runtime-level `node_modules` today; only the 3 codex-adapter
links point at canonical dirs).

---

## 3. Installation Contract (Q3)

What the install actually depends on — each is a constraint on any dedup design:

1. **Relative node resolution + junction symlinks.** Each component resolves its deps from its own
   `node_modules` upward; cross-component refs (`file:../core` etc.) resolve via installer-created
   links — `symlinkSync(..., 'junction')` on Windows, relative dir links on Unix (installer.ts:2035-2096,
   2267-2288). Under ESM realpath semantics the link must point at the canonical component dir
   (PRI-711 comment: missing links = `ERR_MODULE_NOT_FOUND` on every `pd` command; stale physical
   copies are *detected and replaced* — `ensureCodexAdapterResolution`). The `!existsSync` bypass in
   `syncPdCli` is the only reason the other components still carry physical copies.
2. **Package boundary = component manifest.** Payload components keep real `package.json`s with the
   rewritten `file:` refs; the parity gates and `preflightSelfContainedReleaseAsset`'s
   `prepareBundledComponentDependencies` validate that every bundled component's deps are present.
3. **Manifest digest = per-file content addressing.** `_release/manifest.json` records
   `{path, sha256, size}` for **every file** of the asset (installer excludes depth-0 `node_modules`
   of the installer package itself only); `verifyReleaseAssetManifestAsync` re-hashes the full tree
   before any mutation, and **symlinks inside the asset are a hard failure** (`asset_path_unsafe`,
   release-asset-manifest.ts:73-76). The archive itself is verified against the TUF/signed
   `archiveSha256 + size` before extraction (apply-payload.ts:132-169). Consequence: *any layout
   change — including dedup — changes the manifest and the reproducibility baseline
   (`compare-release-archives`, deterministic archive), and no sharing can ship as asset symlinks;
   links must be built by the installer at deploy time* (exactly what it already does for codex-adapter).
4. **Rollback = whole-runtime backup rename-swap + host handshake.** Deployment order is
   digest preflight → backup rename-swap → component deploy → console probe → host installers →
   commit/cleanup (installer.ts:1114-1143; release-manager.ts:455). `active.json`/`previous.json` +
   journaled transactions record identity (`releaseId`, `releaseMetadataDigest`, generation); the
   rollback policy demands **all-or-nothing across components and hosts** — a split-brain component
   mix must never activate; one auto-rollback per transaction, then circuit breaker
   (rollback-policy.ts). This *helps* Option B: since the whole `~/.pd/runtime` already swaps
   atomically as one unit, a shared `runtime/node_modules` inside it rollback-swaps for free;
   `~/.pd/releases/` stores metadata only (24 KiB on disk), so keeping a prior shared layer for
   rollback would be *new* state — prefer keeping the shared layer inside the swapped tree.
5. **Version uniformity is already enforced upstream**: per-component committed release-locks
   (`release-locks/<component>/package-lock.json`, `check-release-locks` runs real `npm ci`) pin the
   shipped trees; the measured install confirms single versions for 220/222 duplicated packages.

---

## 4. Options Comparison (Q4)

| | A — keep self-contained; add duplicate detection / build-cache only | B — shared runtime dependency layer (`runtime/node_modules` + `components/*`) | C — externalize dependencies (user-side npm install) |
|-|-|-|-|
| Disk saving (installed) | ~0 (advisory report; OPT-002/003 already cut bundle bytes) | B1 (extend symlink pass, no layer): **≈188 MiB** PD-graph copies gone. B2 (full shared layer): additionally collapse the ≈350-390 MiB third-party tail → **≈540-580 MiB total**, installed runtime ≈530-570 MiB | everything B saves, plus per-install `npm ci` at build |
| Download saving | 0 | proportional (tar re-gzips shared layer once): 255 MiB → roughly 100-130 MiB (estimate, not measured) | as B |
| Install impact | none | installer gains one deterministic post-extract pass replacing materialized `@principles/*` copies with canonical links (B1 = already-written code, generalized); B2 adds a merged-lock hoist step at **build** time, deploy unchanged | install now requires registry access, node headers and build tools on the user machine; breaks the `--ignore-scripts`/prebuilds-only native story |
| Upgrade/rollback impact | none | none beyond current: shared layer lives inside the swapped runtime tree (§3.4), all-or-nothing invariant preserved; **migration for existing installs** must handle stale copies (PRI-711 replacement logic is exactly this) | two installs on one machine, partial npm failures, and plugin host resolution become new rollback surface that doesn't exist today |
| Checksum/reproducibility impact | none | asset manifest file-set changes → **must re-baseline** digests + `compare-release-archives` + publish metadata flow (one-time, mechanical); release-locks: B1 unchanged, B2 becomes one merged lock — version reconciliation (commander/retry skew) must be designed in | signed asset no longer covers the dependency bytes at all; TUF integrity guarantee effectively lost for the biggest part of the runtime — **this breaks the trust model, not just the layout** |
| Platform-binary risk | none | shared `better-sqlite3` is ABI-safe (§6); OpenClaw/Codex host isolation unchanged (plugin still self-contained as a *package*; its node_modules becomes links to canonical runtime dirs, same as the extension's `core` symlink today) | foreign-platform or ABI mismatch becomes a user-machine error class; node-gyp fallback returns |
| Plugin isolation | intact | intact — resolution still stays inside `~/.pd/runtime`; the OpenClaw extension already runs on one such symlink (`plugin/core`) | violated: ambient `node_modules` up the tree can shadow PD deps — the class of confusion AGENTS §1.1 exists to prevent |
| Risk | none | **medium-high**: cross-package contract (installer + build + gates), needs a SPEC, migration path, e2e install/update/rollback matrix per platform | **high, direction-regressing** |
| Verdict | adopt the *detection* half as a release-build guard (cheap drift alarm re-tracking what this audit found by hand); does not pay for itself as the whole answer | **recommended target**, staged B1 → B2 | rejected; revisit only if per-platform asset downloads become bandwidth-gated, which is not the current pain |

---

## 5. better-sqlite3 — Native Binary Sharing (Q5)

- **Current state:** 6 copies × 26.0 MiB. Each copy ships **8 platform prebuilds**
  (`prebuilds/{darwin-arm64,darwin-x64,linux-arm64,linux-x64,linuxmusl-arm64,linuxmusl-x64,win32-arm64,win32-x64}.node`,
  17 MiB of the 26) plus `node-addon-api`/binding inputs. On this win32-x64 runtime, **7/8 binaries
  per copy are unreachable code** — ≈90 MiB of the ≈156 MiB total is dead on every platform asset.
- **Sharing safety:** the runtime already keys the whole pipeline on the **platform+arch+nodeAbi
  triple** (`selectReleaseAsset` refuses ABI mismatch before any write; asset identity is
  re-verified). Therefore every component inside one installed runtime loads the *same* ABI:
  a single shared copy resolved via the hoisted layer is strictly safer than today's 6 copies —
  two `.node` instances loaded into one process (console server + pd-cli + host hooks can coexist
  in-process) is the latent hazard sharing removes, not adds. Windows "file in use during update"
  risk is unchanged: the whole tree rename-swaps today regardless.
- **Prune vs share:** per-platform prebuild pruning is independent of the dedup decision and
  survives every option: build each platform asset with only its own `.node` (build-time knowledge
  of `targetPlatform/targetArch` already exists in `build-self-contained-release.mjs:67-75`).
  **−125 MiB unpacked per asset with zero topology change** — the highest saving-per-risk item in
  this audit. Node-ABI variants (`abi137` etc.) stay a release-matrix axis, not an in-tree one.
- Platform variants that must keep separate copies: none within one install; across installs
  (multiple PD versions pinned to different Node majors) isolation is per `~/.pd` home, already true.

---

## 6. Recommendation

**Yes, deduplication is worth implementing — sequenced by evidence, not by ambition.**

1. **SPEC-P0 (no architecture change, do first): prune foreign better-sqlite3 prebuilds per
   platform asset** (§5). −125 MiB unpacked / est. −30-40 MiB download. Touches only the asset
   build's copy rules; manifest reproducibility re-baselines trivially.
2. **SPEC-P1 (extend existing mechanism, not a new subsystem): generalize the PRI-711 canonical-symlink
   pass to all components' materialized `@principles/*` copies** (core×3 small + core's 130.6 MiB
   plugin copy + plugin×2 + host-runtime/install-layout/codex-adapter cross-copies). −188 MiB
   installed, no third-party layout change, release-locks and asset manifest barely move
   (payload file-set changes are already covered by re-baseline). This is "connection before
   creation": the code exists and runs in production for one component.
3. **SPEC-P2 (the real Option B2): shared `runtime/node_modules` hoist layer + merged lock**,
   collapsing the ≈350-390 MiB third-party B-class tail. Gate: designed migration + full
   install/update/rollback e2e per platform + reproducibility re-baseline + the commander/retry
   skew resolution recorded in the merged lock. Only this step changes the dependency architecture
   — which is why P0/P1 must land without it.
4. **Adopt Option A's cheap half as a guard:** a release-build duplicate report (the inventory
   script logic in this audit is a working prototype) so the B-class tail cannot regrow silently —
   the same posture as the satellite-purity guard.
5. **Do not pursue Option C.** It trades a size win for a trust-model and isolation loss.
   Upstream, also file the two dependency-hygiene questions independent of layout: esbuild (build
   tool) as a *prod* dep of `@earendil-works/chord`, and `@types/node` in runtime trees.

## 7. Not Included

Per mission constraints: no implementation and no architecture change — installer, package.json,
lockfiles, build scripts, bundle logic and dependency layout were not modified; nothing was written
under `~/.pd/*` (read-only walk). Not attempted here: per-ABI multi-copy experiments on this
machine; npm-tarball (`bundled` mode) channel measurement as a separate population (its
deploy-time `npm ci` reproduces the same per-component topology — §1.1); exact re-gzip download
figures for hypothetical shared layouts (estimates flagged as such); the console UI `dependencies`
audit (lucide/tailwind chain — list it under SPEC-P2's lock work, needs a runtime-import check
first); ERR-record filing (no AI-mistake root cause belongs to this session).

### Appendix — measurement tools

- Inventory walker (kept out-of-repo, this audit's ground truth): `D:/tmp/opt4-inventory.mjs`
  → `D:/tmp/opt4-runtime-inventory.json` (per-package bytes, locations, version sets, nested flags).
- Analysis extracts: `D:/tmp/opt4-analysis{1,2,3}.txt`.
- Component manifests read from `~/.pd/runtime/*/package.json` (declared deps, §1.3).
- Source citations are at `d743b303` (2.0.4 merge base).
