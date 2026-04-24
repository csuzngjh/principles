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
export declare class ResilientHistoryQuery implements HistoryQuery {
    private readonly inner;
    private readonly emitter;
    constructor(inner: HistoryQuery, emitter: StoreEventEmitter);
    query(trajectoryRef: string, cursor?: string, options?: HistoryQueryOptions): Promise<HistoryQueryResult>;
    private emitDegradation;
}
//# sourceMappingURL=resilient-history-query.d.ts.map