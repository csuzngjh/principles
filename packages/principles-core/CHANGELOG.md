# Changelog

## 1.287.5

### Patch Changes

- da4c731: Identity **writer** boundary (PRI-911A, third gate after the Type Boundary #1851 and the Activation Identity Boundary #1856): `pi_artifacts.source_principle_id` can now only ever hold a **canonical ledger UUID or NULL** — never title/`T-NN`/other display text. Audit trail: `docs/audit/identity-writer-hardening.md`.
  
  **W1 — DreamerRunner no longer carries an LLM-asserted identity.** The runner wrote `output.sourcePrincipleId` straight onto the artifact column; after `stripFabricatedCorePrincipleIds` the only value that can reach it is a Historical Core Principle registry id (`T-NN`), which is not a ledger principle. The column is now left empty and the assertion is reported via `dreamer_identity_assertion_not_carried`. The value still rides in `contentJson`, so the Activations console's Bug-O L1 'unlinked' display is unchanged — stamping the real identity remains ScribeRunner's ledger-verified job (PR #1856 I2).
  
  **W2 — EvaluatorRunner's rule stamp replaced its lenient chain.** Rule assembly previously resolved the identity through column → `contentJson.principleId` → `contentJson.sourcePrincipleId` → `principleDraft.title`, which is exactly how philosopher titles became durable identities in the column. Assembly now reads the bearer's `source_principle_id` column only, gates it through `canonicalLedgerPrincipleId` — the value-level gate split out of PR #1856's `resolveActivationPrincipleId`, so there is still exactly one UUID parser in the repo — and, when the host injects the new optional `EvaluatorRunnerDeps.ledgerIdentity.hasPrinciple`, verifies ledger membership. Outcomes: `evaluator_identity_stamp_success`, or the rule written with a NULL identity plus `evaluator_identity_stamp_failed` carrying `missing_identity` / `non_canonical_identity` / `invalid_identity` (`ambiguous_identity` stays with the bearer/lineage resolvers that can actually see multiplicity).
  
  **Rule assembly is deliberately NOT aborted on an unverified identity** — PR #1856 established that identity gaps are enforced at the publication boundary (rule preserved, no approval subject, no activation), so a wrong identity no longer silently becomes a lost candidate; `evaluator_rule_assembly_failed` keeps its structural meaning. All three production `EvaluatorRunner` construction sites (host-runtime consumer cycle, pd-cli `createEvaluatorRunnerDeps` shared by RuleHost and `runtime internalization run-once`) are wired with the ledger check; unwired callers keep the shape-only gate. The wiring is no longer
  grep-maintained: `identity-writer-production-wiring.test.ts` fails if a production construction site
  drops the injection (or bypasses the sanctioned `createEvaluatorRunnerDeps` factory), or if an identity
  event name drifts away from `TelemetryEventType`. Rollback = revert; no schema change, no data migration, no new flag.

## 1.287.4

### Patch Changes

- 42f0f4a: Activation identity boundary is now **ledger-aware and end-to-end** (Phase 3, I2 + I3 — `docs/architecture/principle-identity-reconciliation.md`), fixing the Owner review of PR #1856 where the shape-only gate cut the live production chain.
  
  **I2 — production chain stamping (the missing half of the ADR §6).** `ScribeRunner` now resolves the ledger principle identity through the real chain and stamps it at write time: scribe context → dreamer artifact (`sourceDreamerArtifactId`) → dreamer task seed `diagnosticJson.candidateId` (fallback: the `dreamer-<candidateId>-<channel>` task-id spelling) → `ledger.listForCandidate` exactly-one. Stamping is fail-soft and observable (`identity_stamp_failed` / `identity_stamp_skipped` events; `task_succeeded` carries `sourcePrincipleId`) — an unresolvable or ambiguous chain writes the artifact unstamped instead of guessing. Requires the new optional `ScribeRunnerDeps.ledgerIdentity` dep; unwired callers are unchanged.
  
  **I3 — ledger membership, verified BEFORE the commit.** The gate moved out of the writers (they now only guard `kind` + `validationStatus`) into `ActivationDispatcher.resolveActivationIdentity`, which runs on **both** paths: `enqueueForApproval` (before the approval record — that record *is* the pre-commit state change) and `activateArtifact` (before the activation commit). Resolution states:
  - `direct_validated` — a stamped UUID that the ledger actually contains;
  - `candidate_lineage` — an unstamped artifact resolved through the dreamer lineage;
  - unresolved → `invalid_artifact`. A stamped-but-unknown UUID is data drift (`principle_not_in_ledger: <id>`) and never falls through to lineage guessing.
  
  UUID shape alone never proves membership. Writers no longer refuse identity-less artifacts (they lack ledger deps; the dispatcher is the single gate). Without `ledgerIdentity` deps the legacy strict UUID-shape boundary applies unchanged, so unwired callers keep prior behavior.
  
  Console / CLI / E2E fixtures were migrated to real ledger-backed UUID identities, and **all manual identity stamping in tests was removed** — the identity must now come from the production chain.
  
  **Every production dispatch site is now wired with ledger deps**, so the identity chain is not cut at any entry point:
  
  - `demo-story-a-runner` previously used the synthetic string `demo-principle-<runId>` as the artifact identity and built its dispatcher with no ledger deps — the new gate refused all three channels (`invalid_artifact`). It now mints a **real ledger principle** (`PrincipleTreeLedgerAdapter.writeProbationEntry`, `derivedFromPainIds: [demo-<runId>]`), stamps that UUID onto both artifacts (`makePrincipleArtifactRecord(runId, principleId)`), and passes `ledgerIdentity` to both dispatchers. The Story-A demo exercises the SAME identity contract production does instead of bypassing it.
  - `pd-cli` rollout-parity fixtures seed the durable ledger entry their scribe chain implies (a real principle UUID + `sourceRef`), matching what a production internalization produces.
  - The pd-console **E2E seed** (`scripts/e2e-seed.ts`) now seeds ledger-backed UUID identities for every `pi_artifact` it writes (10 stable UUIDs + `p-001`). Previously the seed pointed artifacts at non-UUID, non-ledger ids (`p-001`, `p-002`, `p-click-*`, `p-rulecode-*`), so under the fail-closed gate the happy-path approvals returned 500 (`no_principle_id_in_artifact`) and — worse — that gate reason **shadowed** the RuleHostWriter golden-trace schema check that `rule-host-writer-golden-trace.spec.ts` asserts. With ledger-resolved identities the gate passes and the schema check runs, so `golden_trace_schema_invalid` surfaces as the spec requires (its own regression contract). Verified locally: `focus-approve-flow` 2/2, `rule-host-writer-golden-trace` 4/4, BDD `focus-page` 1/1.
  - `resolveActivationPrincipleId` now **lowercase-normalizes** the resolved UUID: ledger keys come from `randomUUID()` (always lowercase), so an uppercase-but-shape-valid UUID previously missed `hasPrinciple` and was misreported as `principle_not_in_ledger`.

## 1.287.3

### Patch Changes

- 4ced615: OPT-002 (runtime-v2 barrel narrowing): the plugin's satellite bundles no longer pull the LLM SDK graph. Six shared plugin modules switched their VALUE imports from the `@principles/core/runtime-v2` barrel to the eight narrow leaf subpaths (type-only barrel imports unchanged; exported names unchanged), and `@principles/core` exports gained those additive subpaths (`./runtime-v2/store/workspace-leak-guard`, `./runtime-v2/feedback/redact-sensitive`, `./runtime-v2/types/event-types`, `./runtime-v2/trajectory-schema`, `./runtime-v2/internalization/{rule-host-input-builder,rule-context-v2,behavior-example-pack,tool-semantic-registry}`). governance-audit.js drops 2,783,013 → 70,786 bytes (−97.5%) and rulehost-evidence.js 2,826,401 → 60,244 bytes (−97.9%); bundle.js is byte-identical (4,151,557) — the main package keeps its LLM runtime through its own direct barrel import. `runtime-v2/index.ts` and all existing exports are untouched. A build-level satellite purity guard (`scripts/build/check-satellite-purity.mjs`, wired into `esbuild.config.js`) now fails any plugin bundle build that reintroduces pi-ai / pi-agent-core / anthropic / openai / genai / undici inputs into the satellite outputs, so the invariant no longer rests on discipline alone.
- de38d90: Principle Ledger write boundary (Phase 1 / PR1): candidate-origin writes to the Principle Ledger now require a validated `recommendation_kind === 'principle'`. Unknown, missing, or malformed kinds are refused fail-closed and reported as an explicit disposition instead of silently collapsing into a principle; candidate persistence, kind routing, and defer handling are unchanged.

## 1.287.2

### Patch Changes

- 99e6a8c: RAH-1 (PRI-905): production builds now exclude test code (tsconfig.build.json: *.test.*, __tests__/, __fixtures__/, *.spec.*), clean dist before building, and fail the build if compiled test artifacts appear in dist. Published dist shrinks accordingly (@principles/core tarball was ~57% test artifacts by size); runtime API, source layout and vitest behavior are unchanged. Test files are still type-checked via the new `typecheck` (tsc --noEmit) scripts, wired into verify:merge.
- 8b7b775: Security audit run-1 remediation (findings verified against eabbde6d, applied on ccc69252):
  
  - **RuleCode enforcement is now content-bound** (audit HIGH `rulecode-approval-content-unbound`): the production gate and the OpenClaw plugin RuleHost re-verify the current `pi_artifacts` row against the `activation_decisions.artifact_digest` recorded at Owner promotion time before compiling it. A workspace-local rewrite of `content_json` (or lineage fields) is now skipped with a structured `artifact_content_tampered` warning instead of silently executing unapproved code. Rows without a recorded decision (legacy activations) keep their prior behavior. Adds `mapPiArtifactRow`/`PiArtifactRow` exports (the single `pi_artifacts` row→snapshot mapping) so enforcement reproduces the promotion-time digest byte-for-byte.
  - **Replay evaluate is hard-bounded** (audit MEDIUM `rulecode.replay.in-process-evaluate-no-hard-timeout`): pre-activation replay runs each evaluate call through a precompiled vm script with a 2000ms hard timeout — a looping LLM-authored candidate now fails its replay case instead of hanging the console server, evaluator worker, or CLI process.
  - **Governance-store unavailability leaves a durable trace** (audit MEDIUM `gate-failopen-allow-on-state-corruption`): when `state.db` is missing or unreadable, the gate/plugin record a best-effort marker under `~/.pd/enforcement-health/` (outside the agent-writable workspace), and the console governance read model distinguishes "state.db deleted after initialization — enforcement degraded (fail-open)" from a never-initialized workspace.
  - **Console refuses unauthenticated non-loopback binds** (audit MEDIUM `pd-console-noauth-nonloopback-bind`): the loopback-only invariant now keys on the effective authentication state (token-less default included), not just the explicit `--no-auth` flag.
  - **Plugin honors an explicit conversation-access opt-out** (audit LOW `openclaw-plugin:conversation-access-autofix-overrides-explicit-owner-opt-out`): the auto-fix repairs only an absent `allowConversationAccess` flag; an explicit `false` (the documented turn-off) is preserved and surfaced as an honored Owner opt-out instead of being silently rewritten on every gateway start.
- 9d98f89: Test Diet 2.2-B3-B: move the split-pipeline cached LLM fixture out of the `__tests__` boundary. `test-double-runtime-adapter.ts` (production) imported it from `internalization/__tests__/__fixtures__/`, which made the runtime-v2 fixture a source of truth consumed across the test boundary; the file now lives next to its two owners as `runtime-v2/adapter/split-pipeline-fixtures.ts`. Data, export names and adapter dispatch behavior are unchanged — the only content edits are three relative type-import depths and the import paths of its five consumers. No behavior change.
- 92074a0: Test Diet 2.2-B3-C: remove dead PassThroughValidator scaffold from runtime-v2 diagnostician validator module. Zero consumers (no production or test imports, not in any barrel or barrel-surface fixture), superseded by DefaultDiagnosticianValidator. No behavior change.

## 1.287.1

### Patch Changes

- 75b4ac4: PRI-866 sourcePainId reader convergence: pd-cli's two inline sourcePainId parsers now delegate to the core canonical reader (exported from @principles/core/runtime-v2), and the rulehost pipeline dreamer-task lookup normalizes both sides at the comparison boundary — historical rows or queries carrying surrounding whitespace no longer miss their dreamer seed and are no longer rejected with a misleading no_dreamer_task_seeded.

## 1.287.0

### Minor Changes

- 8424d60: Baseline-cutover accounting for the unpublished source delta between the registry baseline (1.286.0, published from 7e8bf2f0) and current main: internalization pipeline behavioral fixes and additions (dreamer prompt builder, evaluator pain-reason echo, pitask metadata, formation context), owner-decision view contract, pain-to-principle service and sqlite task store changes, and the telemetry event registry — carried by PR #1766 (PRI-846) and PR #1781 (PRI-874). These source changes were never released: the version number alignment to 1.286.0 is a starting point, not a claim this content shipped.

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-17

### Added

- `PainSignalSchema`, `validatePainSignal()`, `deriveSeverity()` -- Universal PainSignal schema and validation (SDK-CORE-03)
- `PainSignalAdapter<TRawEvent>` -- Framework-agnostic pain signal capture interface (SDK-ADP-02)
- `EvolutionHook` -- Callback interface for evolution lifecycle events (SDK-ADP-05)
- `TelemetryEvent` TypeBox schema -- In-process telemetry event schema (SDK-OBS-05)
- `StorageAdapter` -- Abstract storage adapter interface for principle persistence (SDK-CORE-02)
- `PrincipleInjector` -- Framework-agnostic principle injection interface (SDK-ADP-03)
- `DefaultPrincipleInjector` -- Minimal framework-agnostic implementation with budget-aware selection and P0 forced inclusion (SDK-ADP-03, SDK-ADP-04)
- `OpenClawPainAdapter` -- Reference coding domain adapter for OpenClaw tool failures (SDK-ADP-07)
- `WritingPainAdapter` -- Reference writing domain adapter for text quality issues (SDK-ADP-08)
- `CodeReviewPainAdapter` -- Reference code review domain adapter for diff complexity, comment sentiment, and process violations (SDK-ADP-09)
- `describePainAdapterConformance` -- Conformance test factory for PainSignalAdapter implementations (SDK-TEST-02)
- `describeInjectorConformance` -- Conformance test factory for PrincipleInjector implementations (SDK-TEST-02)
- Performance benchmarks with p99 targets (SDK-TEST-03)

### API Freeze Commitment

As of v0.1.0, the following interfaces are frozen (Semver protected):
- `PainSignal` schema (all 12 fields)
- `PainSignalAdapter<TRawEvent>.capture()` signature
- `PrincipleInjector.getRelevantPrinciples()` / `formatForInjection()` signatures
- `InjectionContext` interface
- `InjectablePrinciple` interface

Any additions will be made as non-breaking changes (new optional fields, new interfaces).

### Validation

- PainSignalSchema validated against 3 domains: coding, writing, code-review
- Gap analysis: ZERO unfillable fields across all domains
- E2E pipeline validated: ReviewEvent -> PainSignal -> DefaultPrincipleInjector

### Package

- Initial release as `@principles/core` v0.1.0
- Published from `packages/principles-core/`
- Supports tree-shaking via granular exports map
