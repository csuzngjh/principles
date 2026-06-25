/**
 * PRI-459: Principle Ledger single-implementation guard.
 *
 * HISTORY (PRI-413): This test originally asserted FIELD PARITY between the
 * core ledger types and the openclaw-plugin ledger copy — both were expected
 * to define identical interfaces, because the plugin maintained a full
 * duplicate implementation.
 *
 * CURRENT (PRI-459): The plugin ledger was reduced to a thin re-export
 * adapter over @principles/core/principle-tree-ledger. The plugin file must
 * NOT re-define any ledger type, codec function, or mutator — it must only
 * re-export from core. This test enforces that convergence so the dual-
 * implementation drift (and the lost-update / silent-field-loss classes it
 * caused) cannot silently return.
 *
 * Related: docs/ERROR_PATTERN_INDEX.md EP-10 (do not re-open merged
 * convergence — PRI-413/PRI-443/PRI-459).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Load source files
// ---------------------------------------------------------------------------

const CORE_LEDGER_TYPES_PATH = resolve(__dirname, '..', 'src', 'runtime-v2', 'types', 'ledger-store.ts');
const CORE_LEDGER_CODEC_PATH = resolve(__dirname, '..', 'src', 'runtime-v2', 'principle-tree', 'ledger-codec.ts');
const CORE_LEDGER_IO_PATH = resolve(__dirname, '..', 'src', 'principle-tree-ledger.ts');
const PLUGIN_LEDGER_PATH = resolve(
  __dirname,
  '..',
  '..',
  'openclaw-plugin',
  'src',
  'core',
  'principle-tree-ledger.ts',
);

const coreTypesSource = readFileSync(CORE_LEDGER_TYPES_PATH, 'utf-8');
const coreCodecSource = readFileSync(CORE_LEDGER_CODEC_PATH, 'utf-8');
const coreIoSource = readFileSync(CORE_LEDGER_IO_PATH, 'utf-8');
const pluginSource = readFileSync(PLUGIN_LEDGER_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PRI-459: plugin ledger is a re-export adapter (no duplicate impl)', () => {
  describe('plugin must NOT define ledger types or codec functions', () => {
    // These definitions lived in the plugin before PRI-459. Re-introducing
    // any of them re-opens the dual-implementation drift.
    const FORBIDDEN_PLUGIN_DEFINITIONS = [
      'interface LegacyPrincipleTrainingState',
      'interface HybridLedgerStore',
      'interface LedgerPrinciple',
      'interface LedgerRule',
      'interface LedgerTreeStore',
      'interface PrincipleSubtree',
      'function parseHybridLedger',
      'function serializeLedger',
      'function parseLegacyTrainingStore',
      'function parsePrinciples',
      'function parseRules',
      'function mutateLedger',
      'const VALID_EVALUABILITIES',
      'const VALID_INTERNALIZATION_STATUSES',
    ];

    for (const token of FORBIDDEN_PLUGIN_DEFINITIONS) {
      it(`plugin principle-tree-ledger.ts does not define "${token}"`, () => {
        expect(pluginSource).not.toContain(token);
      });
    }
  });

  describe('plugin must re-export from core', () => {
    it('plugin principle-tree-ledger.ts re-exports from @principles/core/principle-tree-ledger', () => {
      expect(pluginSource).toContain('@principles/core/principle-tree-ledger');
    });

    it('plugin re-exports the core loadLedger / saveLedger mutators', () => {
      // Spot-check a representative value + type export rather than the full
      // list (the build itself is the exhaustive export-coverage test).
      expect(pluginSource).toMatch(/\bloadLedger\b/);
      expect(pluginSource).toMatch(/\bsaveLedger\b/);
      expect(pluginSource).toMatch(/LedgerPrinciple/);
    });
  });
});

describe('PRI-459: core remains the single SSOT for ledger types + codec', () => {
  describe('SSOT: ledger types defined exactly once in core src/', () => {
    it('HybridLedgerStore is defined only in runtime-v2/types/ledger-store.ts', async () => {
      const { readdirSync, statSync } = await import('node:fs');
      const { join } = await import('node:path');

      const coreSrcDir = resolve(__dirname, '..', 'src');
      const hits: string[] = [];

      function scanDir(dir: string): void {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            if (entry === 'node_modules' || entry === '__tests__') continue;
            scanDir(full);
          } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
            const content = readFileSync(full, 'utf-8');
            if (/export\s+interface\s+HybridLedgerStore\s*\{/.test(content)) {
              hits.push(full.replace(coreSrcDir + '\\', '').replace(coreSrcDir + '/', ''));
            }
          }
        }
      }

      scanDir(coreSrcDir);

      const normalizedHits = hits.map((f: string) => f.replace(/\\/g, '/'));
      expect(normalizedHits).toContain('runtime-v2/types/ledger-store.ts');
      expect(normalizedHits).toEqual(['runtime-v2/types/ledger-store.ts']);
    });

    it('LegacyPrincipleTrainingState is defined in core runtime-v2/types/ledger-store.ts', () => {
      // core types module is the sole definition site for the legacy training
      // state interface. (ledger-codec and principle-tree-ledger consume it.)
      expect(coreTypesSource).toContain('interface LegacyPrincipleTrainingState');
    });
  });

  describe('SSOT: codec functions defined exactly once in core', () => {
    it('parseHybridLedger lives only in runtime-v2/principle-tree/ledger-codec.ts', async () => {
      const { readdirSync, statSync } = await import('node:fs');
      const { join } = await import('node:path');

      const coreSrcDir = resolve(__dirname, '..', 'src');
      const codecHits: string[] = [];

      function scanDir(dir: string): void {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            if (entry === 'node_modules' || entry === '__tests__') continue;
            scanDir(full);
          } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
            const content = readFileSync(full, 'utf-8');
            if (/export\s+function\s+parseHybridLedger\b/.test(content)) {
              codecHits.push(full.replace(coreSrcDir + '\\', '').replace(coreSrcDir + '/', ''));
            }
          }
        }
      }

      scanDir(coreSrcDir);

      const normalized = codecHits.map((f: string) => f.replace(/\\/g, '/'));
      expect(normalized).toEqual(['runtime-v2/principle-tree/ledger-codec.ts']);
    });

    it('ledger-codec.ts exports parseHybridLedger and serializeLedger', () => {
      expect(coreCodecSource).toMatch(/export\s+function\s+parseHybridLedger/);
      expect(coreCodecSource).toMatch(/export\s+function\s+serializeLedger/);
    });
  });

  describe('serialization format invariants (preserved from PRI-413)', () => {
    it('core defines TREE_NAMESPACE constant with value _tree', () => {
      expect(coreTypesSource).toMatch(/export\s+const\s+TREE_NAMESPACE\s*=\s*'_tree'/);
    });

    it('core defines PRINCIPLE_TRAINING_FILE with the canonical filename', () => {
      expect(coreIoSource).toMatch(/const\s+PRINCIPLE_TRAINING_FILE\s*=\s*'principle_training_state.json'/);
    });
  });
});
