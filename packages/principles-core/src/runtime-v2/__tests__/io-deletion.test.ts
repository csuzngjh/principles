/**
 * PRI-443 Phase 4: io.ts deletion guard
 *
 * Verifies that:
 * 1. `src/io.ts` no longer exists in principles-core
 * 2. `atomicWriteFileSync` is NOT re-exported from the top-level barrel
 * 3. `principle-tree-ledger.ts` still performs atomic write+read roundtrips
 *    (the inlined private atomicWriteFileSync preserves crash-safe semantics)
 * 4. `package.json` no longer exposes `"./io"` subpath
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolve } from 'path';

const CORE_SRC = resolve(__dirname, '..', '..');

describe('PRI-443 Phase 4: io.ts deletion', () => {
  it('src/io.ts does NOT exist in principles-core', () => {
    const ioPath = join(CORE_SRC, 'io.ts');
    expect(existsSync(ioPath)).toBe(false);
  });

  it('index.ts barrel does NOT re-export atomicWriteFileSync', () => {
    const barrelPath = join(CORE_SRC, 'index.ts');
    const content = readFileSync(barrelPath, 'utf-8');
    expect(content).not.toMatch(/export\s*\{[^}]*\batomicWriteFileSync\b[^}]*\}/);
    expect(content).not.toMatch(/from\s+['"]\.\/io\.js['"]/);
  });

  it('package.json does NOT expose "./io" subpath', () => {
    const pkgPath = resolve(CORE_SRC, '..', 'package.json');
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'exports')) {
      throw new Error('package.json 缺少 exports 字段');
    }
    const pkgExports = (parsed as { exports: unknown }).exports;
    if (!pkgExports || typeof pkgExports !== 'object') {
      throw new Error('package.json exports 字段格式非法');
    }
    expect(Object.hasOwn(pkgExports, './io')).toBe(false);
  });

  it('principle-tree-ledger.ts inlines atomicWriteFileSync as a private (non-exported) helper', () => {
    const ledgerPath = join(CORE_SRC, 'principle-tree-ledger.ts');
    const content = readFileSync(ledgerPath, 'utf-8');
    // The function must be defined locally (not imported)
    expect(content).not.toMatch(/from\s+['"]\.\/io\.js['"]/);
    // The function must NOT be re-exported (private to the module)
    expect(content).not.toMatch(/export\s*\{[^}]*\batomicWriteFileSync\b[^}]*\}/);
    expect(content).not.toMatch(/export\s+function\s+atomicWriteFileSync/);
    // The function body must be present locally
    expect(content).toMatch(/function\s+atomicWriteFileSync/);
    expect(content).toMatch(/fs\.renameSync/);
  });
});

describe('PRI-443 Phase 4: principle-tree-ledger atomic roundtrip', () => {
  it('saveLedger → loadLedger roundtrip preserves data atomically', async () => {
    // Dynamic import to avoid importing io.ts (which should not exist)
    const { loadLedger, addPrincipleToLedger } = await import('../../principle-tree-ledger.js');

    const tmpDir = mkdtempSync(join(tmpdir(), 'pri443-phase4-'));
    try {
      const principle = {
        id: 'pri-test-001',
        version: 1,
        text: 'Always validate user input before processing',
        triggerPattern: 'user_input_received',
        action: 'validate_input',
        status: 'active' as const,
        priority: 'P1' as const,
        scope: 'domain' as const,
        evaluability: 'deterministic' as const,
        valueScore: 0.8,
        adherenceRate: 0.95,
        painPreventedCount: 3,
        derivedFromPainIds: ['pain-1'],
        ruleIds: ['rule-1'],
        conflictsWithPrincipleIds: [],
        createdAt: '2026-06-22T00:00:00.000Z',
        updatedAt: '2026-06-22T00:00:00.000Z',
      };

      addPrincipleToLedger(tmpDir, principle);
      const loaded = loadLedger(tmpDir);

      expect(loaded.tree.principles['pri-test-001']).toBeDefined();
      expect(loaded.tree.principles['pri-test-001']?.text).toBe('Always validate user input before processing');
      expect(loaded.tree.principles['pri-test-001']?.status).toBe('active');

      // Verify the .tmp file was cleaned up (atomic write completed)
      const tmpFile = join(tmpDir, 'principle_training_state.json.tmp');
      expect(existsSync(tmpFile)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
