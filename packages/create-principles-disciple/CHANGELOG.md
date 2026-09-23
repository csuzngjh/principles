# create-principles-disciple

## 1.144.2

### Patch Changes

- fc1c9de: OPT-001 (artifact-size audit P1): releases now ship the production console web bundle. The pd-console `build` script (used by every official path — installer bundling, release-metadata, publish action, reproducibility, CI smokes) runs the UI step as `build:ui:production` (esbuild minify, no inline sourcemap): app.js drops from 8.6 MiB to 1.1 MiB, shrinking the installer payload by ~7.6 MiB. The bundler script additionally fails loud if a dev-mode app.js (sourceMappingURL marker) ever reaches the payload again. Local dev and console e2e keep using `build:ui` (dev) unchanged.
- c7453ea: PR #1844 follow-up: the Governance Focus prompt-injection forecast and the PRI-890 approve-time budget check now read `buildLivePromptInjectionProjection` (host-runtime), which follows the SAME injection route the agent uses — with `abstraction_layer_v1` off (the live default) the forecast replays the plugin's PromptActivationReader → trimToBudget chain instead of always rendering with the shared-path directive wrapper. Previously a saturated 2000-char budget was over-forecast (~3/11 principles "injected" vs the real 9/11), so the Focus page badge and approve warnings overstated budget pressure. Principle selection, FIFO ordering, injection behavior and the budget algorithm are unchanged; parity and boundary regression tests pin the projection to the live path.
- 38b86f6: PRI-889: Governance Focus now renders the existing PendingReviewCard (Wave 7 component with approve/reject/revise actions) for pending approval groups, giving Owners their first clickable activation-approval path in the browser. When grouped approvals data is available, activation_approval entries skip the legacy OwnerDecisionCard (its only affordance was a dead CTA); when unavailable, all entries keep rendering so decisions never silently disappear. The card honors the PRI-787 governance-readiness lock with a visible reason.
- 5fc33bd: PRI-890: approve now recomputes the production prompt injection projection (same FIFO + 2000-char budget logic the prompt hook uses) and surfaces a non-fatal warning when the freshly approved prompt-channel activation lands outside the budget — previously the approval silently never reached agent behavior when the budget was saturated (PRI-768 v6-02). Non-budget exclusions (artifact resolution failures) are reported with their own reason code, and the Governance Focus approve flow shows the warning toast so the Owner sees it at decision time.
- 84c7074: PRI-892: fixed the silent no-op of `npx create-principles-disciple` on Windows. Node resolves the main module through symlinks/junctions while `process.argv[1]` keeps the unresolved link path handed over by npm/npx `.bin` shims, so the raw `pathToFileURL(argv[1]) === import.meta.url` entry guard never matched and the CLI exited 0 with zero output (install / repair-update-chain / uninstall all dead). The guard now canonicalizes argv[1] with `realpathSync` before comparing (fail-safe: an unreadable entry is simply not the main module), keeps the cli-7 import-safety semantics (importing the module still never parses argv), and adds an rc-9 observable fallback: when the entry path unambiguously names this package's `dist/index.js` but canonicalization still misses, the CLI warns on stderr instead of saying nothing. The identical guard in the Codex `pd-hook` entry is fixed the same way (linked installs previously skipped `main()` silently). Regression tests spawn the built CLI and hook through a junction path and assert real output (red before the fix: empty stdout, exit 0).
- edaae75: Fix PRI-898: the global `pd` command is no longer gated on the npm-distributed payload mode, and the Windows shim set now reaches every shell.
  
  - Decoupling: self-contained release-asset installs (the recommended channel) now write the global `pd` shim into the PATH-managed npm global bin dir, so the host agent finds `pd` without manual PATH edits.
  - Windows coverage: in addition to `pd.cmd` (cmd) and `pd.ps1` (PowerShell), the installer writes an extensionless `pd` sh shim — Git Bash/MSYS does not apply PATHEXT, so a bare `pd` only resolves to that exact-named file. Without it a Git Bash host got command-not-found even with the `.cmd` on PATH.
  - Shim path quoting: the sh forwarding shim embeds its target path in POSIX single quotes, so an install directory containing spaces, `$`, backticks or an apostrophe resolves literally instead of being expanded or breaking out of the quote (the previous double-quote form only escaped `"`).
  
  Foreign-`pd` protection, rollback bookkeeping, the uninstaller scan (now also cleaning the extensionless `pd` on Windows), and the `PD_SKIP_GLOBAL_SHIM` smoke gate are unchanged; the pd-cli upgrade / dependency-resolution payload-mode gates stay where they belong.
- edbbcd9: RAH-3 (PRI-907): complete the release-artifact content boundary. @principles/install-layout and principles-disciple (openclaw-plugin) production builds now exclude compiled tests (tsconfig.build.json; plugin build:types declaration emit filtered too) with the same fail-loud dist hygiene assertion as RAH-1. The installer bundle script (create-principles-disciple) filters compiled test artifacts out of every payload copy AND asserts zero test artifacts across all payload components after materialization — test code can no longer reach user machines even if a future package forgets its build-boundary guard. A repo-level scan (check:workspace-artifacts, wired into verify:merge) backstops all workspace dist trees.
- 8b7b775: Security audit run-1 remediation (findings verified against eabbde6d, applied on ccc69252):
  
  - **RuleCode enforcement is now content-bound** (audit HIGH `rulecode-approval-content-unbound`): the production gate and the OpenClaw plugin RuleHost re-verify the current `pi_artifacts` row against the `activation_decisions.artifact_digest` recorded at Owner promotion time before compiling it. A workspace-local rewrite of `content_json` (or lineage fields) is now skipped with a structured `artifact_content_tampered` warning instead of silently executing unapproved code. Rows without a recorded decision (legacy activations) keep their prior behavior. Adds `mapPiArtifactRow`/`PiArtifactRow` exports (the single `pi_artifacts` row→snapshot mapping) so enforcement reproduces the promotion-time digest byte-for-byte.
  - **Replay evaluate is hard-bounded** (audit MEDIUM `rulecode.replay.in-process-evaluate-no-hard-timeout`): pre-activation replay runs each evaluate call through a precompiled vm script with a 2000ms hard timeout — a looping LLM-authored candidate now fails its replay case instead of hanging the console server, evaluator worker, or CLI process.
  - **Governance-store unavailability leaves a durable trace** (audit MEDIUM `gate-failopen-allow-on-state-corruption`): when `state.db` is missing or unreadable, the gate/plugin record a best-effort marker under `~/.pd/enforcement-health/` (outside the agent-writable workspace), and the console governance read model distinguishes "state.db deleted after initialization — enforcement degraded (fail-open)" from a never-initialized workspace.
  - **Console refuses unauthenticated non-loopback binds** (audit MEDIUM `pd-console-noauth-nonloopback-bind`): the loopback-only invariant now keys on the effective authentication state (token-less default included), not just the explicit `--no-auth` flag.
  - **Plugin honors an explicit conversation-access opt-out** (audit LOW `openclaw-plugin:conversation-access-autofix-overrides-explicit-owner-opt-out`): the auto-fix repairs only an absent `allowConversationAccess` flag; an explicit `false` (the documented turn-off) is preserved and surfaced as an honored Owner opt-out instead of being silently rewritten on every gateway start.
- Updated dependencies [edbbcd9]
  - @principles/install-layout@0.2.7

## 1.144.1

### Patch Changes

- 0d39045: chore(deps-dev): bump @types/node 26.5.1 -> 26.6.1 in create-principles-disciple.
- 6b05c87: chore(deps): bump @radix-ui/react-slot 1.3.0 -> 1.3.3 (pd-console, ships inside installer).
- 78a3564: chore(deps): bump js-yaml 5.4.1 -> 5.4.2 in create-principles-disciple (runtime dependency).
- 3587170: chore(deps): bump @radix-ui/react-dialog 1.1.15 -> 1.1.23 (pd-console, ships inside installer).
- 7f5558b: chore(deps-dev): bump vitest 5.0.0 -> 5.0.1 in create-principles-disciple.
- 76ed7d0: chore(deps): bump react/react-dom/@types to 19.3.0 (pd-console, ships inside installer). 单独 bump react-dom 会使 react<->react-dom 版本错配导致 Console 白屏（e2e useMemo of null），故本 PR 配对升级 react 与 @types/react.

## 1.144.0

### Minor Changes

- 8424d60: Baseline-cutover accounting for the unpublished source delta between the registry baseline (1.143.3, published from fb397452) and current main: the update-chain rework landed by PR #1768 (bootstrap executor, transaction journal, release-manager authority, dual-ABI payload application, embedded product identity stamp, public exports) plus the pd-console payload changes it ships (owner-decision UI and console surface updates). The version alignment to 1.143.3 is a starting point, not a claim this content shipped.

### Patch Changes

- 40de641: Owner-facing console fixes carried by PR #1789 (focus CTA deep-links), which merged after the Changesets cutover and was not yet in release accounting. The pd-console payload bundled by the installer now: deep-links owner-decision and grouped-approval CTAs to the specific Principle record instead of the generic review list (activation_approval inbox items carry a resolved `principleId`; on resolution failure they fall back to the prior un-deep-linked behavior, rc-9); re-applies the ledger-validation contract that was silently dropped when the shared artifact→principleId resolver was extracted (ERR-142); and escapes externally-supplied values interpolated into CSS deep-link selectors to close a selector-injection path (ERR-143). Installer bundle content is new, so the installer needs a release.

## 1.10.0

### Minor Changes

- 650ae5a: ## v1.9.1: WebUI Data Source Fixes

  ### Phase 16-20 Complete

  - **Phase 16**: Data Source Tracing - mapped all 4 WebUI pages to API endpoints
  - **Phase 17**: Overview Page Fix - fixed `/api/central/overview`, `/api/overview`, `/api/overview/health`
  - **Phase 18**: Loop/Samples + Feedback Fix - fixed `/api/samples`, `/api/feedback/*` data sources
  - **Phase 19**: Gate Monitor Frontend - fixed `/api/gate/stats`, `/api/gate/blocks` types
  - **Phase 20**: E2E Validation - 19 regression tests added for all API endpoints

  ### Bug Fixes

  - Fixed `evolution-worker.ts` missing `runtimeAdapter` parameter
  - Fixed `nocturnal-train.ts` mode field type annotation
  - Fixed `sync-version.sh` to include `create-principles-disciple` package

  ### Infrastructure

  - Added `@changesets/cli` for monorepo version management
  - Added `data-endpoints-regression.test.ts` with 19 tests
