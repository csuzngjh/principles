import { type HistoryQueryResult } from '../context-payload.js';
import type { SqliteConnection } from './sqlite-connection.js';
import type { HistoryQuery, HistoryQueryOptions } from './history-query.js';
export declare class SqliteHistoryQuery implements HistoryQuery {
    private readonly connection;
    constructor(connection: SqliteConnection);
    query(trajectoryRef: string, cursor?: string, options?: HistoryQueryOptions): Promise<HistoryQueryResult>;
    private executeQuery;
    private queryFirstPage;
    private queryWithCursor;
    private getRunStartedAt;
    private static decodeCursor;
    private static buildCursor;
    /**
     * Format a payload string for display.
     *
     * If the payload looks like a JSON object or array, pretty-print it
     * so display consumers can render structured content. Plain strings
     * are passed through unchanged.
     */
    private static formatPayload;
    private static mapRunToEntries;
}
//# sourceMappingURL=sqlite-history-query.d.ts.map