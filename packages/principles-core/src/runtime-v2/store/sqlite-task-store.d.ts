import { type TaskRecord } from '../task-status.js';
import type { SqliteConnection } from './sqlite-connection.js';
import type { TaskStore, TaskStoreFilter, TaskStoreUpdatePatch } from './task-store.js';
export declare class SqliteTaskStore implements TaskStore {
    private readonly connection;
    constructor(connection: SqliteConnection);
    createTask(record: Omit<TaskRecord, 'createdAt' | 'updatedAt'> & {
        diagnosticJson?: string;
    }): Promise<TaskRecord>;
    getTask(taskId: string): Promise<TaskRecord | null>;
    updateTask(taskId: string, patch: TaskStoreUpdatePatch): Promise<TaskRecord>;
    listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]>;
    deleteTask(taskId: string): Promise<boolean>;
    private rowToRecord;
}
//# sourceMappingURL=sqlite-task-store.d.ts.map