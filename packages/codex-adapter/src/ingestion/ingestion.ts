/**
 * Codex conversation ingestion orchestrator (Codex Governance Closure
 * Slice A; SPEC rev 2 §7/§9/§17).
 *
 * Called by pd-hook ONLY after both `host.codex` and
 * `codex_conversation_ingestion` are enabled — the flag check happens
 * before any transcript filesystem I/O, so flag-off means this module is
 * never entered and the transcript boundary receives zero calls (SPEC §10
 * hard privacy invariant, proven by a port spy test).
 *
 * Responsibilities: extract validated ingestion fields from the raw hook
 * payload (Codex protocol facts live in the adapter, not host-runtime),
 * authorize the transcript path, run bounded incremental decoding from the
 * durable checkpoint, apply the supported-version guard, and hand the
 * projected observations to the host-neutral host-runtime seam.
 *
 * Stop (`turn_complete`) is the turn-complete ingestion trigger (G1 §2);
 * live `UserPromptSubmit`/`PostToolUse` contribute live observations that
 * the transcript replay later converges with (SPEC §10 source precedence).
 */
import type { HostEventKind } from '@principles/core/host';
import {
  ingestGovernanceObservations,
  readGovernanceCheckpoint,
  type GovernanceIngestDegradation,
  type GovernanceObservationInput,
} from '@principles/host-runtime';
import { resolveCodexHome } from './codex-home.js';
import { validateCodexTranscriptPath } from './transcript-path.js';
import { classifyCodexVersion, CODEX_VERSION_NEXT_ACTION } from './codex-version.js';
import { decodeTranscriptWindow, createNodeTranscriptPort, CODEX_INGESTION_MAX_BATCH_BYTES, TranscriptReplacedError, type TranscriptExpectedIdentity, type TranscriptPort } from './transcript-decoder.js';

export interface CodexIngestionOptions {
  readonly workspaceDir: string;
  readonly env?: { CODEX_HOME?: string | undefined };
  readonly now?: Date;
  readonly port?: TranscriptPort;
}

export type CodexIngestionOutcome =
  | { status: 'ok'; inserted: number; enriched: number; duplicates: number; warnings: readonly string[]; lagBytes: number }
  | { status: 'degraded'; reason: string; nextAction: string; warnings: readonly string[] };

let activePort: TranscriptPort | null = null;

/** Test seam: inject/inspect the transcript filesystem boundary (zero-read proofs). */
export function setCodexTranscriptPortForTest(port: TranscriptPort | null): void {
  activePort = port;
}

function activeTranscriptPort(options: CodexIngestionOptions): TranscriptPort {
  return options.port ?? activePort ?? createNodeTranscriptPort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

interface PayloadFields {
  transcriptPath: string | null;
  sessionId: string;
  turnId: string | null;
  prompt: string | null;
  toolUseId: string | null;
  toolName: string | null;
  toolInput: unknown;
  toolResponse: unknown;
}

function extractFields(raw: unknown): PayloadFields | null {
  if (!isRecord(raw)) return null;
  const transcriptPath = own(raw, 'transcript_path');
  if (transcriptPath !== null && typeof transcriptPath !== 'string') return null;
  const sessionId = own(raw, 'session_id');
  const turnId = own(raw, 'turn_id');
  const prompt = own(raw, 'prompt');
  const toolUseId = own(raw, 'tool_use_id');
  const toolName = own(raw, 'tool_name');
  return {
    transcriptPath: transcriptPath ?? null,
    sessionId: typeof sessionId === 'string' ? sessionId : '',
    turnId: typeof turnId === 'string' ? turnId : null,
    prompt: typeof prompt === 'string' ? prompt : null,
    toolUseId: typeof toolUseId === 'string' ? toolUseId : null,
    toolName: typeof toolName === 'string' ? toolName : null,
    toolInput: own(raw, 'tool_input'),
    toolResponse: own(raw, 'tool_response'),
  };
}

interface LiveObservationArgs {
  readonly fields: PayloadFields;
  readonly rolloutIdentity: string;
  readonly workspaceDir: string;
  readonly now: Date;
}

function ingestLiveObservation({ fields, rolloutIdentity, workspaceDir, now }: LiveObservationArgs): CodexIngestionOutcome {
  const nowIso = now.toISOString();
  let observation: GovernanceObservationInput | null = null;
  if (fields.turnId !== null && fields.prompt !== null) {
    observation = {
      hostKind: 'codex',
      rolloutIdentity,
      rootSessionId: fields.sessionId,
      hostTurnId: fields.turnId,
      kind: 'user_turn',
      logicalObservationKey: `codex|${rolloutIdentity}|${fields.turnId}|user`,
      visibleText: fields.prompt,
      source: 'live_hook',
      completeness: 'complete',
      observedAt: nowIso,
    };
  } else if (fields.turnId !== null && fields.toolUseId !== null) {
    observation = {
      hostKind: 'codex',
      rolloutIdentity,
      rootSessionId: fields.sessionId,
      hostTurnId: fields.turnId,
      kind: 'tool_call',
      logicalObservationKey: `codex|${rolloutIdentity}|${fields.toolUseId}`,
      toolUseId: fields.toolUseId,
      toolFacts: {
        toolName: fields.toolName,
        params: fields.toolInput ?? null,
        result: fields.toolResponse ?? null,
      },
      source: 'live_hook',
      completeness: 'complete',
      observedAt: nowIso,
    };
  }
  if (observation === null) {
    return { status: 'degraded', reason: 'transcript_path_invalid', nextAction: 'the live event lacks turn/prompt/tool identity; no observation was written.', warnings: [] };
  }
  const result = ingestGovernanceObservations({
    workspaceDir,
    observations: [observation],
    now,
  });
  if (!result.ok) return { status: 'degraded', reason: result.reason ?? 'governance_write_failed', nextAction: result.nextAction ?? 'inspect the workspace trajectory database.', warnings: result.warnings };
  return { status: 'ok', inserted: result.inserted, enriched: result.enriched, duplicates: result.duplicates, warnings: result.warnings, lagBytes: 0 };
}

interface TranscriptDeltaArgs {
  readonly fields: PayloadFields;
  readonly canonicalPath: string;
  readonly identity: TranscriptExpectedIdentity;
  readonly rolloutIdentity: string;
  readonly workspaceDir: string;
  readonly env: { CODEX_HOME?: string | undefined };
  readonly now: Date;
  readonly port: TranscriptPort;
}

function ingestTranscriptDelta({ fields, canonicalPath, identity, rolloutIdentity, workspaceDir, now, port }: TranscriptDeltaArgs): CodexIngestionOutcome {
  const checkpoint = readGovernanceCheckpoint({ workspaceDir, hostKind: 'codex', rolloutIdentity });
  if (checkpoint !== null && !('byteOffset' in checkpoint) && 'ok' in checkpoint && checkpoint.ok === false) {
    return { status: 'degraded', reason: checkpoint.reason, nextAction: checkpoint.nextAction, warnings: [] };
  }
  const existing = checkpoint !== null && 'byteOffset' in checkpoint ? checkpoint : null;
  const offset = existing !== null ? existing.byteOffset : 0;

  let window;
  try {
    // Post-open revalidation (SPEC §9): the port must prove the opened
    // object still carries the identity the validator approved.
    window = port.read({ canonicalPath, offset, maxBytes: CODEX_INGESTION_MAX_BATCH_BYTES, expectedIdentity: identity });
  } catch (error) {
    if (error instanceof TranscriptReplacedError) {
      return { status: 'degraded', reason: 'transcript_replaced', nextAction: 'the transcript changed identity after validation (replacement or symlink swap); refusing to read — the next Stop revalidates the current file.', warnings: [] };
    }
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { status: 'degraded', reason: `transcript_read_failed:${detail}`, nextAction: 'verify the transcript file still exists and is a regular file inside the Codex sessions root.', warnings: [] };
  }
  if (offset > window.fileSize) {
    // The file shrank below the committed cursor: replaced or truncated —
    // never guess; hold the checkpoint and degrade explicitly.
    return { status: 'degraded', reason: 'checkpoint_inconsistent', nextAction: 'the transcript is shorter than the committed checkpoint; run the audited recovery/quarantine path once available or re-ingest from a fresh rollout.', warnings: [] };
  }

  const byteBoundReached = offset + window.bytes.length < window.fileSize;
  const decoded = decodeTranscriptWindow({
    bytes: window.bytes,
    fileOffset: offset,
    byteBoundReached,
    rolloutIdentity,
    fallbackRootSessionId: existing !== null ? existing.rootSessionId : fields.sessionId,
    nowIso: now.toISOString(),
  });

  // Supported-version guard (SPEC §9): the version signal lives in the
  // transcript session_meta (or the committed checkpoint after the first
  // batch). Anything below the verified floor or above the verified ceiling
  // degrades explicitly — never guess record fields of an unknown contract.
  const cliVersion = decoded.rolloutMeta.cliVersion ?? existing?.cliVersion ?? null;
  const version = classifyCodexVersion(cliVersion);
  if (version.status !== 'supported') {
    return {
      status: 'degraded',
      reason: `${version.reason}:${cliVersion ?? 'unknown'}`,
      nextAction: CODEX_VERSION_NEXT_ACTION,
      warnings: decoded.warnings,
    };
  }

  const degradations: GovernanceIngestDegradation[] = [];
  if (decoded.stop.kind === 'malformed') {
    degradations.push({ reason: 'transcript_record_malformed', ...(decoded.stop.ordinal !== null ? { ordinal: decoded.stop.ordinal } : {}), nextAction: 'the record is stable-invalid; run the audited quarantine command once available (Slice D). Later records remain as lag.' });
  } else if (decoded.stop.kind === 'oversized_record') {
    degradations.push({ reason: 'transcript_record_too_large', nextAction: 'a single transcript record exceeds the bounded-read window; inspect the rollout file.' });
  }

  const rootSessionId = decoded.rolloutMeta.rootSessionId ?? existing?.rootSessionId ?? fields.sessionId;
  const result = ingestGovernanceObservations({
    workspaceDir,
    rollout: {
      hostKind: 'codex',
      rolloutIdentity,
      rootSessionId,
      ...(decoded.rolloutMeta.parentRolloutIdentity !== null ? { parentRolloutIdentity: decoded.rolloutMeta.parentRolloutIdentity } : {}),
      ...(decoded.rolloutMeta.agentIdentity !== null ? { agentIdentity: decoded.rolloutMeta.agentIdentity } : {}),
      ...(decoded.rolloutMeta.agentDepth !== null ? { agentDepth: decoded.rolloutMeta.agentDepth } : {}),
    },
    observations: decoded.observations,
    checkpoint: {
      hostKind: 'codex',
      rolloutIdentity,
      byteOffset: decoded.nextByteOffset,
      lastOrdinal: decoded.lastOrdinal >= 0 ? decoded.lastOrdinal : existing?.lastOrdinal ?? 0,
      cliVersion: cliVersion ?? undefined,
      rootSessionId,
      incompleteTail: decoded.stop.kind === 'incomplete_tail',
    },
    ...(degradations.length > 0 ? { degradations } : {}),
    ...(decoded.compactionTimestamp !== null ? { compactionTimestamp: decoded.compactionTimestamp } : {}),
    ...(decoded.rollbackTurns.length > 0 ? { rollbackTurns: decoded.rollbackTurns } : {}),
    now,
  });

  const warnings = [...decoded.warnings, ...result.warnings];
  if (!result.ok) {
    return { status: 'degraded', reason: result.reason ?? 'governance_write_failed', nextAction: result.nextAction ?? 'inspect the workspace trajectory database.', warnings };
  }
  if (decoded.stop.kind === 'incomplete_tail') {
    warnings.push('transcript_incomplete_tail');
  }
  if (decoded.stop.kind === 'malformed') {
    // The store already committed the records before the malformed line and
    // held the checkpoint at it; surface the stable failure loudly (SPEC §14.2).
    return {
      status: 'degraded',
      reason: 'transcript_record_malformed',
      nextAction: 'the record is stable-invalid; run the audited quarantine command once available (Slice D). Later records remain as lag.',
      warnings,
    };
  }
  if (decoded.stop.kind === 'oversized_record') {
    return {
      status: 'degraded',
      reason: 'transcript_record_too_large',
      nextAction: 'a single transcript record exceeds the bounded-read window; inspect the rollout file.',
      warnings,
    };
  }
  return {
    status: 'ok',
    inserted: result.inserted,
    enriched: result.enriched,
    duplicates: result.duplicates,
    warnings,
    lagBytes: Math.max(0, window.fileSize - decoded.nextByteOffset),
  };
}

export function ingestCodexConversation(rawPayload: unknown, kind: HostEventKind, options: CodexIngestionOptions): CodexIngestionOutcome {
  const fields = extractFields(rawPayload);
  if (fields === null || fields.sessionId.length === 0) {
    return { status: 'degraded', reason: 'transcript_path_invalid', nextAction: 'the hook payload lacks the required Codex identity fields.', warnings: [] };
  }
  if (fields.transcriptPath === null) {
    // SPEC §9: never scan for another file; keep a neutral degraded result.
    return { status: 'degraded', reason: 'transcript_unavailable', nextAction: 'Codex supplied no transcript for this event; nothing is read or fabricated.', warnings: [] };
  }
  const home = resolveCodexHome(options.env);
  if (!home.ok) return { status: 'degraded', reason: home.reason, nextAction: home.nextAction, warnings: [] };
  const validated = validateCodexTranscriptPath(fields.transcriptPath, home.home);
  if (!validated.ok) return { status: 'degraded', reason: validated.reason, nextAction: validated.nextAction, warnings: [] };
  const now = options.now ?? new Date();

  if (kind === 'before_prompt_build' || kind === 'after_tool_call') {
    return ingestLiveObservation({ fields, rolloutIdentity: validated.rolloutIdentity, workspaceDir: options.workspaceDir, now });
  }
  return ingestTranscriptDelta({
    fields,
    canonicalPath: validated.canonicalPath,
    identity: validated.identity,
    rolloutIdentity: validated.rolloutIdentity,
    workspaceDir: options.workspaceDir,
    env: options.env ?? {},
    now,
    port: activeTranscriptPort(options),
  });
}
