/**
 * WorkBuddy session-transcript incremental decoder (PRI-1171 P2; SPEC v0.2
 * §4.4, tech design §5.2–§5.4).
 *
 * WorkBuddy appends flat JSONL records (one record per line, no envelope
 * wrapper) under `~/.workbuddy/projects/<encoded-cwd>/<sessionId>.jsonl`.
 * The record-type baseline is frozen from the cross-period forensics in
 * docs/plans/2026-08-28-workbuddy-session-transcript-access.md §8.1
 * (message ×5 variants, function_call ×3, reasoning ×2,
 * function_call_result / file-history-snapshot / ai-title / resend-fork-notice
 * ×1) plus the `session-meta` head record observed on 2026-11-11 (absent
 * from the Aug-28 census — tolerated as a known skip, see the mapping in
 * projectRecord).
 *
 * Failure classes inherit the seam taxonomy (host-runtime
 * conversation-ingestion/source.ts): an incomplete final line at EOF is a
 * transient append boundary (checkpoint holds); a newline-terminated line
 * that does not parse is a stable malformed record (stop, never advance
 * past it); unknown-but-well-formed types are skipped with an aggregated,
 * bounded warning and DO advance (rc-9: no silent skips).
 *
 * Privacy/semantics guardrails from the tech design:
 *   - `compactionTimestamp` is ALWAYS null — WorkBuddy compaction only
 *     APPENDS a summary record (forensics §8.2); history stays valid on
 *     disk, and the store treats that parameter as an active tombstone
 *     (tech design §5.4), so passing it would destroy live evidence.
 *     Markers surface as the aggregated `wb_compaction_marker` warning.
 *   - reasoning attribution never guesses: the parentId chain resolves
 *     within the decoded window or the observation lands
 *     partial + phase `unattributed` (tech design §4.8).
 *   - Ordinals are synthesized (the host file carries none): the caller
 *     seeds `startOrdinal` from the committed checkpoint so replays are
 *     stable; the durable replay identity is byte-based
 *     (`wb|<sessionId>|<byteOffset>`, tech design §5.3).
 *   - Host context is NOT Owner conversation: a user record wraps the real
 *     utterance in `<system-reminder>...</system-reminder>` blocks followed by
 *     `<user_query>...</user_query>` (forensic samples, 2026-11-11). Only the
 *     Owner utterance may become `visibleText`. Projecting the whole blob
 *     would persist host prompts as Owner behavior evidence, and the store's
 *     200-char head-only bound would truncate the actual utterance away.
 */
import {
  CONVERSATION_INGESTION_MAX_BATCH_RECORDS,
  planJsonlWindow,
  type GovernanceObservationInput,
  type TranscriptDecodeStop,
} from '@principles/host-runtime';

export interface DecodedWorkbuddyDelta {
  readonly observations: readonly GovernanceObservationInput[];
  readonly stop: TranscriptDecodeStop;
  readonly nextByteOffset: number;
  readonly lastOrdinal: number;
  readonly warnings: readonly string[];
}

/** Distinct aggregated warning tokens per window (mirrors the Codex 16-warning bound). */
const MAX_WARNING_TOKENS = 16;
/** Max hops when resolving a reasoning parentId chain to its assistant record. */
const MAX_PARENT_CHAIN_HOPS = 8;
/** WorkBuddy user records: host context blocks + the Owner's utterance block. */
const USER_QUERY_BLOCK = /<user_query>([\s\S]*?)<\/user_query>/g;
const SYSTEM_REMINDER_BLOCK = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Join the `text` of content parts (input_text / output_text / reasoning_text all carry `.text`). */
function joinContentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const text = own(item, 'text');
    if (typeof text === 'string') parts.push(text);
  }
  return parts.length > 0 ? parts.join('') : null;
}

/** Extract a bounded result preview: `{type:'text',text}` object or plain string (store sanitizes). */
function resultOutputPreview(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (isRecord(output)) return nonEmptyString(own(output, 'text'));
  return null;
}

interface DecodeContext {
  readonly sessionIdentity: string;
  readonly nowIso: string;
  observations: GovernanceObservationInput[];
  /** id → {parentId, role} for in-window reasoning attribution (§4.8). */
  seenRecords: Map<string, { parentId: string | null; role: string | null }>;
  /** callId → observation index awaiting its function_call_result (FIFO by file order). */
  pendingToolCalls: Map<string, number>;
  warningCounts: Map<string, number>;
}

function warnAggregated(context: DecodeContext, token: string): void {
  if (context.warningCounts.size >= MAX_WARNING_TOKENS && !context.warningCounts.has(token)) return;
  context.warningCounts.set(token, (context.warningCounts.get(token) ?? 0) + 1);
}

function warningList(context: DecodeContext): string[] {
  return [...context.warningCounts.entries()].map(([token, count]) => `${token}:${count}`);
}

/**
 * Project ONLY the Owner utterance from a WorkBuddy user record.
 *
 * A real user record is ~15KB of `<system-reminder>` host context (AGENTS,
 * identity files, tool declarations, connector state) with the Owner's words
 * in a trailing `<user_query>` block. Projecting that whole blob would persist
 * host prompts as Owner behavior evidence AND lose the utterance: the store's
 * `sanitizeString` keeps a 200-char head-only preview, which in 24/24 sampled
 * real records contained none of the Owner's words.
 *
 * `null` means "no Owner text to store": the observation still lands as
 * `partial`, but host context never reaches the governance store. Every such
 * degradation carries an aggregated warning (rc-9).
 */
function projectUserText(context: DecodeContext, text: string | null): string | null {
  if (text === null) return null;

  // Preferred contract: the host marks the Owner's own words explicitly. An
  // Owner who literally pasted `<system-reminder>` inside their query keeps
  // it verbatim — we never strip inside the query block.
  const queries = [...text.matchAll(USER_QUERY_BLOCK)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((part) => part.length > 0);
  if (queries.length > 0) return queries.join('\n');

  // Legacy/plain records carry no wrapper at all — preserve them unchanged.
  if (!text.includes('<system-reminder')) return text;

  const remainder = text.replace(SYSTEM_REMINDER_BLOCK, '').trim();
  if (remainder.includes('<system-reminder')) {
    // Unclosed or nested marker: never persist a half-parsed host prompt.
    warnAggregated(context, 'wb_user_context_unparsed');
    return null;
  }
  if (remainder.length === 0) {
    warnAggregated(context, 'wb_user_context_only');
    return null;
  }
  warnAggregated(context, 'wb_user_context_stripped');
  return remainder;
}

function epochMsToIso(value: unknown, fallbackIso: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallbackIso;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallbackIso : date.toISOString();
}

function providerDataOf(record: Record<string, unknown>): Record<string, unknown> | null {
  const providerData = own(record, 'providerData');
  return isRecord(providerData) ? providerData : null;
}

function hostTurnIdOf(record: Record<string, unknown>, id: string | null, sessionIdentity: string): string {
  const providerData = providerDataOf(record);
  const messageId = providerData !== null ? nonEmptyString(own(providerData, 'messageId')) : null;
  // Callers guard id !== null before projecting; the session identity is the
  // durable last-resort container so hostTurnId is always a non-empty string.
  return messageId ?? id ?? sessionIdentity;
}

/** Detect a WorkBuddy compaction marker (providerData.compType / isCompacted; forensics §8.2). */
function hasCompactionMarker(providerData: Record<string, unknown> | null): boolean {
  if (providerData === null) return false;
  return own(providerData, 'isCompacted') === true || nonEmptyString(own(providerData, 'compactType')) !== null;
}

interface ProjectedRecord {
  readonly record: Record<string, unknown>;
  /** Validated non-empty by decodeLine before projection (flat envelope contract). */
  readonly type: string;
  readonly id: string | null;
  readonly ordinal: number;
  readonly recordByteStart: number;
  readonly timestampIso: string;
}

function observationBase(context: DecodeContext, record: ProjectedRecord): Pick<GovernanceObservationInput, 'hostKind' | 'rolloutIdentity' | 'rootSessionId' | 'hostTurnId'> {
  return {
    hostKind: 'workbuddy',
    rolloutIdentity: context.sessionIdentity,
    rootSessionId: context.sessionIdentity,
    hostTurnId: hostTurnIdOf(record.record, record.id, context.sessionIdentity),
  };
}

/** Follow the parentId chain to the owning assistant message record id, in-window only; never guess. */
function resolveAssistantAncestor(context: DecodeContext, parentId: unknown): string | null {
  let current = nonEmptyString(parentId);
  for (let hop = 0; hop < MAX_PARENT_CHAIN_HOPS && current !== null; hop += 1) {
    const seen = context.seenRecords.get(current);
    if (seen === undefined) return null;
    if (seen.role === 'assistant') return current;
    current = seen.parentId;
  }
  return null;
}

function noteRecordIdentity(context: DecodeContext, record: Record<string, unknown>): void {
  const id = nonEmptyString(own(record, 'id'));
  if (id === null) return;
  const role = own(record, 'role');
  context.seenRecords.set(id, {
    parentId: nonEmptyString(own(record, 'parentId')),
    role: typeof role === 'string' ? role : null,
  });
}

function noteSessionIdMismatch(context: DecodeContext, record: Record<string, unknown>): void {
  const recordSessionId = nonEmptyString(own(record, 'sessionId'));
  if (recordSessionId !== null && recordSessionId !== context.sessionIdentity) {
    warnAggregated(context, 'wb_session_id_mismatch');
  }
}

function projectRecord(context: DecodeContext, record: ProjectedRecord): void {
  const raw = record.record;
  const { type } = record;
  noteSessionIdMismatch(context, raw);

  // Known structural records with no governance projection (rc-9: counted, never silent).
  if (type === 'session-meta' || type === 'file-history-snapshot' || type === 'ai-title') {
    warnAggregated(context, `wb_skipped:${type}`);
    noteRecordIdentity(context, raw);
    return;
  }
  if (type === 'resend-fork-notice') {
    // Session fork notice — branch marker only; old rows are never rewritten (§4.7).
    warnAggregated(context, 'wb_fork_notice');
    noteRecordIdentity(context, raw);
    return;
  }

  if (type === 'message') {
    noteRecordIdentity(context, raw);
    if (record.id === null) {
      warnAggregated(context, 'wb_observation_skipped_missing_identity');
      return;
    }
    const role = own(raw, 'role');
    const providerData = providerDataOf(raw);
    if (hasCompactionMarker(providerData)) {
      // §5.4: append-only compaction — warn, never tombstone (compactionTimestamp stays null).
      warnAggregated(context, 'wb_compaction_marker');
    }
    if (role !== 'user' && role !== 'assistant') {
      warnAggregated(context, 'wb_skipped_message_role');
      return;
    }
    const joined = joinContentText(own(raw, 'content'));
    // Only user turns carry the host-context wrapper; assistant turns keep the
    // existing verbatim projection (no wrapper observed in forensic samples).
    const text = role === 'user' ? projectUserText(context, joined) : joined;
    context.observations.push({
      ...observationBase(context, record),
      kind: role === 'user' ? 'user_turn' : 'assistant_turn',
      logicalObservationKey: `wb|${context.sessionIdentity}|${record.id}`,
      transcriptRecordKey: `wb|${context.sessionIdentity}|${record.recordByteStart}`,
      recordOrdinal: record.ordinal,
      recordByteStart: record.recordByteStart,
      ...(role === 'assistant' ? { assistantItemId: record.id } : {}),
      ...(role === 'assistant' ? { toolFacts: { model: providerData !== null ? nonEmptyString(own(providerData, 'model')) : null } } : {}),
      ...(text !== null ? { visibleText: text } : {}),
      source: 'transcript',
      completeness: text !== null ? 'complete' : 'partial',
      observedAt: record.timestampIso,
    });
    return;
  }

  if (type === 'reasoning') {
    noteRecordIdentity(context, raw);
    if (record.id === null) {
      warnAggregated(context, 'wb_observation_skipped_missing_identity');
      return;
    }
    const text = joinContentText(own(raw, 'content')) ?? joinContentText(own(raw, 'rawContent'));
    const assistantAncestor = resolveAssistantAncestor(context, own(raw, 'parentId'));
    context.observations.push({
      ...observationBase(context, record),
      kind: 'reasoning',
      logicalObservationKey: `wb|${context.sessionIdentity}|${record.id}`,
      transcriptRecordKey: `wb|${context.sessionIdentity}|${record.recordByteStart}`,
      recordOrdinal: record.ordinal,
      recordByteStart: record.recordByteStart,
      ...(assistantAncestor !== null ? { assistantItemId: assistantAncestor } : { phase: 'unattributed' }),
      ...(text !== null ? { visibleText: text } : {}),
      source: 'transcript',
      completeness: text !== null && assistantAncestor !== null ? 'complete' : 'partial',
      observedAt: record.timestampIso,
    });
    return;
  }

  if (type === 'function_call') {
    noteRecordIdentity(context, raw);
    if (record.id === null) {
      warnAggregated(context, 'wb_observation_skipped_missing_identity');
      return;
    }
    const providerData = providerDataOf(raw);
    const callId = nonEmptyString(own(raw, 'callId'));
    if (callId === null) warnAggregated(context, 'wb_missing_call_id');
    const observation: GovernanceObservationInput = {
      ...observationBase(context, record),
      kind: 'tool_call',
      logicalObservationKey: `wb|${context.sessionIdentity}|${record.id}`,
      transcriptRecordKey: `wb|${context.sessionIdentity}|${record.recordByteStart}`,
      recordOrdinal: record.ordinal,
      recordByteStart: record.recordByteStart,
      ...(callId !== null ? { toolUseId: callId } : {}),
      toolFacts: {
        toolName: nonEmptyString(own(raw, 'name')),
        params: nonEmptyString(own(raw, 'arguments')),
        model: providerData !== null ? nonEmptyString(own(providerData, 'model')) : null,
      },
      source: 'transcript',
      // 'partial' until the matching function_call_result lands in-window (§5.3).
      completeness: 'partial',
      observedAt: record.timestampIso,
    };
    const index = context.observations.push(observation) - 1;
    if (callId !== null && !context.pendingToolCalls.has(callId)) {
      context.pendingToolCalls.set(callId, index);
    }
    return;
  }

  if (type === 'function_call_result') {
    noteRecordIdentity(context, raw);
    const callId = nonEmptyString(own(raw, 'callId'));
    const status = nonEmptyString(own(raw, 'status'));
    const outputPreview = resultOutputPreview(own(raw, 'output'));
    const pairedIndex = callId !== null ? context.pendingToolCalls.get(callId) : undefined;
    const pairedCall = pairedIndex !== undefined ? context.observations[pairedIndex] : undefined;
    if (callId !== null && pairedIndex !== undefined && pairedCall !== undefined) {
      // Result side backfills its in-window call observation (anchored on the
      // call record id — replay converges on ONE logical key per execution).
      context.pendingToolCalls.delete(callId);
      context.observations[pairedIndex] = {
        ...pairedCall,
        completeness: 'complete',
        toolFacts: {
          ...(isRecord(pairedCall.toolFacts) ? pairedCall.toolFacts : {}),
          resultStatus: status,
          ...(outputPreview !== null ? { output: outputPreview } : {}),
        },
      };
      return;
    }
    if (record.id === null) {
      warnAggregated(context, 'wb_observation_skipped_missing_identity');
      return;
    }
    // Orphan/lead result: the call record is outside this window (earlier
    // batch already committed) or genuinely missing — partial, never guessed.
    warnAggregated(context, 'wb_unpaired_tool_result');
    context.observations.push({
      ...observationBase(context, record),
      kind: 'tool_call',
      logicalObservationKey: `wb|${context.sessionIdentity}|${record.id}`,
      transcriptRecordKey: `wb|${context.sessionIdentity}|${record.recordByteStart}`,
      recordOrdinal: record.ordinal,
      recordByteStart: record.recordByteStart,
      ...(callId !== null ? { toolUseId: callId } : {}),
      toolFacts: {
        toolName: nonEmptyString(own(raw, 'name')),
        resultStatus: status,
        ...(outputPreview !== null ? { output: outputPreview } : {}),
      },
      source: 'transcript',
      completeness: 'partial',
      observedAt: record.timestampIso,
    });
    return;
  }

  // Unknown-but-well-formed type: explicit degradation, checkpoint still
  // advances (rc-9; a new host variant must be visible, not swallowed).
  warnAggregated(context, `wb_unknown_record_type:${type.slice(0, 40)}`);
}

type DecodedLine =
  | { ok: true; record: Record<string, unknown>; type: string; id: string | null; timestamp: unknown }
  | { ok: false };

function decodeLine(lineBytes: Buffer): DecodedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(lineBytes.toString('utf8'));
  } catch {
    return { ok: false };
  }
  if (!isRecord(parsed)) return { ok: false };
  // Envelope contract: a flat record with a non-empty string `type`. A line
  // without it is a stable malformed record (seam taxonomy) — never skipped.
  const type = nonEmptyString(own(parsed, 'type'));
  if (type === null) return { ok: false };
  return { ok: true, record: parsed, type, id: nonEmptyString(own(parsed, 'id')), timestamp: own(parsed, 'timestamp') };
}

interface DecodeCursor {
  readonly nextByteOffset: number;
  readonly lastOrdinal: number;
}

function finish(context: DecodeContext, cursor: DecodeCursor, stop: TranscriptDecodeStop): DecodedWorkbuddyDelta {
  return {
    observations: context.observations,
    stop,
    nextByteOffset: cursor.nextByteOffset,
    lastOrdinal: cursor.lastOrdinal,
    warnings: warningList(context),
  };
}

export interface DecodeWorkbuddyWindowInput {
  readonly bytes: Buffer;
  readonly fileOffset: number;
  /** True when bytes.length did not reach EOF — the window was cut by the bounded read. */
  readonly byteBoundReached: boolean;
  /** Durable session identity from the locator (file uuid) — keys are ALWAYS built from this, never from record.sessionId. */
  readonly sessionIdentity: string;
  /** Synthesized-ordinal seed: committed checkpoint's lastOrdinal + 1 (0 when no checkpoint). */
  readonly startOrdinal: number;
  readonly nowIso: string;
}

export function decodeWorkbuddyTranscriptWindow(input: DecodeWorkbuddyWindowInput): DecodedWorkbuddyDelta {
  const context: DecodeContext = {
    sessionIdentity: input.sessionIdentity,
    nowIso: input.nowIso,
    observations: [],
    seenRecords: new Map(),
    pendingToolCalls: new Map(),
    warningCounts: new Map(),
  };

  const { bytes } = input;
  if (bytes.length === 0) {
    return finish(context, { nextByteOffset: input.fileOffset, lastOrdinal: input.startOrdinal - 1 }, { kind: 'eof' });
  }

  // Byte-exact newline-window split from the seam — the incomplete-tail
  // semantics every host inherits (a half-line at EOF never advances).
  const plan = planJsonlWindow(bytes, input.fileOffset);

  let lastOrdinal = input.startOrdinal - 1;
  let nextOrdinal = input.startOrdinal;
  let recordsConsumed = 0;

  const consume = (line: Extract<DecodedLine, { ok: true }>, recordByteStart: number): void => {
    lastOrdinal = nextOrdinal;
    nextOrdinal += 1;
    recordsConsumed += 1;
    projectRecord(context, {
      record: line.record,
      type: line.type,
      id: line.id,
      ordinal: lastOrdinal,
      recordByteStart,
      timestampIso: epochMsToIso(line.timestamp, input.nowIso),
    });
  };

  for (const { bytes: lineBytes, recordByteStart } of plan.lines) {
    if (lineBytes.length === 0 || lineBytes.toString('utf8').trim().length === 0) continue;
    if (recordsConsumed >= CONVERSATION_INGESTION_MAX_BATCH_RECORDS) {
      return finish(context, { nextByteOffset: recordByteStart, lastOrdinal }, { kind: 'byte_bound' });
    }
    const line = decodeLine(lineBytes);
    if (!line.ok) {
      // Stable malformed record: stop without advancing past it. The would-be
      // ordinal of the malformed line is reported (the file carries none).
      return finish(context, { nextByteOffset: recordByteStart, lastOrdinal }, { kind: 'malformed', ordinal: nextOrdinal });
    }
    consume(line, recordByteStart);
  }

  if (plan.tail !== null) {
    const tailStart = plan.tail.startOffset;
    if (input.byteBoundReached) {
      // Window cut mid-line by the byte bound — bounded lag, never a verdict on the line.
      if (plan.lines.length === 0) {
        return finish(context, { nextByteOffset: input.fileOffset, lastOrdinal }, { kind: 'oversized_record' });
      }
      return finish(context, { nextByteOffset: tailStart, lastOrdinal }, { kind: 'byte_bound' });
    }
    const line = decodeLine(plan.tail.bytes);
    if (line.ok) {
      // Parseable final line without a trailing newline: complete record at EOF.
      consume(line, tailStart);
      return finish(context, { nextByteOffset: tailStart + plan.tail.bytes.length, lastOrdinal }, { kind: 'eof' });
    }
    // Incomplete final line: transient append/flush boundary — hold the checkpoint.
    return finish(context, { nextByteOffset: tailStart, lastOrdinal }, { kind: 'incomplete_tail' });
  }

  return finish(context, { nextByteOffset: plan.completeEndOffset, lastOrdinal }, input.byteBoundReached ? { kind: 'byte_bound' } : { kind: 'eof' });
}
