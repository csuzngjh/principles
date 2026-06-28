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
    'pd-task-types.ts',
    'evolution-types.ts',
    'empathy-types.ts',
    'correction-types.ts',
    'principle-injection.ts',
    'principle-compiler/template-generator.ts',
  ] as const;

  // Categories 3-5: Plugin I/O adapters, Do Not Move, I/O boundary
  const PLUGIN_IO_FILES = [
    // Thin adapter candidates
    'principle-internalization/principle-lifecycle-service.ts',
    // principle-tree-ledger-adapter.ts removed — orphan duplicate of the canonical
    // @principles/core/runtime-v2 adapter (PRI-459 consolidation completed).
    'principle-compiler/ledger-registrar.ts',
    'principle-compiler/code-validator.ts',
    'pd-task-service.ts',
    'principle-internalization/lifecycle-read-model.ts',
    'principle-internalization/filesystem-lifecycle-datasource.ts',
    'config-service.ts',
    'principle-compiler/index.ts',
    'principle-internalization/lifecycle-refresh.ts',
    // Do Not Move
    'event-log.ts',
    'path-resolver.ts',
    'init.ts',
    'workspace-context.ts',
    'reflection/reflection-context.ts',
    'bootstrap-rules.ts',
    'rule-host.ts',
    'principle-training-state.ts',
    'pain-diagnostic-gate.ts',
    'hygiene/tracker.ts',
    'paths.ts',
    'workspace-dir-validation.ts',
    'rule-implementation-runtime.ts',
    'detection-service.ts',
    'dictionary-service.ts',
    // I/O boundary
    'trajectory.ts',
    'evolution-reducer.ts',
    'focus-history.ts',
    'replay-engine.ts',
    'control-ui-db.ts',
    'thinking-models.ts',
    'pd-task-reconciler.ts',
    'correction-cue-learner.ts',
    'principle-compiler/compiler.ts',
    'pain.ts',
    'config.ts',
    'code-implementation-storage.ts',
    'workflow-funnel-loader.ts',
    'dictionary.ts',
    'thinking-os-parser.ts',
    'system-logger.ts',
    'detection-funnel.ts',
    'risk-calculator.ts',
    'migration.ts',
    'file-store.ts',
    'pd-task-store.ts',
    'empathy-keyword-matcher.ts',
    'session-tracker.ts',
    'principle-tree-ledger.ts',
    'evolution-logger.ts',
    'evolution-engine.ts',
    'runtime-v2-prompt-activation-reader.ts',
    'workspace-guidance-migrator.ts',
    'surface-guard.ts',
    'pd-config-loader.ts',
    'config-health.ts',  // PRI-346: conversation access check extracted to avoid circular imports
    // PRI-467: Plugin I/O boundary — reads .principles/INTENT.md with TTL+mtime
    // cache, delegates parsing/validation/hashing to @principles/core. Never throws.
    'intent-doc-reader.ts',
    // PRI-468: Plugin adapter implementing core IntentDocReader port — pure type
    // mapping from safeReadIntentDoc result to core IntentDocReadResult. No new I/O.
    'intent-doc-reader-adapter.ts',
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
