# principles-disciple

## 2.0.7

### Patch Changes

- 7421049: The console's prompt-injection budget forecast now mirrors the production
  selection policy instead of silently defaulting to the legacy FIFO prefix
  (PRI-935). The forecast previously called the budget selector without its
  round key, which did not make it conservative — it selected a different
  policy, one that structurally excludes the newest activation from every
  truncated selection. The console therefore told the Owner an approved
  principle "will NOT enter agent behavior until older ones are deactivated"
  while the live injection path rotates and injects it within a bounded number
  of user turns, pushing Owners to deactivate healthy principles.
  
  buildLivePromptInjectionProjection now accepts the caller's round key and
  reports the policy it actually ran, the eligible count, whether production
  rotates on this route, and the set of activations reachable under some round.
  Reachability is a property of the policy rather than of a single round, so a
  console with no session round key can still distinguish an activation that is
  merely rotated out of the current window from one that is genuinely starved.
  Approve now emits injection_budget_queued for the queued case — with a bounded
  "within at most N consecutive user turns" statement and an explicit note that
  deactivating older principles is not required — and reserves
  injection_budget_excluded for real starvation, no longer asserting a FIFO
  ordering the production route does not use. The pre-decision queue badge and
  both locales follow the same policy, and the raw English server text is
  collapsed behind a native details element so the toast no longer renders as one
  mixed Chinese/English block (still preserved verbatim).
  
  The shared host route deliberately passes no round key and continues to report
  legacy_fifo_prefix_v1, so cross-host fairness remains PRI-930 and is not
  claimed here. All new projection fields are optional; payloads without them
  validate as before and render policy-agnostic copy.
- Updated dependencies [b50ec74]
  - @principles/core@1.287.7

## 2.0.6

### Patch Changes

- 276efe4: A workspace pointer that does not name one fixed directory is no longer
  resolved. A value that lost its separators in transit —
  `"D:.openclawworkspace"` for `D:\.openclaw\workspace` — used to be handed to
  `path.resolve()`, which turned it into a plausible absolute path that depends
  on the process working directory; a root-relative value such as `\workspace`
  was anchored to whichever drive the caller was on. The same config could then
  send governance state (`.pd/state.db`, `.state/trajectory.db`) to a different
  directory depending on which process read it, with no warning.
  
  The plugin now skips such a candidate, continues with the next declared source
  (env > config > default is unchanged), and logs the refusal together with the
  source it fell back to. The installer refuses such a workspace before any side
  effect, rather than only when writing the config pointer. Values that carry
  their own drive, or a UNC share, are unaffected (PRI-931).

## 2.0.5

### Patch Changes

- 50ed22e: Prompt principle injection now rotates deterministically under the fixed
  2000-char budget instead of always packing the oldest prefix, so a live,
  eligible, individually-fitting principle can no longer be permanently starved
  by its position (PRI-904). The rotation round is the session-local user-turn
  ordinal already persisted in the trajectory database — an existing fact, read
  through the registered trajectory-store seam — so consecutive rounds advance
  by exactly one and N rounds cover all N eligible positions: a bounded
  opportunity window with no new persisted scheduling state, no randomness and
  no clock. Non-fitting entries no longer terminate the scan; oversized entries
  are reported separately; the injection event carries selectionPolicy,
  eligibleCount, rotationStartIndex, the round ordinal that produced the
  selection, and schema-bounded dropped/oversized activation id lists (max 16)
  so truncation is explainable and traceable. The legacy FIFO prefix behavior
  remains the rollback baseline whenever no round ordinal is available.
- Updated dependencies [50ed22e]
  - @principles/core@1.287.6

## 2.0.4

### Patch Changes

- 4ced615: OPT-002 (runtime-v2 barrel narrowing): the plugin's satellite bundles no longer pull the LLM SDK graph. Six shared plugin modules switched their VALUE imports from the `@principles/core/runtime-v2` barrel to the eight narrow leaf subpaths (type-only barrel imports unchanged; exported names unchanged), and `@principles/core` exports gained those additive subpaths (`./runtime-v2/store/workspace-leak-guard`, `./runtime-v2/feedback/redact-sensitive`, `./runtime-v2/types/event-types`, `./runtime-v2/trajectory-schema`, `./runtime-v2/internalization/{rule-host-input-builder,rule-context-v2,behavior-example-pack,tool-semantic-registry}`). governance-audit.js drops 2,783,013 → 70,786 bytes (−97.5%) and rulehost-evidence.js 2,826,401 → 60,244 bytes (−97.9%); bundle.js is byte-identical (4,151,557) — the main package keeps its LLM runtime through its own direct barrel import. `runtime-v2/index.ts` and all existing exports are untouched. A build-level satellite purity guard (`scripts/build/check-satellite-purity.mjs`, wired into `esbuild.config.js`) now fails any plugin bundle build that reintroduces pi-ai / pi-agent-core / anthropic / openai / genai / undici inputs into the satellite outputs, so the invariant no longer rests on discipline alone.
- Updated dependencies [4ced615]
- Updated dependencies [de38d90]
  - @principles/core@1.287.3

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
