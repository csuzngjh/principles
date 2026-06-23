/**
 * PRI-443 Phase 5: runtime-v2 barrel I/O cleanup
 *
 * Verifies that:
 * 1. runtime-v2/index.ts does NOT re-export I/O functions (loadLedger, saveLedger,
 *    getLedgerFilePathPublic, updatePrinciple) — these belong in the I/O module
 * 2. runtime-v2/index.ts does NOT re-export LedgerTreeStore from
 *    '../principle-tree-ledger.js' — types come from pure modules
 * 3. package.json exposes "./principle-tree-ledger" subpath for direct I/O access
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const CORE_SRC = resolve(__dirname, '..', '..');

describe('PRI-443 Phase 5: runtime-v2 barrel I/O cleanup', () => {
  it('runtime-v2/index.ts does NOT re-export I/O functions from principle-tree-ledger', () => {
    const barrelPath = resolve(CORE_SRC, 'runtime-v2', 'index.ts');
    const content = readFileSync(barrelPath, 'utf-8');

    // The I/O functions loadLedger, saveLedger, getLedgerFilePathPublic,
    // updatePrinciple must NOT be re-exported from the runtime-v2 barrel.
    // Consumers should import from @principles/core/principle-tree-ledger instead.
    expect(content).not.toMatch(/export\s*\{[^}]*\bloadLedger\b[^}]*\}\s*from\s*['"]\.\.\/principle-tree-ledger\.js['"]/);
    expect(content).not.toMatch(/export\s*\{[^}]*\bsaveLedger\b[^}]*\}\s*from\s*['"]\.\.\/principle-tree-ledger\.js['"]/);
    expect(content).not.toMatch(/export\s*\{[^}]*\bgetLedgerFilePathPublic\b[^}]*\}\s*from\s*['"]\.\.\/principle-tree-ledger\.js['"]/);
    expect(content).not.toMatch(/export\s*\{[^}]*\bupdatePrinciple\b[^}]*\}\s*from\s*['"]\.\.\/principle-tree-ledger\.js['"]/);
  });

  it('runtime-v2/index.ts does NOT re-export LedgerTreeStore from principle-tree-ledger', () => {
    const barrelPath = resolve(CORE_SRC, 'runtime-v2', 'index.ts');
    const content = readFileSync(barrelPath, 'utf-8');

    // LedgerTreeStore type must come from the pure types module, not the I/O module
    expect(content).not.toMatch(/export\s+type\s*\{[^}]*\bLedgerTreeStore\b[^}]*\}\s*from\s*['"]\.\.\/principle-tree-ledger\.js['"]/);
  });

  it('package.json exposes "./principle-tree-ledger" subpath', () => {
    const pkgPath = resolve(CORE_SRC, '..', 'package.json');
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'exports')) {
      throw new Error('package.json 缺少 exports 字段');
    }
    const pkgExports = (parsed as { exports: unknown }).exports;
    if (!pkgExports || typeof pkgExports !== 'object') {
      throw new Error('package.json exports 字段格式非法');
    }
    expect(Object.hasOwn(pkgExports, './principle-tree-ledger')).toBe(true);
  });
});
