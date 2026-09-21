# create-principles-disciple

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
