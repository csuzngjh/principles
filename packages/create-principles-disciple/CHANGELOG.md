# create-principles-disciple

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
