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
import {
  type DiagnosticianContextPayload,
  type DiagnosisTarget,
  type FullTracePayload,
  type ToolCallEntry,
  type PainContext,
  DiagnosticianContextPayloadSchema,
} from '../../context-payload.js';
import type { TaskRecord, DiagnosticianTaskRecord } from '../../task-status.js';
import type { RunRecord } from '../../runtime-protocol.js';
import { PDRuntimeError } from '../../error-categories.js';

// ── PII Sanitizer (PRI-171) ──

const SECRET_KEY_NAMES = ['apikey', 'api_key', 'token', 'authorization', 'password', 'secret', 'bearer'];

function sanitizeString(input: string): string {
  return input
    .replace(/\bapi[_-]?key\s*[:=]\s*\S+/gi, (m) => m.replace(/\S+$/, '[REDACTED]'))
    .replace(/\bapi[_-]?key["']?\s*:\s*["'][^"']*["']/gi, (m) => {
      const i = m.indexOf(':');
      return m.slice(0, i + 1) + '"[REDACTED]"';
    })
    .replace(/\btoken\s*[:=]\s*\S+/gi, (m) => m.replace(/\S+$/, '[REDACTED]'))
    .replace(/\btoken["']?\s*:\s*["'][^"']*["']/gi, (m) => {
      const i = m.indexOf(':');
      return m.slice(0, i + 1) + '"[REDACTED]"';
    })
    .replace(/\bauthorization\s*[:=]\s*\S+/gi, (m) => m.replace(/\S+$/, '[REDACTED]'))
    .replace(/\bauthorization["']?\s*:\s*["'][^"']*["']/gi, (m) => {
      const i = m.indexOf(':');
      return m.slice(0, i + 1) + '"[REDACTED]"';
    })
    .replace(/\bpassword\s*[:=]\s*\S+/gi, (m) => m.replace(/\S+$/, '[REDACTED]'))
    .replace(/\bpassword["']?\s*:\s*["'][^"']*["']/gi, (m) => {
      const i = m.indexOf(':');
      return m.slice(0, i + 1) + '"[REDACTED]"';
    })
    .replace(/\bsecret\s*[:=]\s*\S+/gi, (m) => m.replace(/\S+$/, '[REDACTED]'))
    .replace(/\bsecret["']?\s*:\s*["'][^"']*["']/gi, (m) => {
      const i = m.indexOf(':');
      return m.slice(0, i + 1) + '"[REDACTED]"';
    })
    .replace(/\bbearer\s+\S+/gi, (m) => m.replace(/\S+$/, '[REDACTED]'));
}

function sanitizeObject(obj: unknown): unknown {
  if (typeof obj === 'string') return sanitizeString(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const keyLower = key.toLowerCase();
      if (SECRET_KEY_NAMES.some(p => keyLower.includes(p))) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = sanitizeObject(value);
      }
    }
    return result;
  }
  return obj;
}

function sanitizePii(input: string): string {
  return sanitizeString(input);
}

function sanitizeJsonOrString(value: unknown): string {
  if (typeof value === 'string') return sanitizePii(value);
  return JSON.stringify(sanitizeObject(value));
}

function tryParseJson(input: string | undefined): Record<string, unknown> | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// ── SqliteContextAssembler ──

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

    const runs = await this.runStore.listRunsByTask(taskId);
    const runIds = runs.map((r) => r.runId);

    // Use the earliest run's startedAt as time window start so that all runs,
    // including imported openclaw-history runs that predate the task creation,
    // are included in the conversation window. Without an explicit lower bound,
    // the default 24-hour window would filter out all historical runs.
    const firstRunStartedAt = runs[0]?.startedAt;
    const earliestStart = firstRunStartedAt !== undefined
      ? runs.reduce((earliest, r) => r.startedAt < earliest ? r.startedAt : earliest, firstRunStartedAt)
      : task.createdAt;

    const historyResult = await this.historyQuery.query(taskId, undefined, {
      timeWindowStart: earliestStart,
    });

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

    // Build fullTrace when painId (sourcePainId) is available (PRI-171)
    const fullTrace: FullTracePayload | null = dt.sourcePainId
      ? SqliteContextAssembler.buildFullTraceSafe(dt, runs)
      : null;

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

  private static buildFullTraceSafe(
    dt: DiagnosticianTaskRecord,
    runs: readonly RunRecord[],
  ): FullTracePayload | null {
    try {
      return SqliteContextAssembler.buildFullTrace(dt, runs);
    } catch {
      return null;
    }
  }

  private static buildFullTrace(
    dt: DiagnosticianTaskRecord,
    runs: readonly RunRecord[],
  ): FullTracePayload {
    const painContext: PainContext = {
      painId: dt.sourcePainId || undefined,
      severity: dt.severity || undefined,
      source: dt.source || undefined,
      reasonSummary: dt.reasonSummary || undefined,
      sessionIdHint: dt.sessionIdHint || undefined,
    };

    const scratchpad: string[] = [];
    const toolCallHistory: ToolCallEntry[] = [];

    for (const run of runs) {
      SqliteContextAssembler.extractScratchpadLines(run.inputPayload, scratchpad);
      SqliteContextAssembler.extractScratchpadLines(run.outputPayload, scratchpad);
      SqliteContextAssembler.extractToolCalls({
        inputPayload: run.inputPayload,
        outputPayload: run.outputPayload,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        executionStatus: run.executionStatus,
        accumulator: toolCallHistory,
      });
    }

    return {
      painContext,
      scratchpad,
      toolCallHistory,
    };
  }

  private static extractScratchpadLines(
    payload: string | undefined,
    accumulator: string[],
  ): void {
    if (!payload) return;

    const trimmed = payload.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) {
          // Extract thinking/scratchpad/reasoning fields
          const thinking = parsed.thinking ?? parsed.scratchpad ?? parsed.reasoning;
          if (typeof thinking === 'string' && thinking.length > 0) {
            accumulator.push(sanitizePii(thinking));
          } else if (Array.isArray(thinking)) {
            for (const item of thinking) {
              if (typeof item === 'string') accumulator.push(sanitizePii(item));
            }
          }
          // Extract user turn text
          if (Array.isArray(parsed.userTurns)) {
            for (const turn of parsed.userTurns) {
              if (turn && typeof turn === 'object' && typeof turn.text === 'string') {
                accumulator.push(sanitizePii(turn.text));
              }
            }
          }
          // Extract assistant turn text
          if (Array.isArray(parsed.turns)) {
            for (const turn of parsed.turns) {
              if (turn && typeof turn === 'object' && typeof turn.text === 'string') {
                accumulator.push(sanitizePii(turn.text));
              }
            }
          }
        }
      } catch {
        // Not valid JSON -- add as plain text
        if (trimmed.length > 0) accumulator.push(sanitizePii(trimmed));
      }
    } else if (trimmed.length > 0) {
      accumulator.push(sanitizePii(trimmed));
    }
  }

  private static extractToolCalls(opts: {
    inputPayload: string | undefined;
    outputPayload: string | undefined;
    startedAt: string;
    endedAt: string | undefined;
    executionStatus: string;
    accumulator: ToolCallEntry[];
  }): void {
    const inputParsed = tryParseJson(opts.inputPayload);
    const outputParsed = tryParseJson(opts.outputPayload);

    // Extract from toolCalls array if present
    const toolCalls = inputParsed?.toolCalls ?? outputParsed?.toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (typeof tc !== 'object' || tc === null) continue;
        opts.accumulator.push({
          toolName: typeof tc.toolName === 'string' ? tc.toolName : typeof tc.name === 'string' ? tc.name : undefined,
          status: typeof tc.status === 'string' ? tc.status : undefined,
          params: tc.params ? sanitizeJsonOrString(tc.params) : undefined,
          resultSummary: tc.result ? sanitizeJsonOrString(tc.result) : undefined,
          errorSummary: tc.error ? sanitizeJsonOrString(tc.error) : undefined,
          startedAt: opts.startedAt,
          completedAt: opts.endedAt ?? opts.startedAt,
        });
      }
    } else if (inputParsed) {
      // No explicit toolCalls array -- synthesize from single toolName if present
      const toolName = inputParsed.toolName ?? inputParsed.name;
      if (typeof toolName === 'string') {
        opts.accumulator.push({
          toolName,
          status: opts.executionStatus === 'succeeded' ? 'succeeded' : opts.executionStatus === 'failed' ? 'failed' : undefined,
          params: inputParsed.params ? sanitizeJsonOrString(inputParsed.params) : undefined,
          resultSummary: opts.outputPayload ? sanitizePii(opts.outputPayload.length > 500 ? opts.outputPayload.slice(0, 500) + '...[truncated]' : opts.outputPayload) : undefined,
          errorSummary: opts.executionStatus === 'failed' && outputParsed?.error ? sanitizePii(String(outputParsed.error)) : undefined,
          startedAt: opts.startedAt,
          completedAt: opts.endedAt ?? opts.startedAt,
        });
      }
    }
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
   */
  private static reconstructDiagnosticianRecord(task: TaskRecord): DiagnosticianTaskRecord {
    const base = task as TaskRecord & { workspaceDir?: string };
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
      workspaceDir: base.workspaceDir ?? (extra).workspaceDir ?? '<unknown>',
      reasonSummary: extra.reasonSummary ?? (base as DiagnosticianTaskRecord).reasonSummary ?? '',
      source: extra.source ?? (base as DiagnosticianTaskRecord).source,
      severity: extra.severity ?? (base as DiagnosticianTaskRecord).severity,
      sourcePainId: extra.sourcePainId ?? (base as DiagnosticianTaskRecord).sourcePainId,
      sessionIdHint: extra.sessionIdHint ?? (base as DiagnosticianTaskRecord).sessionIdHint,
      agentIdHint: extra.agentIdHint ?? (base as DiagnosticianTaskRecord).agentIdHint,
    };
  }
}