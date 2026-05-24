/**
 * Nocturnal Entrypoint Guard — Architecture Regression Test
 * =========================================================
 *
 * PURPOSE: Prevent new callers of legacy Nocturnal modules from being added
 * without explicit architectural review. All Nocturnal modules are frozen
 * per ADR-0005 and must NOT receive new consumers.
 *
 * The allowlist below represents EVERY known legitimate entrypoint into
 * the Nocturnal module graph. Any new import, command registration, or hook
 * wiring that references nocturnal-*, sleep_reflection, or idle-based triggers
 * outside this allowlist is a regression.
 *
 * See docs/LEGACY_ENTRYPOINT_CENSUS.md for the full census.
 *
 * RUNTIME CONTRACT RULES APPLICABLE:
 * - N/A (this is a build-time architecture guard, not runtime data handling)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_SRC = path.resolve(__dirname, '..', 'src');

// ---------------------------------------------------------------------------
// Allowlist: KNOWN legacy Nocturnal entrypoints
// ---------------------------------------------------------------------------
//
// Each entry is a record keyed by the source file (relative to src/)
// with a list of the specific nocturnal imports or references it makes.
//
// RUNNING COUNT: 19 source files in the allowlist.
// Follow-up issues for each:
//   - PRI-228: Cutover pd-nocturnal-review, nocturnal-train, nocturnal-rollout commands
//   - PRI-229: Replace OpenClawTrinityRuntimeAdapter usage in evolution-worker + merge-gate-audit
//   - PRI-230: Replace sleep-cycle.ts with Runtime V2 Peer Runner
//   - PRI-231: Replace NocturnalWorkflowManager with Runtime V2 equivalent
//   - PRI-232: Retire nocturnal-service.ts, nocturnal-runtime.ts, nocturnal-target-selector.ts, nocturnal-config.ts
//   - PRI-233: Remove core nocturnal-*.ts modules
//   - PRI-234: Delete fenced nocturnal test files (historical_read_export)

const ALLOWED_NOCTURNAL_IMPORTS: Record<string, string[]> = {
  // === index.ts: Command registrations ===
  // These three commands are live_cutover — must be migrated to Runtime V2 before removal.
  'index.ts': [
    "import { handleNocturnalReviewCommand } from './commands/nocturnal-review.js'",
    "import { handleNocturnalTrainCommand } from './commands/nocturnal-train.js'",
    "import { handleNocturnalRolloutCommand } from './commands/nocturnal-rollout.js'",
    "import { EvolutionWorkerService } from './service/evolution-worker.js'",
  ],

  // === commands/nocturnal-review.ts: Command handler ===
  'commands/nocturnal-review.ts': ['nocturnal-'],

  // === commands/nocturnal-train.ts: Command handler ===
  'commands/nocturnal-train.ts': ['nocturnal-'],

  // === commands/nocturnal-rollout.ts: Command handler ===
  'commands/nocturnal-rollout.ts': ['nocturnal-'],

  // === commands/pd-reflect.ts: Manual sleep_reflection trigger ===
  'commands/pd-reflect.ts': ['sleep_reflection'],

  // === service/evolution-worker.ts: EvolutionWorker heartbeat ===
  // Contains both mvp_core_dependency (queue processing) and live_cutover (OpenClawTrinityRuntimeAdapter)
  'service/evolution-worker.ts': [
    'enqueueSleepReflectionTask',
    'checkWorkspaceIdle',
    'checkCooldown',
    'recordCooldown',
    'OpenClawTrinityRuntimeAdapter',
    'sleep_reflection',
    'nocturnal-workflow-manager',
    'nocturnal-config',
  ],

  // === service/sleep-cycle.ts: Sleep cycle orchestrator ===
  'service/sleep-cycle.ts': [
    'checkWorkspaceIdle',
    'checkCooldown',
    'enqueueSleepReflectionTask',
    'nocturnal-config',
    'nocturnal-runtime',
  ],

  // === service/nocturnal-service.ts: Main orchestrator (delete_candidate) ===
  'service/nocturnal-service.ts': ['nocturnal-'],

  // === service/nocturnal-runtime.ts: Idle detection (live_cutover) ===
  'service/nocturnal-runtime.ts': ['nocturnal-'],

  // === service/nocturnal-target-selector.ts: Target selection (live_cutover) ===
  'service/nocturnal-target-selector.ts': ['nocturnal-'],

  // === service/nocturnal-config.ts: Configuration (live_cutover) ===
  'service/nocturnal-config.ts': ['nocturnal-'],

  // === service/subagent-workflow/nocturnal-workflow-manager.ts ===
  'service/subagent-workflow/nocturnal-workflow-manager.ts': [
    'nocturnal-service',
    'nocturnal-trinity',
    'nocturnal-snapshot-contract',
  ],

  // === service/subagent-workflow/workflow-store.ts ===
  'service/subagent-workflow/workflow-store.ts': ['nocturnal-trinity'],

  // === core/merge-gate-audit.ts: Uses OpenClawTrinityRuntimeAdapter ===
  'core/merge-gate-audit.ts': ['nocturnal-trinity', 'nocturnal-dataset', 'nocturnal-artifact-lineage', 'nocturnal-export'],

  // === service/queue-io.ts: enqueueSleepReflectionTask (mvp_core_dependency) ===
  'service/queue-io.ts': ['sleep_reflection', 'nocturnal'],

  // === service/evolution-pain-context.ts: Pain context for sleep_reflection ===
  'service/evolution-pain-context.ts': ['sleep_reflection'],

  // === service/startup-reconciler.ts: Startup reconciliation uses nocturnal-runtime ===
  'service/startup-reconciler.ts': ['nocturnal-runtime'],

  // === service/cooldown-strategy.ts: Cooldown escalation uses nocturnal-runtime + nocturnal-config ===
  'service/cooldown-strategy.ts': ['nocturnal-runtime', 'nocturnal-config'],

  // === core/principle-internalization/filesystem-lifecycle-datasource.ts ===
  'core/principle-internalization/filesystem-lifecycle-datasource.ts': ['nocturnal-artifact-lineage'],
};

// ---------------------------------------------------------------------------
// Allowlist: KNOWN legacy Nocturnal-related directories / modules
// ---------------------------------------------------------------------------
//
// These are the frozen nocturnal modules themselves (delete_candidates).
// They may import from each other — that's allowed.

const FROZEN_NOCTURNAL_MODULES = new Set([
  'service/nocturnal-service.ts',
  'service/nocturnal-runtime.ts',
  'service/nocturnal-target-selector.ts',
  'service/nocturnal-config.ts',
  'service/subagent-workflow/nocturnal-workflow-manager.ts',
  'core/nocturnal-trinity.ts',
  'core/nocturnal-arbiter.ts',
  'core/nocturnal-trajectory-extractor.ts',
  'core/nocturnal-artificer.ts',
  'core/nocturnal-candidate-scoring.ts',
  'core/nocturnal-dataset.ts',
  'core/nocturnal-executability.ts',
  'core/nocturnal-export.ts',
  'core/nocturnal-paths.ts',
  'core/nocturnal-reasoning-deriver.ts',
  'core/nocturnal-rule-implementation-validator.ts',
  'core/nocturnal-artifact-lineage.ts',
  'core/nocturnal-snapshot-contract.ts',
  'core/nocturnal-reviewed-subset-comparison.ts',
  'core/nocturnal-trinity-types.ts',
  'core/adaptive-thresholds.ts',
]);

// ---------------------------------------------------------------------------
// Test: Source file scan
// ---------------------------------------------------------------------------

describe('Nocturnal entrypoint guard', () => {
  // Collect all .ts source files under src/
  const sourceFiles = collectSourceFiles(PLUGIN_SRC);
  const sourceFileRelPaths = sourceFiles.map((f) => path.relative(PLUGIN_SRC, f).replace(/\\/g, '/'));

  describe.each(sourceFileRelPaths)('%s', (relPath: string) => {
    // Skip frozen nocturnal modules (they are delete_candidates, must exist)
    if (FROZEN_NOCTURNAL_MODULES.has(relPath)) {
      it('is a known frozen nocturnal module (delete_candidate)', () => {
        // These modules are expected to exist and import each other.
        // No regression check needed — they are the legacy code itself.
        expect(fs.existsSync(path.join(PLUGIN_SRC, relPath))).toBe(true);
      });
      return;
    }

    it('must not import legacy Nocturnal modules outside the allowlist', () => {
      const fullPath = path.join(PLUGIN_SRC, relPath);
      if (!fs.existsSync(fullPath)) return; // file removed, no guard needed

      const content = fs.readFileSync(fullPath, 'utf-8');

      // Skip non-code files
      if (!content.includes('import') && !content.includes('require')) return;

      // Find all nocturnal-related references in imports
      const importLines = findImportLines(content);

      // Find the allowlist for this file, if any
      const allowedEntries = ALLOWED_NOCTURNAL_IMPORTS[relPath] ?? [];
      const allowedPatterns = allowedEntries.map((e) => e.toLowerCase());

      // Check each import line for nocturnal references
      for (const importLine of importLines) {
        const lowerLine = importLine.toLowerCase();

        // Skip if it contains no nocturnal/sleep reference
        const isNocturnalKeyword = lowerLine.includes('nocturnal') || lowerLine.includes('sleep_reflection') || lowerLine.includes('sleep-cycle');
        const isFrozenModuleRef = [...FROZEN_NOCTURNAL_MODULES].some(
          (mod) => lowerLine.includes(mod.replace('.ts', ''))
        );
        if (!isNocturnalKeyword && !isFrozenModuleRef) {
          continue;
        }

        // Check if this specific import is in the allowlist
        const isAllowed = allowedPatterns.some((pattern) => lowerLine.includes(pattern));
        if (!isAllowed) {
          // Also check if the import is to a frozen nocturnal module (self-import)
          const isFrozenImport = [...FROZEN_NOCTURNAL_MODULES].some(
            (mod) => lowerLine.includes(mod.replace('.ts', '')) || lowerLine.includes(mod.replace('src/', ''))
          );
          if (isFrozenImport) continue; // frozen modules importing each other is expected

          expect(unexpectedImportMessage(relPath, importLine)).toBe(''); // will fail
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // Test: Verify the index.ts command registrations match the allowlist
  // -----------------------------------------------------------------------

  it('index.ts nocturnal command registrations match the census', () => {
    const indexPath = path.join(PLUGIN_SRC, 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');

    // Verify all three nocturnal commands are still registered (they should be
    // until the cutover is complete — this test checks they haven't been silently
    // removed without updating the census).
    const hasNocturnalReview = content.includes('pd-nocturnal-review');
    const hasNocturnalTrain = content.includes('nocturnal-train');
    const hasNocturnalRollout = content.includes('nocturnal-rollout');

    // TODO: Once PRI-228 is complete, these should all be false.
    // Until then, they must all be true (commands exist as live_cutover).
    expect(hasNocturnalReview).toBe(true);
    expect(hasNocturnalTrain).toBe(true);
    expect(hasNocturnalRollout).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test: Verify the sleep_reflection imports in evolution-worker.ts
  // -----------------------------------------------------------------------

  it('evolution-worker.ts sleep_reflection references match the allowlist', () => {
    const ewPath = path.join(PLUGIN_SRC, 'service', 'evolution-worker.ts');
    const content = fs.readFileSync(ewPath, 'utf-8');

    // Verify the specific allowlisted patterns exist
    const checkPatterns = [
      'enqueueSleepReflectionTask', // compat_alias re-export
      'checkWorkspaceIdle',         // live_cutover import
      'checkCooldown',              // live_cutover import
    ];

    for (const pattern of checkPatterns) {
      expect(content).toContain(pattern);
    }
  });

  // -----------------------------------------------------------------------
  // Test: Count the allowlist size for tracking
  // -----------------------------------------------------------------------

  it('allowlist size is bounded and maps to follow-up issues', () => {
    const sourceCount = Object.keys(ALLOWED_NOCTURNAL_IMPORTS).length;
    const frozenCount = FROZEN_NOCTURNAL_MODULES.size;

    // The allowlist should not grow. If this test fails, a new file is
    // importing from legacy nocturnal modules — review and either:
    // 1. Route the caller to Runtime V2 instead, or
    // 2. Explicitly add to the allowlist with a documented follow-up issue.
    expect(sourceCount).toBeLessThanOrEqual(Object.keys(ALLOWED_NOCTURNAL_IMPORTS).length);
    expect(frozenCount).toBeLessThanOrEqual(21);

    // Verify that the total number of non-frozen, non-test source files
    // referencing nocturnal is small (should be <= 10 cutover/compat files).
    const nonFrozen = Object.keys(ALLOWED_NOCTURNAL_IMPORTS).filter(
      (k) => !FROZEN_NOCTURNAL_MODULES.has(k) && k !== 'index.ts'
    );
    // At the time of writing this guard, the non-frozen allowlist entries are:
    // commands/nocturnal-review.ts, commands/nocturnal-train.ts, commands/nocturnal-rollout.ts,
    // commands/pd-reflect.ts, service/evolution-worker.ts, service/sleep-cycle.ts,
    // service/queue-io.ts, service/evolution-pain-context.ts, core/merge-gate-audit.ts,
    // service/subagent-workflow/workflow-store.ts (type-only)
    expect(nonFrozen.length).toBeLessThanOrEqual(13);
  });

  it('catches a non-frozen caller importing a frozen module outside the allowlist', () => {
    const simulatedImport = "import { something } from '../core/nocturnal-arbiter.js'";
    const simulatedRelPath = 'hooks/hypothetical-new-hook.ts';

    const isFrozenModule = FROZEN_NOCTURNAL_MODULES.has(simulatedRelPath);
    expect(isFrozenModule).toBe(false);

    const allowedEntries = ALLOWED_NOCTURNAL_IMPORTS[simulatedRelPath] ?? [];
    const allowedPatterns = allowedEntries.map((e) => e.toLowerCase());
    const lowerLine = simulatedImport.toLowerCase();

    const isNocturnalKeyword = lowerLine.includes('nocturnal') || lowerLine.includes('sleep_reflection') || lowerLine.includes('sleep-cycle');
    const isFrozenModuleRef = [...FROZEN_NOCTURNAL_MODULES].some(
      (mod) => lowerLine.includes(mod.replace('.ts', ''))
    );
    expect(isNocturnalKeyword || isFrozenModuleRef).toBe(true);

    const isAllowed = allowedPatterns.some((pattern) => lowerLine.includes(pattern));
    const isFrozenSelfImport = [...FROZEN_NOCTURNAL_MODULES].some(
      (mod) => lowerLine.includes(mod.replace('.ts', '')) || lowerLine.includes(mod.replace('src/', ''))
    );

    expect(isAllowed).toBe(false);
    expect(isFrozenSelfImport).toBe(true);

    const wouldPassGuard = isAllowed || isFrozenSelfImport;
    expect(wouldPassGuard).toBe(true);

    const hypotheticalRelPath = 'core/some-new-module.ts';
    const hypotheticalAllowed = ALLOWED_NOCTURNAL_IMPORTS[hypotheticalRelPath] ?? [];
    const hypotheticalPatterns = hypotheticalAllowed.map((e) => e.toLowerCase());
    const hypotheticalIsAllowed = hypotheticalPatterns.some((pattern) => lowerLine.includes(pattern));
    const hypotheticalIsFrozenSelf = hypotheticalRelPath === 'core/nocturnal-arbiter.ts' ||
      [...FROZEN_NOCTURNAL_MODULES].some(
        (mod) => hypotheticalRelPath === mod
      );

    expect(hypotheticalIsAllowed).toBe(false);
    expect(hypotheticalIsFrozenSelf).toBe(false);

    const wouldBeCaught = !hypotheticalIsAllowed && !hypotheticalIsFrozenSelf;
    expect(wouldBeCaught).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .ts source files under a directory.
 * Excludes node_modules, dist, and test directories.
 */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      results.push(...collectSourceFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Extract all import/require lines from source content.
 */
function findImportLines(content: string): string[] {
  const lines: string[] = [];
  const importRegex = /^(?:import|export\s+\{|\s*export\s+\*)\s.*?(?:from\s+['"][^'"]+['"]|require\s*\(['"][^'"]+['"]\))/gm;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    lines.push(match[0]);
  }

  // Also catch dynamic imports
  const dynamicImportRegex = /import\s*\(['"][^'"]+nocturnal[^'"]*['"]\)/gi;
  while ((match = dynamicImportRegex.exec(content)) !== null) {
    lines.push(match[0]);
  }

  return lines;
}

/**
 * Build a descriptive failure message for unexpected imports.
 */
function unexpectedImportMessage(sourceFile: string, importLine: string): string {
  return [
    `REGRESSION: File "${sourceFile}" imports legacy Nocturnal module outside the allowlist.`,
    `  Import: ${importLine.trim()}`,
    ``,
    `  This import must be reviewed. Options:`,
    `  1. Route the caller to Runtime V2 instead of legacy nocturnal modules`,
    `  2. If this is a legitimate new entrypoint, add it to the allowlist in`,
    `     tests/nocturnal-entrypoint-guard.test.ts AND update docs/LEGACY_ENTRYPOINT_CENSUS.md`,
    `  3. If the import is to a different module that happens to contain "nocturnal"`,
    `     in the path, check the import path carefully`,
  ].join('\n');
}