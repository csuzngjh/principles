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
import type { TaskStore } from './task-store.js';
import type { RunStore } from './run-store.js';
import type { HistoryQuery } from './history-query.js';
import type { ContextAssembler } from './context-assembler.js';
import {
  type DiagnosticianContextPayload,
  type DiagnosisTarget,
  DiagnosticianContextPayloadSchema,
} from '../context-payload.js';
import type { TaskRecord, DiagnosticianTaskRecord } from '../task-status.js';
import { PDRuntimeError } from '../error-categories.js';

export class SqliteContextAssembler implements ContextAssembler {
  constructor(
    private readonly taskStore: TaskStore,
    private readonly historyQuery: HistoryQuery,
    private readonly runStore: RunStore,
  ) {}

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

    const dt = SqliteContextAssembler.reconstructDiagnosticianRecord(task);

    const historyResult = await this.historyQuery.query(taskId);

    const runs = await this.runStore.listRunsByTask(taskId);
    const runIds = runs.map((r) => r.runId);

    const contextId = randomUUID();
    const serialized = JSON.stringify(historyResult.entries);
    const contextHash = createHash('sha256').update(serialized).digest('hex');

    const diagnosisTarget: DiagnosisTarget = {
      reasonSummary: dt.reasonSummary || undefined,
      source: dt.source || undefined,
      severity: dt.severity || undefined,
      painId: dt.sourcePainId || undefined,
      sessionIdHint: dt.sessionIdHint || undefined,
    };

    const ambiguityNotes = SqliteContextAssembler.buildAmbiguityNotes(
      taskId,
      historyResult.entries,
      historyResult.truncated,
    );

    const payload: DiagnosticianContextPayload = {
      contextId,
      contextHash,
      taskId,
      workspaceDir: dt.workspaceDir,
      sourceRefs: [taskId, ...runIds],
      diagnosisTarget,
      conversationWindow: historyResult.entries,
      ambiguityNotes,
    };

    if (!Value.Check(DiagnosticianContextPayloadSchema, payload)) {
      throw new PDRuntimeError(
        'storage_unavailable',
        'Context payload schema validation failed',
      );
    }

    return payload;
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
   * Reconstruct a DiagnosticianTaskRecord from a base TaskRecord by decoding
   * the diagnostic_json column (if present).
   *
   * The base TaskRecord from SqliteTaskStore carries diagnostic_json as an
   * untyped string column. This method decodes it and overlays the fields
   * onto the base record to produce a full DiagnosticianTaskRecord.
   */
  private static reconstructDiagnosticianRecord(task: TaskRecord): DiagnosticianTaskRecord {
    const base = task as TaskRecord & { diagnosticJson?: string };
    let extra: Partial<DiagnosticianTaskRecord> = {};

    if (base.diagnosticJson) {
      try {
        extra = JSON.parse(base.diagnosticJson) as Partial<DiagnosticianTaskRecord>;
      } catch {
        // Malformed JSON — ignore, return base as plain record
      }
    }

    return {
      ...base,
      taskKind: 'diagnostician',
      workspaceDir: (extra).workspaceDir ?? '<unknown>',
      reasonSummary: extra.reasonSummary ?? '',
      source: extra.source,
      severity: extra.severity,
      sourcePainId: extra.sourcePainId,
      sessionIdHint: extra.sessionIdHint,
      agentIdHint: extra.agentIdHint,
    };
  }
}
