/**
 * Codex rollout transcript incremental decoder (Codex Governance Closure
 * Slice A; SPEC rev 2 §9, G1 probe report §6).
 *
 * Decodes a bounded byte window from the durable checkpoint offset and
 * projects ONLY governance-relevant visible facts (SPEC §12 privacy
 * boundary): genuine visible user messages (`content_item_kinds[0] ===
 * "user.text"` — host-injected context arrives as user-role records with
 * other kinds), visible assistant commentary/final messages, and tool
 * execution facts anchored on the `event_msg item_completed
 * CommandExecution` record whose `item.id` IS the hook `tool_use_id` id
 * space (the G1-verified bridge; the model-level `call_id` is a different
 * space). Hidden reasoning, system/developer prompts, world_state,
 * host-injected context, and unknown record bodies are identified by shape
 * and dropped before persistence — never projected, logged, or emitted.
 *
 * Failure classes are distinct (SPEC §14): an incomplete final line (no
 * trailing newline at EOF) is a transient append/flush boundary — the
 * checkpoint does not advance past it and the next ingestion retries; a
 * complete line that fails JSON parsing or envelope validation is a stable
 * malformed record — decoding stops at it without advancing, with a
 * structured reason. Unknown-but-well-formed record types are skipped with
 * a bounded warning and DO advance.
 */
import fs from 'node:fs';
import type { GovernanceObservationInput } from '@principles/host-runtime';

export const CODEX_INGESTION_MAX_BATCH_BYTES = 1024 * 1024;
export const CODEX_INGESTION_MAX_BATCH_RECORDS = 256;

export interface TranscriptReadResult {
  /** Raw bytes read from [offset, offset+maxBytes) — never a decoded string, so multi-byte UTF-8 never corrupts offset math. */
  readonly bytes: Buffer;
  readonly fileSize: number;
}

/** Filesystem boundary for the transcript read — injectable so tests can spy. */
export interface TranscriptPort {
  read(canonicalPath: string, offset: number, maxBytes: number): TranscriptReadResult;
}

export function createNodeTranscriptPort(): TranscriptPort {
  return {
    read(canonicalPath: string, offset: number, maxBytes: number): TranscriptReadResult {
      const fd = fs.openSync(canonicalPath, 'r');
      try {
        const stats = fs.fstatSync(fd);
        if (!stats.isFile()) throw new Error('transcript_is_not_regular_file');
        const length = Math.max(0, Math.min(maxBytes, stats.size - offset));
        if (length === 0) return { bytes: Buffer.alloc(0), fileSize: stats.size };
        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
        // Post-read byte bound re-verification (EP-08): never trust the
        // pre-read stat for the enforced cap.
        const actual = bytesRead < 0 ? 0 : bytesRead;
        if (actual > maxBytes) throw new Error('transcript_read_exceeded_bound');
        return { bytes: buffer.subarray(0, actual), fileSize: stats.size };
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

export type TranscriptDecodeStop =
  | { kind: 'eof' }
  | { kind: 'incomplete_tail' }
  | { kind: 'malformed'; ordinal: number | null }
  | { kind: 'byte_bound' }
  | { kind: 'oversized_record' };

export interface DecodedDelta {
  readonly observations: readonly GovernanceObservationInput[];
  readonly rolloutMeta: {
    rootSessionId: string | null;
    cliVersion: string | null;
    parentRolloutIdentity: string | null;
    agentIdentity: string | null;
    agentDepth: number | null;
  };
  readonly compactionTimestamp: string | null;
  readonly rollbackTurns: readonly number[];
  readonly stop: TranscriptDecodeStop;
  /** Checkpoint byte offset to commit: start of the first unconsumed byte. */
  readonly nextByteOffset: number;
  /** Highest ordinal consumed (for the checkpoint's last_ordinal). */
  readonly lastOrdinal: number;
  readonly warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

function metadataTurnId(payload: Record<string, unknown>): string | null {
  const passthrough = own(payload, 'internal_chat_message_metadata_passthrough');
  if (!isRecord(passthrough)) return null;
  const turnId = own(passthrough, 'turn_id');
  return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
}

function contentItemKinds(payload: Record<string, unknown>): readonly string[] {
  const passthrough = own(payload, 'internal_chat_message_metadata_passthrough');
  if (!isRecord(passthrough)) return [];
  const kinds = own(passthrough, 'content_item_kinds');
  if (!Array.isArray(kinds)) return [];
  return kinds.filter((kind): kind is string => typeof kind === 'string');
}

function joinContentText(payload: Record<string, unknown>, type: string): string | null {
  const content = own(payload, 'content');
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (own(item, 'type') === type && typeof own(item, 'text') === 'string') parts.push(own(item, 'text') as string);
  }
  return parts.length > 0 ? parts.join('') : null;
}

interface DecodeContext {
  readonly rolloutIdentity: string;
  readonly fallbackRootSessionId: string | null;
  readonly nowIso: string;
  observations: GovernanceObservationInput[];
  meta: { rootSessionId: string | null; cliVersion: string | null; parentRolloutIdentity: string | null; agentIdentity: string | null; agentDepth: number | null };
  modelCallsByTurn: Map<string, { callId: string | null; name: string | null }[]>;
  compactionTimestamp: string | null;
  rollbackTurns: number[];
  warnings: string[];
}

function warnBounded(context: DecodeContext, warning: string): void {
  if (context.warnings.length < 16) context.warnings.push(warning);
}

function applySessionMeta(context: DecodeContext, payload: Record<string, unknown>): void {
  const sessionId = own(payload, 'session_id');
  if (typeof sessionId === 'string' && sessionId.length > 0 && context.meta.rootSessionId === null) {
    // Root-session lineage only. For subagent rollouts this value is the
    // PARENT thread id (G1 §4 collision trap) — rollout identity comes from
    // the file uuid, never from session_meta.session_id.
    context.meta.rootSessionId = sessionId;
  }
  const cliVersion = own(payload, 'cli_version');
  if (typeof cliVersion === 'string' && cliVersion.length > 0 && context.meta.cliVersion === null) {
    context.meta.cliVersion = cliVersion;
  }
  const source = own(payload, 'source');
  const spawn = isRecord(source) ? own(source, 'subagent') : undefined;
  const threadSpawn = isRecord(spawn) ? own(spawn, 'thread_spawn') : undefined;
  if (isRecord(threadSpawn)) {
    const parentThreadId = own(threadSpawn, 'parent_thread_id');
    if (typeof parentThreadId === 'string' && parentThreadId.length > 0) context.meta.parentRolloutIdentity = parentThreadId;
    const nickname = own(threadSpawn, 'agent_nickname');
    const agentPath = own(threadSpawn, 'agent_path');
    const identity = typeof nickname === 'string' && nickname.length > 0 ? nickname : typeof agentPath === 'string' && agentPath.length > 0 ? agentPath : null;
    if (identity !== null) context.meta.agentIdentity = identity;
    const depth = own(threadSpawn, 'depth');
    if (typeof depth === 'number' && Number.isInteger(depth) && depth >= 0) context.meta.agentDepth = depth;
  } else {
    const forkedFrom = own(payload, 'forked_from_id');
    if (typeof forkedFrom === 'string' && forkedFrom.length > 0 && context.meta.parentRolloutIdentity === null) {
      context.meta.parentRolloutIdentity = forkedFrom;
    }
  }
}

function joinItemText(item: Record<string, unknown>): string | null {
  const content = own(item, 'content');
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    // UserMessage items use "text", AgentMessage items use "Text".
    const type = own(entry, 'type');
    if ((type === 'text' || type === 'Text') && typeof own(entry, 'text') === 'string') {
      parts.push(own(entry, 'text') as string);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

function observationBase(context: DecodeContext, turnId: string): Pick<GovernanceObservationInput, 'hostKind' | 'rolloutIdentity' | 'rootSessionId' | 'hostTurnId'> {
  return {
    hostKind: 'codex',
    rolloutIdentity: context.rolloutIdentity,
    rootSessionId: context.meta.rootSessionId ?? context.fallbackRootSessionId ?? turnId,
    hostTurnId: turnId,
  };
}

interface ProjectedRecord {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly ordinal: number;
  readonly recordByteStart: number;
  readonly timestamp: string | null;
}

function projectRecord(context: DecodeContext, record: ProjectedRecord): void {
  const { type, payload, ordinal, recordByteStart, timestamp } = record;
  const observedAt = timestamp ?? context.nowIso;

  if (type === 'session_meta') {
    applySessionMeta(context, payload);
    return;
  }
  if (type === 'compacted') {
    // Marker: replacement_history becomes the logical history going forward;
    // replaced records must not be re-imported as new turns (G1 §6). The
    // store tombstones prior unpromoted observations at ingest time.
    context.compactionTimestamp = observedAt;
    return;
  }
  if (type === 'world_state' || type === 'inter_agent_communication_metadata') {
    // Environment/host snapshots — identified and dropped (privacy boundary).
    return;
  }
  if (type === 'turn_context') {
    // Per-turn host configuration (sandbox/permissions/model) — known type,
    // no governance projection, no warning.
    return;
  }

  if (type === 'response_item') {
    const payloadType = own(payload, 'type');
    if (payloadType === 'reasoning') return; // hidden/encrypted reasoning — never projected
    if (payloadType === 'custom_tool_call' || payloadType === 'function_call') {
      const turnId = metadataTurnId(payload);
      const callId = own(payload, 'call_id');
      const name = own(payload, 'name');
      if (turnId !== null) {
        const queue = context.modelCallsByTurn.get(turnId) ?? [];
        queue.push({ callId: typeof callId === 'string' ? callId : null, name: typeof name === 'string' ? name : null });
        context.modelCallsByTurn.set(turnId, queue);
      }
      return;
    }
    if (payloadType === 'message' && own(payload, 'role') === 'user') {
      // 0.150.1 marks genuine visible user input with content_item_kinds[0]
      // === "user.text"; host-injected context carries other kinds. 0.148.0
      // does not emit content_item_kinds at all, so this channel is used ONLY
      // when the discriminator exists — the authoritative cross-version user
      // channel is the item_completed UserMessage record below.
      const kinds = contentItemKinds(payload);
      if (kinds.length === 0 || kinds[0] !== 'user.text') return;
      const turnId = metadataTurnId(payload);
      if (turnId === null) {
        warnBounded(context, `observation_skipped_missing_identity:${ordinal}`);
        return;
      }
      const text = joinContentText(payload, 'input_text');
      context.observations.push({
        ...observationBase(context, turnId),
        kind: 'user_turn',
        logicalObservationKey: `codex|${context.rolloutIdentity}|${turnId}|user`,
        transcriptRecordKey: `codex|${context.rolloutIdentity}|${ordinal}`,
        recordByteStart,
        visibleText: text ?? undefined,
        source: 'transcript',
        completeness: text !== null ? 'complete' : 'partial',
        observedAt,
      });
      return;
    }
    // Assistant/developer response_item messages are not projected here: the
    // item_completed AgentMessage channel is the cross-version visible
    // assistant source (0.148.0 lacks content_item_kinds discriminators).
    return;
  }

  if (type === 'event_msg') {
    const payloadType = own(payload, 'type');
    if (payloadType === 'item_completed') {
      const item = own(payload, 'item');
      if (!isRecord(item)) return;
      const itemType = own(item, 'type');
      const turnId = own(payload, 'turn_id');
      if (itemType === 'UserMessage') {
        // Only genuine visible user turns produce UserMessage completions —
        // host-injected context never does (both supported versions).
        if (typeof turnId !== 'string' || turnId.length === 0) {
          warnBounded(context, `observation_skipped_missing_identity:${ordinal}`);
          return;
        }
        const text = joinItemText(item);
        context.observations.push({
          ...observationBase(context, turnId),
          kind: 'user_turn',
          logicalObservationKey: `codex|${context.rolloutIdentity}|${turnId}|user`,
          transcriptRecordKey: `codex|${context.rolloutIdentity}|${ordinal}`,
          recordByteStart,
          visibleText: text ?? undefined,
          source: 'transcript',
          completeness: text !== null ? 'complete' : 'partial',
          observedAt,
        });
        return;
      }
      if (itemType === 'AgentMessage') {
        if (typeof turnId !== 'string' || turnId.length === 0) {
          warnBounded(context, `observation_skipped_missing_identity:${ordinal}`);
          return;
        }
        const itemId = own(item, 'id');
        if (typeof itemId !== 'string' || itemId.length === 0) {
          warnBounded(context, `observation_skipped_missing_identity:${ordinal}`);
          return;
        }
        const text = joinItemText(item);
        // AgentMessage phase sits on the item (fixture-verified; keep the
        // payload sibling as a tolerated alternative).
        const phase = own(item, 'phase') ?? own(payload, 'phase');
        context.observations.push({
          ...observationBase(context, turnId),
          kind: 'assistant_turn',
          logicalObservationKey: `codex|${context.rolloutIdentity}|${turnId}|${itemId}`,
          transcriptRecordKey: `codex|${context.rolloutIdentity}|${ordinal}`,
          recordByteStart,
          assistantItemId: itemId,
          phase: typeof phase === 'string' ? phase : undefined,
          visibleText: text ?? undefined,
          source: 'transcript',
          completeness: text !== null ? 'complete' : 'partial',
          observedAt,
        });
        return;
      }
      if (itemType === 'CommandExecution') {
        const toolUseId = own(item, 'id');
        if (typeof toolUseId !== 'string' || toolUseId.length === 0 || typeof turnId !== 'string' || turnId.length === 0) {
          warnBounded(context, `observation_skipped_missing_identity:${ordinal}`);
          return;
        }
        // FIFO-pair with the model-level call in the same turn for the tool
        // name / call_id enrichment (execution order; G1 bridge fixture).
        const queue = context.modelCallsByTurn.get(turnId);
        const paired = queue !== undefined && queue.length > 0 ? queue.shift() : undefined;
        if (queue !== undefined && queue.length === 0) context.modelCallsByTurn.delete(turnId);
        const exitCode = own(item, 'exit_code');
        const command = own(item, 'command');
        const stdout = own(item, 'stdout');
        const stderr = own(item, 'stderr');
        context.observations.push({
          ...observationBase(context, turnId),
          kind: 'tool_call',
          logicalObservationKey: `codex|${context.rolloutIdentity}|${toolUseId}`,
          transcriptRecordKey: `codex|${context.rolloutIdentity}|${ordinal}`,
          recordByteStart,
          toolUseId,
          transcriptToolCallId: paired?.callId ?? undefined,
          toolFacts: {
            toolName: paired?.name ?? null,
            exitCode: typeof exitCode === 'number' ? exitCode : null,
            command: Array.isArray(command) ? command.filter((part): part is string => typeof part === 'string').slice(0, 8) : null,
            stdout: typeof stdout === 'string' ? stdout : null,
            stderr: typeof stderr === 'string' ? stderr : null,
          },
          source: 'transcript',
          completeness: 'complete',
          observedAt,
        });
        return;
      }
      return;
    }
    if (payloadType === 'thread_rolled_back') {
      // Documented rule (G1 runtime contract, thread_rollout_truncation.rs):
      // rollback appends a marker carrying num_turns; physical records remain
      // while effective logical history is truncated.
      const numTurns = own(payload, 'num_turns');
      if (typeof numTurns === 'number' && Number.isInteger(numTurns) && numTurns > 0) {
        context.rollbackTurns.push(numTurns);
      }
      return;
    }
    // task_started / turn_context / token_count / task_complete /
    // thread_settings_applied: known turn bookkeeping — no projection.
    return;
  }

  warnBounded(context, `unknown_record_type_skipped:${type}`);
}

export interface DecodeTranscriptWindowInput {
  readonly bytes: Buffer;
  readonly fileOffset: number;
  /** True when bytes.length did not reach EOF — the window was cut by the bounded read. */
  readonly byteBoundReached: boolean;
  readonly rolloutIdentity: string;
  readonly fallbackRootSessionId: string | null;
  readonly nowIso: string;
}

interface DecodedLine {
  readonly record: Record<string, unknown> | null; // null = the line did not parse
  readonly type: string | null;
  readonly ordinal: number | null;
  readonly timestamp: string | null;
  readonly payload: Record<string, unknown> | null;
}

function decodeLine(lineBytes: Buffer): DecodedLine {
  const text = lineBytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { record: null, type: null, ordinal: null, timestamp: null, payload: null };
  }
  if (!isRecord(parsed)) return { record: null, type: null, ordinal: null, timestamp: null, payload: null };
  const type = own(parsed, 'type');
  const ordinal = own(parsed, 'ordinal');
  const timestamp = own(parsed, 'timestamp');
  const payload = own(parsed, 'payload');
  const validEnvelope = typeof type === 'string' && type.length > 0
    && typeof ordinal === 'number' && Number.isInteger(ordinal)
    && (payload === undefined || isRecord(payload));
  if (!validEnvelope) {
    return { record: parsed, type: null, ordinal: typeof ordinal === 'number' && Number.isInteger(ordinal) ? ordinal : null, timestamp: null, payload: null };
  }
  return {
    record: parsed,
    type,
    ordinal,
    timestamp: typeof timestamp === 'string' ? timestamp : null,
    payload: payload === undefined ? {} : payload,
  };
}

function finish(context: DecodeContext, nextByteOffset: number, lastOrdinal: number): Omit<DecodedDelta, 'stop'> {
  return {
    observations: context.observations,
    rolloutMeta: context.meta,
    compactionTimestamp: context.compactionTimestamp,
    rollbackTurns: context.rollbackTurns,
    nextByteOffset,
    lastOrdinal,
    warnings: context.warnings,
  };
}

export function decodeTranscriptWindow(input: DecodeTranscriptWindowInput): DecodedDelta {
  const context: DecodeContext = {
    rolloutIdentity: input.rolloutIdentity,
    fallbackRootSessionId: input.fallbackRootSessionId,
    nowIso: input.nowIso,
    observations: [],
    meta: { rootSessionId: null, cliVersion: null, parentRolloutIdentity: null, agentIdentity: null, agentDepth: null },
    modelCallsByTurn: new Map(),
    compactionTimestamp: null,
    rollbackTurns: [],
    warnings: [],
  };

  const { bytes } = input;
  if (bytes.length === 0) {
    return { ...finish(context, input.fileOffset, -1), stop: { kind: 'eof' } };
  }

  // UTF-8 multi-byte sequences never contain 0x0A, so splitting the byte
  // window at newline bytes is safe and keeps the checkpoint byte-exact.
  const lastNewline = bytes.lastIndexOf(0x0a);
  const completeEnd = lastNewline + 1; // exclusive byte end of the newline-terminated region
  const tailBytes = bytes.subarray(completeEnd); // bytes after the final newline (no terminator)

  let cursor = input.fileOffset;
  let lastOrdinal = -1;
  let recordsConsumed = 0;

  let lineStart = 0;
  while (lineStart < completeEnd) {
    const lineEnd = bytes.indexOf(0x0a, lineStart);
    if (lineEnd === -1 || lineEnd >= completeEnd) break;
    const lineBytes = bytes.subarray(lineStart, lineEnd);
    const recordByteStart = cursor;
    cursor = input.fileOffset + lineEnd + 1;
    lineStart = lineEnd + 1;
    if (lineBytes.length === 0 || lineBytes.toString('utf8').trim().length === 0) continue;
    if (recordsConsumed >= CODEX_INGESTION_MAX_BATCH_RECORDS) {
      return { ...finish(context, recordByteStart, lastOrdinal), stop: { kind: 'byte_bound' } };
    }
    const line = decodeLine(lineBytes);
    if (line.record === null || line.type === null) {
      // A newline-terminated line that does not parse (or fails the record
      // envelope) is a stable malformed record: stop here without advancing
      // past it (SPEC §14.2).
      return { ...finish(context, recordByteStart, lastOrdinal), stop: { kind: 'malformed', ordinal: line.ordinal } };
    }
    recordsConsumed += 1;
    lastOrdinal = line.ordinal as number;
    projectRecord(context, { type: line.type, payload: line.payload ?? {}, ordinal: line.ordinal as number, recordByteStart, timestamp: line.timestamp });
  }

  if (tailBytes.length > 0) {
    const tailStart = cursor; // byte offset where the unterminated tail begins
    if (input.byteBoundReached) {
      // The window ended mid-line because of the byte bound — the line is not
      // known-incomplete; leave it wholly unread and report bounded lag.
      if (lastNewline === -1) {
        return { ...finish(context, input.fileOffset, lastOrdinal), stop: { kind: 'oversized_record' } };
      }
      return { ...finish(context, tailStart, lastOrdinal), stop: { kind: 'byte_bound' } };
    }
    const line = decodeLine(tailBytes);
    if (line.record !== null && line.type !== null) {
      // A parseable final line without a trailing newline is a complete
      // record; consume it and advance the checkpoint to EOF.
      lastOrdinal = line.ordinal as number;
      projectRecord(context, { type: line.type, payload: line.payload ?? {}, ordinal: line.ordinal as number, recordByteStart: tailStart, timestamp: line.timestamp });
      return { ...finish(context, tailStart + tailBytes.length, lastOrdinal), stop: { kind: 'eof' } };
    }
    // Incomplete final line: transient append/flush boundary — do not
    // advance past the previous record; the next ingestion retries (SPEC §14.1).
    return { ...finish(context, tailStart, lastOrdinal), stop: { kind: 'incomplete_tail' } };
  }

  return { ...finish(context, cursor, lastOrdinal), stop: input.byteBoundReached ? { kind: 'byte_bound' } : { kind: 'eof' } };
}
