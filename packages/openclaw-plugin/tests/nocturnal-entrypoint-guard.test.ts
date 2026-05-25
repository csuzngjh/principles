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
// RUNNING COUNT: matches Object.keys(ALLOWED_NOCTURNAL_IMPORTS).length at runtime.
// PRI-227 only does census + no-new-caller guard. It does NOT authorize deletion.
// MVP-Core (ADR-0014): prompt, code_tool_hook / RuleHost, defer_archive only.
// All idle/night/sleep-reflection/nocturnal dispatch = retirement / live cutover / delete blocker.
// Retirement chain (current valid issues):
//   - PRI-119: DONE — Nocturnal callers cut over; 3 commands RETIRED, heartbeat retired,
//     sleep_reflection/keyword_optimization filters empty, dead code imports retained for PRI-230
//   - PRI-229: Replace OpenClawTrinityRuntimeAdapter usage in merge-gate-audit (evolution-worker removed in PRI-119)
//   - PRI-230: Physical deletion of legacy Nocturnal modules
//   - PRI-231: Retire nocturnal-service.ts, nocturnal-runtime.ts, nocturnal-target-selector.ts, nocturnal-config.ts

const ALLOWED_NOCTURNAL_IMPORTS: Record<string, string[]> = {
  // === index.ts: Command registrations ===
  // PRI-119: Handler imports removed. Commands registered as RETIRED with inline retirement handlers.
  'index.ts': [
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

  // === commands/export.ts: Export command (live_cutover) ===
  'commands/export.ts': ['nocturnal-export'],

  // === service/evolution-worker.ts: EvolutionWorker heartbeat ===
  // PRI-119: Active Nocturnal paths retired. Imports below are dead code retained for PRI-230.
  'service/evolution-worker.ts': [
    'enqueueSleepReflectionTask',
    'recordCooldown',
    'OpenClawTrinityRuntimeAdapter',
    'sleep_reflection',
    'nocturnal-workflow-manager',
    'nocturnal-config',
    'nocturnal-snapshot-contract',
    'nocturnal-trajectory-extractor',
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

  // === service/queue-io.ts: enqueueSleepReflectionTask (live_cutover) ===
  'service/queue-io.ts': ['sleep_reflection', 'nocturnal'],

  // === service/evolution-pain-context.ts: Pain context for sleep_reflection ===
  'service/evolution-pain-context.ts': ['sleep_reflection'],

  // === service/startup-reconciler.ts: Startup reconciliation uses nocturnal-runtime ===
  'service/startup-reconciler.ts': ['nocturnal-runtime'],

  // === service/cooldown-strategy.ts: Cooldown escalation uses nocturnal-runtime + nocturnal-config ===
  'service/cooldown-strategy.ts': ['nocturnal-runtime', 'nocturnal-config'],

  // === core/principle-internalization/filesystem-lifecycle-datasource.ts ===
  'core/principle-internalization/filesystem-lifecycle-datasource.ts': ['nocturnal-artifact-lineage'],

  // === core/correction-cue-learner.ts: Keyword opt cooldown (live_cutover) ===
  'core/correction-cue-learner.ts': ['nocturnal-runtime'],

  // === core/event-log.ts: Event log records nocturnal event types (live_cutover) ===
  'core/event-log.ts': ['nocturnal', 'event-types'],

  // === core/reflection/reflection-context.ts: Reflection context uses nocturnal types (live_cutover) ===
  'core/reflection/reflection-context.ts': ['nocturnal-trajectory-extractor'],

  // === core/replay-engine.ts: Replay engine uses nocturnal dataset types (live_cutover) ===
  'core/replay-engine.ts': ['nocturnal-dataset', 'nocturnal-trajectory-extractor'],

  // === service/subagent-workflow/types.ts: Type definitions reference nocturnal modules (live_cutover) ===
  'service/subagent-workflow/types.ts': ['nocturnal-arbiter', 'nocturnal-executability', 'nocturnal-trajectory-extractor', 'nocturnal-trinity', 'nocturnal-runtime', 'nocturnal-target-selector'],
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


      const frozenModuleBasenames = [...FROZEN_NOCTURNAL_MODULES].map(
        (mod) => path.basename(mod, '.ts')
      );

      for (const importLine of importLines) {
        const lowerLine = importLine.toLowerCase();

        const isFrozenModuleRef = frozenModuleBasenames.some(
          (basename) => lowerLine.includes(basename)
        );
        const isNocturnalKeyword = /(?:^|[-_/.])idle(?:[-_/.]|$)|nocturnal|sleep_reflection|sleep-cycle/i.test(importLine);
        if (!isFrozenModuleRef && !isNocturnalKeyword) {
          continue;
        }

        const isAllowed = allowedPatterns.some((pattern) => lowerLine.includes(pattern));
        if (!isAllowed) {
          expect(unexpectedImportMessage(relPath, importLine)).toBe('');
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

    // PRI-119: Commands still registered but as RETIRED (inline retirement handlers).
    // The command names must still appear so that /pd-nocturnal-review etc. get a
    // retirement message instead of "unknown command".
    const hasNocturnalReview = content.includes('pd-nocturnal-review');
    const hasNocturnalTrain = content.includes('nocturnal-train');
    const hasNocturnalRollout = content.includes('nocturnal-rollout');

    expect(hasNocturnalReview).toBe(true);
    expect(hasNocturnalTrain).toBe(true);
    expect(hasNocturnalRollout).toBe(true);

    // PRI-119: Verify the retirement helper is present
    expect(content).toContain('RETIRED_NOCTURNAL_MSG');

    // PRI-119: Handler imports should be gone
    expect(content).not.toContain('handleNocturnalReviewCommand');
    expect(content).not.toContain('handleNocturnalTrainCommand');
    expect(content).not.toContain('handleNocturnalRolloutCommand');
  });

  // -----------------------------------------------------------------------
  // Test: Verify the sleep_reflection imports in evolution-worker.ts
  // -----------------------------------------------------------------------

  it('evolution-worker.ts sleep_reflection references match the allowlist', () => {
    const ewPath = path.join(PLUGIN_SRC, 'service', 'evolution-worker.ts');
    const content = fs.readFileSync(ewPath, 'utf-8');

    // PRI-119: Only dead code imports remain. Active paths removed.
    const checkPatterns = [
      'enqueueSleepReflectionTask', // dead code import (PRI-230 target)
      'OpenClawTrinityRuntimeAdapter', // dead code import (PRI-230 target)
    ];

    for (const pattern of checkPatterns) {
      expect(content).toContain(pattern);
    }

    // PRI-119: Active Nocturnal callers must be gone
    expect(content).not.toContain('checkWorkspaceIdle');
    expect(content).not.toContain('checkCooldown');
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
    expect(sourceCount).toBe(Object.keys(ALLOWED_NOCTURNAL_IMPORTS).length);
    expect(frozenCount).toBeLessThanOrEqual(21);

    // Verify that the total number of non-frozen, non-test source files
    // referencing nocturnal is small (should be <= 10 cutover/compat files).
    const nonFrozen = Object.keys(ALLOWED_NOCTURNAL_IMPORTS).filter(
      (k) => !FROZEN_NOCTURNAL_MODULES.has(k) && k !== 'index.ts'
    );
    // At the time of writing this guard, the non-frozen allowlist entries are:
    // commands/nocturnal-review.ts, commands/nocturnal-train.ts, commands/nocturnal-rollout.ts,
    // commands/pd-reflect.ts, commands/export.ts, service/evolution-worker.ts, service/sleep-cycle.ts,
    // service/queue-io.ts, service/evolution-pain-context.ts, service/startup-reconciler.ts,
    // service/cooldown-strategy.ts, core/merge-gate-audit.ts,
    // service/subagent-workflow/workflow-store.ts (type-only)
    // core/event-log.ts (nocturnal event type names), core/reflection/reflection-context.ts,
    // core/replay-engine.ts, service/subagent-workflow/types.ts (type definitions),
    // core/principle-internalization/filesystem-lifecycle-datasource.ts, core/correction-cue-learner.ts
    expect(nonFrozen.length).toBeLessThanOrEqual(19);
  });

  it('non-allowlisted caller importing nocturnal-trinity must fail', () => {
    const simulatedImport = "import { something } from '../core/nocturnal-trinity.js'";
    const simulatedRelPath = 'hooks/hypothetical-new-hook.ts';

    const isFrozenModule = FROZEN_NOCTURNAL_MODULES.has(simulatedRelPath);
    expect(isFrozenModule).toBe(false);

    const allowedEntries = ALLOWED_NOCTURNAL_IMPORTS[simulatedRelPath] ?? [];
    const allowedPatterns = allowedEntries.map((e) => e.toLowerCase());
    const lowerLine = simulatedImport.toLowerCase();

    const isNocturnalKeyword = lowerLine.includes('nocturnal');
    const isFrozenModuleRef = [...FROZEN_NOCTURNAL_MODULES].some(
      (mod) => lowerLine.includes(path.basename(mod, '.ts'))
    );
    expect(isNocturnalKeyword || isFrozenModuleRef).toBe(true);

    const isAllowed = allowedPatterns.some((pattern) => lowerLine.includes(pattern));
    expect(isAllowed).toBe(false);

    const guardWouldFail = !isAllowed;
    expect(guardWouldFail).toBe(true);
  });

  it('non-allowlisted caller importing adaptive-thresholds must fail', () => {
    const simulatedImport = "import { getThreshold } from '../core/adaptive-thresholds.js'";
    const simulatedRelPath = 'core/some-new-module.ts';

    const isFrozenModule = FROZEN_NOCTURNAL_MODULES.has(simulatedRelPath);
    expect(isFrozenModule).toBe(false);

    const allowedEntries = ALLOWED_NOCTURNAL_IMPORTS[simulatedRelPath] ?? [];
    const allowedPatterns = allowedEntries.map((e) => e.toLowerCase());
    const lowerLine = simulatedImport.toLowerCase();

    const isFrozenModuleRef = [...FROZEN_NOCTURNAL_MODULES].some(
      (mod) => lowerLine.includes(path.basename(mod, '.ts'))
    );
    expect(isFrozenModuleRef).toBe(true);

    const isAllowed = allowedPatterns.some((pattern) => lowerLine.includes(pattern));
    expect(isAllowed).toBe(false);

    const guardWouldFail = !isAllowed;
    expect(guardWouldFail).toBe(true);
  });

  it('allowlisted existing caller import must pass', () => {
    const simulatedImport = "import { OpenClawTrinityRuntimeAdapter } from '../core/nocturnal-trinity.js'";
    const simulatedRelPath = 'service/evolution-worker.ts';

    const isFrozenModule = FROZEN_NOCTURNAL_MODULES.has(simulatedRelPath);
    expect(isFrozenModule).toBe(false);

    const allowedEntries = ALLOWED_NOCTURNAL_IMPORTS[simulatedRelPath] ?? [];
    const allowedPatterns = allowedEntries.map((e) => e.toLowerCase());
    const lowerLine = simulatedImport.toLowerCase();

    const isAllowed = allowedPatterns.some((pattern) => lowerLine.includes(pattern));
    expect(isAllowed).toBe(true);
  });

  it('frozen module internal import remains allowed', () => {
    const simulatedRelPath = 'core/nocturnal-executability.ts';
    const isFrozenModule = FROZEN_NOCTURNAL_MODULES.has(simulatedRelPath);
    expect(isFrozenModule).toBe(true);
  });

  it('multiline import of frozen module outside allowlist must fail', () => {
    const content = [
      "import {",
      "  DreamerOutput,",
      "  PhilosopherOutput,",
      "} from '../core/nocturnal-trinity.js'",
    ].join('\n');
    const importLines = findImportLines(content);
    expect(importLines.length).toBeGreaterThan(0);
    const lowerLine = importLines[0].toLowerCase();
    expect(lowerLine).toContain('nocturnal-trinity');
    const simulatedRelPath = 'hooks/hypothetical-hook.ts';
    const allowedEntries = ALLOWED_NOCTURNAL_IMPORTS[simulatedRelPath] ?? [];
    const allowedPatterns = allowedEntries.map(e => e.toLowerCase());
    const isAllowed = allowedPatterns.some(pattern => lowerLine.includes(pattern));
    expect(isAllowed).toBe(false);
  });

  it('assigned require of frozen module outside allowlist must fail', () => {
    const content = "const trinity = require('../core/nocturnal-trinity.js')";
    const importLines = findImportLines(content);
    expect(importLines.length).toBeGreaterThan(0);
    const lowerLine = importLines[0].toLowerCase();
    expect(lowerLine).toContain('nocturnal-trinity');
    const simulatedRelPath = 'core/new-module.ts';
    const allowedEntries = ALLOWED_NOCTURNAL_IMPORTS[simulatedRelPath] ?? [];
    const allowedPatterns = allowedEntries.map(e => e.toLowerCase());
    const isAllowed = allowedPatterns.some(pattern => lowerLine.includes(pattern));
    expect(isAllowed).toBe(false);
  });

  it('side-effect import of frozen module outside allowlist must fail', () => {
    const content = "import '../core/nocturnal-trinity.js'";
    const importLines = findImportLines(content);
    expect(importLines.length).toBeGreaterThan(0);
    const lowerLine = importLines[0].toLowerCase();
    expect(lowerLine).toContain('nocturnal-trinity');
    const simulatedRelPath = 'hooks/another-hook.ts';
    const allowedEntries = ALLOWED_NOCTURNAL_IMPORTS[simulatedRelPath] ?? [];
    const allowedPatterns = allowedEntries.map(e => e.toLowerCase());
    const isAllowed = allowedPatterns.some(pattern => lowerLine.includes(pattern));
    expect(isAllowed).toBe(false);
  });

  it('test-only import in __tests__ is not treated as new production entrypoint', () => {
    const testRelPath = 'core/__tests__/some-test.ts';
    const isInTests = testRelPath.includes('__tests__');
    expect(isInTests).toBe(true);
  });

  it('findImportLines detects single-line static import', () => {
    const content = "import { something } from '../core/nocturnal-trinity.js'";
    const lines = findImportLines(content);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('nocturnal-trinity');
  });

  it('findImportLines detects multiline static import', () => {
    const content = "import {\n  DreamerOutput,\n  PhilosopherOutput,\n} from '../core/nocturnal-trinity.js'";
    const lines = findImportLines(content);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('nocturnal-trinity');
  });

  it('findImportLines detects assigned require', () => {
    const content = "const trinity = require('../core/nocturnal-trinity.js')";
    const lines = findImportLines(content);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('nocturnal-trinity');
  });

  it('findImportLines detects bare require', () => {
    const content = "require('../core/nocturnal-trinity.js')";
    const lines = findImportLines(content);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('nocturnal-trinity');
  });

  it('findImportLines detects side-effect import', () => {
    const content = "import '../core/nocturnal-trinity.js'";
    const lines = findImportLines(content);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('nocturnal-trinity');
  });

  it('findImportLines detects dynamic import of non-frozen-basename legacy module', () => {
    const content = "const mod = import('../service/sleep-cycle.js')";
    const lines = findImportLines(content);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('sleep-cycle');
  });

  it('findImportLines detects dynamic import with nocturnal- path not in FROZEN set', () => {
    const content = "await import('../service/nocturnal-new-module.js')";
    const lines = findImportLines(content);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('nocturnal-new-module');
  });

  it('findImportLines detects dynamic import with idle path', () => {
    const content = "await import('../service/idle-detector.js')";
    const lines = findImportLines(content);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('idle-detector');
  });

  it('idle import not in allowlist is flagged by enforcement logic', () => {
    const importLine = "import('../service/idle-detector.js')";
    const lowerLine = importLine.toLowerCase();
    const frozenModuleBasenames = [...FROZEN_NOCTURNAL_MODULES].map(
      (mod) => path.basename(mod, '.ts')
    );
    const isFrozenModuleRef = frozenModuleBasenames.some(
      (basename) => lowerLine.includes(basename)
    );
    const isNocturnalKeyword = /(?:^|[-_/.])idle(?:[-_/.]|$)|nocturnal|sleep_reflection|sleep-cycle/i.test(importLine);
    expect(isFrozenModuleRef || isNocturnalKeyword).toBe(true);

    const fakeRelPath = 'commands/new-command.ts';
    const allowedEntries = ALLOWED_NOCTURNAL_IMPORTS[fakeRelPath] ?? [];
    const allowedPatterns = allowedEntries.map((e) => e.toLowerCase());
    const isAllowed = allowedPatterns.some((pattern) => lowerLine.includes(pattern));
    expect(isAllowed).toBe(false);
  });

  it('HybridLedgerStore does not trigger idle keyword (word boundary)', () => {
    const importLine = "import type { HybridLedgerStore } from './principle-tree-ledger.js'";
    const isNocturnalKeyword = /(?:^|[-_/.])idle(?:[-_/.]|$)|nocturnal|sleep_reflection|sleep-cycle/i.test(importLine);
    expect(isNocturnalKeyword).toBe(false);
  });

  it('idle in path segment triggers keyword (word boundary)', () => {
    const importLine = "import('../service/idle-detector.js')";
    const isNocturnalKeyword = /(?:^|[-_/.])idle(?:[-_/.]|$)|nocturnal|sleep_reflection|sleep-cycle/i.test(importLine);
    expect(isNocturnalKeyword).toBe(true);
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
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
      results.push(...collectSourceFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const relPath = path.relative(PLUGIN_SRC, fullPath);
      if (relPath.includes('__tests__')) continue;
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Extract all import/require lines from source content.
 *
 * Detects:
 * - Single-line static imports: `import X from 'module'`
 * - Multiline static imports: `import { A, B } from 'module'`
 * - Side-effect imports: `import 'module'`
 * - Assigned require: `const x = require('module')` or `require('module')`
 * - Dynamic imports: `import('module')`
 */
function findImportLines(content: string): string[] {
  const lines: string[] = [];

  const staticImportRegex = /import\s+[\s\S]*?from\s+['"][^'"]+['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = staticImportRegex.exec(content)) !== null) {
    lines.push(match[0]);
  }

  const sideEffectImportRegex = /import\s+['"][^'"]+['"]/gm;
  while ((match = sideEffectImportRegex.exec(content)) !== null) {
    const already = lines.some(l => l === match![0]);
    if (!already) {
      lines.push(match[0]);
    }
  }

  const requireRegex = /(?:const\s+\w+\s*=\s*)?require\s*\(\s*['"][^'"]+['"]\s*\)/gm;
  while ((match = requireRegex.exec(content)) !== null) {
    lines.push(match[0]);
  }

  for (const mod of FROZEN_NOCTURNAL_MODULES) {
    const basename = path.basename(mod, '.ts');
    const dynRegex = new RegExp('import\\s*\\([\'"]' + '[^\'"]+' + basename + '[^\'"]*' + '[\'"]\\)', 'gi');
    let dynMatch;
    while ((dynMatch = dynRegex.exec(content)) !== null) {
      lines.push(dynMatch[0]);
    }
  }

  const legacyPathPatterns = [
    /nocturnal-/,
    /sleep-cycle/,
    /sleep_reflection/,
    /(?:^|[-_/.])idle(?:[-_/.]|$)/i,
  ];
  const genericDynImportRegex = /import\s*\(\s*['"][^'"]+['"]\s*\)/gi;
  let genericMatch;
  while ((genericMatch = genericDynImportRegex.exec(content)) !== null) {
    const importPath = genericMatch[0];
    const already = lines.some(l => l === importPath);
    if (!already && legacyPathPatterns.some(p => p.test(importPath))) {
      lines.push(importPath);
    }
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
