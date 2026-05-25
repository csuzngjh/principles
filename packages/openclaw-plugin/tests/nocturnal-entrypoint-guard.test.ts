import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const PLUGIN_SRC = path.join(PLUGIN_ROOT, 'src');
const PLUGIN_TESTS = path.join(PLUGIN_ROOT, 'tests');

const DELETED_NOCTURNAL_MODULES = new Set([
  'commands/nocturnal-review.ts',
  'commands/nocturnal-train.ts',
  'commands/nocturnal-rollout.ts',
  'commands/pd-reflect.ts',
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
  'core/nocturnal-compliance.ts',
  'core/adaptive-thresholds.ts',
  'service/nocturnal-service.ts',
  'service/nocturnal-runtime.ts',
  'service/nocturnal-target-selector.ts',
  'service/nocturnal-config.ts',
  'service/sleep-cycle.ts',
  'service/subagent-workflow/nocturnal-workflow-manager.ts',
  'service/evolution-pain-context.ts',
  'service/startup-reconciler.ts',
  'service/cooldown-strategy.ts',
]);

const DELETED_NOCTURNAL_TESTS = new Set([
  'commands/nocturnal-review.test.ts',
  'commands/nocturnal-train.test.ts',
  'core/nocturnal-arbiter.test.ts',
  'core/nocturnal-artifact-lineage.test.ts',
  'core/nocturnal-artificer.test.ts',
  'core/nocturnal-candidate-scoring.test.ts',
  'core/nocturnal-compliance-p-principles.test.ts',
  'core/nocturnal-compliance.test.ts',
  'core/nocturnal-dataset.test.ts',
  'core/nocturnal-e2e.test.ts',
  'core/nocturnal-executability.test.ts',
  'core/nocturnal-export.test.ts',
  'core/nocturnal-reasoning-deriver.test.ts',
  'core/nocturnal-reviewed-subset-comparison.test.ts',
  'core/nocturnal-rule-implementation-validator.test.ts',
  'core/nocturnal-snapshot-contract.test.ts',
  'core/nocturnal-trinity.test.ts',
  'core/nocturnal-trajectory-extractor.test.ts',
  'service/nocturnal-runtime-hardening.test.ts',
  'service/nocturnal-runtime.test.ts',
  'service/nocturnal-service-code-candidate.test.ts',
  'service/nocturnal-target-selector.test.ts',
  'service/nocturnal-workflow-manager.test.ts',
  'service/evolution-worker.nocturnal.test.ts',
  'service/evolution-worker.nocturnal-cutover.test.ts',
  'service/cooldown-strategy.test.ts',
  'service/startup-reconciler.test.ts',
  'core/m10-artificer-core.test.ts',
  'core/m10-artificer-pipeline.test.ts',
]);

const DELETED_NOCTURNAL_BASENAMES = [...DELETED_NOCTURNAL_MODULES].map(
  (mod) => path.basename(mod, '.ts')
);

const NOCTURNAL_IMPORT_PATTERN = /(?:^|[-_/.])idle(?:[-_/.]|$)|nocturnal|sleep_reflection|sleep-cycle/i;

describe('Nocturnal deletion regression guard (PRI-230)', () => {
  it('deleted nocturnal production modules must not exist on disk', () => {
    const violations: string[] = [];
    for (const relPath of DELETED_NOCTURNAL_MODULES) {
      const fullPath = path.join(PLUGIN_SRC, relPath);
      if (fs.existsSync(fullPath)) {
        violations.push(relPath);
      }
    }
    expect(violations, `These deleted modules still exist: ${violations.join(', ')}`).toEqual([]);
  });

  it('deleted nocturnal test modules must not exist on disk', () => {
    const violations: string[] = [];
    for (const relPath of DELETED_NOCTURNAL_TESTS) {
      const fullPath = path.join(PLUGIN_TESTS, relPath);
      if (fs.existsSync(fullPath)) {
        violations.push(relPath);
      }
    }
    expect(violations, `These deleted test files still exist: ${violations.join(', ')}`).toEqual([]);
  });

  it('no production source file imports from deleted nocturnal modules', () => {
    const sourceFiles = collectSourceFiles(PLUGIN_SRC);
    const violations: string[] = [];

    for (const fullPath of sourceFiles) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const importLines = findImportLines(content);

      for (const importLine of importLines) {
        const lowerLine = importLine.toLowerCase();
        for (const basename of DELETED_NOCTURNAL_BASENAMES) {
          if (lowerLine.includes(basename)) {
            const relPath = path.relative(PLUGIN_SRC, fullPath).replace(/\\/g, '/');
            violations.push(`${relPath}: ${importLine.trim()}`);
            break;
          }
        }
        if (NOCTURNAL_IMPORT_PATTERN.test(importLine) && !isRuntimeV2NocturnalImport(importLine)) {
          const relPath = path.relative(PLUGIN_SRC, fullPath).replace(/\\/g, '/');
          const already = violations.some(v => v.startsWith(relPath));
          if (!already) {
            violations.push(`${relPath}: ${importLine.trim()}`);
          }
        }
      }
    }

    expect(violations, `Found imports from deleted nocturnal modules:\n${violations.join('\n')}`).toEqual([]);
  });

  it('index.ts must not register retired nocturnal commands', () => {
    const indexPath = path.join(PLUGIN_SRC, 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');

    expect(content).not.toContain('pd-nocturnal-review');
    expect(content).not.toContain('nocturnal-train');
    expect(content).not.toContain('nocturnal-rollout');
    expect(content).not.toContain('RETIRED_NOCTURNAL_MSG');
    expect(content).not.toContain('pd-reflect');
    expect(content).not.toContain('handleNocturnalReviewCommand');
    expect(content).not.toContain('handleNocturnalTrainCommand');
    expect(content).not.toContain('handleNocturnalRolloutCommand');
    expect(content).not.toContain('handlePdReflect');
  });

  it('evolution-worker.ts must not reference deleted nocturnal modules', () => {
    const ewPath = path.join(PLUGIN_SRC, 'service', 'evolution-worker.ts');
    const content = fs.readFileSync(ewPath, 'utf-8');

    expect(content).not.toContain('OpenClawTrinityRuntimeAdapter');
    expect(content).not.toContain('enqueueSleepReflectionTask');
    expect(content).not.toContain('enqueueKeywordOptimizationTask');
    expect(content).not.toContain('NocturnalWorkflowManager');
    expect(content).not.toContain('sleep_reflection');
    expect(content).not.toContain('keyword_optimization');
    expect(content).not.toContain('checkWorkspaceIdle');
    expect(content).not.toContain('checkCooldown');
    expect(content).not.toContain('recordCooldown');
    expect(content).not.toContain('NocturnalConfig');
    expect(content).not.toContain('loadCooldownEscalationConfig');
  });

  it('dynamic import of deleted nocturnal module must be flagged', () => {
    const content = "const mod = await import('../core/nocturnal-trinity.js')";
    const importLines = findImportLines(content);
    expect(importLines.length).toBeGreaterThan(0);
    const lowerLine = importLines[0].toLowerCase();
    expect(lowerLine).toContain('nocturnal-trinity');
  });

  it('dynamic import with idle path must be flagged', () => {
    const content = "await import('../service/idle-detector.js')";
    const importLines = findImportLines(content);
    expect(importLines.length).toBeGreaterThan(0);
    expect(importLines[0]).toContain('idle-detector');
  });

  it('Runtime V2 nocturnal module import is not flagged', () => {
    const importLine = "import { NocturnalCompliance } from '@principles/core/runtime-v2/nocturnal/nocturnal-compliance.js'";
    expect(isRuntimeV2NocturnalImport(importLine)).toBe(true);
  });

  it('non-Runtime-V2 nocturnal import is flagged', () => {
    const importLine = "import { NocturnalTrinity } from '../core/nocturnal-trinity.js'";
    expect(isRuntimeV2NocturnalImport(importLine)).toBe(false);
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

  it('findImportLines detects side-effect import', () => {
    const content = "import '../core/nocturnal-trinity.js'";
    const lines = findImportLines(content);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('nocturnal-trinity');
  });

  it('HybridLedgerStore does not trigger idle keyword', () => {
    const importLine = "import type { HybridLedgerStore } from './principle-tree-ledger.js'";
    const isNocturnalKeyword = NOCTURNAL_IMPORT_PATTERN.test(importLine);
    expect(isNocturnalKeyword).toBe(false);
  });

  it('idle in path segment triggers keyword', () => {
    const importLine = "import('../service/idle-detector.js')";
    const isNocturnalKeyword = NOCTURNAL_IMPORT_PATTERN.test(importLine);
    expect(isNocturnalKeyword).toBe(true);
  });

  it('deleted nocturnal fixture must not exist', () => {
    const fixturePath = path.join(PLUGIN_TESTS, 'fixtures', 'nocturnal-reviewed-subset.json');
    expect(fs.existsSync(fixturePath)).toBe(false);
  });
});

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

  const genericDynImportRegex = /import\s*\(\s*['"][^'"]+['"]\s*\)/gi;
  let genericMatch;
  while ((genericMatch = genericDynImportRegex.exec(content)) !== null) {
    const importPath = genericMatch[0];
    const already = lines.some(l => l === importPath);
    if (!already) {
      lines.push(importPath);
    }
  }

  return lines;
}

function isRuntimeV2NocturnalImport(importLine: string): boolean {
  return /@principles\/core\/runtime-v2\/nocturnal/.test(importLine) ||
    /principles-core\/.*runtime-v2\/nocturnal/.test(importLine);
}
