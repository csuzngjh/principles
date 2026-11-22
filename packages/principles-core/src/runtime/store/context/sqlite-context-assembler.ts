/**
 * SQLite implementation of ContextAssembler.
 *
 * Composes TaskStore + HistoryQuery + RunStore to assemble
 * DiagnosticianContextPayload from PD-owned retrieval results.
 *
 * Generates UUIDv4 contextId and SHA-256 contextHash for payload identity.
 * Produces template-generated ambiguityNotes for data quality issues.
 * Validates output with TypeBox Value.Check() before returning.
 */
import { randomUUID, createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { TaskStore } from '../task/task-store.js';
import type { RunStore } from '../run/run-store.js';
import type { HistoryQuery } from '../history/history-query.js';
import type { ContextAssembler } from './context-assembler.js';
import type { SourceTraceLocator } from '../trajectory/source-trace-locator.js';
import type { TrajectoryTurnReader } from './trajectory-turn-reader.js';
import {
  type DiagnosticianContextPayload,
  type DiagnosisTarget,
  type FullTracePayloadV2,
  type PainEvidenceEntry,
  type PainCorrectionEvidence,
  DiagnosticianContextPayloadSchema,
  validateFullTracePayload,
  sanitizeFullTracePayload,
  buildFullTraceTimeline,
  buildSourceRefs,
} from '../../context-payload.js';
import { parsePainAnchor, type HistoryQueryEntry } from '../../context-payload.js';
import type { TaskRecord, DiagnosticianTaskRecord } from '../../task-status.js';
import type { RunRecord } from '../../runtime-protocol.js';
import { PDRuntimeError } from '../../error-categories.js';
import { MAX_EVIDENCE_ENTRIES, MAX_EVIDENCE_NOTE_CHARS } from '../../pain-signal-bridge.js';
import { sanitizeString } from '../../evidence-sanitizer.js';
import { DEFAULT_PROMPT_BUILDER_LIMITS } from '../../diagnostician-prompt-builder.js';
import { readPromotedEvidenceWindow } from './promoted-evidence-reader.js';
import {
  denyAllSourceMaterialAuthorization,
  filterEvidenceByAuthorization,
  isOwnerManualCorrectionEvidence,
  type SourceMaterialAuthorizationPort,
  type SourceMaterialHostKind,
} from '../../source-material-authorization.js';

const PAIN_PROVENANCE_VALUES = ['host_context_bound', 'owner_reported_no_host_trace', 'automatic_hook'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPainProvenance(value: unknown): value is (typeof PAIN_PROVENANCE_VALUES)[number] {
  return typeof value === 'string' && (PAIN_PROVENANCE_VALUES as readonly string[]).includes(value);
}

/**
 * PRI-1283 R2 (review round 2, directive B): correction evidence channel →
 * the host whose consent governs the statement. Owner-authored statements
 * (owner_manual — a direct Owner channel, or an agent-assisted channel with
 * a bound Owner confirmation record) are Owner acts, not conversation
 * ingestion — they are NOT governed by the conversation-ingestion ledger and
 * survive a revocation (classification via the shared core helper so sweep /
 * recall / assembler / console / admission apply ONE judgment). A
 * `codex_explicit_agent` record WITHOUT a bound confirmation is
 * Agent-derived and stays governed (it maps back to the codex host below).
 * Channel-less legacy records of a codex/workbuddy task remain governed
 * (their correction text came from that host's consent-gated ingestion);
 * OpenClaw / CLI corrections return null.
 */
function correctionEvidenceHost(
  correction: NonNullable<DiagnosticianTaskRecord['correctionEvidence']>,
  taskHostKind: string | undefined,
): SourceMaterialHostKind | null {
  const channel = typeof (correction as { channel?: unknown }).channel === 'string'
    ? (correction as { channel: string }).channel
    : '';
  if (isOwnerManualCorrectionEvidence(correction)) return null;
  if (channel.startsWith('codex')) return 'codex';
  if (channel.startsWith('workbuddy')) return 'workbuddy';
  if (taskHostKind === 'codex') return 'codex';
  if (taskHostKind === 'workbuddy') return 'workbuddy';
  return null;
}

/**
 * PRI-1283 R2: the governance-observation host kinds whose consent is
 * currently granted — passed to the promoted-window read so unauthorized
 * rows are excluded inside the query. An empty array excludes every host's
 * rows; `undefined` (pre-R2 behavior) is never produced here because the
 * assembler always resolves the port (deny-all when unwired).
 */
function authorizedGovernanceHostKinds(port: SourceMaterialAuthorizationPort): readonly SourceMaterialHostKind[] {
  const hosts: SourceMaterialHostKind[] = [];
  for (const host of ['codex', 'workbuddy', 'openclaw'] as const) {
    if (port.isHostSourceMaterialAuthorized(host).authorized) hosts.push(host);
  }
  return hosts;
}

/**
 * Read-side provenance normalization (SPEC §12): persisted diagnosticJson may
 * carry the legacy `openclaw_context_bound` spelling; normalize to the current
 * value without rewriting history.
 */
function normalizedProvenance(dt: DiagnosticianTaskRecord): (typeof PAIN_PROVENANCE_VALUES)[number] | undefined {
  if (isPainProvenance(dt.provenance)) return dt.provenance;
  if (dt.provenance === 'openclaw_context_bound') return 'host_context_bound';
  return undefined;
}

/**
 * SPEC v0.3 §5: the diagnostician context must keep the admitting host —
 * losing `workbuddy` here silently degrades attribution to "unknown host".
 */
function resolveDiagnosticianHostKind(value: string | undefined): 'openclaw' | 'codex' | 'workbuddy' | undefined {
  return value === 'openclaw' || value === 'codex' || value === 'workbuddy' ? value : undefined;
}

// ── SqliteContextAssembler ──

export class SqliteContextAssembler implements ContextAssembler {
  // eslint-disable-next-line @typescript-eslint/max-params
  constructor(
    private readonly taskStore: TaskStore,
    private readonly historyQuery: HistoryQuery,
    private readonly runStore: RunStore,
    options?: {
      sourceTraceLocator?: SourceTraceLocator;
      trajectoryTurnReader?: TrajectoryTurnReader;
      /**
       * PRI-1283 R2: latest-consent gate for governance-sourced material.
       * Consulted per assemble() call. ABSENT = fail-closed for
       * governance-sourced evidence/conversation material (deny-all default):
       * consuming consent-gated excerpts without an authorization check is the
       * exact R2 gap this option exists to close.
       */
      sourceMaterialAuthorization?: SourceMaterialAuthorizationPort;
    },
  ) {
    this.sourceTraceLocator = options?.sourceTraceLocator;
    this.trajectoryTurnReader = options?.trajectoryTurnReader;
    this.sourceMaterialAuthorization = options?.sourceMaterialAuthorization ?? denyAllSourceMaterialAuthorization;
  }

  private readonly sourceTraceLocator?: SourceTraceLocator;
  private readonly trajectoryTurnReader?: TrajectoryTurnReader;
  private readonly sourceMaterialAuthorization: SourceMaterialAuthorizationPort;

  async assemble(taskId: string): Promise<DiagnosticianContextPayload> {
    const task = await this.taskStore.getTask(taskId);
    if (!task) {
      throw new PDRuntimeError('storage_unavailable', `Task not found: ${taskId}`);
    }

    if (task.taskKind !== 'diagnostician') {
      throw new PDRuntimeError(
        'input_invalid',
        `Task ${taskId} is not a diagnostician task (kind: ${task.taskKind})`,
      );
    }

    const ambiguityNotes: string[] = [];

    const dt = SqliteContextAssembler.reconstructDiagnosticianRecord(task, ambiguityNotes);

    const runs = await this.runStore.listRunsByTask(taskId);
    const runIds = runs.map((r) => r.runId);

    const firstRunStartedAt = runs[0]?.startedAt;
    const earliestStart = firstRunStartedAt !== undefined
      ? runs.reduce((earliest, r) => r.startedAt < earliest ? r.startedAt : earliest, firstRunStartedAt)
      : task.createdAt;

    const historyResult = await this.historyQuery.query(taskId, undefined, {
      timeWindowStart: earliestStart,
    });

    const contextId = randomUUID();
    let conversationEntries = historyResult.entries;

    const diagnosisTarget: DiagnosisTarget = {
      reasonSummary: dt.reasonSummary || undefined,
      source: dt.source || undefined,
      severity: dt.severity || undefined,
      painId: dt.sourcePainId || undefined,
      anchor: dt.anchor,
      sessionIdHint: dt.sessionIdHint || undefined,
      provenance: normalizedProvenance(dt) || undefined,
      hostKind: dt.hostKind,
      provenanceReason: dt.provenanceReason || undefined,
      evidence: dt.evidence,
      correctionEvidence: dt.correctionEvidence,
    };

    // PRI-1283 R2: enforce the LATEST source-material authorization on the
    // persisted evidence excerpts and the correction evidence. Governance-
    // sourced entries whose host consent is no longer granted are withheld
    // here — BEFORE they can reach any downstream prompt or model input. The
    // ambiguity note records counts and reasons only, never excerpt text.
    {
      const auth = this.sourceMaterialAuthorization;
      const evidenceInput = Array.isArray(diagnosisTarget.evidence) ? diagnosisTarget.evidence : [];
      const filtered = filterEvidenceByAuthorization(evidenceInput, auth);
      if (filtered.removed.length > 0) {
        diagnosisTarget.evidence = Array.from(filtered.kept);
        ambiguityNotes.push(
          `source-material authorization: ${filtered.removed.length} evidence entr${filtered.removed.length === 1 ? 'y is' : 'ies are'} withheld (host consent not granted; reasons: ${filtered.denialReasons.join(', ')}) — the entries are not valid diagnosis input (PRI-1283 R2)`,
        );
      }
      const correction = diagnosisTarget.correctionEvidence;
      if (correction !== undefined) {
        const governingHost = correctionEvidenceHost(correction, diagnosisTarget.hostKind);
        if (governingHost !== null) {
          const decision = auth.isHostSourceMaterialAuthorized(governingHost);
          if (!decision.authorized) {
            diagnosisTarget.correctionEvidence = undefined;
            ambiguityNotes.push(
              `source-material authorization: correction evidence withheld (host=${governingHost}, reason=${decision.reason}) — the conversation-sourced statement is not valid diagnosis input (PRI-1283 R2)`,
            );
          }
        }
      }
    }

    const convAmbiguityNotes = SqliteContextAssembler.buildAmbiguityNotes(
      taskId,
      historyResult.entries,
      historyResult.truncated,
    );

    // Promoted governance evidence is the authoritative window when it exists:
    // it was written for THIS pain (promotion_ref = canonical pain id) and is
    // the only conversation evidence available on hosts whose run history and
    // user_turns/assistant_turns tables are empty (Codex). Absent it, every
    // existing fallback below behaves exactly as before.
    // PRI-1283 R2: rows of a host whose consent is no longer granted are
    // excluded at the query boundary — revoked conversation material must not
    // enter the window at all, not be filtered after reading.
    const promotedWindow = typeof dt.sourcePainId === 'string' && dt.sourcePainId.length > 0 && dt.workspaceDir !== '<unknown>'
      ? readPromotedEvidenceWindow({
        workspaceDir: dt.workspaceDir,
        painId: dt.sourcePainId,
        maxEntries: DEFAULT_PROMPT_BUILDER_LIMITS.maxConversationEntries,
        authorizedHostKinds: authorizedGovernanceHostKinds(this.sourceMaterialAuthorization),
      })
      : null;

    let usedPromotedWindow = false;
    if (promotedWindow !== null) {
      if (promotedWindow.status === 'unavailable') {
        // rc-9: a failed read is reported, never mistaken for "no evidence".
        ambiguityNotes.push(
          `promoted evidence window unavailable for painId=${dt.sourcePainId}: ${promotedWindow.reason}; conversation window unchanged`,
        );
      } else if (promotedWindow.entries.length > 0) {
        if (conversationEntries.length > 0) {
          ambiguityNotes.push(
            `promoted evidence window replaced the run-history window for painId=${dt.sourcePainId} (promoted observations take precedence)`,
          );
        }
        conversationEntries = promotedWindow.entries;
        usedPromotedWindow = true;
        if (promotedWindow.truncated) {
          ambiguityNotes.push(
            `promoted evidence window truncated to ${DEFAULT_PROMPT_BUILDER_LIMITS.maxConversationEntries} entries (most recent kept) for painId=${dt.sourcePainId}`,
          );
        }
        if (promotedWindow.omittedCount > 0) {
          ambiguityNotes.push(
            `promoted evidence window: ${promotedWindow.omittedCount} of ${promotedWindow.observationCount} observations carried no readable text and were omitted (painId=${dt.sourcePainId})`,
          );
        }
      } else {
        // rc-9: an empty promoted window is a fallback, so it stays observable
        // even when the run-history window has entries to fall back to.
        ambiguityNotes.push(
          promotedWindow.observationCount > 0
            ? `promoted evidence window empty for painId=${dt.sourcePainId}: ${promotedWindow.observationCount} promoted observations carried no readable text`
            : `promoted evidence window: no promoted observations for painId=${dt.sourcePainId}; conversation window unchanged`,
        );
      }
    }
    if (!usedPromotedWindow && convAmbiguityNotes) {
      ambiguityNotes.push(...convAmbiguityNotes);
    }

    // PRI-350 / PRI-1265: fallback to the authorized trajectory reader when the
    // run-history window carries NO USABLE TEXT — an empty window and a window
    // of empty-text entries are equally blind, and the run-history projection
    // (e.g. a diagnostic task's own empty system/assistant stubs) must not
    // starve the diagnosis of the session's original turns.
    const historyHasUsableText = conversationEntries.some((entry) => typeof entry.text === 'string' && entry.text.trim().length > 0);
    if (!usedPromotedWindow && !historyHasUsableText && dt.sessionIdHint && dt.workspaceDir !== '<unknown>' && this.trajectoryTurnReader) {
      // PRI-1274 (B1 / P1-3): a NAMED target turn narrows the read to that
      // exact (session, turn) — never the whole session (the other turns
      // must not substitute the target), and never a guessed "latest" turn.
      const trajectoryEntries = this.readTrajectoryTurns(dt.sessionIdHint, ambiguityNotes, { targetTurnId: dt.targetTurnId, hostKind: dt.hostKind });
      if (trajectoryEntries.length > 0) {
        if (conversationEntries.length > 0) {
          ambiguityNotes.push(
            `run-history window had ${conversationEntries.length} entries with no usable text; replaced by the authorized trajectory turns for sessionId=${dt.sessionIdHint}`,
          );
        }
        conversationEntries = trajectoryEntries;
        // Remove the "No conversation history" note since we now have entries
        const noHistIdx = ambiguityNotes.findIndex((n) => n.includes('No conversation history'));
        if (noHistIdx !== -1) {
          ambiguityNotes.splice(noHistIdx, 1);
        }
      }
    }

    // Compute contextHash after trajectory fallback so it reflects final conversationWindow
    const serialized = JSON.stringify(conversationEntries);
    const contextHash = createHash('sha256').update(serialized).digest('hex');

    // PRI-255: For CLI-only pain, add explicit degradation note about missing trace
    // and SKIP source trace lookup entirely — no-host-trace pain must not attempt
    // to bind a conversation trace it cannot legitimately claim.
    let fullTrace: FullTracePayloadV2 | null = null;
    if (dt.provenance === 'owner_reported_no_host_trace') {
      ambiguityNotes.push(
        'owner_reported_no_host_trace: no authenticated host session provenance available for CLI-submitted pain; fullTrace unavailable',
      );
      diagnosisTarget.traceAvailability = 'unavailable_with_reason';
      diagnosisTarget.traceUnavailableDetail = {
        reason: 'CLI-submitted pain has no authenticated host session provenance; conversation trace cannot be bound to an OpenClaw session',
        nextAction: 'Report pain from within an OpenClaw session to enable context-bound trace, or rely on owner reason alone for diagnosis',
      };
    } else if (dt.sourcePainId) {
      // Build fullTrace from source pain trajectory (PRI-171 / PRI-189).
      // Source trace comes from the original execution that caused the pain signal,
      // NOT from the diagnostician task's own runs.
      fullTrace = await this.buildFullTraceFromSource(dt, ambiguityNotes);
    }

    // PRI-255: Set traceAvailability based on fullTrace result
    if (diagnosisTarget.traceAvailability === undefined) {
      if (fullTrace !== null) {
        diagnosisTarget.traceAvailability = 'available';
      } else if (dt.provenance === 'openclaw_context_bound' || dt.provenance === 'host_context_bound') {
        diagnosisTarget.traceAvailability = 'unavailable_with_reason';
        if (!diagnosisTarget.traceUnavailableDetail) {
          diagnosisTarget.traceUnavailableDetail = {
            reason: 'Context-bound pain but source trace could not be resolved',
            nextAction: 'Check sessionIdHint matches an active host session with recorded trajectory',
          };
        }
      } else if (dt.provenance === 'automatic_hook' || dt.provenance === 'owner_reported_no_host_trace') {
        diagnosisTarget.traceAvailability = 'unavailable_with_reason';
        if (!diagnosisTarget.traceUnavailableDetail) {
          diagnosisTarget.traceUnavailableDetail = {
            reason: dt.provenance === 'automatic_hook'
              ? 'Automatic hook pain but source trace could not be resolved'
              : 'Owner-reported pain without host session trace',
            nextAction: 'Provide pain from an OpenClaw session to enable context-bound trace',
          };
        }
      }
    }

    // PRI-1283 R2: sourceRefs mirror the (already filtered) diagnosisTarget
    // evidence — a revoked source's ref must not survive as a payload ref.
    const evidenceSourceRefs = (diagnosisTarget.evidence ?? []).map(e => e.sourceRef);

    const payload: DiagnosticianContextPayload = {
      contextId,
      contextHash,
      taskId,
      workspaceDir: dt.workspaceDir,
      sourceRefs: [taskId, ...runIds, ...evidenceSourceRefs],
      diagnosisTarget,
      conversationWindow: conversationEntries,
      ambiguityNotes: ambiguityNotes.length > 0 ? ambiguityNotes : undefined,
      fullTrace,
    };

    if (!Value.Check(DiagnosticianContextPayloadSchema, payload)) {
      throw new PDRuntimeError(
        'storage_unavailable',
        'Context payload schema validation failed',
      );
    }

    return payload;
  }


  private async buildFullTraceFromSource(
    dt: DiagnosticianTaskRecord,
    ambiguityNotes: string[],
  ): Promise<FullTracePayloadV2 | null> {
    const located = await this.locateSourceRuns(dt, ambiguityNotes);
    if (located === null) return null;
    return SqliteContextAssembler.buildFullTraceV2({ dt, sourceTaskId: located.sourceTaskId, runs: located.runs, ambiguityNotes });
  }

  private async locateSourceRuns(
    dt: DiagnosticianTaskRecord,
    ambiguityNotes: string[],
  ): Promise<{ sourceTaskId: string; runs: readonly RunRecord[] } | null> {
    if (!this.sourceTraceLocator) {
      ambiguityNotes.push(
        'SourceTraceLocator not available; cannot resolve source trace for sourcePainId=' + (dt.sourcePainId ?? 'unknown'),
      );
      return null;
    }

    const result = await this.sourceTraceLocator.locate({
      sourcePainId: dt.sourcePainId,
      sessionIdHint: dt.sessionIdHint,
      workspaceDir: dt.workspaceDir,
      excludeTaskIds: [dt.taskId],
    });

    if (result.ambiguityNotes.length > 0) {
      ambiguityNotes.push(...result.ambiguityNotes);
    }

    if (result.decision !== 'found' || !result.candidate) {
      if (result.ambiguityNotes.length === 0) {
        ambiguityNotes.push(
          'Source trace not found for sourcePainId=' + (dt.sourcePainId ?? 'unknown') +
          ': decision=' + result.decision,
        );
      }
      return null;
    }

    const runs = await this.runStore.listRunsByTask(result.candidate.taskId);
    return { sourceTaskId: result.candidate.taskId, runs };
  }

  private static buildFullTraceV2(opts: {
    dt: DiagnosticianTaskRecord;
    sourceTaskId: string;
    runs: readonly RunRecord[];
    ambiguityNotes: string[];
  }): FullTracePayloadV2 | null {
    const { dt, sourceTaskId, runs, ambiguityNotes } = opts;
    if (!dt.sourcePainId || !dt.taskId) return null;

    const { sourcePainId } = dt;
    const sourceRunIds = runs.map((r) => r.runId);
    const capturedAt = new Date().toISOString();

    const sourceRefs = buildSourceRefs(sourceTaskId, sourceRunIds);

    const timeline = buildFullTraceTimeline(runs.map((r) => ({
      runId: r.runId,
      inputPayload: r.inputPayload,
      outputPayload: r.outputPayload,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      executionStatus: r.executionStatus,
    })));

    const rawPayload: FullTracePayloadV2 = {
      sourceTaskId,
      sourcePainId,
      sourceRunIds,
      capturedAt,
      sourceRefs,
      timeline,
      ambiguityNotes: [...ambiguityNotes],
      sanitizationNotes: [],
    };

    const validation = validateFullTracePayload(rawPayload);
    if (!validation.valid) {
      ambiguityNotes.push(
        'fullTrace V2 validation failed for painId=' + sourcePainId + ': ' + validation.errors.join('; '),
      );
      return null;
    }

    const { payload: sanitized } = sanitizeFullTracePayload(rawPayload);

    return sanitized;
  }

  private static buildAmbiguityNotes(
    taskId: string,
    entries: readonly { text?: string }[],
    truncated: boolean,
  ): string[] | undefined {
    const notes: string[] = [];

    if (entries.length === 0) {
      notes.push(`No conversation history available for diagnostician task ${taskId}`);
    }

    if (truncated) {
      notes.push('Conversation window truncated; some history may be missing');
    }

    const emptyTextCount = entries.filter((e) => e.text === undefined).length;
    if (emptyTextCount > 0) {
      notes.push(`${emptyTextCount} entries have empty text content`);
    }

    return notes.length > 0 ? notes : undefined;
  }

  /**
   * PRI-350: Read turns from TrajectoryDB and convert to HistoryQueryEntry[].
   * Returns empty array if no turns found, with ambiguityNote added (ERR-002).
   *
   * PRI-1274 (B1 / P1-3): when `targetTurnId` is known, the read is EXACT —
   * only that (session, host turn id) may enter the window. The session's
   * other turns never substitute a named target, and an unreadable target
   * stays unreadable (observable note) instead of being replaced.
   */
  private readTrajectoryTurns(
    sessionId: string,
    ambiguityNotes: string[],
    target?: { readonly targetTurnId?: string; readonly hostKind?: 'openclaw' | 'codex' | 'workbuddy' },
  ): HistoryQueryEntry[] {
    const { targetTurnId } = target ?? {};
    const reader = this.trajectoryTurnReader;
    // Caller guarantees reader is defined; guard for type safety
    if (!reader) return [];

    if (targetTurnId !== undefined) {
      if (reader.listTurnTextsForHostTurnId === undefined) {
        ambiguityNotes.push(
          `Target turn ${targetTurnId} named for sessionId=${sessionId} but the trajectory reader cannot read by host turn id; session-wide substitution skipped`,
        );
        return [];
      }
      const exact = reader.listTurnTextsForHostTurnId(sessionId, targetTurnId, target?.hostKind);
      const entries: HistoryQueryEntry[] = [];
      for (const turn of exact.userTurns) {
        entries.push({ ts: turn.createdAt, role: 'user', text: turn.rawExcerpt });
      }
      for (const turn of exact.assistantTurns) {
        entries.push({ ts: turn.createdAt, role: 'assistant', text: sanitizeString(turn.sanitizedText) });
      }
      entries.sort((a, b) => a.ts.localeCompare(b.ts));
      if (entries.length === 0) {
        ambiguityNotes.push(
          `Target turn ${targetTurnId} for sessionId=${sessionId} has no readable text in the authorized trajectory store; session-wide substitution skipped`,
        );
      }
      return entries;
    }

    const userTurns = reader.listUserTurnsForSession(sessionId);
    const assistantTurns = reader.listAssistantTurns(sessionId);

    const entries: HistoryQueryEntry[] = [];

    for (const turn of userTurns) {
      entries.push({
        ts: turn.createdAt,
        role: 'user',
        text: turn.rawExcerpt,
      });
    }

    for (const turn of assistantTurns) {
      entries.push({
        ts: turn.createdAt,
        role: 'assistant',
        text: sanitizeString(turn.sanitizedText),
      });
    }

    // Sort by timestamp ascending
    entries.sort((a, b) => a.ts.localeCompare(b.ts));

    // ERR-002: No silent degradation — if trajectory also has no turns, add note
    if (entries.length === 0) {
      ambiguityNotes.push(
        `Trajectory fallback attempted for sessionId=${sessionId} but no turns found in trajectory database`,
      );
    }

    return entries;
  }

  private static extractStringField(obj: Record<string, unknown>, key: string): string | undefined {
    if (!Object.hasOwn(obj, key) || typeof obj[key] !== 'string') return undefined;
    return obj[key];
  }

  private static extractEvidence(parsed: Record<string, unknown>): PainEvidenceEntry[] | undefined {
    if (!Object.hasOwn(parsed, 'evidence') || !Array.isArray(parsed.evidence)) return undefined;
    return (parsed.evidence as unknown[])
      .filter((e: unknown): e is PainEvidenceEntry =>
        typeof e === 'object' && e !== null &&
        typeof (e as Record<string, unknown>).sourceRef === 'string' &&
        typeof (e as Record<string, unknown>).note === 'string'
      )
      .map((e) => ({
        sourceRef: e.sourceRef,
        note: e.note.slice(0, MAX_EVIDENCE_NOTE_CHARS),
      }))
      .slice(0, MAX_EVIDENCE_ENTRIES);
  }

  /**
   * PRI-844: extract the Owner's verbatim correction from persisted
   * diagnosticJson. Pass-through — the 2000-char defensive bound was already
   * applied by the writer (buildDiagnosticJson); no second truncation here so
   * there is exactly one storage bound. Undefined for legacy rows that
   * predate the field (Case D) — callers treat absence as "no correction
   * evidence available", never as license to fabricate one.
   */
  private static extractCorrectionEvidence(parsed: Record<string, unknown>): PainCorrectionEvidence | undefined {
    if (!Object.hasOwn(parsed, 'correctionEvidence')) return undefined;
    const raw = parsed.correctionEvidence;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.text !== 'string' || obj.text.length === 0) return undefined;
    const num = (v: unknown): number | undefined =>
      // PRI-844 review fix (P2): the schema declares Type.Integer — accept
      // only integers here so a fractional persisted identifier is omitted
      // (graceful degradation) instead of failing the whole payload
      // validation and aborting the diagnosis.
      typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v : undefined;
    return {
      text: obj.text,
      sessionId: str(obj.sessionId),
      turnIndex: num(obj.turnIndex),
      referencesAssistantTurnId: num(obj.referencesAssistantTurnId),
      occurredAt: str(obj.occurredAt),
      // PRI-1283 review round 2 (directive B): the classification/channel are
      // PROVENANCE the writer persists (PainCorrectionEvidenceSchema) — the
      // explicit Owner-submission channels decide whether a correction is an
      // Owner act that survives a consent revocation. Dropping them here made
      // every correction fall back to task-host attribution (mis-withheld).
      ...(obj.classification === 'owner_statement' ? { classification: 'owner_statement' as const } : {}),
      ...(typeof obj.channel === 'string' && obj.channel.length > 0 ? { channel: obj.channel as PainCorrectionEvidence['channel'] } : {}),
      // PRI-1283 round 3: carry the bound Owner confirmation record through so
      // the shared owner_manual judgment can verify agent-assisted statements.
      ...(typeof obj.ownerConfirmation === 'object' && obj.ownerConfirmation !== null && !Array.isArray(obj.ownerConfirmation)
        ? { ownerConfirmation: obj.ownerConfirmation as PainCorrectionEvidence['ownerConfirmation'] }
        : {}),
    };
  }

  /**
   * Reconstruct a DiagnosticianTaskRecord from a base TaskRecord by decoding
   * the diagnostic_json column (if present).
   */
  private static reconstructDiagnosticianRecord(
    task: TaskRecord,
    ambiguityNotes: string[],
  ): DiagnosticianTaskRecord {
    const base = task as TaskRecord & { workspaceDir?: string };
    let extra: Partial<DiagnosticianTaskRecord> = {};

    if (base.diagnosticJson) {
      try {
        const parsed: unknown = JSON.parse(base.diagnosticJson);
        if (isRecord(parsed)) {
          // SPEC §11 / TD §6.2: the anchor is only usable when it is a
          // well-formed {type, ref}; anything else is UNKNOWN, never coerced.
          const rawAnchor = Object.hasOwn(parsed, 'anchor') ? parsed.anchor : undefined;
          const anchor = parsePainAnchor(rawAnchor);
          if (rawAnchor !== undefined && rawAnchor !== null && anchor === undefined) {
            ambiguityNotes.push(
              `diagnosticJson for task ${task.taskId} carries an unreadable anchor; the anchor is treated as unknown`,
            );
          }
          extra = {
            sourcePainId: SqliteContextAssembler.extractStringField(parsed, 'sourcePainId'),
            reasonSummary: SqliteContextAssembler.extractStringField(parsed, 'reasonSummary'),
            source: SqliteContextAssembler.extractStringField(parsed, 'source'),
            severity: SqliteContextAssembler.extractStringField(parsed, 'severity'),
            sessionIdHint: SqliteContextAssembler.extractStringField(parsed, 'sessionIdHint'),
            agentIdHint: SqliteContextAssembler.extractStringField(parsed, 'agentIdHint'),
            workspaceDir: SqliteContextAssembler.extractStringField(parsed, 'workspaceDir'),
            // PRI-1274 (B1 / P1-3): the verified submission/target turn ids —
            // read-only pointers into painIngress.verifiedHostSession; a
            // malformed block degrades to absence (session-level policy),
            // never to a guessed turn.
            ...SqliteContextAssembler.extractVerifiedTurnIds(parsed),
            anchor,
            provenance: Object.hasOwn(parsed, 'provenance') && (isPainProvenance(parsed.provenance) || parsed.provenance === 'openclaw_context_bound')
              ? (isPainProvenance(parsed.provenance) ? parsed.provenance : 'host_context_bound')
              : undefined,
            hostKind: resolveDiagnosticianHostKind(SqliteContextAssembler.extractStringField(parsed, 'hostKind')),
            provenanceReason: SqliteContextAssembler.extractStringField(parsed, 'provenanceReason'),
            evidence: SqliteContextAssembler.extractEvidence(parsed),
            correctionEvidence: SqliteContextAssembler.extractCorrectionEvidence(parsed),
          };
        } else {
          ambiguityNotes.push(
            `diagnosticJson for task ${task.taskId} parsed to non-object (${Array.isArray(parsed) ? 'array' : typeof parsed}); evidence fields unavailable`,
          );
        }
      } catch (parseErr) {
        ambiguityNotes.push(
          `diagnosticJson for task ${task.taskId} is malformed JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}; evidence fields unavailable`,
        );
      }
    }

    return {
      ...base,
      taskKind: 'diagnostician',
      workspaceDir: base.workspaceDir ?? (extra).workspaceDir ?? '<unknown>',
      reasonSummary: extra.reasonSummary ?? (base as DiagnosticianTaskRecord).reasonSummary ?? '',
      source: extra.source ?? (base as DiagnosticianTaskRecord).source,
      severity: extra.severity ?? (base as DiagnosticianTaskRecord).severity,
      sourcePainId: extra.sourcePainId ?? (base as DiagnosticianTaskRecord).sourcePainId,
      anchor: extra.anchor,
      sessionIdHint: extra.sessionIdHint ?? (base as DiagnosticianTaskRecord).sessionIdHint,
      agentIdHint: extra.agentIdHint ?? (base as DiagnosticianTaskRecord).agentIdHint,
      provenance: extra.provenance,
      hostKind: extra.hostKind,
      provenanceReason: extra.provenanceReason,
      evidence: extra.evidence,
      correctionEvidence: extra.correctionEvidence,
      submissionTurnId: extra.submissionTurnId,
      targetTurnId: extra.targetTurnId,
    };
  }

  /**
   * PRI-1274 (B1 / P1-3): read the verified submission/target turn ids from
   * `painIngress.verifiedHostSession`. Strictly guarded — a malformed block
   * yields neither id (the diagnosis then stays on session-level policy
   * rather than reading a guessed turn).
   */
  private static extractVerifiedTurnIds(parsed: Record<string, unknown>): { submissionTurnId?: string; targetTurnId?: string } {
    const {painIngress} = parsed;
    if (!isRecord(painIngress)) return {};
    const verified = painIngress.verifiedHostSession;
    if (!isRecord(verified) || verified.status !== 'verified') return {};
    const submissionTurnId = typeof verified.submissionTurnId === 'string' && verified.submissionTurnId.length > 0
      ? verified.submissionTurnId
      : undefined;
    const targetTurnId = typeof verified.targetTurnId === 'string' && verified.targetTurnId.length > 0
      ? verified.targetTurnId
      : undefined;
    return {
      ...(submissionTurnId === undefined ? {} : { submissionTurnId }),
      ...(targetTurnId === undefined ? {} : { targetTurnId }),
    };
  }
}
