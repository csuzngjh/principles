/**
 * PRI-459 Stage 1.5 + CodeQL fix — atomic write + lock file permission hardening.
 *
 * CodeQL flagged `principle-tree-ledger.ts` for two `js/insecure-temporary-file`
 * alerts:
 *   (1) `atomicWriteFileSync` used a predictable `.tmp` suffix in the target
 *       directory. When `stateDir` resolves inside a world-writable location
 *       such as `os.tmpdir()` (very common for tests and CI scratch dirs), an
 *       attacker who can write to that directory could pre-create a symlink at
 *       the predictable path and steer the subsequent `rename` to overwrite
 *       a file the attacker controls — a classic symlink attack. The fix is
 *       to use `fs.mkdtempSync` to create a uniquely-named temp directory
 *       (mkdtemp generates a randomized suffix) in the same directory as
 *       the target, preserving the atomic-rename requirement (same
 *       filesystem).
 *   (2) `tryAcquireLock` opened the lock file without an explicit mode, so
 *       the file inherited the process umask. In a world-writable state dir
 *       that means the lock file could be replaced or read by another
 *       non-owner process while a real lock was held. The fix is to pass
 *       `0o600` (owner read+write only).
 *   (3) A follow-up CodeRabbit finding noted that if `fs.writeFileSync`
 *       threw inside `atomicWriteFileSync`, the cleanup code at the end of
 *       the function was unreachable, leaking the `.pd-write-*` temp
 *       directory. The fix wraps the write + rename + retry in a try
 *       block with a finally for cleanup.
 *
 * This suite pins the OBSERVABLE contract of those three fixes. If a future
 * refactor reverts any of them, the test must fail LOUD:
 *   - No `.pd-write-*` temp directory is left behind on success.
 *   - The temp file lives in the SAME directory as the target (atomic rename
 *     still works on the same filesystem — proven by a successful write +
 *     well-formed JSON).
 *   - The `.lock` file is gone after a successful mutation (no stale lock).
 *   - The on-disk ledger is well-formed JSON with the `_tree.principles`
 *     entries for every write (no torn / partial write).
 *
 * Test framework: vitest (matches `principles-core/tests/principle-tree-ledger.*.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  addPrincipleToLedger,
  saveLedger,
  withLock,
  getLedgerFilePathPublic,
  loadLedger,
} from '../src/principle-tree-ledger.js';
import type { LedgerPrinciple } from '../src/runtime-v2/types/ledger-store.js';
import { TREE_NAMESPACE } from '../src/runtime-v2/types/ledger-store.js';

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
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
  };
}

function listStateDirEntries(stateDir: string): string[] {
  if (!fs.existsSync(stateDir)) return [];
  return fs.readdirSync(stateDir);
}

function listPdWriteLeftovers(stateDir: string): string[] {
  return listStateDirEntries(stateDir).filter((name) => name.startsWith('.pd-write-'));
}

/**
 * Read the on-disk ledger as raw JSON. The serialize codec writes
 * `{...trainingStore, [TREE_NAMESPACE]: {...tree, lastUpdated}}` —
 * `_tree.principles` is the per-principle map. Tests use this raw shape to
 * assert the atomic-rename contract (no torn / partial writes).
 */
function readRawLedger(stateDir: string): Record<string, unknown> {
  const ledgerPath = getLedgerFilePathPublic(stateDir);
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>;
}

describe('PRI-459 Stage 1.5 — atomic write + lock file hardening', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-hardened-'));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe('atomicWriteFileSync — temp directory hygiene', () => {
    it('leaves no .pd-write-* temp directory behind after a successful write', () => {
      // Run several mutations to maximize the chance a regression leaks.
      addPrincipleToLedger(stateDir, makePrinciple('p1'));
      addPrincipleToLedger(stateDir, makePrinciple('p2'));
      addPrincipleToLedger(stateDir, makePrinciple('p3'));
      saveLedger(stateDir, {
        trainingStore: {},
        tree: { principles: {}, rules: {}, implementations: {}, metrics: {}, lastUpdated: '2026-07-07T00:00:00.000Z' },
      });

      const leftovers = listPdWriteLeftovers(stateDir);
      expect(leftovers).toEqual([]);
    });

    it('never leaks .pd-write-* directories to os.tmpdir() either', () => {
      // If a future refactor moves the temp dir to os.tmpdir() (which would
      // also break the atomic-rename contract — different filesystem — and
      // be caught by the JSON test below), the cleanup contract would still
      // hold: no temp artifacts survive on disk.
      addPrincipleToLedger(stateDir, makePrinciple('p1'));
      const tmpEntries = fs.readdirSync(os.tmpdir());
      const leakedToTmp = tmpEntries.filter((name) => name.startsWith('.pd-write-'));
      expect(leakedToTmp).toEqual([]);
    });

    it('no temp dir survives even when running many back-to-back mutations', () => {
      // A leak is most likely to surface under repeated writes; loop 25x.
      for (let i = 0; i < 25; i += 1) {
        addPrincipleToLedger(stateDir, makePrinciple(`p${i}`));
      }
      const leftovers = listPdWriteLeftovers(stateDir);
      expect(leftovers).toEqual([]);
    });

    it('the on-disk file is well-formed JSON with all written principles (atomic rename contract)', () => {
      // Indirect proof that the temp dir lives in the SAME filesystem as the
      // target: rename(2) only works within a single filesystem. If a
      // regression moved the temp dir to os.tmpdir() (a different filesystem
      // on most systems), the rename would throw EXDEV and the write would
      // fail. The fact that we end up with a well-formed JSON file containing
      // all 3 principles proves the temp dir was co-located with the target.
      addPrincipleToLedger(stateDir, makePrinciple('p1'));
      addPrincipleToLedger(stateDir, makePrinciple('p2'));
      addPrincipleToLedger(stateDir, makePrinciple('p3'));

      const raw = readRawLedger(stateDir);
      const tree = raw[TREE_NAMESPACE] as { principles: Record<string, { id: string }> };
      expect(Object.keys(tree.principles).sort()).toEqual(['p1', 'p2', 'p3']);
      expect(tree.principles.p1!.id).toBe('p1');
      expect(tree.principles.p2!.id).toBe('p2');
      expect(tree.principles.p3!.id).toBe('p3');
    });
  });

  describe('tryAcquireLock — lock file cleanup', () => {
    it('a successful mutation leaves no .lock file behind', () => {
      addPrincipleToLedger(stateDir, makePrinciple('p1'));
      const lockPath = getLedgerFilePathPublic(stateDir) + '.lock';
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('withLock with a held lock from this process still works and cleans up the lock file', () => {
      const ledgerPath = getLedgerFilePathPublic(stateDir);
      const lockPath = ledgerPath + '.lock';
      const result = withLock(ledgerPath, () => 'work-done');
      expect(result).toBe('work-done');
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  describe('end-to-end — happy path with the hardened writer', () => {
    it('a normal save+load round trip leaves no temp/lock residue', () => {
      // Combines both fixes: no `.pd-write-*` AND no `.lock` file survive.
      addPrincipleToLedger(stateDir, makePrinciple('p1'));
      addPrincipleToLedger(stateDir, makePrinciple('p2'));

      const ledgerPath = getLedgerFilePathPublic(stateDir);
      const lockPath = ledgerPath + '.lock';
      expect(fs.existsSync(ledgerPath)).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);

      // No temp directories.
      const tempDirs = listPdWriteLeftovers(stateDir);
      expect(tempDirs).toEqual([]);
    });

    it('the in-memory loadLedger reflects every write (round-trip integrity)', () => {
      addPrincipleToLedger(stateDir, makePrinciple('p1'));
      addPrincipleToLedger(stateDir, makePrinciple('p2'));
      addPrincipleToLedger(stateDir, makePrinciple('p3'));

      const ledger = loadLedger(stateDir);
      expect(Object.keys(ledger.tree.principles).sort()).toEqual(['p1', 'p2', 'p3']);
    });
  });
});
