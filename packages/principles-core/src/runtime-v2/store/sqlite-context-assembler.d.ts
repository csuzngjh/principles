import type { TaskStore } from './task-store.js';
import type { RunStore } from './run-store.js';
import type { HistoryQuery } from './history-query.js';
import type { ContextAssembler } from './context-assembler.js';
import { type DiagnosticianContextPayload } from '../context-payload.js';
export declare class SqliteContextAssembler implements ContextAssembler {
    private readonly taskStore;
    private readonly historyQuery;
    private readonly runStore;
    constructor(taskStore: TaskStore, historyQuery: HistoryQuery, runStore: RunStore);
    assemble(taskId: string): Promise<DiagnosticianContextPayload>;
    private static buildAmbiguityNotes;
    /**
     * Reconstruct a DiagnosticianTaskRecord from a base TaskRecord by decoding
     * the diagnostic_json column (if present).
     *
     * The base TaskRecord from SqliteTaskStore carries diagnostic_json as an
     * untyped string column. This method decodes it and overlays the fields
     * onto the base record to produce a full DiagnosticianTaskRecord.
     */
    private static reconstructDiagnosticianRecord;
}
//# sourceMappingURL=sqlite-context-assembler.d.ts.map