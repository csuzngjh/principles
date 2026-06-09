import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── PRI-212: Plugin core anti-growth architecture guard ─────────────────────
//
// Prevents new unclassified files from being added to packages/openclaw-plugin/src/core/
// without explicit allowlisting. New pure domain logic MUST go to @principles/core.
//
// Baseline from PRI-211 inventory (2026-05-21).
// Reference: docs/reviews/plugin-core-inventory-2026-05.md
//
// How to add a new file:
//   1. Is it pure domain logic? → add to @principles/core, NOT here
//   2. Is it a plugin I/O adapter/binding? → add to PLUGIN_IO_FILES
//      with a comment explaining why it belongs in plugin core
//   3. NEVER add to/from FROZEN_LEGACY (ADR-0005) — those must NOT be modified

describe('PRI-212 plugin core anti-growth guard', () => {
  // Category 1: Frozen Legacy (ADR-0005) — deleted in PRI-230
  const FROZEN_LEGACY = [
  ] as const;

  // Category 2: Pure domain logic with zero I/O imports — should migrate to @principles/core
  const ZERO_IMPORT_CANDIDATES = [
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
  ] as const;

  // Categories 3-5: Plugin I/O adapters, Do Not Move, I/O boundary
  const PLUGIN_IO_FILES = [
    // Thin adapter candidates
    'local-worker-routing.ts',
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
    'principle-compiler/index.ts',
    'principle-internalization/lifecycle-refresh.ts',
    // Do Not Move
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
    // I/O boundary
    'trajectory.ts',
    'evolution-reducer.ts',
    'promotion-gate.ts',
    'model-training-registry.ts',
    'focus-history.ts',
    'model-deployment-registry.ts',
    'training-program.ts',
    'replay-engine.ts',
    'external-training-contract.ts',
    'merge-gate-audit.ts',
    'shadow-observation-registry.ts',
    'control-ui-db.ts',
    'thinking-models.ts',
    'pd-task-reconciler.ts',
    'correction-cue-learner.ts',
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
    'detection-funnel.ts',
    'risk-calculator.ts',
    'migration.ts',
    'file-store.ts',
    'pd-task-store.ts',
    'evolution-migration.ts',
    'empathy-keyword-matcher.ts',
    'pain-lifecycle.ts',
    'session-tracker.ts',
    'principle-tree-ledger.ts',
    'evolution-logger.ts',
    'evolution-engine.ts',
    'runtime-v2-prompt-activation-reader.ts',
    'workspace-guidance-migrator.ts',
    'surface-guard.ts',
    'pd-config-loader.ts',
    'config-health.ts',  // PRI-346: conversation access check extracted to avoid circular imports
  ] as const;

  // Category 6: Test files
  const KNOWN_TEST_FILES = [
    '__tests__/focus-history.test.ts',
    'principle-compiler/__tests__/compiler-replay-gate.test.ts',
  ] as const;

  const ALL_KNOWN = [
    ...FROZEN_LEGACY,
    ...ZERO_IMPORT_CANDIDATES,
    ...PLUGIN_IO_FILES,
    ...KNOWN_TEST_FILES,
  ];

  function enumerateFiles(dir: string, prefix = ''): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...enumerateFiles(fullPath, relPath));
      } else if (entry.name.endsWith('.ts')) {
        files.push(relPath.replace(/\\/g, '/'));
      }
    }
    return files;
  }

  it('no new unclassified files in plugin core', () => {
    const coreDir = path.resolve(__dirname, '../src/core');
    const actualFiles = enumerateFiles(coreDir).sort();
    const expectedFiles = [...ALL_KNOWN].sort();

    const actualSet = new Set(actualFiles);
    const knownSet = new Set(expectedFiles);

    const unknownFiles = actualFiles.filter((f) => !knownSet.has(f));
    const missingFiles = expectedFiles.filter((f) => !actualSet.has(f));

    expect(unknownFiles, [
      `\nUnclassified files detected in packages/openclaw-plugin/src/core/:`,
      ...unknownFiles.map((f) => `  + ${f}`),
      ``,
      `New pure domain logic MUST go to @principles/core (packages/principles-core/).`,
      `Plugin I/O adapter additions must be explicitly allowlisted in`,
      `packages/openclaw-plugin/tests/core-anti-growth.test.ts`,
      `ADR-0005 frozen files must NOT be modified.`,
      `Reference: docs/reviews/plugin-core-inventory-2026-05.md (PRI-211)`,
    ].join('\n')).toEqual([]);

    expect(missingFiles, [
      `\nBaseline files missing from packages/openclaw-plugin/src/core/:`,
      ...missingFiles.map((f) => `  - ${f}`),
      ``,
      `Missing baseline files may indicate:`,
      `  - File was moved or deleted (update inventory if intentional)`,
      `  - Stale-main rollback (ERR-012): rebase on latest origin/main`,
      `  - File was renamed (update inventory with new name)`,
    ].join('\n')).toEqual([]);
  });

  it('zero-import candidates are tracked for migration awareness', () => {
    expect(ZERO_IMPORT_CANDIDATES.length).toBeGreaterThan(0);
  });
});
