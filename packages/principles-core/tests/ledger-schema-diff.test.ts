/**
 * PRI-413: Ledger Schema SSOT Guard
 *
 * Detects field-set divergence between the two principle-tree-ledger copies:
 *   - packages/principles-core/src/principle-tree-ledger.ts  (CANONICAL — SSOT)
 *   - packages/openclaw-plugin/src/core/principle-tree-ledger.ts (richer impl, must stay aligned)
 *
 * This test reads both source files and extracts interface field names,
 * then asserts the field sets match. If the plugin copy adds or removes a field
 * that core does not have, this test fails — forcing a conscious convergence decision.
 *
 * Related: docs/architecture-audit-2026-06.md §0.3, §4 A0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract field names from a TypeScript interface declaration in source text.
 * Handles multi-line interfaces with `fieldName:` or `fieldName?` patterns.
 *
 * LIMITATION: Does not handle nested braces ({ ... { ... } ... }) or block
 * comments spanning the interface body. If a target interface acquires nested
 * types or block comments containing field-like patterns, this parser will
 * produce incorrect results. Consider using the TypeScript compiler API for
 * robust extraction if this becomes a problem.
 */
function extractInterfaceFields(source: string, interfaceName: string): string[] {
  // Match `export interface InterfaceName { ... }` (handles `extends` clauses)
  const regex = new RegExp(
    `(?:export\\s+)?interface\\s+${interfaceName}\\s*(?:extends\\s+[^{]+)?\\{([^}]+)\\}`,
    's',
  );
  const match = source.match(regex);
  if (!match) return [];

  const body = match[1]!;
  const fields: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    // Skip empty lines, comments, index signatures
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('[')) continue;
    // Match `fieldName:` or `fieldName?:` patterns
    const fieldMatch = trimmed.match(/^(\w+)\??:/);
    if (fieldMatch) {
      fields.push(fieldMatch[1]!);
    }
  }
  return fields.sort();
}

// ---------------------------------------------------------------------------
// Load source files
// ---------------------------------------------------------------------------

const CORE_LEDGER_PATH = resolve(__dirname, '..', 'src', 'principle-tree-ledger.ts');
const PLUGIN_LEDGER_PATH = resolve(
  __dirname,
  '..',
  '..',
  'openclaw-plugin',
  'src',
  'core',
  'principle-tree-ledger.ts',
);

const coreSource = readFileSync(CORE_LEDGER_PATH, 'utf-8');
const pluginSource = readFileSync(PLUGIN_LEDGER_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PRI-413: Ledger schema SSOT guard', () => {
  describe('LegacyPrincipleTrainingState field parity', () => {
    it('core and plugin define identical field sets for LegacyPrincipleTrainingState', () => {
      const coreFields = extractInterfaceFields(coreSource, 'LegacyPrincipleTrainingState');
      const pluginFields = extractInterfaceFields(pluginSource, 'LegacyPrincipleTrainingState');

      expect(coreFields.length).toBeGreaterThan(0);
      expect(pluginFields.length).toBeGreaterThan(0);
      expect(coreFields).toEqual(pluginFields);
    });
  });

  describe('HybridLedgerStore field parity', () => {
    it('core and plugin define identical field sets for HybridLedgerStore', () => {
      const coreFields = extractInterfaceFields(coreSource, 'HybridLedgerStore');
      const pluginFields = extractInterfaceFields(pluginSource, 'HybridLedgerStore');

      expect(coreFields.length).toBeGreaterThan(0);
      expect(pluginFields.length).toBeGreaterThan(0);
      expect(coreFields).toEqual(pluginFields);
    });
  });

  describe('LegacyPrincipleTrainingStore type alias parity', () => {
    it('both define LegacyPrincipleTrainingStore as Record<string, LegacyPrincipleTrainingState>', () => {
      // Both should declare: type LegacyPrincipleTrainingStore = Record<string, LegacyPrincipleTrainingState>
      const coreHasType = /export\s+type\s+LegacyPrincipleTrainingStore\s*=\s*Record<string,\s*LegacyPrincipleTrainingState>/.test(coreSource);
      const pluginHasType = /export\s+type\s+LegacyPrincipleTrainingStore\s*=\s*Record<string,\s*LegacyPrincipleTrainingState>/.test(pluginSource);

      expect(coreHasType).toBe(true);
      expect(pluginHasType).toBe(true);
    });
  });

  describe('SSOT: HybridLedgerStore defined exactly once in core src/', () => {
    it('core principle-tree-ledger.ts is the sole HybridLedgerStore definition in core/src/', () => {
      // Scan all .ts files under core/src/ for `interface HybridLedgerStore` declarations
      // The only hit should be in principle-tree-ledger.ts
      const { readdirSync, statSync } = require('fs') as typeof import('fs');
      const { join } = require('path') as typeof import('path');

      const coreSrcDir = resolve(__dirname, '..', 'src');
      const hits: string[] = [];

      function scanDir(dir: string): void {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            // Skip node_modules and __tests__
            if (entry === 'node_modules' || entry === '__tests__') continue;
            scanDir(full);
          } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
            const content = readFileSync(full, 'utf-8');
            if (/export\s+interface\s+HybridLedgerStore\s*\{/.test(content)) {
              // Record relative path from src/
              hits.push(full.replace(coreSrcDir + '\\', '').replace(coreSrcDir + '/', ''));
            }
          }
        }
      }

      scanDir(coreSrcDir);

      // PRI-415 D6 deleted types.ts — only principle-tree-ledger.ts remains.
      const allowedFiles = [
        'principle-tree-ledger.ts',
      ];
      const unexpected = hits.filter((f: string) => !allowedFiles.includes(f));
      expect(unexpected).toEqual([]);

      // The canonical file must always be present
      expect(hits).toContain('principle-tree-ledger.ts');
    });
  });

  describe('Serialization format parity', () => {
    it('both copies use the same TREE_NAMESPACE constant value', () => {
      const coreNs = coreSource.match(/export\s+const\s+TREE_NAMESPACE\s*=\s*'([^']+)'/);
      const pluginNs = pluginSource.match(/export\s+const\s+TREE_NAMESPACE\s*=\s*'([^']+)'/);

      expect(coreNs).not.toBeNull();
      expect(pluginNs).not.toBeNull();
      expect(coreNs![1]).toBe(pluginNs![1]);
    });

    it('both copies use the same PRINCIPLE_TRAINING_FILE constant value', () => {
      const coreFile = coreSource.match(/const\s+PRINCIPLE_TRAINING_FILE\s*=\s*'([^']+)'/);
      const pluginFile = pluginSource.match(/const\s+PRINCIPLE_TRAINING_FILE\s*=\s*'([^']+)'/);

      expect(coreFile).not.toBeNull();
      expect(pluginFile).not.toBeNull();
      expect(coreFile![1]).toBe(pluginFile![1]);
    });
  });
});
