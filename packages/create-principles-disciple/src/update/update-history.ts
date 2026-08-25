/**
 * Update history semantics (SPEC §12).
 *
 * History events use explicit kinds: update, reinstall, channel_promotion,
 * legacy_migration, rollback, refusal, and recovery. Direction is DERIVED
 * from canonical release identity and metadata sequence — never from
 * package.json values found in a checkout. Every failed or refused event
 * states what happened, whether the previous release remains active, and
 * the safest next action.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type HistoryKind =
  | 'update'
  | 'reinstall'
  | 'channel_promotion'
  | 'legacy_migration'
  | 'rollback'
  | 'refusal'
  | 'recovery';

export type HistoryDirection = 'forward' | 'backward' | 'none';

export type HistoryOutcome = 'succeeded' | 'refused' | 'failed' | 'recovered';

export interface UpdateHistoryEvent {
  readonly at: string;
  readonly kind: HistoryKind;
  readonly direction: HistoryDirection;
  readonly outcome: HistoryOutcome;
  readonly productVersion: string | null;
  readonly releaseId: string | null;
  readonly previousReleaseId: string | null;
  /** True when the previously confirmed release is still the active one. */
  readonly previousRemainsActive: boolean;
  readonly reason: string | null;
  readonly nextAction: string | null;
  readonly transactionId: string | null;
}

export class UpdateHistoryError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'UpdateHistoryError';
    this.field = field;
  }
}

const HISTORY_KINDS: ReadonlySet<string> = new Set([
  'update', 'reinstall', 'channel_promotion', 'legacy_migration', 'rollback', 'refusal', 'recovery',
]);

const HISTORY_DIRECTIONS: ReadonlySet<string> = new Set(['forward', 'backward', 'none']);

const HISTORY_OUTCOMES: ReadonlySet<string> = new Set(['succeeded', 'refused', 'failed', 'recovered']);

const isHistoryKind = (value: string): value is HistoryKind => HISTORY_KINDS.has(value);

const isHistoryDirection = (value: string): value is HistoryDirection => HISTORY_DIRECTIONS.has(value);

const isHistoryOutcome = (value: string): value is HistoryOutcome => HISTORY_OUTCOMES.has(value);

/**
 * Direction is derived from canonical publication sequences: forward when the
 * event's release is newer than the previous one, backward when older,
 * none for reinstall/refusal/unknown.
 */
export function classifyDirection(input: {
  kind: HistoryKind;
  releasePublicationSequence: number | null;
  previousPublicationSequence: number | null;
}): HistoryDirection {
  if (input.kind === 'reinstall' || input.kind === 'refusal') return 'none';
  if (input.releasePublicationSequence === null || input.previousPublicationSequence === null) return 'none';
  if (input.releasePublicationSequence > input.previousPublicationSequence) return 'forward';
  if (input.releasePublicationSequence < input.previousPublicationSequence) return 'backward';
  return 'none';
}

function validateEvent(event: UpdateHistoryEvent): void {
  if (!HISTORY_KINDS.has(event.kind)) {
    throw new UpdateHistoryError('kind', `Unknown history kind: ${JSON.stringify(event.kind)}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(event.at)) {
    throw new UpdateHistoryError('at', `History event timestamps must be RFC3339 UTC: ${JSON.stringify(event.at)}`);
  }
  if (event.outcome !== 'succeeded' && event.outcome !== 'refused' && event.outcome !== 'failed' && event.outcome !== 'recovered') {
    throw new UpdateHistoryError('outcome', `Unknown history outcome: ${JSON.stringify(event.outcome)}`);
  }
  if (event.outcome !== 'succeeded' && event.nextAction === null) {
    throw new UpdateHistoryError('nextAction', `A ${event.outcome} history event must carry a next action (rc-9).`);
  }
}

/** Appends one durable history event to `<pdHome>/logs/history.jsonl`. */
export function appendHistoryEvent(historyFilePath: string, event: UpdateHistoryEvent): void {
  validateEvent(event);
  mkdirSync(dirname(historyFilePath), { recursive: true });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(historyFilePath, 'a');
    appendFileSync(descriptor, `${JSON.stringify(event)}\n`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Strict reader for tests and the Console history surface. */
export function readHistoryEvents(historyFilePath: string): UpdateHistoryEvent[] {
  if (!existsSync(historyFilePath)) return [];
  const raw = readFileSync(historyFilePath, 'utf8');
  const events: UpdateHistoryEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new UpdateHistoryError('line', 'history lines must be objects');
    }
    const read = (field: string): unknown => Reflect.get(parsed, field);
    const fail = (field: string, value: unknown): never => {
      throw new UpdateHistoryError('line', `history field "${field}" has invalid type: ${JSON.stringify(value)}`);
    };
    const requireString = (field: string): string => {
      const value = read(field);
      return typeof value === 'string' ? value : fail(field, value);
    };
    const stringOrNull = (field: string): string | null => {
      const value = read(field);
      if (value === null || value === undefined) return null;
      return typeof value === 'string' ? value : fail(field, value);
    };
    // Enum fields are narrowed through their closed vocabularies before
    // construction; validateEvent below re-checks cross-field contracts.
    const kindValue = requireString('kind');
    const directionValue = requireString('direction');
    const outcomeValue = requireString('outcome');
    const event: UpdateHistoryEvent = {
      at: requireString('at'),
      kind: isHistoryKind(kindValue) ? kindValue : fail('kind', kindValue),
      direction: isHistoryDirection(directionValue) ? directionValue : fail('direction', directionValue),
      outcome: isHistoryOutcome(outcomeValue) ? outcomeValue : fail('outcome', outcomeValue),
      productVersion: stringOrNull('productVersion'),
      releaseId: stringOrNull('releaseId'),
      previousReleaseId: stringOrNull('previousReleaseId'),
      previousRemainsActive: read('previousRemainsActive') === true,
      reason: stringOrNull('reason'),
      nextAction: stringOrNull('nextAction'),
      transactionId: stringOrNull('transactionId'),
    };
    validateEvent(event);
    events.push(event);
  }
  return events;
}
