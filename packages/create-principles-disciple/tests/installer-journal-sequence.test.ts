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
import {
  readTransactionJournal,
  readTransactionJournalForRecovery,
  recoverUnfinishedTransaction,
} from '../src/update/transaction-journal.js';

// Partial mock: real implementation by default, per-test failures injectable.
vi.mock('../src/update/transaction-journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/update/transaction-journal.js')>();
  return {
    ...actual,
    appendJournalTransition: vi.fn(actual.appendJournalTransition),
  };
});

// Payload fixture: an EMBEDDED identity stamp provides the product version
// (PRI-874 — unstamped payloads are refused); the digest provenance over the
// component manifest (no asset manifest) is a separate, retained semantic.
function makeFixtureBundle(root: string): string {
  const pluginDir = path.join(root, 'bundle');
  const pdCliDir = path.join(pluginDir, 'pd-cli');
  fs.mkdirSync(pdCliDir, { recursive: true });
  fs.writeFileSync(path.join(pdCliDir, 'package.json'), JSON.stringify({ name: '@principles/pd-cli', version: '9.9.9' }));
  const releaseDir = path.join(pluginDir, '_release');
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(releaseDir, 'product-identity.json'),
    JSON.stringify({ schemaVersion: 1, productVersion: '9.9.9', sourceCommit: 'a'.repeat(40) }),
  );
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
      expect(t.sourceCommit).toBe('a'.repeat(40));
      expect(t.releaseMetadataDigest).toBe(journal.releaseMetadataDigest);
      expect(t.releaseMetadataDigest).toMatch(/^[a-f0-9]{64}$/);
      // No asset manifest in the fixture: the digest provenance stays
      // 'package_manifest' (integrity semantics — PRI-874 kept this and
      // only removed the component-version FALLBACK for productVersion).
      expect(t.releaseMetadataDigestSource).toBe('package_manifest');
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

  // PRI-664 review — recovery behavior of an UNFINISHED installer transaction.
  //
  // HONEST SCOPE (do not pretend closure): as of this commit, NOTHING in the
  // codebase reads installer journals for automatic recovery — the journal
  // currently provides OBSERVABILITY ONLY. Recovery ownership (wiring
  // readTransactionJournalForRecovery + recoverUnfinishedTransaction into an
  // actual recovery flow for ~/.pd/transactions/) belongs to PRI-661
  // ReleaseManager adoption. These tests pin the SEMANTIC contract a future
  // consumer will inherit, so the migration cannot silently change it.
  describe('unfinished transaction — recovery contract (not yet wired, PRI-661 owns wiring)', () => {
    // Restore the REAL journal writer: an earlier test in this file replaces
    // the shared mock's implementation with a throwing one (Tier-1 contract).
    let actualAppend: typeof import('../src/update/transaction-journal.js')['appendJournalTransition'];
    beforeEach(async () => {
      const { appendJournalTransition } = await import('../src/update/transaction-journal.js');
      const actualModule = await vi.importActual<typeof import('../src/update/transaction-journal.js')>('../src/update/transaction-journal.js');
      actualAppend = actualModule.appendJournalTransition;
      vi.mocked(appendJournalTransition).mockImplementation(actualAppend);
    });

    it('an interrupted install (activation never journaled) is recoverable as old-confirmed; journal stays parseable', () => {
      const pluginDir = makeFixtureBundle(tmpHome);
      const journal = beginInstallerJournal(pluginDir);
      journalInstallerTransition(journal, null, 'planned', 'begin');
      journalInstallerTransitionDegrading(journal, 'planned', 'staged', 'content laid down');
      // Simulate crash: no activated/confirmed transition ever lands.

      // The journal remains strictly parseable (no torn tail, chain intact).
      const recovery = readTransactionJournalForRecovery(journal.journalPath);
      expect(recovery.transitions.map((t) => t.to)).toEqual(['planned', 'staged']);
      expect(recovery.tornTailDetected).toBe(false);

      // What a future recovery consumer would conclude (and PRI-661 must
      // preserve): the swap lineage never reached activation, and since the
      // installer model has no active.json, the "old" side trivially stands.
      const outcome = recoverUnfinishedTransaction({
        transitions: recovery.transitions,
        activeRecord: null,
        transactionId: journal.transactionId,
      });
      expect(outcome).toMatchObject({ kind: 'old_confirmed', releaseId: null, generation: null });
    });

    it('an interrupted install that already journaled activation is an explicit refusal under the installer model (no active record to reconcile)', () => {
      const pluginDir = makeFixtureBundle(tmpHome);
      const journal = beginInstallerJournal(pluginDir);
      journalInstallerTransition(journal, null, 'planned', 'begin');
      journalInstallerTransitionDegrading(journal, 'planned', 'staged', 'content laid down');
      journalInstallerTransitionDegrading(journal, 'staged', 'probed', 'console verified');
      journalInstallerTransitionDegrading(journal, 'probed', 'activated', 'host installers done');
      // Crash before confirmed.

      const recovery = readTransactionJournalForRecovery(journal.journalPath);
      const outcome = recoverUnfinishedTransaction({
        transitions: recovery.transitions,
        activeRecord: null, // installer never writes active.json (ADR-0023 audit F3)
        transactionId: journal.transactionId,
      });
      // Activation lineage exists but there is no active record to reconcile:
      // the recovery primitive refuses explicitly instead of guessing — the
      // prescribed answer is "re-run the official installer".
      expect(outcome).toMatchObject({ kind: 'explicit_refusal', reason: 'activation_interrupted_without_previous' });
    });
  });
});
