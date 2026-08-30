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
  DiagnosticianContextPayloadSchema,
  validateFullTracePayload,
  sanitizeFullTracePayload,
  buildFullTraceTimeline,
  buildSourceRefs,
} from '../../context-payload.js';
import type { HistoryQueryEntry } from '../../context-payload.js';
import type { TaskRecord, DiagnosticianTaskRecord } from '../../task-status.js';
import type { RunRecord } from '../../runtime-protocol.js';
import { PDRuntimeError } from '../../error-categories.js';
import { MAX_EVIDENCE_ENTRIES, MAX_EVIDENCE_NOTE_CHARS } from '../../pain-signal-bridge.js';
import { sanitizeString } from '../../evidence-sanitizer.js';

const PAIN_PROVENANCE_VALUES = ['host_context_bound', 'owner_reported_no_host_trace', 'automatic_hook'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPainProvenance(value: unknown): value is (typeof PAIN_PROVENANCE_VALUES)[number] {
  return typeof value === 'string' && (PAIN_PROVENANCE_VALUES as readonly string[]).includes(value);
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

// ── SqliteContextAssembler ──

export class SqliteContextAssembler implements ContextAssembler {
  // eslint-disable-next-line @typescript-eslint/max-params
  constructor(
    private readonly taskStore: TaskStore,
    private readonly historyQuery: HistoryQuery,
    private readonly runStore: RunStore,
    options?: { sourceTraceLocator?: SourceTraceLocator; trajectoryTurnReader?: TrajectoryTurnReader },
  ) {
    this.sourceTraceLocator = options?.sourceTraceLocator;
    this.trajectoryTurnReader = options?.trajectoryTurnReader;
  }

  private readonly sourceTraceLocator?: SourceTraceLocator;
  private readonly trajectoryTurnReader?: TrajectoryTurnReader;

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
      sessionIdHint: dt.sessionIdHint || undefined,
      provenance: normalizedProvenance(dt) || undefined,
      hostKind: dt.hostKind,
      provenanceReason: dt.provenanceReason || undefined,
      evidence: dt.evidence,
    };

    const convAmbiguityNotes = SqliteContextAssembler.buildAmbiguityNotes(
      taskId,
      historyResult.entries,
      historyResult.truncated,
    );
    if (convAmbiguityNotes) {
      ambiguityNotes.push(...convAmbiguityNotes);
    }

    // PRI-350: Fallback to TrajectoryDB when historyQuery is empty
    if (conversationEntries.length === 0 && dt.sessionIdHint && dt.workspaceDir !== '<unknown>' && this.trajectoryTurnReader) {
      const trajectoryEntries = this.readTrajectoryTurns(dt.sessionIdHint, ambiguityNotes);
      if (trajectoryEntries.length > 0) {
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

    const evidenceSourceRefs = dt.evidence?.map(e => e.sourceRef) ?? [];

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
   */
  private readTrajectoryTurns(sessionId: string, ambiguityNotes: string[]): HistoryQueryEntry[] {
    const reader = this.trajectoryTurnReader;
    // Caller guarantees reader is defined; guard for type safety
    if (!reader) return [];

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
          extra = {
            sourcePainId: SqliteContextAssembler.extractStringField(parsed, 'sourcePainId'),
            reasonSummary: SqliteContextAssembler.extractStringField(parsed, 'reasonSummary'),
            source: SqliteContextAssembler.extractStringField(parsed, 'source'),
            severity: SqliteContextAssembler.extractStringField(parsed, 'severity'),
            sessionIdHint: SqliteContextAssembler.extractStringField(parsed, 'sessionIdHint'),
            agentIdHint: SqliteContextAssembler.extractStringField(parsed, 'agentIdHint'),
            workspaceDir: SqliteContextAssembler.extractStringField(parsed, 'workspaceDir'),
            provenance: Object.hasOwn(parsed, 'provenance') && (isPainProvenance(parsed.provenance) || parsed.provenance === 'openclaw_context_bound')
              ? (isPainProvenance(parsed.provenance) ? parsed.provenance : 'host_context_bound')
              : undefined,
            hostKind: SqliteContextAssembler.extractStringField(parsed, 'hostKind') === 'openclaw'
              || SqliteContextAssembler.extractStringField(parsed, 'hostKind') === 'codex'
              ? SqliteContextAssembler.extractStringField(parsed, 'hostKind') as 'openclaw' | 'codex'
              : undefined,
            provenanceReason: SqliteContextAssembler.extractStringField(parsed, 'provenanceReason'),
            evidence: SqliteContextAssembler.extractEvidence(parsed),
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
      sessionIdHint: extra.sessionIdHint ?? (base as DiagnosticianTaskRecord).sessionIdHint,
      agentIdHint: extra.agentIdHint ?? (base as DiagnosticianTaskRecord).agentIdHint,
      provenance: extra.provenance,
      hostKind: extra.hostKind,
      provenanceReason: extra.provenanceReason,
      evidence: extra.evidence,
    };
  }
}
