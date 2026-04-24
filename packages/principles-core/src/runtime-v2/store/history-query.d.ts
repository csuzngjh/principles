/**
 * HistoryQuery -- abstract interface for bounded history query operations.
 *
 * Given a trajectoryRef (taskId), retrieves bounded history entries from
 * run records with cursor-based pagination and time-window scoping.
 *
 * Each RunRecord maps to 2 HistoryQueryEntry items:
 *   - Entry 1: role='system', text=inputPayload, ts=startedAt
 *   - Entry 2: role='assistant', text=outputPayload, ts=startedAt (or endedAt)
 *
 * Caller uses TrajectoryLocator first to get trajectoryRef, then passes
 * it to HistoryQuery for detailed history retrieval.
 *
 * All history query operations go through this interface, enabling
 * swap between SQLite (default) and test doubles.
 */
import type { HistoryQueryResult } from '../context-payload.js';
/** Internal structure of the opaque cursor (encoded as base64 JSON). */
export interface HistoryQueryCursorData {
    /** The taskId (trajectoryRef) this cursor belongs to. */
    taskId: string;
    /** The run_id of the last entry returned -- used for keyset pagination. */
    lastRunId: string;
    /** Pagination direction. */
    direction: 'forward' | 'backward';
}
/** Options for customizing history query behavior. */
export interface HistoryQueryOptions {
    /** Maximum entries to return. Default: 50, Hard max: 200. */
    limit?: number;
    /** Time window start (ISO 8601). Default: now - 24h. */
    timeWindowStart?: string;
    /** Time window end (ISO 8601). Default: now. */
    timeWindowEnd?: string;
}
/** Default page size for history queries. */
export declare const DEFAULT_HISTORY_PAGE_SIZE = 50;
/** Hard maximum entries per query -- prevents unbounded queries. */
export declare const MAX_HISTORY_PAGE_SIZE = 200;
/** Default time window lookback in milliseconds (24 hours). */
export declare const DEFAULT_TIME_WINDOW_MS: number;
export interface HistoryQuery {
    /**
     * Query bounded history entries for a trajectory.
     *
     * @param trajectoryRef - The taskId identifying the trajectory (from TrajectoryLocator)
     * @param cursor - Opaque cursor string from a previous query result (optional)
     * @param options - Query options: limit, time window (optional)
     * @returns HistoryQueryResult with entries, truncated flag, and optional nextCursor
     *
     * No runs for trajectoryRef -> returns { sourceRef, entries: [], truncated: false }.
     * Malformed cursor -> throws PDRuntimeError(invalid_input).
     * Never throws for data-not-found conditions.
     */
    query(trajectoryRef: string, cursor?: string, options?: HistoryQueryOptions): Promise<HistoryQueryResult>;
}
//# sourceMappingURL=history-query.d.ts.map