/**
 * ResilientContextAssembler — never-throws wrapper around ContextAssembler.
 *
 * Catches all errors from the inner assembler and returns a degraded
 * DiagnosticianContextPayload that satisfies the schema. Emits
 * degradation_triggered telemetry for every fallback.
 *
 * Degraded payload markers:
 * - contextId: random UUID (like normal)
 * - contextHash: SHA-256 of "degraded" (deterministic sentinel)
 * - conversationWindow: []
 * - ambiguityNotes: error description + degradation message
 */
import { randomUUID, createHash } from 'node:crypto';
import type { ContextAssembler } from './context-assembler.js';
import type { StoreEventEmitter } from './event-emitter.js';
import {
  type DiagnosticianContextPayload,
} from '../context-payload.js';
import type { PDErrorCategory } from '../error-categories.js';

/** Options for emitting a degradation telemetry event. */
interface DegradationEmitOptions {
  component: string;
  trigger: string;
  fallback: string;
  severity: 'warning' | 'error';
}

export class ResilientContextAssembler implements ContextAssembler {
  constructor(
    private readonly inner: ContextAssembler,
    private readonly emitter: StoreEventEmitter,
  ) {}

  async assemble(taskId: string): Promise<DiagnosticianContextPayload> {
    try {
      return await this.inner.assemble(taskId);
    } catch (error) {
      return ResilientContextAssembler.buildDegradedPayload(taskId, error, (opts) => {
        this.emitDegradation(opts);
      });
    }
  }

  private emitDegradation(opts: DegradationEmitOptions): void {
    this.emitter.emitTelemetry({
      eventType: 'degradation_triggered',
      traceId: `degradation-${Date.now()}`,
      timestamp: new Date().toISOString(),
      sessionId: '',
      payload: { component: opts.component, trigger: opts.trigger, fallback: opts.fallback, severity: opts.severity },
    });
  }

  private static buildDegradedPayload(
    taskId: string,
    error: unknown,
    emit: (opts: DegradationEmitOptions) => void,
  ): DiagnosticianContextPayload {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const category = ResilientContextAssembler.extractCategory(error);

    const severity: 'warning' | 'error' = category === 'storage_unavailable' ? 'error' : 'warning';

    emit({ component: 'ContextAssembler', trigger: errorMessage, fallback: 'degraded_payload', severity });

    const contextId = randomUUID();
    const contextHash = createHash('sha256').update('degraded').digest('hex');

    const notes: string[] = [
      `Context assembly degraded: ${errorMessage}`,
      'Conversation window is empty; diagnostician should proceed with caution',
    ];

    return {
      contextId,
      contextHash,
      taskId,
      workspaceDir: '<unknown>',
      sourceRefs: [taskId],
      diagnosisTarget: {},
      conversationWindow: [],
      ambiguityNotes: notes,
    };
  }

  private static extractCategory(error: unknown): string {
    if (
      error !== null &&
      typeof error === 'object' &&
      'category' in error
    ) {
      return String((error as { category: PDErrorCategory }).category);
    }
    return 'unknown';
  }
}
