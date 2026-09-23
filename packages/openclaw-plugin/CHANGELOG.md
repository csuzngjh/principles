# principles-disciple

## 2.0.3

### Patch Changes

- df43600: PRI-899: effect receipts now carry the activation that produced them, so behavior evidence JOINs back to its activation. The `principle_applications.activation_id` column, the optional `recordPrincipleApplication` input and the presence-path propagation all already existed — every EFFECT write point simply passed nothing, leaving 93/93 effect rows NULL and `JOIN activations` at 0. The legacy hook path now passes `report.liveDecisionActivationId` for `rule_blocked` and `auto_correct_applied` (that value was already in scope and already consumed by the `rulehost_evaluated` event); the shared-gate deny path recovers the same fact from the `metadata.evaluations` live entry and threads it through `accountSharedDeny`; and the prompt-channel `self_reported` row resolves the reported principle to the activation carried alongside it, reusing the single pairing derivation that already fed the presence receipt. Unattributable decisions — no winner, shadow-only, or absent metadata — still write an UNLINKED receipt exactly as before, so lineage is never fabricated and shadow activation ids are never promoted to live.
  
  PRI-900: adds an experiment-level Behavior Signature declaration (`docs/experiments/pri-836/behavior-signature.json`) that reuses a principle artifact's `IntentContractV1` verbatim for Target Behavior / Forbidden Pattern / Evidence Source / Expected New Behavior, and adds only the three fields the acceptance spec marks as new: eligible opportunity, previous behavior (B0 failure pattern, frequency and observed evidence), and before/after observation windows split by `created_at` rather than session (exposed sessions are long-lived and would mix before/after). A repo-wide guard validates every such declaration with the real `isValidIntentContractV1` and rejects declarations that fork their own copies of the contract fields. No new table, runtime, Behavior Engine or storage — the declaration is one JSON file per experiment, and behaviour adjudication stays with the Owner (`adjudication.status = not_evaluated`).
- edbbcd9: RAH-3 (PRI-907): complete the release-artifact content boundary. @principles/install-layout and principles-disciple (openclaw-plugin) production builds now exclude compiled tests (tsconfig.build.json; plugin build:types declaration emit filtered too) with the same fail-loud dist hygiene assertion as RAH-1. The installer bundle script (create-principles-disciple) filters compiled test artifacts out of every payload copy AND asserts zero test artifacts across all payload components after materialization — test code can no longer reach user machines even if a future package forgets its build-boundary guard. A repo-level scan (check:workspace-artifacts, wired into verify:merge) backstops all workspace dist trees.
- 8b7b775: Security audit run-1 remediation (findings verified against eabbde6d, applied on ccc69252):
  
  - **RuleCode enforcement is now content-bound** (audit HIGH `rulecode-approval-content-unbound`): the production gate and the OpenClaw plugin RuleHost re-verify the current `pi_artifacts` row against the `activation_decisions.artifact_digest` recorded at Owner promotion time before compiling it. A workspace-local rewrite of `content_json` (or lineage fields) is now skipped with a structured `artifact_content_tampered` warning instead of silently executing unapproved code. Rows without a recorded decision (legacy activations) keep their prior behavior. Adds `mapPiArtifactRow`/`PiArtifactRow` exports (the single `pi_artifacts` row→snapshot mapping) so enforcement reproduces the promotion-time digest byte-for-byte.
  - **Replay evaluate is hard-bounded** (audit MEDIUM `rulecode.replay.in-process-evaluate-no-hard-timeout`): pre-activation replay runs each evaluate call through a precompiled vm script with a 2000ms hard timeout — a looping LLM-authored candidate now fails its replay case instead of hanging the console server, evaluator worker, or CLI process.
  - **Governance-store unavailability leaves a durable trace** (audit MEDIUM `gate-failopen-allow-on-state-corruption`): when `state.db` is missing or unreadable, the gate/plugin record a best-effort marker under `~/.pd/enforcement-health/` (outside the agent-writable workspace), and the console governance read model distinguishes "state.db deleted after initialization — enforcement degraded (fail-open)" from a never-initialized workspace.
  - **Console refuses unauthenticated non-loopback binds** (audit MEDIUM `pd-console-noauth-nonloopback-bind`): the loopback-only invariant now keys on the effective authentication state (token-less default included), not just the explicit `--no-auth` flag.
  - **Plugin honors an explicit conversation-access opt-out** (audit LOW `openclaw-plugin:conversation-access-autofix-overrides-explicit-owner-opt-out`): the auto-fix repairs only an absent `allowConversationAccess` flag; an explicit `false` (the documented turn-off) is preserved and surfaced as an honored Owner opt-out instead of being silently rewritten on every gateway start.
- Updated dependencies [99e6a8c]
- Updated dependencies [8b7b775]
- Updated dependencies [9d98f89]
- Updated dependencies [92074a0]
  - @principles/core@1.287.2

## 2.0.2

### Patch Changes

- 8424d60: Baseline-cutover accounting for the unpublished source delta between the registry baseline (2.0.1, published from fb397452) and current main: pain/llm hook refinements and the plugin sync script update carried after the 2026-09-19 release train. The version alignment to 2.0.1 is a starting point, not a claim this content shipped.
- Updated dependencies [8424d60]
  - @principles/core@1.287.0

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
