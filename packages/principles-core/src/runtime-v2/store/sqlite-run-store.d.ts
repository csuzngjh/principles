import { type RunRecord } from '../runtime-protocol.js';
import type { SqliteConnection } from './sqlite-connection.js';
import type { RunStore } from './run-store.js';
export declare class SqliteRunStore implements RunStore {
    private readonly connection;
    constructor(connection: SqliteConnection);
    createRun(record: Omit<RunRecord, 'createdAt' | 'updatedAt'>): Promise<RunRecord>;
    getRun(runId: string): Promise<RunRecord | null>;
    updateRun(runId: string, patch: Partial<Pick<RunRecord, 'endedAt' | 'reason' | 'outputRef' | 'outputPayload' | 'errorCategory' | 'executionStatus'>>): Promise<RunRecord>;
    listRunsByTask(taskId: string): Promise<RunRecord[]>;
    deleteRun(runId: string): Promise<boolean>;
    private static rowToRecord;
}
//# sourceMappingURL=sqlite-run-store.d.ts.map