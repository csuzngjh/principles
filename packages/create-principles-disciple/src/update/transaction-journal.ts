/**
 * Transaction journal and recovery (SPEC §8, §14.3).
 *
 * An update follows a persisted state machine:
 *
 *   planned -> downloaded -> verified -> staged -> probed
 *           -> activated -> host_verified -> confirmed
 *           -> rolled_back | refused | failed
 *
 * EVERY transition is appended (and fsynced) to the transaction journal
 * BEFORE the side effect it describes. On restart, recovery reconciles any
 * unfinished transaction: the outcome is always old-confirmed, new-confirmed,
 * or an explicit safe refusal — never a hybrid.
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeRecordAtomically } from './atomic-file.js';

export const TRANSACTION_STATES = [
  'planned',
  'downloaded',
  'verified',
  'staged',
  'probed',
  'activated',
  'host_verified',
  'confirmed',
  'rolled_back',
  'refused',
  'failed',
] as const;

export type TransactionState = typeof TRANSACTION_STATES[number];

export type TransactionKind = 'update' | 'reinstall' | 'explicit_downgrade' | 'rollback' | 'legacy_migration' | 'recovery';

/**
 * Provenance of a transition's `releaseMetadataDigest` (PRI-664 review):
 * - `manifest`          — sha256 of the self-contained asset manifest (whole-payload identity)
 * - `package_manifest`  — sha256 of the bundled component package manifest
 * - `fallback`          — synthetic digest (identity data unavailable); readable but NOT verifiable
 * - `signed_channel`    — PRI-698 Phase 1: digest bound in the TUF-signed channel document
 *                         (ReleaseManager apply orchestration identity chain)
 */
export const RELEASE_METADATA_DIGEST_SOURCES = ['manifest', 'package_manifest', 'fallback', 'signed_channel'] as const;

export type ReleaseMetadataDigestSource = typeof RELEASE_METADATA_DIGEST_SOURCES[number];

const RELEASE_METADATA_DIGEST_SOURCE_SET = new Set<string>(RELEASE_METADATA_DIGEST_SOURCES);

export interface JournalTransition {
  readonly at: string;
  readonly from: TransactionState | null;
  readonly to: TransactionState;
  readonly transactionId: string;
  readonly releaseId: string;
  readonly productVersion: string;
  readonly releaseMetadataDigest: string;
  /** Optional provenance marker; absent on journals written before PRI-664 review. */
  readonly releaseMetadataDigestSource?: ReleaseMetadataDigestSource;
  readonly generation: number;
  readonly detail?: string;
}

export interface ActiveRecord {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly releaseId: string;
  readonly releaseMetadataDigest: string;
  readonly previousReleaseId: string | null;
  readonly transactionId: string;
  readonly productVersion: string;
}

export class TransactionJournalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TransactionJournalError';
    this.code = code;
  }
}

const VALID_STATES = new Set<string>(TRANSACTION_STATES);
const TERMINAL_STATES = new Set<string>(['confirmed', 'rolled_back', 'refused', 'failed']);
const ACTIVATION_OR_LATER = new Set<TransactionState>(['activated', 'host_verified', 'confirmed']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTransition(line: string, lineNumber: number): JournalTransition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new TransactionJournalError('journal_line_invalid', `Journal line ${lineNumber} is not valid JSON.`);
  }
  if (!isPlainObject(parsed)) {
    throw new TransactionJournalError('journal_line_invalid', `Journal line ${lineNumber} is not an object.`);
  }
  const required: readonly [string, 'string' | 'number' | 'null'][] = [
    ['at', 'string'], ['to', 'string'], ['transactionId', 'string'],
    ['releaseId', 'string'], ['productVersion', 'string'],
    ['releaseMetadataDigest', 'string'], ['generation', 'number'],
  ];
  for (const [field, kind] of required) {
    const value = Object.hasOwn(parsed, field) ? parsed[field] : undefined;
    if (kind === 'string' && (typeof value !== 'string' || value.length === 0)) {
      throw new TransactionJournalError('journal_field_invalid', `Journal line ${lineNumber}: field "${field}" must be a non-empty string.`);
    }
    if (kind === 'number' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)) {
      throw new TransactionJournalError('journal_field_invalid', `Journal line ${lineNumber}: field "${field}" must be a positive integer.`);
    }
  }
  const {to} = parsed;
  if (typeof to !== 'string' || !VALID_STATES.has(to)) {
    throw new TransactionJournalError('journal_state_invalid', `Journal line ${lineNumber}: unknown state ${JSON.stringify(to)}.`);
  }
  const fromValue = parsed.from;
  if (fromValue !== null && (typeof fromValue !== 'string' || !VALID_STATES.has(fromValue))) {
    throw new TransactionJournalError('journal_state_invalid', `Journal line ${lineNumber}: invalid from-state ${JSON.stringify(fromValue)}.`);
  }
  if (typeof parsed.releaseMetadataDigest !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.releaseMetadataDigest)) {
    throw new TransactionJournalError('journal_field_invalid', `Journal line ${lineNumber}: releaseMetadataDigest must be 64-char hex.`);
  }
  const digestSource = parsed.releaseMetadataDigestSource;
  if (digestSource !== undefined && (typeof digestSource !== 'string' || !RELEASE_METADATA_DIGEST_SOURCE_SET.has(digestSource))) {
    throw new TransactionJournalError(
      'journal_field_invalid',
      `Journal line ${lineNumber}: releaseMetadataDigestSource must be one of ${RELEASE_METADATA_DIGEST_SOURCES.join(' | ')}.`,
    );
  }
  return {
    at: parsed.at as string,
    from: fromValue as TransactionState | null,
    to: to as TransactionState,
    transactionId: parsed.transactionId as string,
    releaseId: parsed.releaseId as string,
    productVersion: parsed.productVersion as string,
    releaseMetadataDigest: parsed.releaseMetadataDigest,
    ...(digestSource !== undefined ? { releaseMetadataDigestSource: digestSource as ReleaseMetadataDigestSource } : {}),
    generation: parsed.generation as number,
    detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
  };
}

export interface RecoveryAwareJournalRead {
  readonly transitions: readonly JournalTransition[];
  /**
   * True when the final physical journal record was a torn (unparseable,
   * unterminated) write — its transition never durably committed and is
   * EXCLUDED from `transitions`. Physical repair (truncation) belongs to an
   * explicit recovery operation, never to this reader.
   */
  readonly tornTailDetected: boolean;
}

function readJournalLines(journalPath: string, options: { recoveryAware: boolean }): RecoveryAwareJournalRead {
  if (!existsSync(journalPath)) return { transitions: [], tornTailDetected: false };
  const raw = readFileSync(journalPath, 'utf8');
  const segments = raw.split('\n');
  // A trailing '\n' makes split() yield a final empty segment; every other
  // segment is a newline-terminated (complete) physical record.
  const terminated = raw.endsWith('\n');
  const completeLines = segments.slice(0, -1);
  const trailingSegment = terminated ? '' : (segments[segments.length - 1] ?? '');

  const transitions: JournalTransition[] = [];
  let lineNumber = 0;
  for (const line of completeLines) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    transitions.push(parseTransition(line, lineNumber));
  }

  let tornTailDetected = false;
  if (trailingSegment.trim().length > 0) {
    lineNumber += 1;
    if (options.recoveryAware) {
      try {
        transitions.push(parseTransition(trailingSegment, lineNumber));
      } catch {
        // Torn tail: unparseable, unterminated final record. Its transition
        // never durably committed — drop it and flag for the recovery caller.
        tornTailDetected = true;
      }
    } else {
      transitions.push(parseTransition(trailingSegment, lineNumber));
    }
  }

  for (let index = 1; index < transitions.length; index += 1) {
    const previous = transitions[index - 1];
    const current = transitions[index];
    if (!previous || !current) continue;
    if (previous.to !== current.from) {
      throw new TransactionJournalError(
        'journal_sequence_broken',
        `Journal transition ${index + 1} claims from=${JSON.stringify(current.from)} but the previous transition ended at ${JSON.stringify(previous.to)}.`,
      );
    }
    if (TERMINAL_STATES.has(previous.to)) {
      throw new TransactionJournalError(
        'journal_terminal_continued',
        `Journal continues after the terminal state ${previous.to} at transition ${index + 1}.`,
      );
    }
  }
  return { transitions, tornTailDetected };
}

/** Reads and strictly validates the whole journal (fail loud on any tear). */
export function readTransactionJournal(journalPath: string): readonly JournalTransition[] {
  return readJournalLines(journalPath, { recoveryAware: false }).transitions;
}

/**
 * Recovery-aware journal reader (crash contract, SPEC §8).
 *
 * The writer appends `JSON + '\n'` and fsyncs. A crash mid-append can leave a
 * TORN final record: unparseable JSON without a trailing newline. Such a
 * record never durably committed, so recovery drops it. Everything else is
 * strict: a malformed line anywhere else (including a complete-but-invalid
 * final line that DOES end with a newline) fails loud, because a complete
 * write with bad content is corruption, not a torn write.
 */
export function readTransactionJournalForRecovery(journalPath: string): RecoveryAwareJournalRead {
  return readJournalLines(journalPath, { recoveryAware: true });
}

/**
 * Appends one transition durably (append + fsync) BEFORE the caller performs
 * the side effect the transition describes. Journal-first ordering is what
 * makes crash recovery sound.
 */
export function appendJournalTransition(journalPath: string, transition: JournalTransition): void {
  const line = `${JSON.stringify(transition)}\n`;
  const directory = dirname(journalPath);
  mkdirSync(directory, { recursive: true });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(journalPath, 'a');
    appendFileSync(descriptor, line);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export interface ActiveRecordWrite {
  readonly generation: number;
  readonly releaseId: string;
  readonly releaseMetadataDigest: string;
  readonly previousReleaseId: string | null;
  readonly transactionId: string;
  readonly productVersion: string;
}

/** Serializes + atomically replaces active.json (see atomic-file adapter). */
export function writeActiveRecord(recordPath: string, write: ActiveRecordWrite): void {
  const record: ActiveRecord = { schemaVersion: 1, ...write };
  writeRecordAtomically(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

/** Strict active.json reader; returns null when absent. */
export function readActiveRecord(recordPath: string): ActiveRecord | null {
  if (!existsSync(recordPath)) return null;
  let text: string;
  try {
    text = readFileSync(recordPath, 'utf8');
  } catch (error) {
    throw new TransactionJournalError('active_record_corrupt', `active.json could not be read (${recordPath}): ${error instanceof Error ? error.message : String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    // A bare SyntaxError here would escape every ReleaseManager reason
    // contract; corrupt active state maps to its own stable code (rc-3/rc-9).
    throw new TransactionJournalError(
      'active_record_corrupt',
      `active.json is not valid JSON (${recordPath}): ${error instanceof Error ? error.message : String(error)}. Recovery must consult the transaction journal, never guess from a partial file.`,
    );
  }
  if (!isPlainObject(value)) {
    throw new TransactionJournalError('active_record_corrupt', `active.json is not an object: ${recordPath}`);
  }
  if (value.schemaVersion !== 1) {
    throw new TransactionJournalError('active_record_corrupt', `active.json has unsupported schemaVersion: ${JSON.stringify(value.schemaVersion)}`);
  }
  const {generation} = value;
  const {releaseId} = value;
  const digest = value.releaseMetadataDigest;
  const {previousReleaseId} = value;
  const {transactionId} = value;
  const {productVersion} = value;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1
    || typeof releaseId !== 'string' || releaseId.length === 0
    || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)
    || (previousReleaseId !== null && (typeof previousReleaseId !== 'string' || previousReleaseId.length === 0))
    || typeof transactionId !== 'string' || transactionId.length === 0
    || typeof productVersion !== 'string' || productVersion.length === 0) {
    throw new TransactionJournalError('active_record_corrupt', `active.json has malformed fields: ${recordPath}`);
  }
  return {
    schemaVersion: 1,
    generation,
    releaseId,
    releaseMetadataDigest: digest,
    previousReleaseId,
    transactionId,
    productVersion,
  };
}

export type RecoveryOutcome =
  | { readonly kind: 'old_confirmed'; readonly releaseId: string | null; readonly generation: number | null; readonly reason: string }
  | { readonly kind: 'new_confirmed'; readonly releaseId: string; readonly generation: number; readonly reason: string }
  | { readonly kind: 'explicit_refusal'; readonly reason: string; readonly nextAction: string };

/**
 * Reconciles ONE transaction against the active record after a crash. The
 * invariant: the result is old-confirmed, new-confirmed, or an explicit
 * refusal — never a hybrid release (SPEC §18-4).
 *
 * Rules:
 * - No journal activity for this transaction → nothing to reconcile.
 * - Journal reached `confirmed` → new release stands.
 * - Journal never reached `activated` → old release stands (nothing was
 *   swapped); staging residue is cleaned up by the caller.
 * - Journal reached `activated` (or later, unconfirmed) but active.json does
 *   not carry this transaction's generation → the crash interrupted the
 *   active-record write. The journal-confirmed PREVIOUS generation wins:
 *   recovery re-points to it; a hybrid (new code, old pointer) is never
 *   activated. If there is no previous pointer to fall back to, refuse
 *   explicitly and demand the official installer.
 */
export function recoverUnfinishedTransaction(input: {
  transitions: readonly JournalTransition[];
  activeRecord: ActiveRecord | null;
  previousRecord: ActiveRecord | null;
  transactionId: string;
}): RecoveryOutcome {
  const { transitions, activeRecord, previousRecord, transactionId } = input;
  const mine = transitions.filter((transition) => transition.transactionId === transactionId);
  if (mine.length === 0) {
    return { kind: 'old_confirmed', releaseId: null, generation: null, reason: 'no journal activity for this transaction' };
  }
  const last = mine[mine.length - 1] as JournalTransition;

  if (last.to === 'confirmed') {
    return {
      kind: 'new_confirmed',
      releaseId: last.releaseId,
      generation: last.generation,
      reason: 'journal already confirmed the new release',
    };
  }
  if (last.to === 'rolled_back' || last.to === 'refused' || last.to === 'failed') {
    return {
      kind: 'old_confirmed',
      releaseId: previousRecord?.releaseId ?? activeRecord?.releaseId ?? null,
      generation: previousRecord?.generation ?? activeRecord?.generation ?? null,
      reason: `transaction ended in ${last.to}; the previously confirmed release remains active`,
    };
  }

  const reachedActivation = mine.some((transition) => ACTIVATION_OR_LATER.has(transition.to));
  if (!reachedActivation) {
    return {
      kind: 'old_confirmed',
      releaseId: previousRecord?.releaseId ?? activeRecord?.releaseId ?? null,
      generation: previousRecord?.generation ?? activeRecord?.generation ?? null,
      reason: 'activation was never journaled; no swap happened and staging can be discarded',
    };
  }


  // Activation started. The active record decides which side of the swap
  // actually landed, and its generation must match a journal transition.
  const activeMatchesNew = activeRecord !== null
    && activeRecord.transactionId === transactionId
    && activeRecord.generation === last.generation
    && activeRecord.releaseId === last.releaseId;
  if (activeMatchesNew && last.to !== 'activated') {
    // host_verified was journaled but confirmation didn't land — the active
    // pointer plus the journal's activation lineage still close on the new
    // generation; confirm it.
    return {
      kind: 'new_confirmed',
      releaseId: activeRecord.releaseId,
      generation: activeRecord.generation,
      reason: 'active record matches the journaled activation lineage; completing confirmation',
    };
  }
  if (activeMatchesNew && last.to === 'activated') {
    // Pointer landed but host verification never ran: NOT confirmed. The
    // previous confirmed generation is the safe answer when it exists.
    if (previousRecord !== null) {
      return {
        kind: 'old_confirmed',
        releaseId: previousRecord.releaseId,
        generation: previousRecord.generation,
        reason: 'activation pointer landed but the release was never host-verified; falling back to the previous confirmed generation',
      };
    }
    return {
      kind: 'explicit_refusal',
      reason: 'activation_interrupted_without_previous',
      nextAction: 'The first-ever activation was interrupted before host verification and there is no previously confirmed release to fall back to. Re-run the official installer to install a complete release.',
    };
  }

  // Active record does not carry this transaction — the swap never landed.
  const fallback = previousRecord ?? activeRecord;
  if (fallback !== null) {
    return {
      kind: 'old_confirmed',
      releaseId: fallback.releaseId,
      generation: fallback.generation,
      reason: 'the active record never took this transaction\'s generation; the previously confirmed release stands',
    };
  }
  return {
    kind: 'explicit_refusal',
    reason: 'activation_interrupted_without_previous',
    nextAction: 'Activation was interrupted before any confirmed generation existed. Re-run the official installer to install a complete release.',
  };
}

