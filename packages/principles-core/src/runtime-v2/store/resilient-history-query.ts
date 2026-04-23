/**
 * ResilientHistoryQuery — never-throws wrapper for cursor errors.
 *
 * Delegates to inner HistoryQuery. When a cursor-based query throws
 * (invalid/deleted cursor), silently falls back to the first page and
 * emits degradation_triggered telemetry.
 *
 * Non-cursor queries pass through unchanged (already graceful).
 */
import type { HistoryQuery, HistoryQueryOptions } from './history-query.js';
import type { HistoryQueryResult } from '../context-payload.js';
import type { StoreEventEmitter } from './event-emitter.js';

export class ResilientHistoryQuery implements HistoryQuery {
  constructor(
    private readonly inner: HistoryQuery,
    private readonly emitter: StoreEventEmitter,
  ) {}

  async query(
    trajectoryRef: string,
    cursor?: string,
    options?: HistoryQueryOptions,
  ): Promise<HistoryQueryResult> {
    if (cursor) {
      try {
        return await this.inner.query(trajectoryRef, cursor, options);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.emitDegradation(errorMessage);
        try {
          return await this.inner.query(trajectoryRef, undefined, options);
        } catch {
          return { sourceRef: trajectoryRef, entries: [], truncated: false };
        }
      }
    }
    return this.inner.query(trajectoryRef, undefined, options);
  }

  private emitDegradation(trigger: string): void {
    this.emitter.emitTelemetry({
      eventType: 'degradation_triggered',
      traceId: `degradation-${Date.now()}`,
      timestamp: new Date().toISOString(),
      sessionId: '',
      payload: {
        component: 'HistoryQuery',
        trigger,
        fallback: 'first_page_fallback',
        severity: 'warning',
      },
    });
  }
}
