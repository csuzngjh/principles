/**
 * PRI-664 — installer journal helpers: transition sequence semantics against
 * the REAL transaction-journal reader (no fs mocks — HOME is pinned to a temp
 * dir so `~/.pd/transactions/` stays hermetic).
 *
 * Covers what flow tests cannot: the full planned→…→confirmed chain validity
 * under the strict journal reader, and the Tier-2 degradation contract
 * (mid-flight append failure → degrade + skip, journal stays parseable).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  beginInstallerJournal,
  journalInstallerTransition,
  journalInstallerTransitionDegrading,
} from '../src/installer.js';
import { readTransactionJournal } from '../src/update/transaction-journal.js';

// Partial mock: real implementation by default, per-test failures injectable.
vi.mock('../src/update/transaction-journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/update/transaction-journal.js')>();
  return {
    ...actual,
    appendJournalTransition: vi.fn(actual.appendJournalTransition),
  };
});

// Payload fixture: pd-cli/package.json provides productVersion + digest source.
function makeFixtureBundle(root: string): string {
  const pluginDir = path.join(root, 'bundle');
  const pdCliDir = path.join(pluginDir, 'pd-cli');
  fs.mkdirSync(pdCliDir, { recursive: true });
  fs.writeFileSync(path.join(pdCliDir, 'package.json'), JSON.stringify({ name: '@principles/pd-cli', version: '9.9.9' }));
  return pluginDir;
}

describe('installer journal sequence (real journal reader)', () => {
  let tmpHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-installer-journal-'));
    savedHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes a valid planned→staged→probed→activated→confirmed chain with payload identity fields', () => {
    const pluginDir = makeFixtureBundle(tmpHome);
    const journal = beginInstallerJournal(pluginDir);

    journalInstallerTransition(journal, null, 'planned', 'begin');
    journalInstallerTransitionDegrading(journal, 'planned', 'staged', 'content laid down');
    journalInstallerTransitionDegrading(journal, 'staged', 'probed', 'console verified');
    journalInstallerTransitionDegrading(journal, 'probed', 'activated', 'host installers done');
    journalInstallerTransitionDegrading(journal, 'activated', 'confirmed', 'complete');

    expect(journal.degraded).toBe(false);
    expect(journal.journalPath).toBe(path.join(tmpHome, '.pd', 'transactions', `${journal.transactionId}.jsonl`));

    const transitions = readTransactionJournal(journal.journalPath);
    expect(transitions.map((t) => t.to)).toEqual(['planned', 'staged', 'probed', 'activated', 'confirmed']);
    expect(transitions[0]?.from).toBeNull();
    for (let i = 1; i < transitions.length; i += 1) {
      expect(transitions[i]?.from).toBe(transitions[i - 1]?.to);
    }
    for (const t of transitions) {
      expect(t.transactionId).toBe(journal.transactionId);
      expect(t.releaseId).toBe(journal.releaseId);
      expect(t.productVersion).toBe('9.9.9');
      expect(t.releaseMetadataDigest).toBe(journal.releaseMetadataDigest);
      expect(t.releaseMetadataDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(t.generation).toBe(1);
    }
    expect(journal.releaseId).toBe(`bundled-9.9.9-${journal.releaseMetadataDigest.slice(0, 12)}`);
  });

  it('Tier-2 degradation: a mid-flight append failure marks degraded and skips later appends, keeping the journal parseable', async () => {
    const { appendJournalTransition } = await import('../src/update/transaction-journal.js');
    const actualModule = await vi.importActual<typeof import('../src/update/transaction-journal.js')>('../src/update/transaction-journal.js');
    vi.mocked(appendJournalTransition).mockImplementation((journalPath, transition) => {
      if (transition.to === 'staged') {
        throw new Error('EIO: simulated disk failure');
      }
      return actualModule.appendJournalTransition(journalPath, transition);
    });

    const pluginDir = makeFixtureBundle(tmpHome);
    const journal = beginInstallerJournal(pluginDir);
    journalInstallerTransition(journal, null, 'planned', 'begin');
    journalInstallerTransitionDegrading(journal, 'planned', 'staged', 'content laid down');
    // Degraded: further degrading appends are skipped entirely.
    journalInstallerTransitionDegrading(journal, 'staged', 'probed', 'console verified');
    journalInstallerTransitionDegrading(journal, 'probed', 'confirmed', 'complete');
    expect(journal.degraded).toBe(true);
    expect(vi.mocked(appendJournalTransition).mock.calls.length).toBe(2); // planned + failed 'staged' attempt

    // The journal on disk stays a strictly valid (unfinished) transaction.
    const transitions = readTransactionJournal(journal.journalPath);
    expect(transitions.map((t) => t.to)).toEqual(['planned']);
  });

  it('strict append still throws on failure (Tier-1 contract for the caller)', async () => {
    const { appendJournalTransition } = await import('../src/update/transaction-journal.js');
    vi.mocked(appendJournalTransition).mockImplementation(() => {
      throw new Error('EACCES: transactions dir not writable');
    });

    const pluginDir = makeFixtureBundle(tmpHome);
    const journal = beginInstallerJournal(pluginDir);
    expect(() => journalInstallerTransition(journal, null, 'planned', 'begin')).toThrow(/EACCES/);
  });
});
