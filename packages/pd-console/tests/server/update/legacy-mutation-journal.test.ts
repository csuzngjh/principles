/**
 * PRI-709 P0-3 — journal coverage for the legacy console updater (ADR-0024 D-2).
 *
 * PRI-698 Phase 0 Audit finding F-3: the console updater mutated the runtime
 * with zero journal writes. D-2 says an unjournaled runtime mutation must not
 * happen, so before the legacy path can be retired it has to write the SAME
 * journal as the installer and the ReleaseManager.
 *
 * Contracts under test:
 * 1. planned → confirmed / failed, one transaction per mutation.
 * 2. Digest provenance is `fallback` — the legacy updater verifies no signed
 *    metadata and must never claim a digest it cannot back.
 * 3. Degradation is explicit and never blocks the mutation (missing journal
 *    module, failing append).
 * 4. Identity is the PRODUCT version, not the independently versioned pd-cli.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openLegacyMutationJournal,
  runLegacyJournaledMutation,
  type LegacyJournalPort,
} from '../../../src/server/update/legacy-mutation-journal.js';

// The delivery-surface gap under test: in a real installation the console may
// run where the create-principles-disciple dist is absent, so the dynamic
// import in the journal loader rejects. Every other test injects its own port,
// so this mock only affects the degradation path.
vi.mock('create-principles-disciple/dist/update/transaction-journal.js', () => {
  throw new Error('Cannot find module create-principles-disciple/dist/update/transaction-journal.js');
});

interface RecordedTransition {
  readonly journalPath: string;
  readonly to: string;
  readonly from: string | null;
  readonly detail?: string;
  readonly releaseMetadataDigestSource?: string;
  readonly productVersion?: string;
  readonly releaseId?: string;
  readonly transactionId?: string;
}

function makePort(): { port: LegacyJournalPort; calls: RecordedTransition[] } {
  const calls: RecordedTransition[] = [];
  const port: LegacyJournalPort = {
    appendJournalTransition: (journalPath, transition) => {
      calls.push({ journalPath, ...transition } as RecordedTransition);
    },
  };
  return { port, calls };
}

describe('legacy mutation journal (PRI-709 P0-3)', () => {
  let tmpRoot: string;
  let pdHome: string;
  let pluginDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-legacy-journal-'));
    pdHome = path.join(tmpRoot, '.pd');
    pluginDir = path.join(tmpRoot, 'plugin');
    fs.mkdirSync(path.join(pluginDir, 'pd-cli'), { recursive: true });
    // Product version vs the independently versioned pd-cli (P0-2 rule).
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'principles-disciple', version: '1.230.2' }));
    fs.writeFileSync(path.join(pluginDir, 'pd-cli', 'package.json'), JSON.stringify({ name: '@principles/pd-cli', version: '1.147.5' }));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('journals planned → confirmed around a successful mutation', async () => {
    const { port, calls } = makePort();
    const outcome = await runLegacyJournaledMutation(
      { kind: 'apply', pdHome, pluginDir, journal: port },
      async () => 'ok',
    );

    expect(outcome.result).toBe('ok');
    expect(outcome.journal.journaled).toBe(true);
    expect(calls.map((c) => c.to)).toEqual(['planned', 'confirmed']);
    expect(calls[0]?.from).toBeNull();
    expect(calls[1]?.from).toBe('planned');
  });

  it('journals planned → failed when the updater REPORTS failure instead of throwing', async () => {
    // The legacy updater reports failure as a value: doApplyUpdate /
    // doRollbackUpdate / doInlineFullUpdate return { success: false } for ~30
    // distinct failure modes and only throw for infrastructure errors.
    const { port, calls } = makePort();
    const outcome = await runLegacyJournaledMutation(
      { kind: 'apply', pdHome, pluginDir, journal: port },
      async () => ({ success: false, message: 'Backup not found' }),
    );

    expect(outcome.result).toEqual({ success: false, message: 'Backup not found' });
    expect(calls.map((c) => c.to)).toEqual(['planned', 'failed']);
    expect(calls[1]?.detail).toContain('Backup not found');
  });

  it('journals planned → confirmed for a success-shaped result carrying a message', async () => {
    const { port, calls } = makePort();
    await runLegacyJournaledMutation(
      { kind: 'apply-full', pdHome, pluginDir, journal: port },
      async () => ({ success: true, message: 'Updated to 1.231.0', newVersion: '1.231.0' }),
    );
    expect(calls.map((c) => c.to)).toEqual(['planned', 'confirmed']);
    expect(calls[1]?.detail).toContain('Updated to 1.231.0');
  });

  it('journals planned → failed and rethrows when the mutation throws', async () => {
    const { port, calls } = makePort();
    await expect(
      runLegacyJournaledMutation(
        { kind: 'apply-full', pdHome, pluginDir, journal: port },
        async () => { throw new Error('npm install exploded'); },
      ),
    ).rejects.toThrow('npm install exploded');

    expect(calls.map((c) => c.to)).toEqual(['planned', 'failed']);
    expect(calls[1]?.detail).toContain('npm install exploded');
  });

  it('never fabricates a digest: provenance is fallback for every transition', async () => {
    const { port, calls } = makePort();
    await runLegacyJournaledMutation(
      { kind: 'rollback', pdHome, pluginDir, journal: port },
      async () => 'ok',
    );

    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.releaseMetadataDigestSource).toBe('fallback');
    }
    // 64-hex satisfies the strict reader's format requirement, but it is a
    // marker hash — nothing claims it identifies a release.
    expect(calls[0]?.detail).toContain('actor=console-updater');
    expect(calls[0]?.detail).toContain('kind=rollback');
  });

  it('records the PRODUCT version, not the independently versioned pd-cli', async () => {
    const { port, calls } = makePort();
    await runLegacyJournaledMutation(
      { kind: 'apply', pdHome, pluginDir, journal: port },
      async () => 'ok',
    );
    expect(calls[0]?.productVersion).toBe('1.230.2');
    expect(calls[0]?.releaseId).toContain('1.230.2');
  });

  it('writes to the shared ~/.pd/transactions ledger, never a console-private one', async () => {
    const { port, calls } = makePort();
    const opened = await openLegacyMutationJournal({ kind: 'apply', pdHome, pluginDir, journal: port });
    if (!opened.journaled) throw new Error('expected journaled');
    expect(calls[0]?.journalPath).toBe(path.join(pdHome, 'transactions', `${opened.journal.transactionId}.jsonl`));
    expect(opened.journal.transactionId).toMatch(/^console-apply-\d+-[0-9a-f]{8}$/);
  });

  it('degrades explicitly when the journal module is unavailable and still runs the mutation', async () => {
    // No `journal` port supplied: the real loader resolves the dynamic import,
    // which is absent in this test environment — exactly the delivery-surface
    // gap the console must survive.
    const outcome = await runLegacyJournaledMutation(
      { kind: 'apply', pdHome, pluginDir },
      async () => 'mutated',
    );
    expect(outcome.result).toBe('mutated');
    expect(outcome.journal.journaled).toBe(false);
    expect(outcome.journal).toMatchObject({ reason: expect.any(String) });
  });

  it('reports a failing append without changing the mutation outcome', async () => {
    const broken: LegacyJournalPort = {
      appendJournalTransition: () => { throw new Error('EACCES: read-only fs'); },
    };
    const outcome = await runLegacyJournaledMutation(
      { kind: 'apply', pdHome, pluginDir, journal: broken },
      async () => 'mutated',
    );
    expect(outcome.result).toBe('mutated');
    expect(outcome.journal.journaled).toBe(false);
    expect(outcome.journal).toMatchObject({ reason: expect.stringContaining('EACCES') });
  });

  it('falls back to pd-cli when the product manifest is absent (backward compatible)', async () => {
    fs.rmSync(path.join(pluginDir, 'package.json'));
    const { port, calls } = makePort();
    await runLegacyJournaledMutation(
      { kind: 'apply', pdHome, pluginDir, journal: port },
      async () => 'ok',
    );
    expect(calls[0]?.productVersion).toBe('1.147.5');
  });
});
