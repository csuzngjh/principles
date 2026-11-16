/**
 * Phase 7.2 B1 — deterministic exact-duplicate guard for principle writes.
 *
 * Pins the contract from LEDGER_WRITE_SAFETY_SPEC §3.2 (7.1 revision):
 *   - normalizePrincipleText: NFKC equivalence folding ONLY — punctuation
 *     preserved, whitespace collapsed, NO case folding (N1-N8);
 *   - addPrincipleToLedger: in-lock pre-write check against eligible statuses
 *     (candidate/probation/active); a hit registers NOTHING and returns the
 *     surviving principle; near-miss texts stay separate entries;
 *   - the guard composes with appendReuseEvidence SEQUENTIALLY (audit runs
 *     outside the write lock — no nested-lock self-deadlock);
 *   - cross-process concurrency: N writers adding the same normalized text
 *     register exactly one entry;
 *   - PrincipleTreeLedgerAdapter.writeProbationEntry surfaces the dedup as a
 *     surviving-entry view (different id) for the intake service.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  addPrincipleToLedger,
  appendReuseEvidence,
  loadLedger,
} from '../src/principle-tree-ledger.js';
import { normalizePrincipleText } from '../src/principle-text-normalization.js';
import type { LedgerPrinciple } from '../src/runtime/types/ledger-store.js';
import { PrincipleTreeLedgerAdapter } from '../src/runtime/adapter/principle-tree-ledger-adapter.js';

function makePrinciple(id: string, overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id,
    version: 1,
    text: `principle text for ${id}`,
    triggerPattern: 'tp',
    action: 'act',
    status: 'candidate',
    priority: 'P1',
    scope: 'general',
    evaluability: 'weak_heuristic',
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: [`candidate-${id}`],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('Phase 7.2 B1 — normalizePrincipleText (NFKC-only folding)', () => {
  it('N7: fullwidth and halfwidth equivalents normalize to one form', () => {
    expect(normalizePrincipleText('ＡＢＣ　１２３')).toBe(normalizePrincipleText('ABC 123'));
    expect(normalizePrincipleText('ＡＢＣ　１２３')).toBe('ABC 123');
  });

  it('N8: whitespace-only differences collapse (whitespace-level duplicates are duplicates)', () => {
    expect(normalizePrincipleText('  verify   ledger\twrites\nbefore  commit ')).toBe(
      normalizePrincipleText('verify ledger writes before commit'),
    );
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizePrincipleText('  same  ')).toBe('same');
  });

  it('N4: distinct punctuation stays distinct (no punctuation-to-whitespace folding)', () => {
    expect(normalizePrincipleText('先备份，再删除')).not.toBe(normalizePrincipleText('先备份。再删除'));
    expect(normalizePrincipleText('a, b')).not.toBe(normalizePrincipleText('a. b'));
    expect(normalizePrincipleText('a, b')).toBe(normalizePrincipleText('a, b'));
  });

  it('N5: logical operators && and || never fold together', () => {
    expect(normalizePrincipleText('commit && push')).not.toBe(normalizePrincipleText('commit || push'));
  });

  it('N6: latin case is NOT folded (code identifiers stay distinct)', () => {
    expect(normalizePrincipleText('useMockHandler')).not.toBe(normalizePrincipleText('usemockhandler'));
  });

  it('N1: negation is not confused (禁止/必须 keep different normalized forms)', () => {
    expect(normalizePrincipleText('必须先验证备份再删除')).not.toBe(normalizePrincipleText('禁止先验证备份再删除'));
    expect(normalizePrincipleText('always verify')).not.toBe(normalizePrincipleText('never verify'));
  });

  it('N2: conditional polarity differences are preserved', () => {
    expect(normalizePrincipleText('如果测试失败，则阻止合并')).not.toBe(
      normalizePrincipleText('如果测试通过，则阻止合并'),
    );
    expect(normalizePrincipleText('block only when tests fail')).not.toBe(
      normalizePrincipleText('block only when tests pass'),
    );
  });

  it('N3: word-order differences are preserved', () => {
    expect(normalizePrincipleText('verify the backup before deleting files')).not.toBe(
      normalizePrincipleText('before deleting files verify the backup'),
    );
  });

  it('fullwidth punctuation folds to its ASCII equivalent (NFKC class), still distinct from other punctuation', () => {
    // U+FF0C FULLWIDTH COMMA folds onto ',' under NFKC — the intended class.
    expect(normalizePrincipleText('a，b')).toBe(normalizePrincipleText('a,b'));
    // ...but it must never fold onto a DIFFERENT punctuation mark.
    expect(normalizePrincipleText('a，b')).not.toBe(normalizePrincipleText('a;b'));
  });
});

describe('Phase 7.2 B1 — addPrincipleToLedger exact-duplicate guard', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-exact-dedup-'));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function principleCount(): number {
    return Object.keys(loadLedger(stateDir).tree.principles).length;
  }

  it('an exact duplicate registers nothing and returns the surviving principle', () => {
    const first = makePrinciple('p1', { text: 'Always verify the backup before deleting files.' });
    const added = addPrincipleToLedger(stateDir, first);
    expect(added.id).toBe('p1');

    const duplicate = makePrinciple('p2', { text: 'Always verify the backup before deleting files.' });
    const survivor = addPrincipleToLedger(stateDir, duplicate);

    expect(survivor.id).toBe('p1');
    expect(principleCount()).toBe(1);
    expect(loadLedger(stateDir).tree.principles['p2']).toBeUndefined();
  });

  it('whitespace-level differences are deduplicated (N8 through the write path)', () => {
    addPrincipleToLedger(stateDir, makePrinciple('p1', { text: 'Verify  the\nbackup\tfirst.' }));
    const survivor = addPrincipleToLedger(stateDir, makePrinciple('p2', { text: ' Verify the backup first. ' }));
    expect(survivor.id).toBe('p1');
    expect(principleCount()).toBe(1);
  });

  it('fullwidth/halfwidth equivalents are deduplicated (N7 through the write path)', () => {
    addPrincipleToLedger(stateDir, makePrinciple('p1', { text: 'Ｄｅｌｅｔｅ only after Ｂａｃｋｕｐ.' }));
    const survivor = addPrincipleToLedger(stateDir, makePrinciple('p2', { text: 'Delete only after Backup.' }));
    expect(survivor.id).toBe('p1');
    expect(principleCount()).toBe(1);
  });

  it('archived and deprecated principles are excluded from comparison', () => {
    addPrincipleToLedger(stateDir, makePrinciple('archived-1', { text: 'Same statement.', status: 'archived' }));
    addPrincipleToLedger(stateDir, makePrinciple('deprecated-1', { text: 'Same statement.', status: 'deprecated' }));
    const survivor = addPrincipleToLedger(stateDir, makePrinciple('fresh-1', { text: 'Same statement.' }));
    expect(survivor.id).toBe('fresh-1');
    expect(principleCount()).toBe(3);
  });

  it('candidate, probation and active principles all participate in comparison', () => {
    for (const status of ['candidate', 'probation', 'active'] as const) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-exact-dedup-status-'));
      try {
        addPrincipleToLedger(dir, makePrinciple(`p-${status}`, { text: 'Eligible statement.', status }));
        const survivor = addPrincipleToLedger(dir, makePrinciple('p-new', { text: 'Eligible statement.' }));
        expect(survivor.id).toBe(`p-${status}`);
        expect(Object.keys(loadLedger(dir).tree.principles)).toHaveLength(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // Negative controls — every meaning-bearing difference stays a separate entry.
  it.each([
    ['negation', '必须先验证备份再删除。', '禁止先验证备份再删除。'],
    ['conditional polarity', '如果测试失败，则阻止合并。', '如果测试通过，则阻止合并。'],
    ['word order', 'verify the backup before deleting files', 'before deleting files verify the backup'],
    ['punctuation', '先备份，再删除。', '先备份。再删除。'],
    ['logical operators', 'run lint && tests', 'run lint || tests'],
    ['case (code identifiers)', 'useMockHandler in tests', 'usemockhandler in tests'],
  ])('negative control — %s stays a separate entry', (_label, first, second) => {
    addPrincipleToLedger(stateDir, makePrinciple('p1', { text: first }));
    const survivor = addPrincipleToLedger(stateDir, makePrinciple('p2', { text: second }));
    expect(survivor.id).toBe('p2');
    expect(principleCount()).toBe(2);
  });

  it('a dedup no-op refreshes only lastUpdated — the surviving entry is untouched', () => {
    addPrincipleToLedger(stateDir, makePrinciple('p1', { text: 'Stable statement.' }));
    const before = loadLedger(stateDir).tree.principles['p1'];
    addPrincipleToLedger(stateDir, makePrinciple('p2', { text: 'Stable statement.' }));
    const after = loadLedger(stateDir).tree.principles['p1'];
    expect(after).toEqual(before);
  });

  it('composes with appendReuseEvidence sequentially — no nested-lock self-deadlock, idempotent audit', () => {
    addPrincipleToLedger(stateDir, makePrinciple('p1', { text: 'Audited statement.' }));
    // Simulate the adapter/service sequence: dedup write (lock 1 released),
    // then the audit append (lock 2) — same process, same stateDir.
    const duplicate = makePrinciple('p2', { text: 'Audited statement.' });
    const survivor = addPrincipleToLedger(stateDir, duplicate);
    expect(survivor.id).toBe('p1');

    const entry = {
      painId: 'pain-1',
      candidateId: 'candidate-p2',
      decision: 'reuse' as const,
      actor: { kind: 'ai_owner' as const, id: 'exact-dedupe-guard' },
      reason: 'Exact duplicate guard resolved the candidate onto this principle.',
      decidedAt: '2026-11-16T00:00:00.000Z',
    };
    const first = appendReuseEvidence(stateDir, survivor.id, entry);
    expect(first.appended).toBe(true);
    // INV-R07: the retry (same candidate) must not double-audit.
    const retry = appendReuseEvidence(stateDir, survivor.id, { ...entry, decidedAt: '2026-11-16T00:01:00.000Z' });
    expect(retry.appended).toBe(false);
    expect(loadLedger(stateDir).tree.principles['p1']?.reuseEvidence).toHaveLength(1);
  });
});

describe('Phase 7.2 B1 — PrincipleTreeLedgerAdapter.writeProbationEntry dedup view', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-exact-dedup-adapter-'));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function probationEntry(id: string, candidateId: string, text: string) {
    return {
      id,
      title: `title ${id}`,
      text,
      status: 'probation' as const,
      evaluability: 'weak_heuristic' as const,
      sourceRef: `candidate://${candidateId}`,
      artifactRef: `artifact://art-${candidateId}`,
      createdAt: '2026-11-16T00:00:00.000Z',
    };
  }

  it('returns the existing principle view (different id) on an exact-duplicate hit', () => {
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
    const first = adapter.writeProbationEntry(probationEntry('p-one', 'c-one', 'Shared principle text.'));
    expect(first.id).toBe('p-one');

    const second = adapter.writeProbationEntry(probationEntry('p-two', 'c-two', 'Shared principle text.'));
    expect(second.id).toBe('p-one');
    expect(second.text).toBe('Shared principle text.');
    expect(Object.keys(loadLedger(stateDir).tree.principles)).toHaveLength(1);

    // Until the audit lands, the dedup candidate has NO durable ledger
    // relationship: existsForCandidate stays null (so an in-process retry
    // re-runs write → dedup → audit), and the durable short-circuit appears
    // only via findReuseResolutionForCandidate once evidence is appended.
    expect(adapter.existsForCandidate('c-two')).toBeNull();
    expect(adapter.existsForCandidate('c-one')?.id).toBe('p-one');
    expect(adapter.findReuseResolutionForCandidate('c-two')).toBeNull();

    adapter.appendReuseEvidence('p-one', {
      painId: 'pain-c-two',
      candidateId: 'c-two',
      decision: 'reuse',
      actor: { kind: 'ai_owner', id: 'exact-dedupe-guard' },
      reason: 'audit lands after the dedup write',
      decidedAt: '2026-11-16T00:00:00.000Z',
    });
    expect(adapter.findReuseResolutionForCandidate('c-two')?.principleId).toBe('p-one');
  });

  it('distinct texts register distinct entries (passthrough unchanged)', () => {
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
    const a = adapter.writeProbationEntry(probationEntry('p-a', 'c-a', 'First principle.'));
    const b = adapter.writeProbationEntry(probationEntry('p-b', 'c-b', 'Second principle.'));
    expect(a.id).toBe('p-a');
    expect(b.id).toBe('p-b');
    expect(Object.keys(loadLedger(stateDir).tree.principles)).toHaveLength(2);
  });
});

describe('Phase 7.2 B1 — cross-process exact-duplicate registration', () => {
  it('concurrent writers adding the same normalized text register exactly one entry', { timeout: 60_000 }, async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-exact-dedup-conc-'));
    try {
      const testsDir = path.dirname(fileURLToPath(import.meta.url));
      const childScript = path.join(testsDir, 'fixtures', 'exact-dedup-concurrent-child.mjs');
      const distLedger = path.resolve(testsDir, '..', 'dist', 'principle-tree-ledger.js');
      if (!fs.existsSync(distLedger)) {
        throw new Error(`${distLedger} is missing — build packages/principles-core first (npm run build in packages/principles-core).`);
      }
      // Fixed, in-repo script path derived from import.meta.url; guarded by
      // existence + containment checks, and passed after the node option
      // terminator so it can never be read as an option.
      const fixturesRoot = path.resolve(testsDir, 'fixtures');
      if (!childScript.startsWith(fixturesRoot + path.sep) || !fs.existsSync(childScript)) {
        throw new Error(`refusing to spawn unexpected child script path: ${childScript}`);
      }

      // Same normalized text, different raw forms (whitespace + fullwidth).
      const variants = [
        'Always verify  the backup\nbefore deleting any file.',
        '  Always verify the backup before deleting any file. ',
        'Ａｌｗａｙｓ verify the backup before deleting any file.',
        'Always verify the\tbackup before deleting any\tfile.',
      ];
      const barrier = path.join(stateDir, 'start.txt');
      const children = variants.map((text, index) => {
        return new Promise<{ survivorId: string | null; error?: string }>((resolve) => {
          const child = spawn(process.execPath, ['--', childScript], {
            env: {
              ...process.env,
              PD_DEDUP_STATE_DIR: stateDir,
              PD_DEDUP_CHILD_ID: `p-child-${index}`,
              PD_DEDUP_TEXT: text,
              PD_DEDUP_BARRIER: barrier,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
          child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
          child.on('close', (code) => {
            if (code !== 0) {
              resolve({ survivorId: null, error: `child exit ${code}: ${stderr}` });
              return;
            }
            try {
              const parsed = JSON.parse(stdout) as { survivorId: string };
              resolve({ survivorId: parsed.survivorId });
            } catch (err) {
              resolve({ survivorId: null, error: `unparseable child output: ${stdout} (${String(err)})` });
            }
          });
        });
      });

      // Release the barrier once every child is spawned and polling.
      await new Promise((resolve) => setTimeout(resolve, 300));
      fs.writeFileSync(barrier, 'go', 'utf8');

      const results = await Promise.all(children);
      for (const result of results) {
        expect(result.error).toBeUndefined();
        expect(result.survivorId).toBeTruthy();
      }
      const survivorIds = new Set(results.map((r) => r.survivorId));
      expect(survivorIds.size).toBe(1);

      const ledger = loadLedger(stateDir);
      expect(Object.keys(ledger.tree.principles)).toHaveLength(1);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
