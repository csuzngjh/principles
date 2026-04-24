import { type TrajectoryLocateQuery, type TrajectoryLocateResult } from '../context-payload.js';
import type { SqliteConnection } from './sqlite-connection.js';
import type { TrajectoryLocator } from './trajectory-locator.js';
export declare class SqliteTrajectoryLocator implements TrajectoryLocator {
    private readonly connection;
    constructor(connection: SqliteConnection);
    locate(query: TrajectoryLocateQuery): Promise<TrajectoryLocateResult>;
    private routeQuery;
    /**
     * Locate trajectory by painId.
     *
     * NOTE: Despite the name, this implementation treats `painId` as a run_id
     * alias and queries the runs table directly. This is a pragmatic choice —
     * callers pass `run_id` values when they have no better reference.
     *
     * If a true pain-signal → task lookup is needed, the query should be
     * against tasks.diagnostic_json (SQLite JSON path extraction) instead.
     */
    private locateByPainId;
    private locateByTaskId;
    private locateByRunId;
    private locateByTimeRange;
    private locateBySessionHint;
    private locateByExecutionStatus;
}
//# sourceMappingURL=sqlite-trajectory-locator.d.ts.map