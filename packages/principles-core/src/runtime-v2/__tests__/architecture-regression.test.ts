/**
 * Architecture regression guard — verifies critical PRI-12/13/14/15/16/28
 * module boundaries are present and exportable.
 *
 * Add entries here whenever a new service/read-model boundary is established.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fsSync from 'fs';
import * as pathSync from 'path';

// ── Source-file existence ──────────────────────────────────────────────────

const REQUIRED_SOURCE_FILES = [
  'pain-to-principle-service.ts',
  'pain-chain-read-model.ts',
  'pain-signal-bridge.ts',
  'pain-signal-runtime-factory.ts',
  'pain-signal-observability.ts',
  'pruning-read-model.ts',
  'pruning-review-log.ts',
  // PRI-28
  'operator-health-read-model.ts',
  'candidate-audit.ts',
  // PRI-42
  'internalization/rule-host-contracts.ts',
  'internalization/rule-host-helpers.ts',
  'internalization/index.ts',
  // PRI-480 (RuleContext v2 — Phase 1 Core ABI)
  'internalization/rule-context-v2.ts',
  // PRI-43
  'internalization/internalization-route.ts',
  // PRI-44
  'internalization/template-generator.ts',
  'internalization/rule-code-validator.ts',
  'internalization/compile-result.ts',
  // PRI-45
  'internalization/rule-host-evaluator.ts',
  'internalization/rule-host-adapter.ts',
  // PRI-51
  'types/principle-enums.ts',
  'types/principle-schema.ts',
  'types/artifact-lineage.ts',
  'types/replay-types.ts',
  'types/index.ts',
  'internalization/lifecycle-types.ts',
  // PRI-52
  'internalization/lifecycle-metrics.ts',
  // PRI-53
  'internalization/deprecated-readiness.ts',
  // PRI-54
  'internalization/routing-policy.ts',
  // PRI-56
  'internalization/lifecycle-datasource.ts',
  'internalization/lifecycle-read-model.ts',
  // PRI-61
  'internalization/peer-runner-contracts.ts',
  'internalization/internalization-job-graph.ts',
  // PRI-62
  'internalization/internalization-task-guards.ts',
  'internalization/internalization-state-machine.ts',
  // PRI-65
  'internalization/pitask-metadata.ts',
  // PRI-67
  'internalization/dreamer-output.ts',
  'internalization/dreamer-runner.ts',
  // PRI-109
  'internalization/scribe-output.ts',
  'internalization/scribe-runner.ts',
  // PRI-111
  'internalization/artificer-output.ts',
  'internalization/artificer-runner.ts',
  // PRI-EVAL
  'internalization/evaluator-output.ts',
  'internalization/evaluator-runner.ts',
  'internalization/evaluator-prompt-builder.ts',
  // PRI-RR
  'internalization/rollout-reviewer-output.ts',
  'internalization/rollout-reviewer-runner.ts',
  'internalization/rollout-reviewer-prompt-builder.ts',
  // PRI-74 (follow-up to PRI-75 Phase 3)
  '../prompt-builder/routing-guidance.ts',
  // PRI-81 Phase A
  '../prompt-builder/empathy-keyword-matching.ts',
  '../prompt-builder/empathy-types.ts',
  // PRI-81 Phase B
  '../prompt-builder/focus-compression.ts',
  // PRI-76
  'gfi/gfi-types.ts',
  'gfi/gfi-policy.ts',
  'gfi/gfi-kernel.ts',
  'gfi/index.ts',
  // PRI-84
  'internalization/pi-artifact.ts',
  'internalization/pi-artifact-store.ts',
  // PRI-115
  'golden-trace-replay-validator.ts',
  'golden-trace-replay-adapter.ts',
  // PRI-172
  'internalization/refiner-sandbox-wrapper.ts',
  // PRI-173
  'internalization/refiner-rulehost-gate.ts',
  // RuleHost MVP Activation (PRI-421..428, ADR-0014 Amendment 2026-06-17)
  'internalization/adversarial-case.ts',
  'internalization/adversarial-feedback.ts',
  // PRI-485 Phase 6: v2 adversarial case generator (pure logic)
  'internalization/v2-adversarial-cases.ts',
  'internalization/artificer-prompt-builder.ts',
  'adversarial-loop.ts',
  // Phase 2 migration: evolution types
  'evolution/evolution-types.ts',
  'evolution/index.ts',
  // Phase 2 migration: correction types
  'correction/correction-types.ts',
  'correction/index.ts',
  // Phase 2 migration: types directory
  'types/queue-types.ts',
  'types/hygiene-types.ts',
  'types/runtime-summary-types.ts',
  'types/event-types.ts',
  'types/event-payload.ts',
  'types/pain-signal.ts',
  'types/pd-task-types.ts',
  // Phase 2 migration: principle-tree data structures
  'types/principle-dependency.ts',
  'types/principle-value-metrics.ts',
  'types/principle-lifecycle-event.ts',
  'types/principle-tree-store.ts',
  // PRI-140
  'store/sqlite-connection.ts',
  // PRI-139
  'l1-hard-cap.ts',
  // PRI-142
  'internalization/intake-to-internalization-bridge.ts',
  // PRI-144
  'activation/activation-types.ts',
  'activation/activation-dispatcher.ts',
  'activation/low-risk-writers.ts',
  'activation/index.ts',
  // PRI-145
  'activation/approval-queue.ts',
  'activation/memory-approval-store.ts',
  'activation/sqlite-approval-store.ts',
  // PRI-189
  'store/trajectory/source-trace-locator.ts',
  'store/trajectory/sqlite-source-trace-locator.ts',
  // PRI-190
  'full-trace-contract.ts',
  // PRI-191
  'trace-refiner.ts',
  // PRI-192
  'trace-refiner-agent.ts',
  // PRI-193
  'golden-trace-candidate-builder.ts',
  // PRI-149 Tier 2
  'recovery-sweep-service.ts',
  // PRI-146
  'activation/writers/rule-host-writer.ts',
  'activation/writers/index.ts',
  // PRI-295
  'activation/prompt-activation-reader-contract.ts',
  // PRI-215
  'synthetic-baseline.ts',
  // PRI-239
  'feature-flags/feature-flag-contract.ts',
  'feature-flags/index.ts',
  // PRI-367
  'core-principles/core-principle-registry.ts',
  'core-principles/index.ts',
  // PRI-285: MVP seed feedback channel — privacy-preserving report contract.
  // Pure logic only; no I/O. Server I/O lives in pd-console under
  // <workspace>/.pd/feedback/drafts/. No automatic upload.
  'feedback/feedback-types.ts',
  'feedback/internal-guards.ts',
  'feedback/redact-sensitive.ts',
  'feedback/render-markdown.ts',
  'feedback/render-github-url.ts',
  'feedback/privacy-preview.ts',
  'feedback/safe-stringify.ts',
  'feedback/create-report.ts',
  // Slice 1 (PRI-543): deterministic fingerprint for feedback dedup/clustering.
  'feedback/fingerprint.ts',
  'feedback/index.ts',
  // Anonymous Product Telemetry v1 (PRI-595~603, ADR-0021): pure contract —
  // daily unlinkable identity derivation + strict snapshot schema/validator
  // + privacy guard. No I/O; readers/exporter live in @principles/host-runtime.
  'product-telemetry/daily-identity.ts',
  'product-telemetry/snapshot-contract.ts',
  // PRI-372 (T-G)
  'diagnostician/diag-rootcause-output.ts',
  'diagnostician/diag-distiller-output.ts',
  'diagnostician/rootcause-prompt-builder.ts',
  'diagnostician/distiller-prompt-builder.ts',
  'diagnostician/router-prompt-builder.ts',
  'internalization/diag-rootcause-runner.ts',
  'internalization/diag-distiller-runner.ts',
  'internalization/diag-router-runner.ts',
  // PRI-419: L2 agent loop adapter (core, pure orchestration of pi-agent-core; no node:* imports)
  'adapter/l2-agent-loop-adapter.ts',
  // PRI-419: L2 agent loop tool contract + typebox output redeclaration (pure logic, no I/O)
  'tools/agent-tool-contract.ts',
  'tools/dreamer-output-typebox.ts',
  // PRI-439: Artificer L2 agent loop tool contract + typebox output redeclaration (pure logic, no I/O)
  'tools/artificer-l2-tool-contract.ts',
  'tools/artificer-output-typebox.ts',
  // PRI-408: Production gate deps factory — canonical vm-based rule compilation
  'activation/production-gate-deps.ts',
  // PRI-408: Formal approval-completion production service
  'activation/approval-completion-service.ts',
  // PRI-431: L2 principle reader (pure logic, extracted from pd-cli + plugin duplicates)
  'build-l2-principle-reader.ts',
  // PRI-446: pure logic migrated from openclaw-plugin into core
  'evidence-triage/observation-resolver.ts',
  'pain-gate/pain-diagnostic-gate-policy.ts',
  'pain-gate/index.ts',
  'detection/detection-funnel-policy.ts',
  'detection/index.ts',
  // PRI-470: IntentDecisionRecord durable store + types (SPEC §21.7)
  'intent/intent-decision-record.ts',
  'store/intent/sqlite-intent-decision-store.ts',
  'store/intent/index.ts',
] as const;

// ── PRI-212: Plugin core anti-growth guard ────────────────────────────────────
//
// Baseline: PRI-211 inventory (docs/archive/reviews/plugin-core-inventory-2026-05.md)
// Prevents silent growth of packages/openclaw-plugin/src/core/ by requiring
// explicit classification for every new file.
//
// New pure domain logic → @principles/core
// New I/O adapters → must be classified as plugin-specific
// ERR-011 reference: never bypass architecture boundary facades
// ERR-012 reference: stale-main PR rollback must not delete baseline entries
//
// To add a new plugin I/O adapter legitimately, add its relative path
// (from packages/openclaw-plugin/src/core/) to the KNOWN_PLUGIN_CORE_FILES
// set below with a comment explaining why it is plugin-specific.

const KNOWN_PLUGIN_CORE_FILES = new Set([
  // ── Pure Domain Logic Candidates — exist today but new pure logic belongs in @principles/core ──
  'trajectory-types.ts',
  'profile.ts',
  'pain-signal.ts',
  'pd-task-types.ts',
  'evolution-types.ts',
  'telemetry-event.ts',
  'empathy-types.ts',
  'correction-types.ts',
  'principle-injection.ts',
  'principle-compiler/template-generator.ts',

  // ── Thin Adapter Candidates — plugin I/O boundary wrappers ──────────────
  'principle-tree-migration.ts',
  'principle-internalization/principle-lifecycle-service.ts',
  'principle-tree-ledger-adapter.ts',
  'principle-compiler/ledger-registrar.ts',
  'principle-compiler/code-validator.ts',
  'principle-injector.ts',
  'pd-task-service.ts',
  'principle-internalization/lifecycle-read-model.ts',
  'principle-internalization/filesystem-lifecycle-datasource.ts',
  'config-service.ts',
  'config-health.ts', // PRI-346: Pure conversation access config check — plugin-specific due to OpenClaw config shape dependency
  'principle-compiler/index.ts',
  'principle-internalization/lifecycle-refresh.ts',

  // ── Do Not Move — intrinsically plugin-specific ─────────────────────────
  'event-log.ts',
  'schema/schema-definitions.ts',
  'path-resolver.ts',
  'init.ts',
  'workspace-context.ts',
  'reflection/reflection-context.ts',
  'bootstrap-rules.ts',
  'schema/migration-runner.ts',
  'rule-host.ts',
  'principle-training-state.ts',
  // PRI-446: now a thin adapter delegating pure decision logic to
  // runtime-v2/pain-gate/pain-diagnostic-gate-policy.ts. Kept here because it
  // owns the cooldown Map + SystemLogger + Date.now side effects.
  'pain-diagnostic-gate.ts',
  'hygiene/tracker.ts',
  'schema/migrations/002-init-central.ts',
  'workspace-dir-service.ts',
  'paths.ts',
  'schema/migrations/004-add-thinking-and-gfi.ts',
  'evolution-hook.ts',
  'storage-adapter.ts',
  'schema/migrations/003-init-workflow.ts',
  'workspace-dir-validation.ts',
  'pain-signal-adapter.ts',
  'rule-implementation-runtime.ts',
  'detection-service.ts',
  'schema/migrations/index.ts',
  'dictionary-service.ts',
  'schema/index.ts',
  'schema/db-types.ts',
  'rule-host-types.ts',
  'rule-host-helpers.ts',
  'schema/migrations/001-init-trajectory.ts',

  // ── I/O Boundary ────────────────────────────────────────────────────────
  'trajectory.ts',
  // PRI-482: Plugin I/O boundary — converts raw TrajectoryDatabase rows into
  // validated RuleHistoryWindow. Pure logic (canonicalize, validate, facts)
  // delegated to @principles/core. Assembler stays in plugin because it
  // consumes DB row shapes (I/O data).
  'rule-context-assembler.ts',
  // PRI-484: Plugin I/O boundary — assembles a BehaviorExamplePack for the
  // Artificer by reading pain lineage + trajectory from TrajectoryDatabase.
  // Pure logic (type + validator) lives in @principles/core; this module
  // owns the DB row → pack mapping and fail-loud validation.
  'behavior-example-pack-assembler.ts',
  'evolution-reducer.ts',
  'focus-history.ts',
  'training-program.ts',
  'replay-engine.ts',
  'merge-gate-audit.ts',
  'pd-task-reconciler.ts',
  'correction-cue-learner.ts',
  // MVP core-loop closure (P0-B/P0-D/E/F): live correction-cue store projection
  // (learn->detect feedback) and auto-consumer governance wiring (dispatcher +
  // repair deps). Both are plugin I/O boundary modules; core logic lives in
  // @principles/core.
  'signal-keyword-store.ts',
  'auto-consumer-governance-wiring.ts',
  'principle-compiler/compiler.ts',
  'pain.ts',
  'pain-context-extractor.ts',
  'config.ts',
  'code-implementation-storage.ts',
  'observability.ts',
  'file-storage-adapter.ts',
  'workflow-funnel-loader.ts',
  'dictionary.ts',
  'thinking-os-parser.ts',
  'system-logger.ts',
  // Anonymous Product Telemetry v1 (PRI-595~603, ADR-0021): one-time-init
  // trigger shell — wires the host-neutral telemetry service (all logic in
  // @principles/host-runtime product-telemetry) into the OpenClaw plugin
  // lifecycle. Plugin-specific because the trigger point is plugin-owned.
  'product-telemetry-trigger.ts',
  // PRI-446: now a thin shell wiring DetectionFunnelCore (core runtime-v2/detection)
  // with crypto.createHash + PainDictionary. Kept here because it owns the
  // crypto + dictionary I/O boundary.
  'detection-funnel.ts',
  'migration.ts',
  'file-store.ts',
  'pd-task-store.ts',
  'empathy-keyword-matcher.ts',
  // SignalCollector: unified signal collection host (correction + empathy upstream merge).
  // I/O shell: reads .pd/config.yaml, constructs PiAiRuntimeAdapter, writes trajectory.
  // Pure detection logic lives in @principles/core/runtime-v2/signal-collector/.
  'signal-collector-host.ts',
  // PRI-530: Plugin I/O boundary — sync readonly state.db reads resolving principle
  // receipt attribution (title fallback chain / approval date / source summary).
  'principle-receipt-metadata.ts',
  // PRI-531: Plugin I/O boundary — durable receipt ledger writes (state.db
  // principle_applications inserts + 90-day retention sweep).
  'principle-application-ledger.ts',
  'pain-lifecycle.ts',
  'session-tracker.ts',
  // PRI-459: now a thin re-export adapter over @principles/core/principle-tree-ledger.
  // Kept in the plugin baseline so existing relative imports (./principle-tree-ledger.js)
  // still resolve. No parsing/serialization/mutation logic may live here — enforced by
  // tests/ledger-schema-diff.test.ts.
  'principle-tree-ledger.ts',
  'evolution-logger.ts',
  'evolution-engine.ts',

  // ── Runtime V2 ──────────────────────────────────────────────────────────
  'runtime-v2-prompt-activation-reader.ts',
  'workspace-guidance-migrator.ts',
  // PRI-307: Plugin I/O boundary — reads .pd/config.yaml, delegates validation to core
  'pd-config-loader.ts',
  // PRI-346: Pure function for checking conversation access config (extracted for circular import avoidance)
  'config-health.ts',
  // PRI-467: Plugin I/O boundary — reads .principles/INTENT.md with TTL+mtime cache,
  // delegates parsing/validation/hashing to @principles/core. Never throws.
  'intent-doc-reader.ts',
  // PRI-468: Plugin adapter implementing core IntentDocReader port — pure type
  // mapping from safeReadIntentDoc result to the core-owned IntentDocReadResult.
  // No new I/O; delegates to intent-doc-reader.ts above.
  'intent-doc-reader-adapter.ts',
  // RuleCode safety containment I/O boundary — reads approved artifact scope and
  // persists circuit-breaker isolation through the core-owned SQLite safety store.
  // Pure threshold policy remains in principles-core.
  'rulecode-safety-circuit.ts',

  // ── Test Files ──────────────────────────────────────────────────────────
  '__tests__/focus-history.test.ts',
  'principle-compiler/__tests__/compiler-replay-gate.test.ts',
]);

describe('PRI-212 plugin core anti-growth guard', () => {
  const PLUGIN_CORE_RELPATH = '../../../../openclaw-plugin/src/core';

  it('every plugin-core file is in the known baseline', async () => {
    const { readdirSync, existsSync } = await import('node:fs');
    const { resolve, relative, sep } = await import('node:path');

    const pluginCoreDir = resolve(__dirname, PLUGIN_CORE_RELPATH);
    expect(existsSync(pluginCoreDir)).toBe(true);

    // Collect all .ts files recursively (relative to plugin-core root)
    const allFiles: string[] = [];
    function collectDir(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          collectDir(fullPath);
        } else if (entry.name.endsWith('.ts')) {
          allFiles.push(relative(pluginCoreDir, fullPath).split(sep).join('/'));
        }
      }
    }
    collectDir(pluginCoreDir);

    const unknownFiles = allFiles.filter((f) => !KNOWN_PLUGIN_CORE_FILES.has(f));

    if (unknownFiles.length > 0) {
      const msg = [
        `Found ${unknownFiles.length} unclassified file(s) in packages/openclaw-plugin/src/core/:`,
        ...unknownFiles.map((f) => `  ${f}`),
        '',
        'Each new file in plugin core must be explicitly classified:',
        '  1. New pure domain logic → packages/principles-core (zero I/O, testable with no mocks)',
        '  2. New plugin I/O adapter → add to KNOWN_PLUGIN_CORE_FILES with classification comment',
        '  3. See docs/archive/reviews/plugin-core-inventory-2026-05.md for the PRI-211 baseline',
        'ERR-011: never bypass architecture boundary facades',
        'ERR-012: baseline entries must survive rebase — check diff for unintended deletions',
      ].join('\n');
      expect.fail(msg);
    }
  });

  it('known baseline count is self-consistent (98 files)', async () => {
    // Sanity check: if the baseline grows, update this number.
    // Prevents accidental baseline bloat from going unnoticed.
    // See docs/archive/reviews/plugin-core-inventory-2026-05.md §7
    // PRI-286: Removed confirm-first-gate.ts (95 → 94)
    // PRI-307: Added pd-config-loader.ts (96 → 97)
    // PRI-346: Added config-health.ts (97 → 98)
    // PRI-448: Removed local-worker-routing.ts, promotion-gate.ts,
    // model-training-registry.ts, model-deployment-registry.ts,
    // shadow-observation-registry.ts (98 → 93)
    // PRI-449: Removed external-training-contract.ts (93 → 92)
    // PRI-446: pain-diagnostic-gate.ts and detection-funnel.ts remain at 92 —
    // they are now thin adapters delegating pure logic to core, but still live
    // in plugin src/core/ and own I/O side effects, so they stay classified.
    // PRI-467: Added intent-doc-reader.ts (92 → 93) — plugin I/O boundary for
    // reading .principles/INTENT.md with TTL+mtime cache for prompt injection.
    // PRI-468: Added intent-doc-reader-adapter.ts (93 → 94) — plugin adapter
    // implementing core IntentDocReader port (pure type mapping, no new I/O).
    // Stage-1 cleanup: Removed evolution-migration.ts (94 → 93) — dead code,
    // zero production references after refactor to @principles/core.
    // PRI-482: Added rule-context-assembler.ts (93 → 94) — plugin I/O boundary
    // converting TrajectoryDatabase rows to validated RuleHistoryWindow.
    // Stage-3: Removed risk-calculator.ts (94 → 93) — pure logic sunk to
    // core runtime-v2/risk/, dead code (assessRiskLevel/getTargetFileLineCount/
    // calculatePercentageThreshold) removed.
    // Stage-3 sink: Removed surface-guard.ts (93 → 92) — pure guard logic
    // migrated to @principles/core/runtime-v2/feature-flags/surface-guard-policy.
    // SignalCollector: Added signal-collector-host.ts (92 → 93) — unified signal
    // collection I/O host (correction + empathy upstream merge). Reads
    // .pd/config.yaml, constructs PiAiRuntimeAdapter, writes trajectory. Pure
    // detection logic lives in @principles/core/runtime-v2/signal-collector/.
    // PRI-484: Added behavior-example-pack-assembler.ts (92 → 93) — plugin I/O
    // boundary assembling BehaviorExamplePack from pain lineage + trajectory.
    // SignalCollector: Added signal-collector-host.ts (93 → 94) — unified signal
    // collection I/O host (correction + empathy upstream merge). Reads
    // .pd/config.yaml, constructs PiAiRuntimeAdapter, writes trajectory. Pure
    // detection logic lives in @principles/core/runtime-v2/signal-collector/.
    // PRI-530: Added principle-receipt-metadata.ts (94 → 95) — plugin I/O boundary
    // for principle receipt attribution reads (readonly state.db joins).
    // PRI-531: Added principle-application-ledger.ts (95 → 96) — receipt ledger writer.
    // 2026-08-19 retirement: Removed control-ui-db.ts and thinking-models.ts
    // (96 → 94) — zero production consumers after the Thinking Activity
    // writer retirement (census in the PR description).
    // MVP core-loop closure (P0-B/P0-D): Added signal-keyword-store.ts +
    // auto-consumer-governance-wiring.ts (94 → 96) — live correction-cue store
    // projection + auto-consumer governance dispatcher/repair wiring (I/O boundary).
    // RuleCode Owner Live Decision: Added rulecode-safety-circuit.ts (96 → 97)
    // as the plugin I/O shell for scope reads and durable safety isolation.
    expect(KNOWN_PLUGIN_CORE_FILES.size).toBe(98);
  });
});

const REQUIRED_TEST_FILES = [
  'pain-to-principle-service.test.ts',
  'pain-chain-read-model.test.ts',
  'pruning-read-model.test.ts',
  'pruning-review-log.test.ts',
  // PRI-28
  'operator-health-read-model.test.ts',
  'candidate-audit.test.ts',
  // PRI-56 (lifecycle-read-model.test.ts is at internalization/lifecycle-read-model.test.ts, not in __tests__/)
  // Skipping — test file lives at ../internalization/ not __tests__/internalization/
  // PRI-62
  'internalization-state-machine.test.ts',
  // PRI-65
  'pitask-metadata.test.ts',
  // PRI-67
  'dreamer-runner.test.ts',
  // PRI-109
  'scribe-runner-vslice.test.ts',
  // PRI-111
  'artificer-runner-vslice.test.ts',
  // PRI-EVAL
  'evaluator-runner-vslice.test.ts',
  // PRI-RR
  'rollout-reviewer-runner-vslice.test.ts',
  // PRI-74 (follow-up to PRI-75 Phase 3)
  '../../prompt-builder/__tests__/routing-guidance.test.ts',
  // PRI-81 Phase A
  '../../prompt-builder/__tests__/empathy-keyword-matching.test.ts',
  // PRI-81 Phase B
  '../../prompt-builder/__tests__/focus-compression.test.ts',
  // PRI-76
  '../gfi/__tests__/gfi-kernel.test.ts',
  // PRI-115
  'golden-trace-replay-validator.test.ts',
  // PRI-140
  '../store/sqlite-connection-pragma.test.ts',
  // PRI-141
  'task-three-strikes.test.ts',
  // PRI-139
  'l1-hard-cap.test.ts',
  // PRI-142
  'intake-to-internalization-bridge.test.ts',
  // PRI-144
  '../activation/__tests__/activation-dispatcher.test.ts',
  // PRI-145
  '../activation/__tests__/approval-queue.test.ts',
  '../activation/__tests__/sqlite-approval-store.test.ts',
  // PRI-190
  'full-trace-contract.test.ts',
  // PRI-191
  'trace-refiner.test.ts',
  // PRI-192
  'trace-refiner-agent.test.ts',
  // PRI-193
  'golden-trace-candidate-builder.test.ts',
  // PRI-173
  '../internalization/__tests__/refiner-rulehost-gate.test.ts',
  // PRI-146
  '../activation/writers/__tests__/rule-host-writer.test.ts',
  // PRI-215
  'synthetic-baseline.test.ts',
  // PRI-239
  '../feature-flags/__tests__/feature-flag-contract.test.ts',
  // PRI-295
  '../activation/__tests__/prompt-activation-reader-contract.test.ts',
  // PRI-372 (T-G)
  '../diagnostician/__tests__/diag-rootcause-output.test.ts',
  '../diagnostician/__tests__/diag-distiller-output.test.ts',
  '../diagnostician/__tests__/rootcause-prompt-builder.test.ts',
  '../diagnostician/__tests__/distiller-prompt-builder.test.ts',
  '../diagnostician/__tests__/router-prompt-builder.test.ts',
  '../internalization/__tests__/diag-rootcause-runner.test.ts',
  '../internalization/__tests__/diag-distiller-runner.test.ts',
  '../internalization/__tests__/diag-router-runner.test.ts',
  '../internalization/__tests__/diag-chain-e2e.test.ts',
  // PRI-431
  'build-l2-principle-reader.test.ts',
  // PRI-469
  'evidence-chain-intent-tension.test.ts',
  // PRI-470: IntentDecisionRecord types + SQLite store
  '../intent/__tests__/intent-decision-record.test.ts',
  '../store/intent/__tests__/sqlite-intent-decision-store.test.ts',
];

const REQUIRED_DOC_FILES: string[] = [];

for (const file of REQUIRED_SOURCE_FILES) {
  it(`source file ${file} is present`, async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', file))).toBe(true);
  });
}

for (const file of REQUIRED_TEST_FILES) {
  it(`test file __tests__/${file} is present`, async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, file))).toBe(true);
  });
}

for (const file of REQUIRED_DOC_FILES) {
  it(`doc file ${file} is present`, async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, file))).toBe(true);
  });
}

// ── Public API exports ─────────────────────────────────────────────────────

describe('runtime-v2 public API (index.ts barrel)', () => {
  const barrel = import('../index.js');

  const REQUIRED_EXPORTS = [
    // PRI-12
    'PainToPrincipleService',
    // PRI-14
    'PainChainReadModel',
    // M8
    'PainSignalBridge',
    'createPainSignalBridge',
    'recordPainSignalObservability',
    // PRI-15
    'PruningReadModel',
    // PRI-13 → factory
    'resolveRuntimeConfig',
    'validateRuntimeConfig',
    // PRI-28
    'OperatorHealthReadModel',
    'auditCandidateLedgerConsistency',
    // PRI-43
    'decideInternalizationRoute',
    // PRI-44
    'generateFromTemplate',
    'checkForbiddenPatterns',
    'checkReturnStatementsMissingFields',
    // PRI-45
    'mergeDecisions',
    // PRI-149 Tier 2
    'createRecoverySweepService',
    // PRI-239
    'validateFeatureFlagRaw',
    'computeEffectiveFlags',
    // PRI-295
    'filterPromptActivations',
    'resolvePrincipleFromArtifact',
    'trimToBudget',
    'renderPrinciplesToDirectives',
    // PRI-431
    'buildL2PrincipleReaderFromLedger',
    // LLM output hardening — shared utility
    'stripFabricatedCorePrincipleIds',
    // PRI-470: IntentDecisionRecord durable SQLite store
    'SqliteIntentDecisionStore',
    // Slice 1 (PRI-543): fingerprint for feedback dedup/clustering
    'computeFeedbackFingerprint',
  ];

  for (const name of REQUIRED_EXPORTS) {
    it(`exports ${name}`, async () => {
      const mod = (await barrel) as Record<string, unknown>;
      expect(mod).toHaveProperty(name);
      expect(typeof mod[name]).toBe('function');
    }, 15_000);
  }

  // PRI-171: TypeBox schema exports (objects, not functions)
  const REQUIRED_SCHEMA_EXPORTS = [
    'FullTracePayloadSchema',
    'ToolCallEntrySchema',
    'PainContextSchema',
    // PRI-190
    'FullTracePayloadV2Schema',
    'TraceSourceRefSchema',
    'TraceTimelineEntrySchema',
    'TraceEventKindSchema',
    'SourceRefKindSchema',
  ];

  for (const name of REQUIRED_SCHEMA_EXPORTS) {
    it(`exports schema ${name}`, async () => {
      const mod = (await barrel) as Record<string, unknown>;
      expect(mod).toHaveProperty(name);
      expect(typeof mod[name]).toBe('object');
    }, 15_000);
  }
});

// ── OpenClawPlugin pain hook integration ───────────────────────────────────

describe('openclaw-plugin pain hook integration', () => {
  it('pain.ts uses PainToPrincipleService (not createPainSignalBridge)', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const painHookPath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/hooks/pain.ts',
    );
    expect(existsSync(painHookPath)).toBe(true);
    const src = readFileSync(painHookPath, 'utf-8');
    expect(src).toContain('PainToPrincipleService');
    expect(src).not.toContain('createPainSignalBridge');
  });

  // PRI-29: emitPainDetectedEvent → PainToPrincipleService service contract
  it('pain.ts emitPainDetectedEvent calls PainToPrincipleService.recordPain on pain_detected', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const painHookPath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/hooks/pain.ts',
    );
    expect(existsSync(painHookPath)).toBe(true);
    const src = readFileSync(painHookPath, 'utf-8');
    // Must call service.recordPain() inside emitPainDetectedEvent
    expect(src).toMatch(/service\.recordPain\(/);
    // Must log PAIN_SERVICE_FAILED for failure results
    expect(src).toMatch(/PAIN_SERVICE_FAILED/);
    // Must log PAIN_SERVICE_SKIPPED for skipped results
    expect(src).toMatch(/PAIN_SERVICE_SKIPPED/);
    // Must log PAIN_SERVICE_ERROR for exceptions
    expect(src).toMatch(/PAIN_SERVICE_ERROR/);
    // Must NOT use legacy createPainSignalBridge
    expect(src).not.toMatch(/createPainSignalBridge/);
  });
});

// ── PRI-42: Internalization boundary guards ──────────────────────────────────

describe('PRI-42 internalization boundary', () => {
  it('core internalization has zero openclaw-plugin imports', async () => {
    const { existsSync, readdirSync, readFileSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const intDir = resolve(__dirname, '..', 'internalization');
    expect(existsSync(intDir)).toBe(true);

    const files = readdirSync(intDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const file of files) {
      const src = readFileSync(join(intDir, file), 'utf-8');
      expect(src).not.toContain('openclaw-plugin');
      expect(src).not.toContain('../../../openclaw-plugin');
    }
  });

  it('PEAT-B1: evidence-triage has zero openclaw-plugin imports', async () => {
    const { existsSync, readdirSync, readFileSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const triageDir = resolve(__dirname, '..', 'evidence-triage');
    expect(existsSync(triageDir)).toBe(true);

    const files = readdirSync(triageDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const file of files) {
      const src = readFileSync(join(triageDir, file), 'utf-8');
      expect(src).not.toContain('openclaw-plugin');
      expect(src).not.toContain('../../../openclaw-plugin');
    }
  });

  it('PRI-446: pain-gate has zero openclaw-plugin imports', async () => {
    const { existsSync, readdirSync, readFileSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const dir = resolve(__dirname, '..', 'pain-gate');
    expect(existsSync(dir)).toBe(true);

    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const file of files) {
      const src = readFileSync(join(dir, file), 'utf-8');
      expect(src).not.toContain('openclaw-plugin');
      expect(src).not.toContain('../../../openclaw-plugin');
    }
  });

  it('PRI-446: detection has zero openclaw-plugin imports', async () => {
    const { existsSync, readdirSync, readFileSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const dir = resolve(__dirname, '..', 'detection');
    expect(existsSync(dir)).toBe(true);

    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const file of files) {
      const src = readFileSync(join(dir, file), 'utf-8');
      expect(src).not.toContain('openclaw-plugin');
      expect(src).not.toContain('../../../openclaw-plugin');
    }
  });

  it('plugin rule-host.ts imports contracts from core barrel', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const ruleHostPath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/core/rule-host.ts',
    );
    expect(existsSync(ruleHostPath)).toBe(true);
    const src = readFileSync(ruleHostPath, 'utf-8');

    // Must import from @principles/core/runtime-v2, not local rule-host-types
    expect(src).toContain('@principles/core/runtime-v2');
    expect(src).not.toContain("from './rule-host-types.js'");
  });

  it('PRI-436: plugin rule-host.ts does NOT import filesystem ledger or implementation storage', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const ruleHostPath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/core/rule-host.ts',
    );
    expect(existsSync(ruleHostPath)).toBe(true);
    const src = readFileSync(ruleHostPath, 'utf-8');

    // PRI-436: SQLite is the sole RuleHost source. No filesystem imports allowed.
    expect(src).not.toContain("from './principle-tree-ledger.js'");
    expect(src).not.toContain("from './code-implementation-storage.js'");
    expect(src).not.toContain('listImplementationsByLifecycleState');
    expect(src).not.toContain('loadEntrySource');
    expect(src).not.toContain("import * as fs from 'fs'");
  });

  it('plugin gate.ts imports RuleHostInput from core barrel', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const gatePath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/hooks/gate.ts',
    );
    expect(existsSync(gatePath)).toBe(true);
    const src = readFileSync(gatePath, 'utf-8');

    expect(src).toContain('@principles/core/runtime-v2');
    expect(src).not.toContain("from '../core/rule-host-types.js'");
  });

  it('plugin replay-engine.ts imports contracts from core barrel', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const replayPath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/core/replay-engine.ts',
    );
    expect(existsSync(replayPath)).toBe(true);
    const src = readFileSync(replayPath, 'utf-8');

    expect(src).toContain('@principles/core/runtime-v2');
    expect(src).not.toContain("from './rule-host-types.js'");
    expect(src).not.toContain("from './rule-host-helpers.js'");
  });

});

// ── PRI-44: Principle-compiler core boundary ──────────────────────────────────

describe('PRI-44 principle-compiler core boundary', () => {
  it('core template-generator.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'template-generator.ts'), 'utf-8');
    expect(src).not.toContain('node:vm');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('core rule-code-validator.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rule-code-validator.ts'), 'utf-8');
    expect(src).not.toContain('node:vm');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin template-generator.ts re-exports from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-compiler/template-generator.ts'
    ), 'utf-8');
    expect(src).toContain('@principles/core/runtime-v2');
    expect(src).toContain('generateFromTemplate');
  });

  it('plugin code-validator.ts imports checkForbiddenPatterns from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-compiler/code-validator.ts'
    ), 'utf-8');
    expect(src).toContain('checkForbiddenPatterns');
    expect(src).toContain('@principles/core/runtime-v2');
  });

  it('plugin compiler.ts imports CompileResult from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-compiler/compiler.ts'
    ), 'utf-8');
    expect(src).toContain("import type { CompileResult } from '@principles/core/runtime-v2'");
  });
});

// ── PRI-47: Store layer modularization Phase 3 ──────────────────────────────

describe('PRI-47 store modularization Phase 3', () => {
  it('store/candidate/index.ts exists and re-exports CandidateStore + SqliteCandidateStore + MemoryCandidateStore', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'candidate', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('CandidateStore');
    expect(src).toContain('SqliteCandidateStore');
    expect(src).toContain('MemoryCandidateStore');
  });

  it('store/artifact/index.ts exists and re-exports ArtifactStore + SqliteArtifactStore + MemoryArtifactStore', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'artifact', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('ArtifactStore');
    expect(src).toContain('SqliteArtifactStore');
    expect(src).toContain('MemoryArtifactStore');
  });

  it('store/commit/index.ts re-exports CommitStore + SqliteCommitStore + MemoryCommitStore', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'commit', 'index.ts');
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('CommitStore');
    expect(src).toContain('SqliteCommitStore');
    expect(src).toContain('MemoryCommitStore');
  });

  it('store/task/index.ts re-exports MemoryTaskStore', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'task', 'index.ts');
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('MemoryTaskStore');
  });

  it('store/run/index.ts re-exports MemoryRunStore', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'run', 'index.ts');
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('MemoryRunStore');
  });

  it('RuntimeStateManager has zero inline SQL (no db.prepare calls)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'store', 'runtime-state-manager.ts'), 'utf-8');
    expect(src).not.toContain('db.prepare');
  });

  it('Memory*Store test double files exist', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const base = resolve(__dirname, '..', 'store');
    expect(existsSync(resolve(base, 'task', 'memory-task-store.ts'))).toBe(true);
    expect(existsSync(resolve(base, 'run', 'memory-run-store.ts'))).toBe(true);
    expect(existsSync(resolve(base, 'commit', 'memory-commit-store.ts'))).toBe(true);
    expect(existsSync(resolve(base, 'candidate', 'memory-candidate-store.ts'))).toBe(true);
    expect(existsSync(resolve(base, 'artifact', 'memory-artifact-store.ts'))).toBe(true);
  });

  it('Phase 3 M5 types NOT defined inline in runtime-state-manager.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'store', 'runtime-state-manager.ts'), 'utf-8');
    // CommitRecord, CandidateRecord, ArtifactRecord, ArtifactWithCandidates should be re-exported from submodules
    expect(src).not.toMatch(/^export interface CommitRecord/m);
    expect(src).not.toMatch(/^export interface CandidateRecord/m);
    expect(src).not.toMatch(/^export interface ArtifactRecord/m);
    expect(src).not.toMatch(/^export interface ArtifactWithCandidates/m);
  });
});

describe('pd-cli command boundaries', () => {
  it('pain-record.ts does not import createPainSignalBridge or recordPainSignalObservability', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cmdPath = resolve(
      __dirname,
      '../../../../pd-cli/src/commands/pain-record.ts',
    );
    expect(existsSync(cmdPath)).toBe(true);
    const src = readFileSync(cmdPath, 'utf-8');
    expect(src).toContain('PainToPrincipleService');
    expect(src).not.toContain('createPainSignalBridge');
    expect(src).not.toContain('recordPainSignalObservability');
  });

  it('runtime-health-snapshot.ts uses OperatorHealthReadModel (public API)', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cmdPath = resolve(
      __dirname,
      '../../../../pd-cli/src/commands/runtime-health-snapshot.ts',
    );
    expect(existsSync(cmdPath)).toBe(true);
    const src = readFileSync(cmdPath, 'utf-8');
    expect(src).toContain('OperatorHealthReadModel');
    expect(src).not.toContain('auditCandidateLedgerConsistency');
    expect(src).not.toContain('../candidate-audit');
  });

  it('trace.ts does not import RuntimeStateManager or loadLedger', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cmdPath = resolve(
      __dirname,
      '../../../../pd-cli/src/commands/trace.ts',
    );
    expect(existsSync(cmdPath)).toBe(true);
    const src = readFileSync(cmdPath, 'utf-8');
    expect(src).not.toContain('RuntimeStateManager');
    expect(src).not.toContain('loadLedger');
    expect(src).toContain('PainChainReadModel');
  });

  it('health.ts does not import loadLedger', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cmdPath = resolve(
      __dirname,
      '../../../../pd-cli/src/commands/health.ts',
    );
    expect(existsSync(cmdPath)).toBe(true);
    const src = readFileSync(cmdPath, 'utf-8');
    expect(src).not.toContain('loadLedger');
    expect(src).not.toContain('RuntimeStateManager');
    expect(src).toContain('PruningReadModel');
  });

  it('runtime-pruning.ts does not import loadLedger or saveLedger', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cmdPath = resolve(
      __dirname,
      '../../../../pd-cli/src/commands/runtime-pruning.ts',
    );
    expect(existsSync(cmdPath)).toBe(true);
    const src = readFileSync(cmdPath, 'utf-8');
    expect(src).not.toContain('loadLedger');
    expect(src).not.toContain('saveLedger');
    expect(src).not.toContain('RuntimeStateManager');
    expect(src).toContain('removeOrphanReferencesFromLedger');
  });

  it('runtime-internalization-queue.ts does not import RuntimeStateManager', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cmdPath = resolve(
      __dirname,
      '../../../../pd-cli/src/commands/runtime-internalization-queue.ts',
    );
    expect(existsSync(cmdPath)).toBe(true);
    const src = readFileSync(cmdPath, 'utf-8');
    expect(src).not.toContain('RuntimeStateManager');
    expect(src).not.toContain('loadLedger');
    expect(src).toContain('createInternalizationQueueReadModel');
  });

  it('runtime-canary.ts does not import RuntimeStateManager', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cmdPath = resolve(
      __dirname,
      '../../../../pd-cli/src/commands/runtime-canary.ts',
    );
    expect(existsSync(cmdPath)).toBe(true);
    const src = readFileSync(cmdPath, 'utf-8');
    expect(src).not.toContain('RuntimeStateManager');
    expect(src).toContain('createInternalizationQueueReadModel');
  });

  it('runtime-diagnostics-export.ts does not import RuntimeStateManager', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cmdPath = resolve(
      __dirname,
      '../../../../pd-cli/src/commands/runtime-diagnostics-export.ts',
    );
    expect(existsSync(cmdPath)).toBe(true);
    const src = readFileSync(cmdPath, 'utf-8');
    expect(src).not.toContain('RuntimeStateManager');
    expect(src).toContain('createInternalizationQueueReadModel');
  });

  it('runtime-recovery.ts does not import RuntimeStateManager', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cmdPath = resolve(
      __dirname,
      '../../../../pd-cli/src/commands/runtime-recovery.ts',
    );
    expect(existsSync(cmdPath)).toBe(true);
    const src = readFileSync(cmdPath, 'utf-8');
    expect(src).not.toContain('RuntimeStateManager');
    expect(src).toContain('createRecoverySweepService');
  });
});

// ── PRI-198: RuntimeStateHandle lifecycle facade ────────────────────────────

describe('PRI-198 RuntimeStateHandle lifecycle facade', () => {
  it('runtime-state-handle.ts source file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const filePath = resolve(__dirname, '..', 'runtime-state-handle.ts');
    expect(existsSync(filePath)).toBe(true);
  });

  it('internalization-queue-read-model.ts does not import RuntimeStateManager directly', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization-queue-read-model.ts'), 'utf-8');
    expect(src).not.toContain("from './store/runtime-state-manager.js'");
    expect(src).toContain("from './runtime-state-handle.js'");
  });

  it('recovery-sweep-service.ts does not import RuntimeStateManager directly', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'recovery-sweep-service.ts'), 'utf-8');
    expect(src).not.toContain("from './store/runtime-state-manager.js'");
    expect(src).toContain("from './runtime-state-handle.js'");
  });

  it('barrel exports createRuntimeStateHandle and RuntimeStateHandle', async () => {
    const mod = (await import('../index.js')) as Record<string, unknown>;
    expect(mod).toHaveProperty('createRuntimeStateHandle');
  });
});

// ── PRI-45: RuleHost adapter boundary ────────────────────────────────────────

describe('PRI-45 RuleHost adapter boundary', () => {
  it('core rule-host-evaluator.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rule-host-evaluator.ts'), 'utf-8');
    expect(src).not.toContain('node:vm');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('core rule-host-adapter.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rule-host-adapter.ts'), 'utf-8');
    expect(src).not.toContain('node:vm');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin rule-host.ts imports mergeDecisions from core barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/rule-host.ts'
    ), 'utf-8');
    expect(src).toContain('mergeDecisions');
    expect(src).toContain('@principles/core/runtime-v2');
  });

  it('plugin rule-host.ts evaluate method delegates to mergeDecisions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/rule-host.ts'
    ), 'utf-8');
    expect(src).toContain('const liveDecision = mergeDecisions(');
    expect(src).toContain('return this.evaluateDetailed(input).liveDecision');
  });
});

// ── PRI-47: Store layer modularization Phase 1 ──────────────────────────────

describe('PRI-47 store modularization', () => {
  it('store/task/index.ts exists and re-exports TaskStore + SqliteTaskStore', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'task', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('TaskStore');
    expect(src).toContain('SqliteTaskStore');
  });

  it('store/run/index.ts exists and re-exports RunStore + SqliteRunStore', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'run', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('RunStore');
    expect(src).toContain('SqliteRunStore');
  });

  it('store/commit/index.ts exists and re-exports DiagnosticianCommitter', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'commit', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('DiagnosticianCommitter');
    expect(src).toContain('CommitInput');
    expect(src).toContain('CommitResult');
  });

  it('Phase 1 moved files are NOT in root store/ directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const storeDir = resolve(__dirname, '..', 'store');
    // Phase 1: These files should have been moved to subdirectories
    expect(existsSync(resolve(storeDir, 'task-store.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'sqlite-task-store.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'run-store.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'sqlite-run-store.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'diagnostician-committer.ts'))).toBe(false);
  });
});

// ── PRI-47: Store layer modularization Phase 2 ──────────────────────────────

describe('PRI-47 store modularization Phase 2', () => {
  it('store/context/index.ts exists and re-exports ContextAssembler + implementations', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'context', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('ContextAssembler');
    expect(src).toContain('SqliteContextAssembler');
    expect(src).toContain('ResilientContextAssembler');
  });

  it('store/history/index.ts exists and re-exports HistoryQuery + implementations', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'history', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('HistoryQuery');
    expect(src).toContain('SqliteHistoryQuery');
    expect(src).toContain('ResilientHistoryQuery');
  });

  it('store/trajectory/index.ts exists and re-exports TrajectoryLocator + implementation', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'trajectory', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('TrajectoryLocator');
    expect(src).toContain('SqliteTrajectoryLocator');
  });

  it('store/lifecycle/index.ts exists and re-exports lease/retry/recovery', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'lifecycle', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('LeaseManager');
    expect(src).toContain('DefaultLeaseManager');
    expect(src).toContain('DefaultRetryPolicy');
    expect(src).toContain('DefaultRecoverySweep');
  });

  it('Phase 2 moved files are NOT in root store/ directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const storeDir = resolve(__dirname, '..', 'store');
    // Phase 2: context
    expect(existsSync(resolve(storeDir, 'context-assembler.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'sqlite-context-assembler.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'resilient-context-assembler.ts'))).toBe(false);
    // Phase 2: history
    expect(existsSync(resolve(storeDir, 'history-query.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'sqlite-history-query.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'resilient-history-query.ts'))).toBe(false);
    // Phase 2: trajectory
    expect(existsSync(resolve(storeDir, 'trajectory-locator.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'sqlite-trajectory-locator.ts'))).toBe(false);
    // Phase 2: lifecycle
    expect(existsSync(resolve(storeDir, 'lease-manager.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'retry-policy.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'recovery-sweep.ts'))).toBe(false);
  });

  it('barrel still exports all store symbols', async () => {
    const mod = (await import('../index.js')) as Record<string, unknown>;
    const storeSymbols = [
      'SqliteTaskStore', 'SqliteRunStore', 'SqliteConnection',
      'SqliteTrajectoryLocator', 'SqliteHistoryQuery', 'SqliteContextAssembler',
      'SqliteDiagnosticianCommitter',
      'ResilientContextAssembler', 'ResilientHistoryQuery',
      'DefaultLeaseManager', 'DefaultRetryPolicy', 'DefaultRecoverySweep',
      'StoreEventEmitter', 'storeEmitter',
      'RuntimeStateManager',
      'DEFAULT_HISTORY_PAGE_SIZE', 'MAX_HISTORY_PAGE_SIZE', 'DEFAULT_TIME_WINDOW_MS',
    ];
    for (const sym of storeSymbols) {
      expect(mod).toHaveProperty(sym);
    }
  });

  it('barrel exports Memory*Store test doubles', async () => {
    const mod = (await import('../index.js')) as Record<string, unknown>;
    const memoryStores = [
      'MemoryTaskStore', 'MemoryRunStore', 'MemoryCommitStore',
      'MemoryCandidateStore', 'MemoryArtifactStore',
    ];
    for (const sym of memoryStores) {
      expect(mod).toHaveProperty(sym);
    }
  });
});

// ── PRI-51: Lifecycle type extraction ────────────────────────────────────────

describe('PRI-51 lifecycle type extraction', () => {
  const LIFECYCLE_TYPES = [
    'LifecycleClassificationTotals',
    'RuleReplayEvidence',
    'RuleLiveEvidence',
    'RuleLineageEvidence',
    'ImplementationLifecycleEvidence',
    'RuleLifecycleEvidence',
    'PrincipleLifecycleEvidence',
    'LifecycleReadModel',
  ];

  const ENUM_TYPES = [
    'PrinciplePriority',
    'PrincipleEvaluability',
    'RuleType',
    'RuleStatus',
    'ImplementationLifecycleState',
    'ImplementationType',
    'SampleClassification',
  ];

  it('core exports all lifecycle types from barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    for (const name of LIFECYCLE_TYPES) {
      expect(src).toContain(name);
    }
  });

  it('core exports all enum types from barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    for (const name of ENUM_TYPES) {
      expect(src).toContain(name);
    }
  });

  it('lifecycle-types.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'lifecycle-types.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin lifecycle-read-model.ts re-exports types from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-internalization/lifecycle-read-model.ts'
    ), 'utf-8');
    expect(src).toContain('@principles/core/runtime-v2');
    expect(src).toContain('buildLifecycleReadModel');
  });

  it('plugin principle-tree-schema.ts re-exports enums from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/types/principle-tree-schema.ts'
    ), 'utf-8');
    expect(src).toContain("from '@principles/core/runtime-v2'");
    // Should no longer define these locally
    expect(src).not.toMatch(/^export type PrinciplePriority = /m);
    expect(src).not.toMatch(/^export type RuleType = /m);
  });

  it('plugin principle-tree-schema.ts re-exports Rule and Implementation from core (no local re-definition)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/types/principle-tree-schema.ts'
    ), 'utf-8');
    expect(src).toContain("Rule");
    expect(src).toContain("Implementation");
    expect(src).not.toMatch(/^export interface Rule \{/m);
    expect(src).not.toMatch(/^export interface Implementation \{/m);
  });
});

// ── PRI-52: Lifecycle metrics extraction ──────────────────────────────────────

describe('PRI-52 lifecycle metrics', () => {
  it('core exports all lifecycle metrics from barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('RuleMetricResult');
    expect(src).toContain('PrincipleAdherenceResult');
    expect(src).toContain('computeRuleMetrics');
    expect(src).toContain('computePrincipleAdherence');
  });

  it('lifecycle-metrics.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'lifecycle-metrics.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin principle-lifecycle-service.ts imports lifecycle metrics from core barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-internalization/principle-lifecycle-service.ts'
    ), 'utf-8');
    expect(src).toContain("from '@principles/core/runtime-v2'");
    expect(src).toContain('computeRuleMetrics');
    expect(src).toContain('computePrincipleAdherence');
  });
});

// ── PRI-53: Deprecated readiness extraction ──────────────────────────────────

describe('PRI-53 deprecated readiness', () => {
  it('core exports all readiness types/functions from barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('DeprecatedReadinessStatus');
    expect(src).toContain('DeprecatedReadinessAssessment');
    expect(src).toContain('assessDeprecatedReadiness');
  });

  it('deprecated-readiness.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'deprecated-readiness.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin principle-lifecycle-service.ts imports deprecated readiness from core barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-internalization/principle-lifecycle-service.ts'
    ), 'utf-8');
    expect(src).toContain("from '@principles/core/runtime-v2'");
    expect(src).toContain('assessDeprecatedReadiness');
    expect(src).toContain('DeprecatedReadinessAssessment');
  });
});

// ── PRI-54: Routing policy extraction ──────────────────────────────────────────

describe('PRI-54 routing policy', () => {
  it('core exports all routing policy types/functions from barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('LifecycleRoute');
    expect(src).toContain('LifecycleRouteRecommendation');
    expect(src).toContain('LifecycleRouteEvidenceSummary');
    expect(src).toContain('recommendLifecycleRoute');
  });

  it('routing-policy.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'routing-policy.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin principle-lifecycle-service.ts imports routing policy from core barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-internalization/principle-lifecycle-service.ts'
    ), 'utf-8');
    expect(src).toContain("from '@principles/core/runtime-v2'");
    expect(src).toContain('recommendLifecycleRoute');
    expect(src).toContain('LifecycleRouteRecommendation');
  });
});

// ── PRI-56: LifecycleDatasource adapter boundary ──────────────────────────────

describe('PRI-56 LifecycleDatasource adapter boundary', () => {
  it('core exports LifecycleDatasource + buildLifecycleReadModel from barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('LifecycleDatasource');
    expect(src).toContain('buildLifecycleReadModel');
  });

  it('lifecycle-datasource.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'lifecycle-datasource.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('lifecycle-read-model.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'lifecycle-read-model.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin lifecycle-read-model.ts re-exports from core and provides FilesystemLifecycleDatasource', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-internalization/lifecycle-read-model.ts'
    ), 'utf-8');
    expect(src).toContain("from '@principles/core/runtime-v2'");
    expect(src).toContain('buildLifecycleReadModel');
    expect(src).toContain('FilesystemLifecycleDatasource');
  });

  it('plugin principle-lifecycle-service.ts delegates buildReadModel via datasource', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-internalization/principle-lifecycle-service.ts'
    ), 'utf-8');
    expect(src).toContain('FilesystemLifecycleDatasource');
    expect(src).toContain('buildLifecycleReadModel');
  });
});

// ── PRI-61: Internalization Peer Runner Contracts ─────────────────────────────

describe('PRI-61 Internalization Peer Runner Contracts', () => {
  it('core barrel exports PITaskRecord and related types', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('PITaskRecord');
    expect(src).toContain('PeerRunnerKind');
    expect(src).toContain('InternalizationChannel');
    expect(src).toContain('PIArtifact');
  });

  it('core barrel exports job graph functions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('validateEdge');
    expect(src).toContain('isAcyclic');
    expect(src).toContain('getAllowedSuccessors');
    expect(src).toContain('ALLOWED_EDGES');
  });

  it('peer-runner-contracts.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'peer-runner-contracts.ts'
    ), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
        expect(src).not.toContain('node:cron');
  });

  it('internalization-job-graph.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'internalization-job-graph.ts'
    ), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
        expect(src).not.toContain('node:cron');
  });

  it('TASK_MODEL_REUSE: PITaskRecord extends TaskRecord (type-level check)', async () => {
    // PITaskRecord is an interface (type-only export). Type-level check:
    // if PITaskRecord didn't extend TaskRecord, TypeScript would error in the
    // peer-runner-contracts.ts definition at compile time.
    // We verify the module exports the type by checking the source file.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'peer-runner-contracts.ts'
    ), 'utf-8');
    // If PITaskRecord doesn't extend TaskRecord, this interface definition would fail
    expect(src).toContain('interface PITaskRecord extends TaskRecord');
  });

  it('PEER_NO_DIRECT_CHAINING: job graph defines edge validation only, no execution', async () => {
    const { validateEdge, ALLOWED_EDGES } = await import('../internalization/internalization-job-graph.js');
    // validateEdge is a pure function — no side effects, no execution
    expect(typeof validateEdge).toBe('function');
    expect(Array.isArray(ALLOWED_EDGES)).toBe(true);
    // Edge validation is read-only — no task creation or state mutation
    const result = validateEdge('dreamer', 'philosopher');
    expect(typeof result).toBe('boolean');
  });
});

// ── PRI-62: Internalization State Machine Guards ─────────────────────────────

describe('PRI-62 Internalization State Machine Guards', () => {
  it('core barrel exports state machine guard functions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('validateInternalizationTaskReady');
    expect(src).toContain('validateTaskTransition');
    expect(src).toContain('decideArtifactRejectionFeedback');
    expect(src).toContain('createNextTaskProposal');
    expect(src).toContain('validateInternalizationGraph');
  });

  it('core barrel exports guard utility functions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('canAcquireLease');
    expect(src).toContain('areDependenciesMet');
    expect(src).toContain('canTransitionTo');
    expect(src).toContain('isResultRefImmutable');
    expect(src).toContain('canUpdateLastError');
    expect(src).toContain('isArtifactRejected');
  });

  it('internalization-task-guards.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'internalization-task-guards.ts'
    ), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
        expect(src).not.toContain('node:cron');
  });

  it('internalization-state-machine.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'internalization-state-machine.ts'
    ), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
        expect(src).not.toContain('node:cron');
  });

  it('TASK_MODEL_REUSE: guard functions work with PITaskRecord (type-level check)', async () => {
    // If PITaskRecord didn't properly extend TaskRecord, TypeScript would error
    // at compile time in peer-runner-contracts.ts and internalization-task-guards.ts
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'internalization-task-guards.ts'
    ), 'utf-8');
    expect(src).toContain('task: PITaskRecord');
  });

  it('PEER_NO_DIRECT_CHAINING: state machine returns proposals, not execute calls', async () => {
    const { createNextTaskProposal } = await import('../internalization/internalization-state-machine.js');
    // Pure function — returns an object, no side effects
    const { createMinimalPITaskRecord } = await import('../internalization/peer-runner-contracts.js');
    const task = createMinimalPITaskRecord('t1', 'dreamer', 'prompt');
    task.status = 'succeeded';
    task.outputArtifactRefs = [];
    const result = createNextTaskProposal(task, []);
    expect(result === null || typeof result === 'object').toBe(true);
  });
});

describe('PRI-68 InternalizationOrchestrator', () => {
  it('orchestrator source file exists in internalization directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'internalization-orchestrator.ts'))).toBe(true);
  });

  it('orchestrator test file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', '__tests__', 'internalization-orchestrator.test.ts'))).toBe(true);
  });

  it('CORE_NO_SCHEDULING: orchestrator has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'internalization-orchestrator.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
        expect(src).not.toContain('node:cron');
    expect(src).not.toContain('setInterval');
    expect(src).not.toContain('setTimeout');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
  });

  it('CORE_NO_RUNTIME_ADAPTER: orchestrator does not import PDRuntimeAdapter or startRun', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'internalization-orchestrator.ts'), 'utf-8');
    expect(src).not.toContain('PDRuntimeAdapter');
    expect(src).not.toContain('startRun');
    expect(src).not.toContain('DiagnosticianRunner');
  });

  it('BARREL_EXPORTS: internalization/index.ts exports InternalizationOrchestrator and result types', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('InternalizationOrchestrator');
    expect(src).toContain('WakeOnceResult');
    expect(src).toContain('LeaseConflictResult');
  });
});

describe('PRI-67 DreamerRunner', () => {
  it('dreamer source files exist in internalization directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'dreamer-runner.ts'))).toBe(true);
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'dreamer-output.ts'))).toBe(true);
  });

  it('dreamer test file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', '__tests__', 'dreamer-runner.test.ts'))).toBe(true);
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: dreamer-runner.ts has no openclaw-plugin, nocturnal-trinity, philosopher, scribe imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'dreamer-runner.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('nocturnal-trinity');
    expect(src).not.toContain('runTrinity');
    expect(src).not.toContain('philosopher');
    expect(src).not.toContain('scribe');
    expect(src).not.toContain('InternalizationOrchestrator');
    expect(src).not.toContain('createTask');
    expect(src).not.toContain('enqueueTask');
  });

  it('CORE_NO_SCHEDULING: dreamer-runner.ts has no node:fs, node:cron, or cron-style scheduling', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'dreamer-runner.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:cron');
    // setTimeout for sleep() in polling loop is allowed — no cron/interval scheduling
  });

  it('USES_RUNTIME_ADAPTER: dreamer-runner.ts imports and uses PDRuntimeAdapter', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'dreamer-runner.ts'), 'utf-8');
    expect(src).toContain('PDRuntimeAdapter');
    expect(src).toContain('startRun');
  });

  it('BARREL_EXPORTS: internalization/index.ts exports DreamerRunner and DreamerOutput', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'index.ts'), 'utf-8');
    expect(src).toContain('DreamerRunner');
    expect(src).toContain('DreamerOutput');
    expect(src).toContain('PassThroughDreamerValidator');
    expect(src).toContain('DefaultDreamerValidator');
  });
});

// ── PRI-87: DefaultDreamerValidator strict validation ───────────────────────────

describe('PRI-87 DefaultDreamerValidator strict validation', () => {
  it('CORE_NO_FORBIDDEN_IMPORTS: dreamer-output.ts has no openclaw-plugin, nocturnal, fs, path, process imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'dreamer-output.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('nocturnal');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
  });

  it('PRODUCTION_USES_STRICT_VALIDATOR: run-once CLI uses DefaultDreamerValidator, not PassThroughDreamerValidator', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', '..', '..', '..', 'pd-cli', 'src', 'commands', 'runtime-internalization-run-once.ts'
    ), 'utf-8');
    expect(src).toContain('DefaultDreamerValidator');
    expect(src).not.toContain('new PassThroughDreamerValidator()');
  });

  it('BARREL_EXPORTS: DefaultDreamerValidator is exported from internalization/index.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'index.ts'), 'utf-8');
    expect(src).toContain('DefaultDreamerValidator');
  });

  it('validator test file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', '__tests__', 'dreamer-output-validator.test.ts'))).toBe(true);
  });
});

// ── PRI-75/PRI-74/PRI-81: Prompt-builder core boundary ─────────────────────────────────

describe('PRI-75/PRI-74/PRI-81 prompt-builder core boundary', () => {
  const files = [
    'prompt-builder/index.ts',
    'prompt-builder/attitude-directive.ts',
    'prompt-builder/correction-cue.ts',
    'prompt-builder/message-extraction.ts',
    'prompt-builder/minimal-trigger.ts',
    'prompt-builder/size-guard.ts',
    'prompt-builder/types.ts',
    'prompt-builder/principle-selection.ts',
    // PRI-74
    'prompt-builder/routing-guidance.ts',
    // PRI-81 Phase A
    'prompt-builder/empathy-keyword-matching.ts',
    'prompt-builder/empathy-types.ts',
    // PRI-81 Phase B
    'prompt-builder/focus-compression.ts',
  ];

  for (const file of files) {
    it(`${file} has zero infrastructure imports`, async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(resolve(__dirname, '../..', file), 'utf-8');
      expect(src).not.toContain('node:fs');
      expect(src).not.toContain('node:path');
      expect(src).not.toContain('node:process');
      expect(src).not.toContain('openclaw-plugin');
    });
  }

  it('prompt-builder/index.ts exports all functions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../..', 'prompt-builder/index.ts'), 'utf-8');
    // Phase 1
    expect(src).toContain('buildAttitudeDirective');
    expect(src).toContain('detectCorrectionCue');
    expect(src).toContain('extractMessageContent');
    expect(src).toContain('isMinimalTrigger');
    expect(src).toContain('truncateInjectionToBudget');
    // Phase 2
    expect(src).toContain('formatPrinciple');
    expect(src).toContain('selectPrinciplesForInjection');
    expect(src).toContain('DEFAULT_PRINCIPLE_BUDGET');
    // PRI-74 routing guidance
    expect(src).toContain('classifyTaskKind');
    expect(src).toContain('buildReason');
    expect(src).toContain('buildBlockers');
    expect(src).toContain('computeCombinedText');
    expect(src).toContain('containsKeyword');
    // PRI-81 Phase A: empathy keyword matching
    expect(src).toContain('matchEmpathyKeywords');
    expect(src).toContain('createDefaultKeywordStore');
    expect(src).toContain('applyKeywordUpdates');
    expect(src).toContain('shouldTriggerOptimization');
    expect(src).toContain('getKeywordStoreSummary');
    expect(src).toContain('EMPATHY_SEED_KEYWORDS');
    expect(src).toContain('DEFAULT_EMPATHY_KEYWORD_CONFIG');
    expect(src).toContain('scoreToSeverity');
    expect(src).toContain('severityToPenalty');
    expect(src).toContain('normalizeSeverity');
    // PRI-81 Phase B: focus compression
    expect(src).toContain('extractVersion');
    expect(src).toContain('extractDate');
    expect(src).toContain('extractSummary');
    expect(src).toContain('parseWorkingMemorySection');
    expect(src).toContain('workingMemoryToInjection');
    expect(src).toContain('extractMilestones');
    expect(src).toContain('validateCurrentFocus');
    expect(src).toContain('mergeWorkingMemory');
    expect(src).toContain('compressFocusContent');
    expect(src).toContain('DEFAULT_FOCUS_COMPRESSION_OPTIONS');
  });

  it('principle-selection.ts does not import EvolutionReducer or WorkspaceContext', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../..', 'prompt-builder/principle-selection.ts'), 'utf-8');
    expect(src).not.toContain('EvolutionReducer');
    expect(src).not.toContain('WorkspaceContext');
  });

  it('plugin principle-injection.ts is a thin re-export of core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../openclaw-plugin/src/core/principle-injection.ts'), 'utf-8');
    // Must re-export from core
    expect(src).toContain('@principles/core/prompt-builder');
    // Must NOT contain inline selectPrinciplesForInjection implementation
    expect(src).not.toMatch(/function selectPrinciplesForInjection/i);
    // Must NOT contain priority sorting logic
    expect(src).not.toMatch(/PRIORITY_ORDER/i);
  });

  it('plugin prompt.ts imports from @principles/core/prompt-builder', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../openclaw-plugin/src/hooks/prompt.ts'), 'utf-8');
    expect(src).toContain('@principles/core/prompt-builder');
  });

  it('plugin prompt.ts uses core truncateInjectionToBudget, not inline priority stripping', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../openclaw-plugin/src/hooks/prompt.ts'), 'utf-8');
    // Must call the core function
    expect(src).toMatch(/truncateInjectionToBudget\s*\(/);
    // Must NOT have inline priority stripping comment markers (old step comments)
    expect(src).not.toMatch(/\/\/ Step \d+.*strip (project_context|thinking_os|evolution_principles|reflection_log)/i);
    // Must NOT have inline regex-based fallback context block (the strip-by-regex pattern)
    expect(src).not.toMatch(/<reflection_log>\[\\s\\S\]\*?<\/reflection_log>/);
    // Must NOT have the old multi-line fallback block with attitudeDirective interpolation
    expect(src).not.toMatch(/## 【CONTEXT SECTIONS】\n\n\[WARNING: Context sections stripped/);
  });

  it('plugin prompt-helpers.ts imports escapeXml from core, not reimplemented', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../openclaw-plugin/src/hooks/prompt-helpers.ts'), 'utf-8');
    // Must import escapeXml from core
    expect(src).toContain('@principles/core/prompt-builder');
    expect(src).toMatch(/import\s*\{[^}]*escapeXml[^}]*\}\s*from\s*['"]@principles\/core\/prompt-builder['"]/);
    // Must NOT reimplement escapeXml inline
    expect(src).not.toMatch(
      /\b(function\s+escapeXml\s*\(|const\s+escapeXml\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>)/,
    );
  });

  it('plugin empathy-keyword-matcher.ts is a thin adapter (re-exports from core)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../openclaw-plugin/src/core/empathy-keyword-matcher.ts'), 'utf-8');
    expect(src).toContain('@principles/core/prompt-builder');
    expect(src).not.toMatch(/function matchEmpathyKeywords\s*\(/);
    expect(src).not.toMatch(/function createDefaultKeywordStore\s*\(/);
    expect(src).not.toMatch(/function applyKeywordUpdates\s*\(/);
    expect(src).not.toMatch(/function shouldTriggerOptimization\s*\(/);
    expect(src).not.toMatch(/function getKeywordStoreSummary\s*\(/);
  });

  it('plugin empathy-types.ts is a thin re-export (no inline definitions)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../openclaw-plugin/src/core/empathy-types.ts'), 'utf-8');
    expect(src).toContain('@principles/core/prompt-builder');
    expect(src).not.toMatch(/interface EmpathyKeywordStore/);
    expect(src).not.toMatch(/const EMPATHY_SEED_KEYWORDS/);
    expect(src).not.toMatch(/function scoreToSeverity/);
  });

  it('plugin focus-history.ts delegates pure functions to core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../openclaw-plugin/src/core/focus-history.ts'), 'utf-8');
    expect(src).toContain('@principles/core/prompt-builder');
    expect(src).not.toMatch(/function extractSummary\s*\(/);
    expect(src).not.toMatch(/function parseWorkingMemorySection\s*\(/);
    expect(src).not.toMatch(/function workingMemoryToInjection\s*\(/);
    expect(src).not.toMatch(/function extractMilestones\s*\(/);
    expect(src).not.toMatch(/function validateCurrentFocus\s*\(/);
    expect(src).not.toMatch(/function mergeWorkingMemory\s*\(/);
  });
});

// ── PRI-76: GFI core kernel boundary ───────────────────────────────────────

describe('PRI-76 GFI core kernel boundary', () => {
  const gfiFiles = [
    'gfi/gfi-types.ts',
    'gfi/gfi-policy.ts',
    'gfi/gfi-kernel.ts',
    'gfi/gfi-read-model.ts',
    'gfi/index.ts',
  ];

  for (const file of gfiFiles) {
    it(`${file} has zero infrastructure imports`, async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(resolve(__dirname, '..', file), 'utf-8');
      expect(src).not.toContain('node:fs');
      expect(src).not.toContain('node:path');
      expect(src).not.toContain('node:process');
      expect(src).not.toContain('openclaw-plugin');
      expect(src).not.toContain('node:crypto');
      expect(src).not.toContain('node:async_hooks');
    });
  }

  // PRI-82: gfi-kernel.ts must not call Date.now() — nowMs is injected by caller
  it('gfi-kernel.ts does not call Date.now()', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'gfi/gfi-kernel.ts'), 'utf-8');
    expect(src).not.toContain('Date.now()');
  });

  it('gfi/index.ts exports all public symbols', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'gfi/index.ts'), 'utf-8');
    expect(src).toContain('applyFriction');
    expect(src).toContain('applyDecay');
    expect(src).toContain('applyRelief');
    expect(src).toContain('classifyGfiStage');
    expect(src).toContain('createGfiSnapshot');
    expect(src).toContain('DEFAULT_GFI_POLICY');
    expect(src).toContain('GfiState');
    expect(src).toContain('GfiEvent');
    expect(src).toContain('GfiPolicy');
    expect(src).toContain('GfiStage');
    expect(src).toContain('GfiSource');
    expect(src).toContain('GfiSnapshot');
    expect(src).toContain('buildGfiWorkspaceSnapshot');
    expect(src).toContain('GfiReadModelInput');
    expect(src).toContain('GfiWorkspaceSnapshot');
  });
});

// ── PRI-78: GFI observability boundary ──────────────────────────────────────

describe('PRI-78 GFI observability boundary', () => {
  it('gfi-read-model.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'gfi/gfi-read-model.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('pd-cli runtime-gfi-snapshot.ts imports from @principles/core/runtime-v2', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(__dirname, '../../../../pd-cli/src/commands/runtime-gfi-snapshot.ts'),
      'utf-8'
    );
    expect(src).toContain("from '@principles/core/runtime-v2'");
  });
});

// ── PRI-111: ArtificerRunner boundary guards ──────────────────────────────────

describe('PRI-111 ArtificerRunner boundary', () => {
  it('artificer source files exist in internalization directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'artificer-runner.ts'))).toBe(true);
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'artificer-output.ts'))).toBe(true);
  });

  it('artificer test file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, 'artificer-runner-vslice.test.ts'))).toBe(true);
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: artificer-runner.ts has no openclaw-plugin, evaluator, nocturnal-trinity imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'artificer-runner.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('EvaluatorRunner');
    expect(src).not.toContain('nocturnal-trinity');
    expect(src).not.toContain('InternalizationOrchestrator');
    expect(src).not.toContain('createTask');
    expect(src).not.toContain('enqueueTask');
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: artificer-output.ts has no openclaw-plugin, fs, path imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'artificer-output.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
  });

  it('CORE_NO_SCHEDULING: artificer-runner.ts has no node:fs, node:cron, or cron-style scheduling', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'artificer-runner.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:cron');
  });

  it('BARREL_EXPORTS: internalization/index.ts exports ArtificerRunner and ArtificerRuleOutput', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'index.ts'), 'utf-8');
    expect(src).toContain('ArtificerRunner');
    expect(src).toContain('ArtificerRuleOutput');
    expect(src).toContain('DefaultArtificerValidator');
  });

  it('SCHEMA_REGISTRY: shared output-schema-registry registers unified artificer-rule-output-v2 schema', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    // The registry was extracted to adapter/output-schema-registry.ts (single
    // source of truth shared by pi-ai and openclaw-cli adapters). Assert there.
    const src = readFileSync(resolve(__dirname, '..', 'adapter', 'output-schema-registry.ts'), 'utf-8');
    expect(src).toContain('artificer-rule-output-v2');
    expect(src).not.toContain('artificer-rule-output-v1');
    expect(src).toContain('ArtificerRuleOutputSchema');
  });
});

// ── PRI-458: PhilosopherRunner barrel boundary (MVP-Quiet) ─────────────────────

describe('PRI-458 PhilosopherRunner barrel boundary', () => {
  it('BARREL_EXPORTS: internalization/index.ts does NOT export PhilosopherRunner (PRI-458 MVP-Quiet)', async () => {
    // PRI-458: PhilosopherRunner is de-surfaced from the internal barrel (MVP-Quiet).
    // It remains in runtime-v2/index.ts (public barrel) because rulehost-pipeline-runner.ts
    // imports it from there (EP-02 exception).
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'index.ts'), 'utf-8');
    expect(src).not.toContain("from './philosopher-runner.js'");
    expect(src).not.toContain("from './philosopher-output.js'");
  });
});

// ── PRI-EVAL: EvaluatorRunner boundary guards ──────────────────────────────────

describe('PRI-EVAL EvaluatorRunner boundary', () => {
  it('evaluator source files exist in internalization directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'evaluator-runner.ts'))).toBe(true);
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'evaluator-output.ts'))).toBe(true);
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'evaluator-prompt-builder.ts'))).toBe(true);
  });

  it('evaluator test file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, 'evaluator-runner-vslice.test.ts'))).toBe(true);
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: evaluator-output.ts has no openclaw-plugin, fs, path imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'evaluator-output.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: evaluator-runner.ts has no openclaw-plugin, RolloutReviewerRunner, nocturnal-trinity imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'evaluator-runner.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('RolloutReviewerRunner');
    expect(src).not.toContain('nocturnal-trinity');
    expect(src).not.toContain('InternalizationOrchestrator');
    expect(src).not.toContain('createTask');
    expect(src).not.toContain('enqueueTask');
  });

  it('CORE_NO_SCHEDULING: evaluator-runner.ts has no node:fs, node:cron imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'evaluator-runner.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:cron');
  });

  it('BARREL_EXPORTS: internalization/index.ts does NOT export EvaluatorRunner (PRI-458 MVP-Quiet)', async () => {
    // PRI-458: EvaluatorRunner is de-surfaced from the internal barrel (MVP-Quiet).
    // It remains in runtime-v2/index.ts (public barrel) because rulehost-pipeline-runner.ts
    // imports it from there (EP-02 exception). These negative assertions lock the boundary:
    // if someone re-aggregates the evaluator exports into this barrel, the test will fail.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'index.ts'), 'utf-8');
    expect(src).not.toContain("from './evaluator-runner.js'");
    expect(src).not.toContain("from './evaluator-output.js'");
    expect(src).not.toContain("from './evaluator-prompt-builder.js'");
  });

  it('SCHEMA_REGISTRY: shared output-schema-registry registers evaluator-output-v1 schema', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'adapter', 'output-schema-registry.ts'), 'utf-8');
    expect(src).toContain('evaluator-output-v1');
    expect(src).toContain('EvaluatorOutputV1Schema');
  });
});

// ── PRI-RR: RolloutReviewerRunner boundary guards ──────────────────────────────

describe('PRI-RR RolloutReviewerRunner boundary', () => {
  it('rollout_reviewer source files exist in internalization directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'rollout-reviewer-runner.ts'))).toBe(true);
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'rollout-reviewer-output.ts'))).toBe(true);
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'rollout-reviewer-prompt-builder.ts'))).toBe(true);
  });

  it('rollout_reviewer test file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, 'rollout-reviewer-runner-vslice.test.ts'))).toBe(true);
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: rollout-reviewer-output.ts has no openclaw-plugin, fs, path imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rollout-reviewer-output.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: rollout-reviewer-runner.ts has no openclaw-plugin, TrainerRunner, nocturnal-trinity imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rollout-reviewer-runner.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('TrainerRunner');
    expect(src).not.toContain('nocturnal-trinity');
    expect(src).not.toContain('InternalizationOrchestrator');
    expect(src).not.toContain('createTask');
    expect(src).not.toContain('enqueueTask');
  });

  it('CORE_NO_SCHEDULING: rollout-reviewer-runner.ts has no node:fs, node:cron imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rollout-reviewer-runner.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:cron');
  });

  it('BARREL_EXPORTS: internalization/index.ts does NOT export RolloutReviewerRunner (PRI-458 MVP-Quiet)', async () => {
    // PRI-458: RolloutReviewerRunner is de-surfaced from the internal barrel (MVP-Quiet).
    // It remains in runtime-v2/index.ts (public barrel) because runtime-internalization-run-once.ts
    // imports it from there and package.json has no deep import path available (EP-02 exception).
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'index.ts'), 'utf-8');
    expect(src).not.toContain("from './rollout-reviewer-runner.js'");
    expect(src).not.toContain("from './rollout-reviewer-output.js'");
    expect(src).not.toContain("from './rollout-reviewer-prompt-builder.js'");
  });

  it('SCHEMA_REGISTRY: shared output-schema-registry registers rollout-reviewer-output-v1 schema', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'adapter', 'output-schema-registry.ts'), 'utf-8');
    expect(src).toContain('rollout-reviewer-output-v1');
    expect(src).toContain('RolloutReviewerOutputV1Schema');
  });
});

describe('PRI-114: correction-proposal boundary', () => {
  it('CORE_PURE: correction-proposal.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'correction-proposal.ts'), 'utf-8');
    expect(src).not.toContain('node:vm');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('require(');
  });

  it('CONTRACT_IMPORT: rule-host-contracts.ts imports CorrectionProposal from same directory', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rule-host-contracts.ts'), 'utf-8');
    expect(src).toContain("from './correction-proposal.js'");
  });

  it('EVALUATOR_IMPORT: rule-host-evaluator.ts imports validateCorrectionProposal from same directory', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rule-host-evaluator.ts'), 'utf-8');
    expect(src).toContain("from './correction-proposal.js'");
    expect(src).toContain('validateCorrectionProposal');
  });

  it('BARREL_EXPORTS: runtime-v2/index.ts exports CorrectionProposal and validators', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('CorrectionProposal');
    expect(src).toContain('validateProposedParams');
    expect(src).toContain('validateCorrectionProposal');
    expect(src).toContain("from './internalization/correction-proposal.js'");
  });
});

// ── PRI-172: Refiner Sandbox Wrapper boundary ────────────────────────────

describe('PRI-172: refiner-sandbox-wrapper boundary', () => {
  it('CORE_PURE: refiner-sandbox-wrapper.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'refiner-sandbox-wrapper.ts'), 'utf-8');
    const importLines = src.split('\n').filter((line) => line.trim().startsWith('import'));
    const vmImports = importLines.filter((line) => line.includes('node:vm'));
    expect(vmImports).toEqual([]);
    const fsImports = importLines.filter((line) => line.includes('node:fs'));
    expect(fsImports).toEqual([]);
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('eval(');
    expect(src).not.toContain('new Function');
  });

  it('BARREL_EXPORTS: runtime-v2/index.ts exports RefinerSandboxResult and evaluateInRefinerSandbox', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('evaluateInRefinerSandbox');
    expect(src).toContain('RefinerSandboxResult');
    expect(src).toContain('RefinerSandboxFailedCase');
    expect(src).toContain("from './internalization/refiner-sandbox-wrapper.js'");
  });

  it('REUSES_REPLAY: refiner-sandbox-wrapper.ts imports ReplayEvaluateFn from replay validator', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'refiner-sandbox-wrapper.ts'), 'utf-8');
    expect(src).toContain("from '../golden-trace-replay-validator.js'");
    expect(src).toContain('ReplayEvaluateFn');
  });

  it('REUSES_FORBIDDEN: refiner-sandbox-wrapper.ts imports checkForbiddenPatterns from rule-code-validator', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'refiner-sandbox-wrapper.ts'), 'utf-8');
    expect(src).toContain("from './rule-code-validator.js'");
    expect(src).toContain('checkForbiddenPatterns');
  });
});


// ── PRI-173: Refiner RuleHost Gate boundary ────────────────────────────

describe('PRI-173: refiner-rulehost-gate boundary', () => {
  it('CORE_PURE: refiner-rulehost-gate.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'refiner-rulehost-gate.ts'), 'utf-8');
    expect(src).not.toContain('node:vm');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('eval(');
    expect(src).not.toContain('new Function');
  });

  it('BARREL_EXPORTS: runtime-v2/index.ts exports evaluateRefinerRuleHostGate and types', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('evaluateRefinerRuleHostGate');
    expect(src).toContain('RefinerRuleHostGateDecision');
    expect(src).toContain('RefinerRuleHostGateInput');
    expect(src).toContain('RefinerRuleHostGateResult');
    expect(src).toContain("from './internalization/refiner-rulehost-gate.js'");
  });

  it('USES_SANDBOX: refiner-rulehost-gate.ts imports RefinerSandboxResult from refiner-sandbox-wrapper', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'refiner-rulehost-gate.ts'), 'utf-8');
    expect(src).toContain("from './refiner-sandbox-wrapper.js'");
    expect(src).toContain('RefinerSandboxResult');
  });
});

describe('PRI-146: RuleHostWriter shadow activation boundary', () => {
  it('CORE_PURE: rule-host-writer.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'activation', 'writers', 'rule-host-writer.ts'), 'utf-8');
    expect(src).not.toContain('node:vm');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('eval(');
    expect(src).not.toContain('new Function');
  });

  it('SHADOW_AFTER_APPROVAL: rule-host-writer.ts uses shadow action for owner-approved activations (PRI-489)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'activation', 'writers', 'rule-host-writer.ts'), 'utf-8');
    // PRI-489: Owner approval creates a SHADOW activation first. The only
    // shadow -> live transition is `pd activation promote` (atomic action
    // rewrite in SqliteActivationStateStore.promoteActivation). Live action
    // must never appear as a return value from activate(), only in comments
    // documenting the promote path.
    expect(src).toContain("action: 'code_tool_hook_shadow_activate'");
    expect(src).toContain('accepted_shadow');
  });

  it('USES_GATE: rule-host-writer.ts imports evaluateRefinerRuleHostGate', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'activation', 'writers', 'rule-host-writer.ts'), 'utf-8');
    expect(src).toContain('evaluateRefinerRuleHostGate');
    expect(src).toContain("from '../../internalization/refiner-rulehost-gate.js'");
  });

  it('IMPLEMENTS_CHANNEL_WRITER: rule-host-writer.ts implements ChannelWriter interface', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'activation', 'writers', 'rule-host-writer.ts'), 'utf-8');
    expect(src).toContain('implements ChannelWriter');
    expect(src).toContain("channel = 'code_tool_hook'");
  });

  it('BARREL_EXPORTS: activation/index.ts exports RuleHostWriter', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'activation', 'index.ts'), 'utf-8');
    expect(src).toContain('RuleHostWriter');
    expect(src).toContain("from './writers/rule-host-writer.js'");
  });

  it('CHANNEL_MAP: code_tool_hook is in HIGH_RISK_CHANNEL_MAP', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'activation', 'activation-types.ts'), 'utf-8');
    expect(src).toContain("code_tool_hook: 'high'");
  });
});


// ── PRI-117: Nocturnal god-class freeze — no Runtime V2 → Nocturnal reverse imports ─

describe('PRI-117 Nocturnal god-class freeze', () => {
  const NOCTURNAL_GOD_CLASSES = [
    'nocturnal-trinity',
    'nocturnal-service',
    '../core/nocturnal-trinity.js',
    '../service/nocturnal-service.js',
    '../../core/nocturnal-trinity.js',
    '../../service/nocturnal-service.js',
  ];

  it('RUNTIME_V2_NO_NOCTURNAL_TRINITY_IMPORT: runtime-v2 must not import nocturnal-trinity', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const runtimeDir = resolve(__dirname, '..');
    const allFiles: string[] = [];

    function collectTsFiles(dir: string) {
      if (dir.includes('node_modules')) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            collectTsFiles(fullPath);
          } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
            allFiles.push(fullPath);
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    collectTsFiles(runtimeDir);

    for (const file of allFiles) {
      const src = readFileSync(file, 'utf-8');
      for (const badImport of NOCTURNAL_GOD_CLASSES) {
        expect(src).not.toContain(badImport);
      }
    }
  });

  it('OPENCLAW_TRINITY_RUNTIME_ADAPTER_IS_LEGACY: OpenClawTrinityRuntimeAdapter must not be referenced in runtime-v2', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const runtimeDir = resolve(__dirname, '..');
    const allFiles: string[] = [];

    function collectTsFiles(dir: string) {
      if (dir.includes('node_modules')) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            collectTsFiles(fullPath);
          } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
            allFiles.push(fullPath);
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    collectTsFiles(runtimeDir);

    for (const file of allFiles) {
      const src = readFileSync(file, 'utf-8');
      expect(src).not.toContain('OpenClawTrinityRuntimeAdapter');
      expect(src).not.toContain('TrinityRuntimeAdapter');
      expect(src).not.toContain('runTrinity');
      expect(src).not.toContain('runTrinityAsync');
    }
  });

  it('NOCTURNAL_TRINITY_STUBS_ARE_TEST_ONLY: invokeStub* functions must not appear in non-test runtime-v2 files', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const runtimeDir = resolve(__dirname, '..');
    const allFiles: string[] = [];

    function collectTsFiles(dir: string) {
      if (dir.includes('node_modules')) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            collectTsFiles(fullPath);
          } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
            allFiles.push(fullPath);
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    collectTsFiles(runtimeDir);

    for (const file of allFiles) {
      const src = readFileSync(file, 'utf-8');
      expect(src).not.toContain('invokeStubDreamer');
      expect(src).not.toContain('invokeStubPhilosopher');
      expect(src).not.toContain('invokeStubScribe');
    }
  });

  it('RUNTIME_V2_USES_PEER_RUNNERS: DreamerRunner/ScribeRunner/ArtificerRunner are the canonical MVP-Core entry points', async () => {
    // PRI-458: narrowed to MVP-Core runners only. PhilosopherRunner (MVP-Quiet)
    // remains in runtime-v2/index.ts for rulehost-pipeline-runner.ts compatibility
    // but is no longer asserted as a canonical entry point.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('DreamerRunner');
    expect(src).toContain('ScribeRunner');
    expect(src).toContain('ArtificerRunner');
  });
});

// ── Phase 2 Migration: Evolution Types ────────────────────────────────────────

describe('Phase 2.1 evolution types migration', () => {
  const CORE_FILES = [
    'evolution/evolution-types.ts',
    'evolution/index.ts',
  ];

  for (const file of CORE_FILES) {
    it(`core ${file} has zero infrastructure imports`, async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(resolve(__dirname, '..', file), 'utf-8');
      expect(src).not.toContain('node:fs');
      expect(src).not.toContain('node:path');
      expect(src).not.toContain('openclaw-plugin');
    });
  }

  it('core barrel exports EvolutionTier, TIER_DEFINITIONS, getTierDefinition, getTierByPoints', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('EvolutionTier');
    expect(src).toContain('TIER_DEFINITIONS');
    expect(src).toContain('getTierDefinition');
    expect(src).toContain('getTierByPoints');
    expect(src).toContain("from './evolution/evolution-types.js'");
  });

  it('core barrel exports EvolutionPrinciple, EvolutionPrincipleStatus, EvolutionPainDetectedData', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('EvolutionPrinciple');
    expect(src).toContain('EvolutionPrincipleStatus');
    expect(src).toContain('EvolutionPainDetectedData');
  });

  it('plugin evolution-types.ts re-exports from core with backward-compatible aliases', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/evolution-types.ts'
    ), 'utf-8');
    expect(src).toContain("from '@principles/core/runtime-v2'");
    expect(src).toContain('EvolutionTier');
    expect(src).toContain('EvolutionPrinciple');
    expect(src).toContain('type Principle = EvolutionPrinciple');
    expect(src).toContain('type PrincipleStatus = EvolutionPrincipleStatus');
    expect(src).toContain('type PainDetectedData = EvolutionPainDetectedData');
  });

  it('plugin evolution-types.ts does NOT define EvolutionTier or TIER_DEFINITIONS locally', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/evolution-types.ts'
    ), 'utf-8');
    expect(src).not.toMatch(/^export enum EvolutionTier/m);
    expect(src).not.toMatch(/^export const TIER_DEFINITIONS/m);
  });
});

// ── Phase 2 Migration: Correction Types ───────────────────────────────────────

describe('Phase 2.2 correction types migration', () => {
  const CORE_FILES = [
    'correction/correction-types.ts',
    'correction/index.ts',
  ];

  for (const file of CORE_FILES) {
    it(`core ${file} has zero infrastructure imports`, async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(resolve(__dirname, '..', file), 'utf-8');
      expect(src).not.toContain('node:fs');
      expect(src).not.toContain('node:path');
      expect(src).not.toContain('openclaw-plugin');
    });
  }

  it('core barrel exports CorrectionKeyword, CorrectionKeywordStore, MAX_CORRECTION_KEYWORDS', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('CorrectionKeyword');
    expect(src).toContain('CorrectionKeywordStore');
    expect(src).toContain('MAX_CORRECTION_KEYWORDS');
    expect(src).toContain("from './correction/correction-types.js'");
  });

  it('plugin correction-types.ts re-exports from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/correction-types.ts'
    ), 'utf-8');
    expect(src).toContain("from '@principles/core/runtime-v2'");
    expect(src).toContain('CorrectionKeyword');
    expect(src).toContain('MAX_CORRECTION_KEYWORDS');
  });

  it('plugin correction-types.ts does NOT define CorrectionKeyword interface locally', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/correction-types.ts'
    ), 'utf-8');
    expect(src).not.toMatch(/^export interface CorrectionKeyword/m);
  });
});

// ── Phase 2 Migration: Types Directory (queue, hygiene, runtime-summary, events) ──

describe('Phase 2.4 types directory migration', () => {
  const CORE_TYPE_FILES = [
    'types/queue-types.ts',
    'types/hygiene-types.ts',
    'types/runtime-summary-types.ts',
    'types/event-types.ts',
    'types/event-payload.ts',
  ];

  for (const file of CORE_TYPE_FILES) {
    it(`core ${file} has zero infrastructure imports`, async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(resolve(__dirname, '..', file), 'utf-8');
      expect(src).not.toContain('node:fs');
      expect(src).not.toContain('node:path');
      expect(src).not.toContain('openclaw-plugin');
    });
  }

  it('core barrel exports QueueItemId, WorkflowId, SessionKey brand types', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('QueueItemId');
    expect(src).toContain('WorkflowId');
    expect(src).toContain('SessionKey');
    expect(src).toContain("from './types/queue-types.js'");
  });

  it('core barrel exports HygieneStats, createEmptyHygieneStats', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('HygieneStats');
    expect(src).toContain('createEmptyHygieneStats');
    expect(src).toContain("from './types/hygiene-types.js'");
  });

  it('core barrel exports RuntimeTruth, TrendMetrics', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('RuntimeTruth');
    expect(src).toContain('TrendMetrics');
    expect(src).toContain("from './types/runtime-summary-types.js'");
  });

  it('core barrel exports EventType, EventLogEntry, EventEvolutionStats', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('EventType');
    expect(src).toContain('EventLogEntry');
    expect(src).toContain('EventEvolutionStats');
    expect(src).toContain("from './types/event-types.js'");
  });

  it('core barrel exports DiscriminatedEventLogEntry, isToolCallEventEntry', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('DiscriminatedEventLogEntry');
    expect(src).toContain('isToolCallEventEntry');
    expect(src).toContain("from './types/event-payload.js'");
  });

  it('plugin types/queue.ts re-exports from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/types/queue.ts'
    ), 'utf-8');
    expect(src).toContain("@principles/core/runtime-v2");
  });

  it('plugin types/hygiene-types.ts re-exports from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/types/hygiene-types.ts'
    ), 'utf-8');
    expect(src).toContain("@principles/core/runtime-v2");
  });

  it('plugin types/runtime-summary.ts re-exports from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/types/runtime-summary.ts'
    ), 'utf-8');
    expect(src).toContain("@principles/core/runtime-v2");
  });

  it('plugin types/event-types.ts re-exports from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/types/event-types.ts'
    ), 'utf-8');
    expect(src).toContain("@principles/core/runtime-v2");
  });
});

// ── Phase 2 Migration: Principle-Tree Data Structures ─────────────────────────

describe('Phase 2.6 principle-tree data structures migration', () => {
  const CORE_TYPE_FILES = [
    'types/principle-dependency.ts',
    'types/principle-value-metrics.ts',
    'types/principle-lifecycle-event.ts',
    'types/principle-tree-store.ts',
  ];

  for (const file of CORE_TYPE_FILES) {
    it(`core ${file} has zero infrastructure imports`, async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(resolve(__dirname, '..', file), 'utf-8');
      expect(src).not.toContain('node:fs');
      expect(src).not.toContain('node:path');
      expect(src).not.toContain('openclaw-plugin');
    });
  }

  it('core barrel exports PrincipleDependency, PrincipleValueMetrics, PrincipleLifecycleEvent, PrincipleTreeStore', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('PrincipleDependency');
    expect(src).toContain('PrincipleValueMetrics');
    expect(src).toContain('PrincipleLifecycleEvent');
    expect(src).toContain('PrincipleTreeStore');
  });

  it('plugin principle-tree-schema.ts re-exports PrincipleDependency, PrincipleValueMetrics, PrincipleLifecycleEvent, PrincipleTreeStore from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/types/principle-tree-schema.ts'
    ), 'utf-8');
    expect(src).toContain("from '@principles/core/runtime-v2'");
    expect(src).toContain('PrincipleDependency');
    expect(src).toContain('PrincipleValueMetrics');
    expect(src).toContain('PrincipleLifecycleEvent');
    expect(src).toContain('PrincipleTreeStore');
  });

  it('plugin principle-tree-schema.ts does NOT define PrincipleDependency or PrincipleTreeStore locally', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/types/principle-tree-schema.ts'
    ), 'utf-8');
    expect(src).not.toMatch(/^export interface PrincipleDependency/m);
    expect(src).not.toMatch(/^export interface PrincipleTreeStore/m);
  });
});

// ── PRI-141: Task Three Strikes Out Mechanism ──────────────────────────────────

describe('PRI-141 Task Three Strikes Out Mechanism', () => {
  it('core barrel exports isUnresolvable, recordRejection, DEFAULT_UNRESOLVABLE_THRESHOLD', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('isUnresolvable');
    expect(src).toContain('recordRejection');
    expect(src).toContain('DEFAULT_UNRESOLVABLE_THRESHOLD');
  });

  it('core barrel exports UnresolvableSample type', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('UnresolvableSample');
  });

  it('internalization-task-guards.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'internalization-task-guards.ts'
    ), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('node:cron');
  });

  it('PITaskRecord includes rejectionCount field', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'peer-runner-contracts.ts'
    ), 'utf-8');
    expect(src).toContain('rejectionCount');
  });

  it('PITaskMetadata includes rejectionCount field', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'pitask-metadata.ts'
    ), 'utf-8');
    expect(src).toContain('rejectionCount');
  });
});

// ── PRI-139: L1 Hard Cap & LRU Eviction ──────────────────────────────────────

describe('PRI-139 L1 Hard Cap & LRU Eviction', () => {
  it('core barrel exports enforceL1HardCap, validateL1CapConfig, DEFAULT_L1_HARD_CAP, MAX_L1_HARD_CAP', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('enforceL1HardCap');
    expect(src).toContain('validateL1CapConfig');
    expect(src).toContain('DEFAULT_L1_HARD_CAP');
    expect(src).toContain('MAX_L1_HARD_CAP');
  });

  it('core barrel exports L1CapConfig, L1EvictionCandidate, L1EvictionResult types', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('L1CapConfig');
    expect(src).toContain('L1EvictionCandidate');
    expect(src).toContain('L1EvictionResult');
  });

  it('l1-hard-cap.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'l1-hard-cap.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('LedgerPrinciple includes lastTriggeredAt field', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    // PRI-443: type moved to pure module
    const src = readFileSync(resolve(__dirname, '..', 'types', 'ledger-store.ts'), 'utf-8');
    expect(src).toContain('lastTriggeredAt');
  });

  it('PruningHealthSummary includes activeL1Count and l1Cap fields', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'pruning-read-model.ts'), 'utf-8');
    expect(src).toContain('activeL1Count');
    expect(src).toContain('l1Cap');
  });
});

// ── PRI-142: IntakeToInternalizationBridge ──────────────────────────────────────

describe('PRI-142 IntakeToInternalizationBridge', () => {
  it('core barrel exports computeBridgeDecision, buildDreamerTaskSeed, buildDreamerSeedFromCandidate, seedIntakeTask, ROUTE_CHANNEL_MAP', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('computeBridgeDecision');
    expect(src).toContain('buildDreamerTaskSeed');
    expect(src).toContain('buildDreamerSeedFromCandidate');
    expect(src).toContain('seedIntakeTask');
    expect(src).toContain('ROUTE_CHANNEL_MAP');
  });

  it('core barrel exports IntakeToInternalizationBridgeInput, BridgeDecision, BridgeTaskSeed, BridgeTaskStore types', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('IntakeToInternalizationBridgeInput');
    expect(src).toContain('BridgeDecision');
    expect(src).toContain('BridgeTaskSeed');
    expect(src).toContain('BridgeTaskStore');
  });

  it('intake-to-internalization-bridge.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'intake-to-internalization-bridge.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('internalization/index.ts exports bridge symbols', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'index.ts'), 'utf-8');
    expect(src).toContain('computeBridgeDecision');
    expect(src).toContain('buildDreamerTaskSeed');
    expect(src).toContain('buildDreamerSeedFromCandidate');
    expect(src).toContain('seedIntakeTask');
    expect(src).toContain('ROUTE_CHANNEL_MAP');
    expect(src).toContain('IntakeToInternalizationBridgeInput');
    expect(src).toContain('BridgeDecision');
    expect(src).toContain('BridgeTaskSeed');
    expect(src).toContain('BridgeTaskStore');
  });
});

// ── PRI-144: ActivationDispatcher & Low-risk Writers ──────────────────────────

describe('PRI-144 ActivationDispatcher & Low-risk Writers', () => {
  it('core barrel exports ActivationDispatcher, PromptWriter, DeferArchiveWriter, LOW_RISK_CHANNELS, makeIdempotencyKey, isLowRiskChannel, getChannelRiskLevel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('ActivationDispatcher');
    expect(src).toContain('PromptWriter');
    expect(src).toContain('DeferArchiveWriter');
    expect(src).toContain('LOW_RISK_CHANNELS');
    expect(src).toContain('makeIdempotencyKey');
    expect(src).toContain('isLowRiskChannel');
    expect(src).toContain('getChannelRiskLevel');
  });

  it('core barrel exports ActivationDecision, DispatchInput, PIArtifactSnapshot, ChannelWriter types', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('ActivationDecision');
    expect(src).toContain('DispatchInput');
    expect(src).toContain('PIArtifactSnapshot');
    expect(src).toContain('ChannelWriter');
  });

  it('activation core files have zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const files = [
      resolve(__dirname, '..', 'activation', 'activation-types.ts'),
      resolve(__dirname, '..', 'activation', 'activation-dispatcher.ts'),
      resolve(__dirname, '..', 'activation', 'low-risk-writers.ts'),
      resolve(__dirname, '..', 'activation', 'index.ts'),
      resolve(__dirname, '..', 'activation', 'approval-queue.ts'),
      resolve(__dirname, '..', 'activation', 'memory-approval-store.ts'),
      resolve(__dirname, '..', 'activation', 'sqlite-approval-store.ts'),
    ];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      expect(src).not.toContain('node:fs');
      expect(src).not.toContain('node:path');
      expect(src).not.toContain('node:process');
      expect(src).not.toContain('openclaw-plugin');
    }
  });

  it('activation/index.ts exports all public symbols', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'activation', 'index.ts'), 'utf-8');
    expect(src).toContain('ActivationDispatcher');
    expect(src).toContain('PromptWriter');
    expect(src).toContain('DeferArchiveWriter');
    expect(src).toContain('LOW_RISK_CHANNELS');
    expect(src).toContain('makeIdempotencyKey');
    expect(src).toContain('isLowRiskChannel');
    expect(src).toContain('getChannelRiskLevel');
    expect(src).toContain('MemoryActivationStateStore');
    expect(src).toContain('MemoryArtifactReadModel');
    expect(src).toContain('ApprovalQueue');
    expect(src).toContain('decideAutoPromotion');
    expect(src).toContain('MemoryApprovalQueueStore');
    expect(src).toContain('SqliteApprovalQueueStore');
    expect(src).toContain('ApprovalQueueStore');
    expect(src).toContain('AUTO_PROMOTION_CONFIDENCE_THRESHOLD');
    expect(src).toContain('AUTO_PROMOTABLE_CHANNELS');
  });
});

// ── PRI-189: SourceTraceLocator contract boundary ──────────────────────────────

describe('PRI-189 SourceTraceLocator contract boundary', () => {
  it('source-trace-locator.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'store', 'trajectory', 'source-trace-locator.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('sqlite-source-trace-locator.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'store', 'trajectory', 'sqlite-source-trace-locator.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('core barrel exports SourceTraceLocator and SqliteSourceTraceLocator', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('SourceTraceLocator');
    expect(src).toContain('SqliteSourceTraceLocator');
    expect(src).toContain('SourceTraceLocateDecision');
    expect(src).toContain('SourceTraceCandidate');
  });

  it('store/trajectory/index.ts re-exports SourceTraceLocator + SqliteSourceTraceLocator', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'trajectory', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('SourceTraceLocator');
    expect(src).toContain('SqliteSourceTraceLocator');
  });
});

describe('PRI-190 FullTrace quality contract boundary', () => {
  it('full-trace-contract.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'full-trace-contract.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('core barrel exports FullTracePayloadV2Schema and contract functions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('FullTracePayloadV2Schema');
    expect(src).toContain('TraceSourceRefSchema');
    expect(src).toContain('TraceTimelineEntrySchema');
    expect(src).toContain('validateFullTracePayload');
    expect(src).toContain('sanitizeFullTracePayload');
    expect(src).toContain('buildFullTraceTimeline');
    expect(src).toContain('buildSourceRefs');
  });

  it('context-payload.ts re-exports full-trace-contract types', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'context-payload.ts'), 'utf-8');
    expect(src).toContain('full-trace-contract');
    expect(src).toContain('FullTracePayloadV2Schema');
    expect(src).toContain('validateFullTracePayload');
    expect(src).toContain('sanitizeFullTracePayload');
  });

  it('DiagnosticianContextPayloadSchema accepts FullTracePayloadV2', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'context-payload.ts'), 'utf-8');
    expect(src).toContain('FullTracePayloadV2Schema');
  });
});

describe('PRI-191 TraceRefiner read model boundary', () => {
  it('trace-refiner.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'trace-refiner.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('trace-refiner.ts has no LLM or network imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'trace-refiner.ts'), 'utf-8');
    expect(src).not.toContain('node:http');
    expect(src).not.toContain('node:https');
    expect(src).not.toContain('node:net');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('openai');
    expect(src).not.toContain('anthropic');
  });

  it('core barrel exports refineFullTrace and RefinedTracePayload', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('refineFullTrace');
    expect(src).toContain('RefinedTracePayload');
    expect(src).toContain('RefinedTraceEvent');
    expect(src).toContain('TraceRefinerOptions');
    expect(src).toContain('REFINED_EVENT_KINDS');
    expect(src).toContain('SEVERITY_LEVELS');
  });

  it('trace-refiner.ts imports only from full-trace-contract', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'trace-refiner.ts'), 'utf-8');
    const importLines = src.split('\n').filter((line) => line.trim().startsWith('import'));
    for (const line of importLines) {
      expect(line).toContain('full-trace-contract');
    }
  });
});

describe('PRI-192 TraceRefinerAgent shadow contract boundary', () => {
  it('trace-refiner-agent.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'trace-refiner-agent.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('trace-refiner-agent.ts has no LLM or network imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'trace-refiner-agent.ts'), 'utf-8');
    expect(src).not.toContain('node:http');
    expect(src).not.toContain('node:https');
    expect(src).not.toContain('node:net');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('openai');
    expect(src).not.toContain('anthropic');
  });

  it('core barrel exports TraceRefinerAgent types and functions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('createTraceRefinerAgentInput');
    expect(src).toContain('validateTraceRefinerAgentOutput');
    expect(src).toContain('applyTraceRefinerAgentShadowResult');
    expect(src).toContain('TraceRefinerAgentInput');
    expect(src).toContain('TraceRefinerAgentOutput');
    expect(src).toContain('TraceRefinerAgentObjective');
    expect(src).toContain('TraceRefinerAgentMode');
    expect(src).toContain('TraceRefinerEvidenceClaim');
    expect(src).toContain('TraceRefinerRejectedEvidence');
    expect(src).toContain('TraceRefinerAgentStatus');
  });

  it('trace-refiner-agent.ts imports only from full-trace-contract and trace-refiner', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'trace-refiner-agent.ts'), 'utf-8');
    const importLines = src.split('\n').filter((line) => line.trim().startsWith('import'));
    const allowedModules = ["'./full-trace-contract", "'./trace-refiner"];
    for (const line of importLines) {
      expect(
        allowedModules.some((mod) => line.includes(mod))
      ).toBe(true);
    }
  });
});

// ── PRI-215: Synthetic baseline architecture boundary ──────────────────────
//
// After PRI-206, the architecture is:
//   Core: packages/principles-core/src/runtime-v2/synthetic-baseline.ts
//     (pure contract/helper code — zero I/O)
//   I/O Runner: packages/pd-cli/src/services/synthetic-baseline-runner.ts
//   CLI Command: packages/pd-cli/src/commands/runtime-synthetic-baseline.ts
//
// These guards prevent future PRs from moving I/O back into core.
// ERR-011 reference: core must not import runtime orchestration classes
// ERR-012 reference: guard against stale-main rollback of baseline
// ERR-002 reference: not applicable — no degrade path in these tests

const FORBIDDEN_NODE_IO_MODULES = new Set([
  'fs',
  'fs/promises',
  'path',
  'os',
  'child_process',
  'process',
  'better-sqlite3',
  'node:fs',
  'node:path',
  'node:os',
  'node:child_process',
  'node:process',
]);

const FORBIDDEN_RUNTIME_ORCHESTRATION_CLASSES = new Set([
  'RuntimeStateManager',
  'SqliteContextAssembler',
  'SqliteHistoryQuery',
  'SqliteDiagnosticianCommitter',
  'PainSignalBridge',
  'SplitDiagnosticianRunner',
  'DisabledDiagnosticianRunner',
  'DiagRootCauseRunner',
  'DiagDistillerRunner',
  'DiagRouterRunner',
  'TestDoubleRuntimeAdapter',
  'OperatorHealthReadModel',
  'createInternalizationQueueReadModel',
  'PrincipleTreeLedgerAdapter',
  'CandidateIntakeService',
]);

describe('PRI-215 synthetic baseline architecture boundary', () => {
  function extractImportModulePaths(src: string): string[] {
    const paths: string[] = [];
    for (const m of src.matchAll(/import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g)) {
      if (m[1] != null) paths.push(m[1]);
    }
    for (const m of src.matchAll(/import\s+['"]([^'"]+)['"]/g)) {
      if (m[1] != null && !paths.includes(m[1])) paths.push(m[1]);
    }
    return paths;
  }

  function extractImportIdentifiers(src: string): string[] {
    const ids: string[] = [];
    for (const block of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
      if (block[1] == null) continue;
      const clause = block[1].trim();
      const defaultMatch = /^(\w+)/.exec(clause);
      if (defaultMatch?.[1]) ids.push(defaultMatch[1]);
      const namedMatch = /\{([\s\S]*)\}/.exec(clause);
      if (namedMatch?.[1]) {
        namedMatch[1].split(',').forEach((part) => {
          const trimmed = part.trim();
          if (!trimmed) return;
          const asParts = trimmed.split(/\s+as\s+/);
          if (asParts[0]) ids.push(asParts[0].trim());
          if (asParts.length > 1) {
            const alias = asParts[asParts.length - 1];
            if (alias) ids.push(alias.trim());
          }
        });
      }
    }
    return ids;
  }

  // ── Core boundary: no Node I/O imports ──────────────────────────────────
  it('CORE_NO_NODE_IO: synthetic-baseline.ts does not import Node I/O modules', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'synthetic-baseline.ts'), 'utf-8');
    const importModulePaths = extractImportModulePaths(src);
    for (const mod of FORBIDDEN_NODE_IO_MODULES) {
      const found = importModulePaths.filter((p) => p === mod || p.startsWith(mod + '/'));
      expect(found).toEqual([]);
    }
  });

  // ── Core boundary: no runtime orchestration imports ─────────────────────
  it('CORE_NO_RUNTIME_CLASSES: synthetic-baseline.ts does not import runtime orchestration classes', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'synthetic-baseline.ts'), 'utf-8');
    const importIdentifiers = extractImportIdentifiers(src);
    for (const cls of FORBIDDEN_RUNTIME_ORCHESTRATION_CLASSES) {
      expect(importIdentifiers).not.toContain(cls);
    }
  });

  // ── Import parsing: side-effect import detection ────────────────────────
  it('IMPORT_PARSING_SIDE_EFFECT: extractImportModulePaths catches side-effect imports like import "node:fs"', () => {
    const src = `import 'node:fs';\nimport { foo } from 'bar';\n`;
    const paths = extractImportModulePaths(src);
    expect(paths).toContain('node:fs');
    expect(paths).toContain('bar');
  });

  // ── Import parsing: multiline import detection ──────────────────────────
  it('IMPORT_PARSING_MULTILINE: extractImportModulePaths catches multiline imports from forbidden modules', () => {
    const src = `import {\n  RuntimeStateManager,\n  SqliteContextAssembler\n} from './runtime';\n`;
    const paths = extractImportModulePaths(src);
    expect(paths).toContain('./runtime');
  });

  // ── Import parsing: aliased named import detection ──────────────────────
  it('IMPORT_PARSING_ALIAS: extractImportIdentifiers catches both original and alias for "as" imports', () => {
    const src = `import { RuntimeStateManager as RSM, PainSignalBridge } from './runtime';\n`;
    const ids = extractImportIdentifiers(src);
    expect(ids).toContain('RuntimeStateManager');
    expect(ids).toContain('RSM');
    expect(ids).toContain('PainSignalBridge');
  });

  // ── I/O Runner location ─────────────────────────────────────────────────
  it('IO_RUNNER_OUTSIDE_CORE: I/O runner exists at pd-cli/src/services/synthetic-baseline-runner.ts', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const runnerPath = resolve(
      __dirname,
      '../../../../pd-cli/src/services/synthetic-baseline-runner.ts',
    );
    expect(existsSync(runnerPath)).toBe(true);
  });

  // ── CLI Command location ────────────────────────────────────────────────
  it('CLI_COMMAND_OUTSIDE_CORE: CLI command exists at pd-cli/src/commands/runtime-synthetic-baseline.ts', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cmdPath = resolve(
      __dirname,
      '../../../../pd-cli/src/commands/runtime-synthetic-baseline.ts',
    );
    expect(existsSync(cmdPath)).toBe(true);
  });

  // ── Frozen legacy untouched ────────────────────────────────────────────
  it('FROZEN_LEGACY_UNTOUCHED: ADR-0005 frozen files are not imported by synthetic-baseline.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'synthetic-baseline.ts'), 'utf-8');
    expect(src).not.toContain('nocturnal-trinity');
    expect(src).not.toContain('nocturnal-arbiter');
    expect(src).not.toContain('nocturnal-service');
  });
});

describe('PRI-225: No unsafe type assertions on untrusted metadata arrays', () => {
  it('INTEGRITY_READ_MODEL_NO_AS_STRING_ARRAY: internalization-chain-integrity-read-model.ts must not use `as string[]` on untrusted data', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization-chain-integrity-read-model.ts'), 'utf-8');
    expect(src).not.toContain('as string[]');
  });
});

// ── PRI-239: Feature flag registry architecture boundary ──────────────────
//
// Core: packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts
// I/O Loader: packages/pd-cli/src/services/pd-config-loader.ts (PRI-460: replaced feature-flag-loader.ts)
// CLI Command: packages/pd-cli/src/commands/runtime-features.ts
// Consumption: packages/pd-cli/src/commands/runtime-canary.ts (GFI check)

describe('PRI-239: Feature flag registry architecture boundary', () => {
  it('CORE_NO_NODE_IO: feature-flag-contract.ts does not import Node I/O modules', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'feature-flags', 'feature-flag-contract.ts'), 'utf-8');
    expect(src).not.toMatch(/from\s+['"]node:fs['"]/);
    expect(src).not.toMatch(/from\s+['"]node:path['"]/);
    expect(src).not.toMatch(/from\s+['"]fs['"]/);
    expect(src).not.toMatch(/from\s+['"]path['"]/);
    expect(src).not.toMatch(/from\s+['"]js-yaml['"]/);
  });

  it('CORE_NO_RUNTIME_CLASSES: feature-flag-contract.ts does not import runtime orchestration classes', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'feature-flags', 'feature-flag-contract.ts'), 'utf-8');
    expect(src).not.toContain('RuntimeStateManager');
    expect(src).not.toContain('InternalizationOrchestrator');
    expect(src).not.toContain('SqliteConnection');
  });

  it('IO_LOADER_OUTSIDE_CORE: I/O loader exists at pd-cli/src/services/pd-config-loader.ts', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(
      resolve(__dirname, '../../../../pd-cli/src/services/pd-config-loader.ts'),
    )).toBe(true);
  });

  it('CLI_COMMAND_OUTSIDE_CORE: CLI command exists at pd-cli/src/commands/runtime-features.ts', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(
      resolve(__dirname, '../../../../pd-cli/src/commands/runtime-features.ts'),
    )).toBe(true);
  });

  it('FROZEN_LEGACY_UNTOUCHED: ADR-0005 frozen files are not imported by feature-flag-contract.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'feature-flags', 'feature-flag-contract.ts'), 'utf-8');
    expect(src).not.toContain('nocturnal-trinity');
    expect(src).not.toContain('nocturnal-arbiter');
    expect(src).not.toContain('nocturnal-service');
  });

  it('CONSUMPTION_WIRED: runtime-canary.ts imports canonical PD config loader', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../pd-cli/src/commands/runtime-canary.ts'), 'utf-8');
    expect(src).toContain('pd-config-loader');
    expect(src).toContain('loadPdConfig');
  });
});

describe('PRI-304: PD-Owned Config Contract barrel exports and purity', () => {
  it('BARREL_EXPORTS: runtime-v2/index.ts exports PD config contract symbols', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    // Core types
    expect(src).toContain('PdConfig');
    expect(src).toContain('PdConfigValidationResult');
    expect(src).toContain('EffectivePdConfig');
    expect(src).toContain('RedactedPdConfigSummary');
    // Core functions
    expect(src).toContain('validatePdConfig');
    expect(src).toContain('computeEffectivePdConfig');
    expect(src).toContain('redactPdConfig');
    expect(src).toContain('redactConfigValue');
    expect(src).toContain('computeFeatureFlagsFromConfig');
    expect(src).toContain('isFeatureEnabled');
    // Defaults
    expect(src).toContain('getDefaultPdConfig');
    expect(src).toContain('DEFAULT_RUNTIME_PROFILE_ID');
    // Config barrel import path
    expect(src).toContain("from './config/index.js'");
  });

  it('CORE_PURE: config/ module has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const configDir = resolve(__dirname, '..', 'config');
    const files = ['pd-config-types.ts', 'pd-config-validate.ts', 'pd-config-defaults.ts', 'pd-config-effective.ts', 'pd-config-redaction.ts', 'pd-config-feature-flags.ts', 'index.ts'];
    for (const file of files) {
      const src = readFileSync(resolve(configDir, file), 'utf-8');
      expect(src).not.toContain('node:fs');
      expect(src).not.toContain('node:path');
      expect(src).not.toContain('node:process');
      expect(src).not.toContain('openclaw-plugin');
      expect(src).not.toContain('eval(');
      expect(src).not.toContain('new Function');
    }
  });
});

describe('PRI-372: split diagnostician runners extend BasePeerRunner', () => {
  it('DiagRootCauseRunner extends BasePeerRunner', async () => {
    const { DiagRootCauseRunner } = await import('../internalization/diag-rootcause-runner.js');
    const { BasePeerRunner } = await import('../runner/base-peer-runner.js');
    expect(DiagRootCauseRunner.prototype).toBeInstanceOf(BasePeerRunner);
  });

  it('DiagDistillerRunner extends BasePeerRunner', async () => {
    const { DiagDistillerRunner } = await import('../internalization/diag-distiller-runner.js');
    const { BasePeerRunner } = await import('../runner/base-peer-runner.js');
    expect(DiagDistillerRunner.prototype).toBeInstanceOf(BasePeerRunner);
  });

  it('DiagRouterRunner extends BasePeerRunner', async () => {
    const { DiagRouterRunner } = await import('../internalization/diag-router-runner.js');
    const { BasePeerRunner } = await import('../runner/base-peer-runner.js');
    expect(DiagRouterRunner.prototype).toBeInstanceOf(BasePeerRunner);
  });
});

// ── PRI-416: Type Single-Ownership Guards ──────────────────────────────────────
//
// These guards ensure that critical types/functions are defined exactly once
// within principles-core/src/. This prevents the "duplicate type definition"
// debt that led to PRI-413/PRI-415 (e.g., HybridLedgerStore in both
// principle-tree-ledger.ts and types.ts).

describe('PRI-416: type single-ownership guards', () => {
  let fs: typeof import('fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
  let pathModule: typeof import('path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
  let coreSrcDir: string;

  beforeAll(async () => {
    fs = await import('fs');
    pathModule = await import('path');
    coreSrcDir = pathModule.resolve(__dirname, '..', '..');
  });

  function findDefinitions(pattern: RegExp): string[] {
    const hits: string[] = [];
    function scan(dir: string): void {
      for (const entry of fs.readdirSync(dir)) {
        const full = pathModule.join(dir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          if (entry === 'node_modules' || entry === '__tests__') continue;
          scan(full);
        } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
          const content = fs.readFileSync(full, 'utf-8');
          if (pattern.test(content)) {
            hits.push(full.replace(coreSrcDir + pathModule.sep, '').replace(coreSrcDir + '/', '').replace(/\\/g, '/'));
          }
        }
      }
    }
    scan(coreSrcDir);
    return hits;
  }

  it('InjectablePrinciple is defined exactly once in core/src/', () => {
    const hits = findDefinitions(/export\s+interface\s+InjectablePrinciple\s*\{/);
    expect(hits).toEqual(['prompt-builder/principle-selection.ts']);
  });

  it('HybridLedgerStore is defined exactly once in core/src/', () => {
    const hits = findDefinitions(/export\s+interface\s+HybridLedgerStore\s*\{/);
    expect(hits).toEqual(['runtime-v2/types/ledger-store.ts']);
  });

  it('atomicWriteFileSync is NOT exported from any core/src/ file (PRI-443 Phase 4)', () => {
    // After PRI-443 Phase 4, atomicWriteFileSync is inlined as a PRIVATE helper
    // inside principle-tree-ledger.ts. It must NOT be exported from core.
    const hits = findDefinitions(/export\s+function\s+atomicWriteFileSync\s*\(/);
    expect(hits).toEqual([]);
  });

  it('atomicWriteFileSync is defined exactly once as a private function in principle-tree-ledger.ts (PRI-443 Phase 4)', () => {
    // The function is now a private (non-exported) helper inlined in principle-tree-ledger.ts
    const hits = findDefinitions(/function\s+atomicWriteFileSync\s*\(/);
    expect(hits).toEqual(['principle-tree-ledger.ts']);
  });
});

// ── PRI-416: Barrel Cap Guards ────────────────────────────────────────────────
//
// The barrel export file (index.ts) must stay lean to avoid bloat.
// After PRI-415 cleanup, it has ~263 total lines and ~40 export lines.
// Set upper limits to prevent future regression.

describe('PRI-416: barrel cap guards', () => {
  const BARREL_MAX_TOTAL_LINES = 300;
  const BARREL_MAX_EXPORT_LINES = 50;

  it('index.ts total lines <= ' + BARREL_MAX_TOTAL_LINES, async () => {
    const fsMod: typeof import('fs') = await import('fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('path') = await import('path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const barrelPath = pathMod.resolve(__dirname, '..', '..', 'index.ts');
    const content = fsMod.readFileSync(barrelPath, 'utf-8');
    const lineCount = content.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(BARREL_MAX_TOTAL_LINES);
  });

  it('index.ts export lines <= ' + BARREL_MAX_EXPORT_LINES, async () => {
    const fsMod: typeof import('fs') = await import('fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('path') = await import('path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const barrelPath = pathMod.resolve(__dirname, '..', '..', 'index.ts');
    const content = fsMod.readFileSync(barrelPath, 'utf-8');
    const exportLines = content.split('\n').filter((l: string) => /^\s*export\s/.test(l));
    expect(exportLines.length).toBeLessThanOrEqual(BARREL_MAX_EXPORT_LINES);
  });
});

// ── PRI-443: Pure module boundary guards ──────────────────────────────────────
//
// Phases 1-3 extracted pure types/codecs/schema out of I/O modules. These guards
// ensure those pure modules never regress to importing fs/path, and that the
// runtime-v2 barrel never re-exports I/O functions from principle-tree-ledger.

describe('PRI-443: pure module boundary guards', () => {
  const FORBIDDEN_PURE_IMPORTS = [
    "from 'fs'",
    'from "fs"',
    "from 'node:fs'",
    'from "node:fs"',
    "from 'path'",
    'from "path"',
    "from 'node:path'",
    'from "node:path"',
  ];

  async function readSrc(relPath: string): Promise<string> {
    const fsMod: typeof import('fs') = await import('fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const pathMod: typeof import('path') = await import('path'); // eslint-disable-line @typescript-eslint/consistent-type-imports
    const full = pathMod.resolve(__dirname, '..', relPath);
    return fsMod.readFileSync(full, 'utf-8');
  }

  it('runtime-v2/types/ledger-store.ts has zero fs/path imports (pure types module)', async () => {
    const src = await readSrc('types/ledger-store.ts');
    for (const pat of FORBIDDEN_PURE_IMPORTS) {
      expect(src).not.toContain(pat);
    }
  });

  it('runtime-v2/principle-tree/ledger-codec.ts has zero fs/path imports (pure codec module)', async () => {
    const src = await readSrc('principle-tree/ledger-codec.ts');
    for (const pat of FORBIDDEN_PURE_IMPORTS) {
      expect(src).not.toContain(pat);
    }
  });

  it('runtime-v2/types/pain-signal.ts has zero fs/path imports (pure schema module)', async () => {
    const src = await readSrc('types/pain-signal.ts');
    for (const pat of FORBIDDEN_PURE_IMPORTS) {
      expect(src).not.toContain(pat);
    }
  });

  it('runtime-v2/index.ts barrel does NOT export I/O functions from principle-tree-ledger', async () => {
    const src = await readSrc('index.ts');
    // I/O functions must not be re-exported through the pure-types barrel.
    expect(src).not.toMatch(/export\s+\{[^}]*\bloadLedger\b[^}]*\}\s*from\s*['"]\.\.\/principle-tree-ledger/);
    expect(src).not.toMatch(/export\s+\{[^}]*\bsaveLedger\b[^}]*\}\s*from\s*['"]\.\.\/principle-tree-ledger/);
    expect(src).not.toMatch(/export\s+\{[^}]*\bgetLedgerFilePathPublic\b[^}]*\}\s*from\s*['"]\.\.\/principle-tree-ledger/);
    expect(src).not.toMatch(/export\s+\{[^}]*\bupdatePrinciple\b[^}]*\}\s*from\s*['"]\.\.\/principle-tree-ledger/);
    expect(src).not.toMatch(/export\s+\{[^}]*\batomicWriteFileSync\b[^}]*\}\s*from\s*['"]\.\.\/principle-tree-ledger/);
  });

  it('runtime-v2/index.ts barrel re-exports LedgerTreeStore type from pure types module, not from principle-tree-ledger', async () => {
    const src = await readSrc('index.ts');
    // The type must come from the pure types module (./types/ledger-store.js),
    // NOT from the I/O module (../principle-tree-ledger.js).
    expect(src).toMatch(/export\s+type\s+\{\s*LedgerTreeStore\s*\}\s*from\s*['"]\.\/types\/ledger-store\.js['"]/);
    expect(src).not.toMatch(/export\s+type\s+\{\s*LedgerTreeStore\s*\}\s*from\s*['"]\.\.\/principle-tree-ledger\.js['"]/);
  });
});

// ── PRI-450 / PRI-462: Core I/O seam registry guard ───────────────────────────
//
// The single source of truth for core I/O files is
// `packages/principles-core/io-seam-registry.json` (PRI-462). It groups every
// whitelisted file into a named seam with a description explaining WHY the I/O
// is allowed. Both this test and `eslint.config.js` derive their exemption
// lists from that registry — there is no second hand-maintained list.
//
// To add a new I/O file: add it to the appropriate seam in the registry JSON.
// Both the architecture-regression test and the ESLint exemption update
// automatically. This forces developers to explain "which seam does this
// belong to and why?" in their PR.

interface IoSeam {
  name: string;
  description: string;
  files: string[];
}

interface IoSeamRegistry {
  seams: IoSeam[];
}

describe('PRI-450 / PRI-462: core I/O seam registry guard', () => {
  // Registry lives at packages/principles-core/io-seam-registry.json
  // (3 levels up from __tests__: __tests__ → runtime-v2 → src → principles-core)
  const registryPath = pathSync.resolve(__dirname, '..', '..', '..', 'io-seam-registry.json');
  const registryRaw = fsSync.readFileSync(registryPath, 'utf-8');
  const registry: unknown = JSON.parse(registryRaw);

  // Runtime-validate the registry shape (Runtime Contract Rule 1+2: treat
  // parsed JSON as unknown, validate with typeof/Array.isArray before access).
  // `as` is used only for type narrowing AFTER runtime checks, not to bypass them.
  function isValidRegistry(v: unknown): v is IoSeamRegistry {
    if (typeof v !== 'object' || v === null || !Object.hasOwn(v, 'seams')) return false;
    const { seams } = v as { seams: unknown };
    if (!Array.isArray(seams)) return false;
    return seams.every((s) =>
      typeof s === 'object' && s !== null &&
      typeof (s as Record<string, unknown>).name === 'string' &&
      typeof (s as Record<string, unknown>).description === 'string' &&
      Array.isArray((s as Record<string, unknown>).files) &&
      (s as { files: unknown[] }).files.every((f) => typeof f === 'string')
    );
  }

  // Flatten all registry files into a Set (relative to packages/principles-core/src/).
  const ALLOWED_IO_FILES: ReadonlySet<string> = new Set(
    isValidRegistry(registry)
      ? registry.seams.flatMap((s) => s.files)
      : []
  );

  // Extract all RUNTIME import module paths from source code.
  // Handles: import ... from 'mod', import 'mod' (side-effect), and multiline imports.
  // EXCLUDES `import type ... from` — type-only imports are erased at compile time
  // and do not introduce runtime I/O. Reuses the same pattern proven in the
  // PRI-215 extractImportModulePaths helper.
  //
  // The negative lookahead `(?!type\b)` after `import\s+` prevents matching
  // `import type { X } from 'mod'` and `import type X from 'mod'`.
  function extractImportPaths(src: string): string[] {
    const paths: string[] = [];
    // `import ... from 'mod'` — but NOT `import type ... from 'mod'`.
    for (const m of src.matchAll(/import\s+(?!type\b)[\s\S]*?from\s+['"]([^'"]+)['"]/g)) {
      if (m[1] != null) paths.push(m[1]);
    }
    // Side-effect `import 'mod'` — `import type 'mod'` is not valid TS so no
    // exclusion needed, but the lookahead keeps it defensive.
    for (const m of src.matchAll(/import\s+(?!type\b)['"]([^'"]+)['"]/g)) {
      if (m[1] != null && !paths.includes(m[1])) paths.push(m[1]);
    }
    return paths;
  }

  // Check if any runtime import path references a Node I/O module.
  // Covers fs, path, child_process, better-sqlite3 (including sub-paths like fs/promises).
  // Type-only imports (`import type ... from 'fs'`) are excluded by extractImportPaths.
  //
  // This MUST stay in sync with eslint.config.js `no-restricted-imports` patterns.
  // ESLint uses `allowTypeImports: true` for child_process/better-sqlite3, so the
  // arch test is the runtime-I/O backstop for those modules.
  function importsNodeIo(src: string): boolean {
    const paths = extractImportPaths(src);
    return paths.some((p) =>
      p === 'fs' || p.startsWith('fs/') ||
      p === 'node:fs' || p.startsWith('node:fs/') ||
      p === 'path' || p.startsWith('path/') ||
      p === 'node:path' || p.startsWith('node:path/') ||
      p === 'child_process' || p.startsWith('child_process/') ||
      p === 'node:child_process' || p.startsWith('node:child_process/') ||
      p === 'better-sqlite3'
    );
  }

  // Back-compat alias: keep the old name working for any external callers/tests
  // that referenced importsFsOrPath directly. New code should use importsNodeIo.
  const importsFsOrPath = importsNodeIo;

  function collectTsFiles(dir: string, acc: string[]): void {
    const entries = fsSync.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = pathSync.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectTsFiles(fullPath, acc);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.spec.ts')
      ) {
        acc.push(fullPath);
      }
    }
  }

  // ── Registry validity (PRI-462) ───────────────────────────────────────────

  it('io-seam-registry.json is valid: seams array with name/description/files', () => {
    expect(isValidRegistry(registry)).toBe(true);
    if (!isValidRegistry(registry)) return; // type narrowing
    expect(registry.seams.length).toBeGreaterThan(0);
    for (const seam of registry.seams) {
      expect(seam.name.length).toBeGreaterThan(0);
      expect(seam.description.length).toBeGreaterThan(0);
      expect(seam.files.length).toBeGreaterThan(0);
    }
  });

  it('registry has no duplicate files across seams', () => {
    if (!isValidRegistry(registry)) {
      // isValidRegistry test above will fail with details; skip here.
      expect(isValidRegistry(registry)).toBe(true);
      return;
    }
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const seam of registry.seams) {
      for (const f of seam.files) {
        if (seen.has(f)) dupes.push(f);
        seen.add(f);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('every seam description explains why the I/O is allowed (non-trivial)', () => {
    if (!isValidRegistry(registry)) {
      expect(isValidRegistry(registry)).toBe(true);
      return;
    }
    const weak: string[] = [];
    for (const seam of registry.seams) {
      // Description must be at least 20 chars — a single word like "legacy" is
      // not an explanation. This forces maintainers to write a real rationale.
      if (seam.description.trim().length < 20) {
        weak.push(`${seam.name}: "${seam.description}"`);
      }
    }
    expect(weak).toEqual([]);
  });

  // ── Registry ↔ production files (PRI-450, EP-02) ──────────────────────────

  it('core/src/ production files: only registry-listed files import Node I/O modules (fs/path/child_process/better-sqlite3)', () => {
    const coreSrcDir = pathSync.resolve(__dirname, '..', '..');
    const allFiles: string[] = [];
    collectTsFiles(coreSrcDir, allFiles);

    const violations: string[] = [];
    for (const filePath of allFiles) {
      const content = fsSync.readFileSync(filePath, 'utf-8');
      if (importsNodeIo(content)) {
        const relPath = pathSync.relative(coreSrcDir, filePath).replace(/\\/g, '/');
        if (!ALLOWED_IO_FILES.has(relPath)) {
          violations.push(relPath);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} file(s) importing fs/path/child_process/better-sqlite3 that are NOT in io-seam-registry.json.\n` +
        `Add them to the appropriate seam in packages/principles-core/io-seam-registry.json.\n` +
        `Note: \`import type\` from these modules is allowed (erased at runtime) and won't trigger this.\n` +
        `Violations:\n  ` + violations.join('\n  ')
      );
    }
  });

  it('registry-listed files all exist on disk', () => {
    const coreSrcDir = pathSync.resolve(__dirname, '..', '..');
    const missing: string[] = [];
    for (const relPath of ALLOWED_IO_FILES) {
      const fullPath = pathSync.join(coreSrcDir, ...relPath.split('/'));
      if (!fsSync.existsSync(fullPath)) {
        missing.push(relPath);
      }
    }
    expect(missing).toEqual([]);
  });

  // ── Registry ↔ ESLint exemption (PRI-462, EP-06 single source of truth) ───
  //
  // ESLint's no-restricted-imports exemption list must be DERIVED from the
  // registry, not hand-maintained. This test verifies eslint.config.js
  // references the registry file, proving the two stay in sync.

  it('eslint.config.js derives fs/path exemption from the registry (no shadow list)', () => {
    const eslintPath = pathSync.resolve(__dirname, '..', '..', '..', '..', '..', 'eslint.config.js');
    const eslintSrc = fsSync.readFileSync(eslintPath, 'utf-8');
    // The eslint config must read the registry JSON — if this reference is
    // removed, someone has reintroduced a hand-maintained shadow list.
    expect(eslintSrc).toContain('io-seam-registry.json');
  });

  // ── Helper unit tests ─────────────────────────────────────────────────────

  it('importsNodeIo detects sub-path imports (fs/promises) and side-effect imports', () => {
    // Sub-path import
    expect(importsNodeIo(`import { mkdir } from 'node:fs/promises';`)).toBe(true);
    expect(importsNodeIo(`import { posix } from 'path/posix';`)).toBe(true);
    // Side-effect import
    expect(importsNodeIo(`import 'fs';`)).toBe(true);
    expect(importsNodeIo(`import "node:path";`)).toBe(true);
    // Standard import
    expect(importsNodeIo(`import * as fs from 'fs';`)).toBe(true);
    expect(importsNodeIo(`import { resolve } from 'node:path';`)).toBe(true);
    // Non-I/O imports
    expect(importsNodeIo(`import { foo } from 'bar';`)).toBe(false);
    expect(importsNodeIo(``)).toBe(false);
  });

  it('importsNodeIo detects child_process and better-sqlite3 runtime imports', () => {
    // Runtime child_process imports
    expect(importsNodeIo(`import { spawn } from 'child_process';`)).toBe(true);
    expect(importsNodeIo(`import { execSync } from 'node:child_process';`)).toBe(true);
    expect(importsNodeIo(`import { fork } from 'child_process/promises';`)).toBe(true);
    // Runtime better-sqlite3 import
    expect(importsNodeIo(`import Database from 'better-sqlite3';`)).toBe(true);
    // Mixed runtime + type import from child_process (still runtime I/O)
    expect(importsNodeIo(`import { spawn, type SpawnOptions } from 'child_process';`)).toBe(true);
  });

  it('importsNodeIo EXCLUDES `import type` (erased at runtime, no I/O)', () => {
    // Type-only imports from forbidden modules — must NOT trigger
    expect(importsNodeIo(`import type { Database } from 'better-sqlite3';`)).toBe(false);
    expect(importsNodeIo(`import type BetterSqlite3 from 'better-sqlite3';`)).toBe(false);
    expect(importsNodeIo(`import type { SpawnOptions } from 'child_process';`)).toBe(false);
    expect(importsNodeIo(`import type { Stats } from 'node:fs';`)).toBe(false);
    expect(importsNodeIo(`import type { Platform } from 'node:process';`)).toBe(false);
    // Mixed: a real `import type` next to a runtime import from a DIFFERENT module
    // — the type import is excluded, the runtime import is detected.
    expect(importsNodeIo(`import type { Database } from 'better-sqlite3';\nimport { spawn } from 'child_process';`)).toBe(true);
  });

  it('importsFsOrPath alias stays in sync with importsNodeIo', () => {
    // The back-compat alias must point to the same implementation.
    expect(importsFsOrPath(`import { spawn } from 'child_process';`)).toBe(true);
    expect(importsFsOrPath(`import type { Database } from 'better-sqlite3';`)).toBe(false);
  });
});

// ===========================================================================
// SEC-BASE-1: Supply Chain Provenance Guards
// Guards the npm publish / CI supply chain controls declared in
// docs/architecture/SECURITY_BASELINE.md §3 (supply chain layer).
// ===========================================================================
describe('SEC-BASE-1: supply chain provenance guards', () => {
  const REPO_ROOT = pathSync.resolve(__dirname, '../../../../..');

  function readWorkflow(name: string): string | null {
    const p = pathSync.join(REPO_ROOT, '.github', 'workflows', name);
    try {
      return fsSync.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  }

  it('publish-npm.yml uses --provenance', () => {
    const content = readWorkflow('publish-npm.yml');
    expect(content, 'publish-npm.yml should exist').not.toBeNull();
    expect(content).toMatch(/npm\s+publish\s+--provenance/);
  });

  it('publish-npm.yml uses npm ci --ignore-scripts', () => {
    const content = readWorkflow('publish-npm.yml');
    expect(content).not.toBeNull();
    expect(content).toMatch(/npm\s+ci\s+--ignore-scripts/);
  });

  it('SECURITY.md exists at .github/SECURITY.md', () => {
    const p = pathSync.join(REPO_ROOT, '.github', 'SECURITY.md');
    expect(fsSync.existsSync(p), `${p} should exist`).toBe(true);
  });

  it('CodeQL workflow targets javascript-typescript', () => {
    const content = readWorkflow('codeql.yml');
    expect(content, 'codeql.yml should exist').not.toBeNull();
    expect(content).toMatch(/javascript-typescript/);
  });

  it('dependabot.yml covers npm and github-actions', () => {
    const p = pathSync.join(REPO_ROOT, '.github', 'dependabot.yml');
    const content = fsSync.readFileSync(p, 'utf8');
    expect(content).toMatch(/package-ecosystem:\s*['"]?npm['"]?/m);
    expect(content).toMatch(/package-ecosystem:\s*['"]?github-actions['"]?/m);
  });
});

// ===========================================================================
// SEC-BASE-2: Sandbox Escape Regression Guards
// Guards the vm sandbox layer declared in SECURITY_BASELINE.md §4.
// Escape payload regression lives in
// packages/openclaw-plugin/tests/core/sandbox-escape-regression.test.ts
// ===========================================================================
describe('SEC-BASE-2: sandbox escape regression guards', () => {
  const REPO_ROOT = pathSync.resolve(__dirname, '../../../../..');

  it('rule-code-validator forbids import.meta', async () => {
    const { checkForbiddenPatterns } = await import('../internalization/rule-code-validator.js');
    const labels = checkForbiddenPatterns('const u = import.meta.url;');
    expect(labels).toContain('import.meta');
  });

  it('rule-code-validator forbids WeakRef / FinalizationRegistry', async () => {
    const { checkForbiddenPatterns } = await import('../internalization/rule-code-validator.js');
    expect(checkForbiddenPatterns('new WeakRef({});')).toContain('WeakRef');
    expect(checkForbiddenPatterns('new FinalizationRegistry(() => {});')).toContain('FinalizationRegistry');
  });

  it('rule-code-validator forbids SharedArrayBuffer / Atomics', async () => {
    const { checkForbiddenPatterns } = await import('../internalization/rule-code-validator.js');
    expect(checkForbiddenPatterns('new SharedArrayBuffer(8);')).toContain('SharedArrayBuffer');
    expect(checkForbiddenPatterns('Atomics.load(new Int32Array(1), 0);')).toContain('Atomics');
  });

  it('rule-implementation-runtime.ts uses spawnSync with bounded resources', () => {
    const sourcePath = pathSync.join(REPO_ROOT, 'packages', 'openclaw-plugin', 'src', 'core', 'rule-implementation-runtime.ts');
    const source = fsSync.readFileSync(sourcePath, 'utf8');
    expect(source).toContain('spawnSync');
    expect(source).toContain('windowsHide: true');
    expect(source).toContain('maxBuffer');
    expect(source).toContain('--max-old-space-size');
    expect(source).toMatch(/timeout:\s*\w+/);
  });
});

// ===========================================================================
// SEC-BASE-3: PII Redaction Guards
// Guards that the implemented PII sanitization patterns exist in
// openclaw-plugin (trajectory.ts redactText) and that message-sanitize hook
// applies sanitization to message content.
//
// IMPLEMENTED (MVP): <EMAIL>, <TOKEN> (sk/rk/pk prefix), <PATH>, <WINDOWS_PATH>
// POST-MVP GAPS (documented in SECURITY_BASELINE.md): <PHONE>, <CARD>, <IP>
// ===========================================================================
describe('SEC-BASE-3: PII redaction guards', () => {
  const REPO_ROOT = pathSync.resolve(__dirname, '../../../../..');

  it('openclaw-plugin contains email redaction pattern with <EMAIL> replacement', () => {
    const pluginDir = pathSync.join(REPO_ROOT, 'packages', 'openclaw-plugin', 'src');
    const files = fsSync.readdirSync(pluginDir, { recursive: true, encoding: 'utf8' })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts') && !f.includes('__tests__'));
    let foundEmail = false;
    for (const f of files) {
      const content = fsSync.readFileSync(pathSync.join(pluginDir, f), 'utf8');
      // Look for: <EMAIL> replacement token AND a regex containing @ (email pattern)
      if (/<EMAIL>/.test(content) && /\.\s*replace\s*\(\s*\/.*@.*\//.test(content)) {
        foundEmail = true;
        break;
      }
    }
    expect(foundEmail, 'openclaw-plugin should contain email redaction pattern with <EMAIL> replacement').toBe(true);
  });

  it('openclaw-plugin contains API token redaction pattern (<TOKEN> with sk/rk/pk prefix)', () => {
    const pluginDir = pathSync.join(REPO_ROOT, 'packages', 'openclaw-plugin', 'src');
    const files = fsSync.readdirSync(pluginDir, { recursive: true, encoding: 'utf8' })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts') && !f.includes('__tests__'));
    let foundToken = false;
    for (const f of files) {
      const content = fsSync.readFileSync(pathSync.join(pluginDir, f), 'utf8');
      // Look for: <TOKEN> replacement token AND a regex containing (sk|rk|pk)
      if (/<TOKEN>/.test(content) && /\(sk\|rk\|pk\)/.test(content)) {
        foundToken = true;
        break;
      }
    }
    expect(foundToken, 'openclaw-plugin should contain API token redaction pattern with <TOKEN> replacement').toBe(true);
  });

  it('openclaw-plugin message-sanitize hook applies sanitization', () => {
    const sourcePath = pathSync.join(REPO_ROOT, 'packages', 'openclaw-plugin', 'src', 'hooks', 'message-sanitize.ts');
    const source = fsSync.readFileSync(sourcePath, 'utf8');
    // Delegate pattern: import from core + apply to message content
    expect(source).toMatch(/coreSanitize|sanitizeValue|sanitiz/i);
  });
});

// ===========================================================================
// SEC-BASE-4: Log Secret Redaction & SQLite SQL Injection Guards
// Guards that:
//   (a) core does not emit raw secret-named fields in logger output
//   (b) core does not string-concatenate SQL (uses parameterized queries)
// ===========================================================================
describe('SEC-BASE-4: log secret redaction & SQL injection guards', () => {
  const REPO_ROOT = pathSync.resolve(__dirname, '../../../../..');

  it('core source does not log raw api_key / token / secret / password fields', () => {
    const coreDir = pathSync.join(REPO_ROOT, 'packages', 'principles-core', 'src');
    const files = fsSync.readdirSync(coreDir, { recursive: true, encoding: 'utf8' })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts') && !f.includes('__tests__'));
    const suspicious: string[] = [];
    for (const f of files) {
      const content = fsSync.readFileSync(pathSync.join(coreDir, f), 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (/log(ger)?\./i.test(line) || /console\./.test(line)) {
          if (/\b(api[_-]?key|token|secret|password|credential)\b/i.test(line) && !/<REDACTED>/.test(line) && !/sanitiz/i.test(line)) {
            suspicious.push(`${f}:${idx + 1}: ${line.trim()}`);
          }
        }
      });
    }
    expect(suspicious, `Suspicious unredacted logger lines in core:\n${suspicious.join('\n')}`).toEqual([]);
  });

  it('core source does not string-concatenate SQL statements', () => {
    const coreDir = pathSync.join(REPO_ROOT, 'packages', 'principles-core', 'src');
    const files = fsSync.readdirSync(coreDir, { recursive: true, encoding: 'utf8' })
      .filter((f): f is string => typeof f === 'string'
        && f.endsWith('.ts')
        && !f.endsWith('.test.ts')
        && !f.includes('__tests__'));
    const suspicious: string[] = [];
    // Known-safe pre-built clause variables (constructed from controlled
    // conditions with `?` placeholders for values — not user input).
    // `placeholders` = e.g. `ids.map(() => '?').join(',')` → generates `?,?,?`
    //   (a string of `?` placeholder characters, NOT user values).
    const SAFE_CLAUSE_VARS = new Set([
      'whereClause', 'orderByClause', 'limitClause', 'setClause',
      'conflictClause', 'returningClause', 'onConflictClause',
      'placeholders',
    ]);
    // DML statements that MUST use parameterized values (`?` placeholders).
    // DDL (ALTER TABLE / CREATE TABLE / CREATE INDEX / DROP) is excluded
    // because SQLite does not accept `?` placeholders for identifiers (column
    // names, table names) — DDL string-concat with controlled constants is
    // the only valid pattern and is verified separately.
    const DML_RE = /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/i;
    for (const f of files) {
      const content = fsSync.readFileSync(pathSync.join(coreDir, f), 'utf8');
      // Find line number offset for reporting.
      const lines = content.split('\n');
      // Match .prepare(`...`) and .exec(`...`) template-literal SQL arguments.
      // Uses [\s\S]*? (non-greedy, dotAll-equivalent) to capture multi-line
      // template literals. Only the FIRST argument (the SQL string) is inspected.
      const templateSqlRe = /\.(prepare|exec)\s*\(\s*`([\s\S]*?)`/g;
      let m: RegExpExecArray | null;
      while ((m = templateSqlRe.exec(content)) !== null) {
        // rc-2-no-as-bypass: RegExpExecArray indices are `string | undefined`
        // under noUncheckedIndexedAccess. Use array destructuring (ESLint
        // prefer-destructuring) + explicit undefined check (fail-loud).
        const [, , sqlBody] = m;
        if (sqlBody === undefined) continue;
        if (!DML_RE.test(sqlBody)) continue; // DDL-only is allowed
        // Find line number of the match start.
        const matchOffset = m.index;
        const lineNum = content.slice(0, matchOffset).split('\n').length;
        // Check for `${X}` interpolations inside the SQL template body.
        const interpRe = /\$\{([^}]+)\}/g;
        let im: RegExpExecArray | null;
        while ((im = interpRe.exec(sqlBody)) !== null) {
          const [, expr] = im;
          if (expr === undefined) continue;
          const exprTrimmed = expr.trim();
          // Safe: ends with .join(...) — column-list / placeholder-list pattern.
          if (/\.join\s*\(/.test(exprTrimmed)) continue;
          // Safe: known pre-built clause variable.
          const rootVar = exprTrimmed.split('.')[0]?.split('[')[0]?.split('(')[0];
          if (rootVar !== undefined && SAFE_CLAUSE_VARS.has(rootVar.trim())) continue;
          // Safe: numeric / length / index expressions (not user data).
          if (/^\d+$/.test(exprTrimmed) || /\.length$/.test(exprTrimmed)) continue;
          suspicious.push(`${f}:${lineNum}: interpolation \${${exprTrimmed}} in DML template`);
        }
      }
      // Also check for string-concatenation pattern: .prepare('...' + var + '...')
      // This is a single-line check (string concat SQL is rarely multi-line).
      const concatSqlRe = /\.(prepare|exec)\s*\(\s*['"][^'"]*['"]\s*\+/g;
      let cm: RegExpExecArray | null;
      while ((cm = concatSqlRe.exec(content)) !== null) {
        const lineNum = content.slice(0, cm.index).split('\n').length;
        const line = lines[lineNum - 1] || '';
        // Only flag if the concatenated string contains DML keywords.
        if (DML_RE.test(line)) {
          suspicious.push(`${f}:${lineNum}: string-concat in DML: ${line.trim()}`);
        }
      }
    }
    expect(suspicious, `Suspicious string-concatenated or interpolated DML in core:\n${suspicious.join('\n')}`).toEqual([]);
  });
});

// ===========================================================================
// SEC-BASE-5: Network & Config Isolation Guards
// Guards:
//   (a) core does not import node:http / node:https / undici / fetch (NET-1)
//   (b) pd-console server config does not default to 0.0.0.0 (NET-5)
//   (c) code_tool_hook config defaults to require_approval (CFG-4)
// ===========================================================================
describe('SEC-BASE-5: network & config isolation guards', () => {
  const REPO_ROOT = pathSync.resolve(__dirname, '../../../../..');

  it('core does not import node:http / node:https / undici / fetch for business', () => {
    const coreDir = pathSync.join(REPO_ROOT, 'packages', 'principles-core', 'src');
    const files = fsSync.readdirSync(coreDir, { recursive: true, encoding: 'utf8' })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts') && !f.includes('__tests__'));
    const violations: string[] = [];
    for (const f of files) {
      const content = fsSync.readFileSync(pathSync.join(coreDir, f), 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (/^import\s+type/.test(line.trim())) return;
        if (/from\s+['"]node:http['"]/.test(line) || /from\s+['"]node:https['"]/.test(line)
            || /from\s+['"]undici['"]/.test(line) || /from\s+['"]node-fetch['"]/.test(line)) {
          violations.push(`${f}:${idx + 1}: ${line.trim()}`);
        }
        if (!/^\s*(\/\/|\/\*|\*)/.test(line) && /\bfetch\s*\(/.test(line) && !/import/.test(line)) {
          violations.push(`${f}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations, `core should not import network modules (NET-1):\n${violations.join('\n')}`).toEqual([]);
  });

  it('pd-console server config does not default to 0.0.0.0', () => {
    const consoleDir = pathSync.join(REPO_ROOT, 'packages', 'pd-console', 'src');
    if (!fsSync.existsSync(consoleDir)) {
      // pd-console may not exist in this worktree — skip with explicit note
      console.warn('SEC-BASE-5: pd-console src dir not found, skipping bind_host check');
      return;
    }
    const files = fsSync.readdirSync(consoleDir, { recursive: true, encoding: 'utf8' })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts'));
    const violations: string[] = [];
    for (const f of files) {
      const content = fsSync.readFileSync(pathSync.join(consoleDir, f), 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        // rc-9-no-silent-fallback: previously used `!/comment/.test(line)` which
        // matched any line containing the substring "comment" (e.g. a variable
        // named `commentField`), silently skipping real 0.0.0.0 defaults.
        // Only skip genuine comment lines.
        const trimmed = line.trim();
        const isCommentLine = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
        if (/host\s*[:=]\s*['"]0\.0\.0\.0['"]/.test(line) && !isCommentLine) {
          violations.push(`${f}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations, `pd-console should not default to 0.0.0.0 (NET-5):\n${violations.join('\n')}`).toEqual([]);
  });

  it('code_tool_hook config defaults to require_approval', () => {
    // rc-9-no-silent-fallback: this was previously `expect(true).toBe(true)`
    // (a tautology that always passed, giving false confidence). Now it fails
    // loud if the require_approval decision is removed from the codebase.
    // The `requireApproval` decision is enforced in gate.ts and is the
    // MVP-Core safety boundary for code_tool_hook.
    const pluginDir = pathSync.join(REPO_ROOT, 'packages', 'openclaw-plugin', 'src');
    const files = fsSync.readdirSync(pluginDir, { recursive: true, encoding: 'utf8' })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts') && !f.includes('__tests__'));
    let foundRequireApproval = false;
    for (const f of files) {
      const content = fsSync.readFileSync(pathSync.join(pluginDir, f), 'utf8');
      if (/code[_-]?tool[_-]?hook/i.test(content) && /require[_-]?approval/i.test(content)) {
        foundRequireApproval = true;
        break;
      }
    }
    expect(
      foundRequireApproval,
      'code_tool_hook should reference require_approval decision in openclaw-plugin src ' +
      '(expected in hooks/gate.ts). If removed, the code_tool_hook safety boundary is broken.',
    ).toBe(true);
  });
});
