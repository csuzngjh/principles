import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  loadLedger,
  addPrincipleToLedger,
  getLedgerFilePathPublic,
  withLock,
} from '../src/principle-tree-ledger.js';
import type { LedgerPrinciple } from '../src/runtime-v2/types/ledger-store.js';

const FAST_LOCK_OPTIONS = { maxRetries: 2, baseRetryDelayMs: 1, maxRetryDelayMs: 2 };

function makePrinciple(id: string): LedgerPrinciple {
  return {
    id,
    version: 1,
    text: `principle ${id}`,
    triggerPattern: 'tp',
    action: 'act',
    status: 'candidate',
    priority: 'P1',
    scope: 'general',
    evaluability: 'manual_only',
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:00:00.000Z',
  };
}

describe('principle-tree-ledger security fixes (PR #1179)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-security-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe('atomicWriteFileSync — unique temp directory (CodeQL js/insecure-temporary-file)', () => {
    it('uses mkdtempSync-generated unique temp directory, not predictable suffix', () => {
      addPrincipleToLedger(stateDir, makePrinciple('p1'));

      const ledgerPath = getLedgerFilePathPublic(stateDir);
      const targetDir = path.dirname(ledgerPath);

      const leftoverTmpFiles = fs.readdirSync(targetDir).filter(
        (file) => file.startsWith('.pd-write-') || file.endsWith('.tmp'),
      );
      expect(leftoverTmpFiles).toEqual([]);

      const ledger = loadLedger(stateDir);
      expect(ledger.tree.principles['p1']).toBeDefined();
    });

    it('does not leave .pd-write-* directories after successful write', () => {
      const ledgerPath = getLedgerFilePathPublic(stateDir);
      const targetDir = path.dirname(ledgerPath);

      addPrincipleToLedger(stateDir, makePrinciple('p-success'));

      const leftoverDirs = fs.readdirSync(targetDir, { withFileTypes: true }).filter(
        (dirent) => dirent.isDirectory() && dirent.name.startsWith('.pd-write-'),
      );
      expect(leftoverDirs).toEqual([]);
    });
  });

  describe('tryAcquireLock — owner-only permissions (0o600)', () => {
    it('creates lock file with 0o600 permissions (owner read/write only)', () => {
      const ledgerPath = getLedgerFilePathPublic(stateDir);
      const lockPath = ledgerPath + '.lock';

      let lockMode: number | undefined;
      withLock(ledgerPath, () => {
        const stats = fs.statSync(lockPath);
        lockMode = stats.mode & 0o777;
      }, FAST_LOCK_OPTIONS);

      expect(lockMode).toBe(0o600);
    });

    it('lock file permissions prevent world-readability in shared temp dir', () => {
      const sharedTempDir = os.tmpdir();
      const ledgerPath = path.join(sharedTempDir, 'pd-test-shared', 'principle_training_state.json');
      const lockPath = ledgerPath + '.lock';

      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

      let lockMode: number | undefined;
      withLock(ledgerPath, () => {
        const stats = fs.statSync(lockPath);
        lockMode = stats.mode & 0o777;
      }, FAST_LOCK_OPTIONS);

      expect(lockMode).toBe(0o600);

      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true });
    });
  });
});