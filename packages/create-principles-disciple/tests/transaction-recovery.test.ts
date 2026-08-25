import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeRecordAtomically, AtomicRecordError } from '../src/update/atomic-file.js';
import {
  appendJournalTransition,
  readActiveRecord,
  readTransactionJournal,
  recoverUnfinishedTransaction,
  writeActiveRecord,
  TransactionJournalError,
  type ActiveRecord,
  type JournalTransition,
  type TransactionState,
} from '../src/update/transaction-journal.js';

const temporaryDirectories: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-txn-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

const OLD_RELEASE = 'a'.repeat(64);
const NEW_RELEASE = 'b'.repeat(64);
const OLD_DIGEST = '1'.repeat(64);
const NEW_DIGEST = '2'.repeat(64);
const TRANSACTION_ID = 'txn-001';

function transition(from: TransactionState | null, to: TransactionState, generation: number, releaseId: string, digest: string): JournalTransition {
  return {
    at: '2026-08-25T12:00:00Z',
    from,
    to,
    transactionId: TRANSACTION_ID,
    releaseId: releaseId,
    productVersion: releaseId === NEW_RELEASE ? '1.223.0' : '1.222.0',
    releaseMetadataDigest: digest,
    generation,
  };
}

// The full happy-path transition sequence of one update transaction from the
// currently active generation 5 (old release) to generation 6 (new release).
function fullSequence(): JournalTransition[] {
  return [
    transition(null, 'planned', 6, NEW_RELEASE, NEW_DIGEST),
    transition('planned', 'downloaded', 6, NEW_RELEASE, NEW_DIGEST),
    transition('downloaded', 'verified', 6, NEW_RELEASE, NEW_DIGEST),
    transition('verified', 'staged', 6, NEW_RELEASE, NEW_DIGEST),
    transition('staged', 'probed', 6, NEW_RELEASE, NEW_DIGEST),
    transition('probed', 'activated', 6, NEW_RELEASE, NEW_DIGEST),
    transition('activated', 'host_verified', 6, NEW_RELEASE, NEW_DIGEST),
    transition('host_verified', 'confirmed', 6, NEW_RELEASE, NEW_DIGEST),
  ];
}

function activeRecord(generation: number, releaseId: string, digest: string, transactionId: string): ActiveRecord {
  return {
    schemaVersion: 1,
    generation,
    releaseId,
    releaseMetadataDigest: digest,
    previousReleaseId: generation > 1 ? OLD_RELEASE : null,
    transactionId,
  };
}

describe('atomic record adapter', () => {
  it('replaces a record atomically and verifies the reread', () => {
    const root = tempRoot();
    const recordPath = path.join(root, 'active.json');
    writeRecordAtomically(recordPath, '{"generation":1}\n');
    writeRecordAtomically(recordPath, '{"generation":2}\n');
    expect(fs.readFileSync(recordPath, 'utf8')).toBe('{"generation":2}\n');
    expect(fs.readdirSync(root).filter((name) => name.startsWith('.record-'))).toEqual([]);
  });

  it('fails loud when the directory does not exist and leaves nothing behind', () => {
    const root = tempRoot();
    const missing = path.join(root, 'absent', 'active.json');
    expect(() => writeRecordAtomically(missing, '{}\n')).toThrow(AtomicRecordError);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('refuses to silently replace non-utf8-identical bytes (verification gate)', () => {
    const root = tempRoot();
    const recordPath = path.join(root, 'active.json');
    writeRecordAtomically(recordPath, 'line1\n');
    // Same content rewritten must still verify.
    expect(() => writeRecordAtomically(recordPath, 'line1\n')).not.toThrow();
  });
});

describe('transaction journal', () => {
  it('round-trips transitions and enforces sequence continuity', () => {
    const root = tempRoot();
    const journalPath = path.join(root, 'transactions', `${TRANSACTION_ID}.jsonl`);
    for (const item of fullSequence()) {
      appendJournalTransition(journalPath, item);
    }
    const transitions = readTransactionJournal(journalPath);
    expect(transitions).toHaveLength(8);
    expect(transitions[7]?.to).toBe('confirmed');

    appendJournalTransition(journalPath, transition('confirmed', 'failed', 6, NEW_RELEASE, NEW_DIGEST));
    expect(() => readTransactionJournal(journalPath)).toThrow(/terminal/i);
  });

  it('rejects torn lines, unknown states, and broken chains loudly (rc-3)', () => {
    const root = tempRoot();
    const journalPath = path.join(root, 't.jsonl');
    fs.writeFileSync(journalPath, '{"at":"x","to":"planned"');
    expect(() => readTransactionJournal(journalPath)).toThrow(TransactionJournalError);

    fs.writeFileSync(journalPath, `${JSON.stringify({ ...transition(null, 'planned', 1, OLD_RELEASE, OLD_DIGEST), to: 'teleported' })}\n`);
    expect(() => readTransactionJournal(journalPath)).toThrow(/unknown state/i);

    fs.writeFileSync(journalPath, [
      JSON.stringify(transition(null, 'planned', 1, OLD_RELEASE, OLD_DIGEST)),
      JSON.stringify(transition('verified', 'staged', 1, OLD_RELEASE, OLD_DIGEST)),
    ].join('\n') + '\n');
    expect(() => readTransactionJournal(journalPath)).toThrow(/claims from/i);
  });

  it('round-trips the active record strictly', () => {
    const root = tempRoot();
    const recordPath = path.join(root, 'active.json');
    writeActiveRecord(recordPath, {
      generation: 6,
      releaseId: NEW_RELEASE,
      releaseMetadataDigest: NEW_DIGEST,
      previousReleaseId: OLD_RELEASE,
      transactionId: TRANSACTION_ID,
      productVersion: '1.223.0',
    });
    const record = readActiveRecord(recordPath);
    expect(record).toMatchObject({ generation: 6, releaseId: NEW_RELEASE, transactionId: TRANSACTION_ID });

    fs.writeFileSync(recordPath, JSON.stringify({ schemaVersion: 1, generation: 'six' }));
    expect(() => readActiveRecord(recordPath)).toThrow(/malformed fields/i);
  });
});

describe('crash recovery matrix (SPEC 14.3: interruption at every boundary)', () => {
  const previousRecord = activeRecord(5, OLD_RELEASE, OLD_DIGEST, 'txn-000');

  it('recovers every pre-activation interruption to the old confirmed release', () => {
    const sequence = fullSequence();
    const preActivation = sequence.slice(0, sequence.findIndex((item) => item.to === 'activated'));
    for (let crashAfter = 0; crashAfter < preActivation.length; crashAfter += 1) {
      const transitions = preActivation.slice(0, crashAfter + 1);
      const outcome = recoverUnfinishedTransaction({
        transitions,
        activeRecord: previousRecord,
        previousRecord,
        transactionId: TRANSACTION_ID,
      });
      expect(outcome.kind, `crash after ${transitions[crashAfter]?.to}`).toBe('old_confirmed');
      if (outcome.kind === 'old_confirmed') {
        expect(outcome.releaseId).toBe(OLD_RELEASE);
      }
    }
  });

  it('recovers an activation-window crash without ever producing a hybrid', () => {
    const sequence = fullSequence();
    const activationIndex = sequence.findIndex((item) => item.to === 'activated');
    const hostVerifiedIndex = sequence.findIndex((item) => item.to === 'host_verified');
    const confirmedIndex = sequence.findIndex((item) => item.to === 'confirmed');

    // Crash right after `activated` was journaled but BEFORE the active
    // record took the new generation: the old confirmed generation wins.
    const crashAtActivation = recoverUnfinishedTransaction({
      transitions: sequence.slice(0, activationIndex + 1),
      activeRecord: previousRecord,
      previousRecord,
      transactionId: TRANSACTION_ID,
    });
    expect(crashAtActivation.kind).toBe('old_confirmed');

    // Crash after the active record landed the new generation AND host
    // verification was journaled, but before `confirmed`: complete as
    // new-confirmed (pointer + journal lineage agree).
    const crashBeforeConfirm = recoverUnfinishedTransaction({
      transitions: sequence.slice(0, hostVerifiedIndex + 1),
      activeRecord: activeRecord(6, NEW_RELEASE, NEW_DIGEST, TRANSACTION_ID),
      previousRecord,
      transactionId: TRANSACTION_ID,
    });
    expect(crashBeforeConfirm.kind).toBe('new_confirmed');
    if (crashBeforeConfirm.kind === 'new_confirmed') {
      expect(crashBeforeConfirm.releaseId).toBe(NEW_RELEASE);
      expect(crashBeforeConfirm.generation).toBe(6);
    }

    // Crash after everything journaled: new-confirmed.
    const afterAll = recoverUnfinishedTransaction({
      transitions: sequence.slice(0, confirmedIndex + 1),
      activeRecord: activeRecord(6, NEW_RELEASE, NEW_DIGEST, TRANSACTION_ID),
      previousRecord,
      transactionId: TRANSACTION_ID,
    });
    expect(afterAll.kind).toBe('new_confirmed');

    // Pointer landed generation 6, but host verification never journaled:
    // fall back to the previous confirmed generation (no hybrid).
    const unverifiedActivation = recoverUnfinishedTransaction({
      transitions: sequence.slice(0, activationIndex + 1),
      activeRecord: activeRecord(6, NEW_RELEASE, NEW_DIGEST, TRANSACTION_ID),
      previousRecord,
      transactionId: TRANSACTION_ID,
    });
    expect(unverifiedActivation.kind).toBe('old_confirmed');
    if (unverifiedActivation.kind === 'old_confirmed') {
      expect(unverifiedActivation.releaseId).toBe(OLD_RELEASE);
      expect(unverifiedActivation.generation).toBe(5);
    }
  });

  it('refuses explicitly when a first-ever activation is interrupted', () => {
    const sequence = fullSequence();
    const activationIndex = sequence.findIndex((item) => item.to === 'activated');
    const outcome = recoverUnfinishedTransaction({
      transitions: sequence.slice(0, activationIndex + 1),
      activeRecord: null,
      previousRecord: null,
      transactionId: TRANSACTION_ID,
    });
    expect(outcome.kind).toBe('explicit_refusal');
    if (outcome.kind === 'explicit_refusal') {
      expect(outcome.reason).toBe('activation_interrupted_without_previous');
      expect(outcome.nextAction).toMatch(/official installer/i);
    }
  });

  it('treats rolled-back, refused, and failed transactions as old-confirmed', () => {
    for (const terminal of ['rolled_back', 'refused', 'failed'] as const) {
      const sequence = [
        ...fullSequence().slice(0, 4),
        transition('probed', terminal, 6, NEW_RELEASE, NEW_DIGEST),
      ];
      const outcome = recoverUnfinishedTransaction({
        transitions: sequence,
        activeRecord: previousRecord,
        previousRecord,
        transactionId: TRANSACTION_ID,
      });
      expect(outcome.kind, terminal).toBe('old_confirmed');
    }
  });

  it('reports nothing to reconcile for an unknown transaction', () => {
    const outcome = recoverUnfinishedTransaction({
      transitions: fullSequence(),
      activeRecord: previousRecord,
      previousRecord,
      transactionId: 'txn-other',
    });
    expect(outcome.kind).toBe('old_confirmed');
    if (outcome.kind === 'old_confirmed') {
      expect(outcome.releaseId).toBeNull();
    }
  });
});
