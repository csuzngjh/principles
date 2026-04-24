/**
 * ContextAssembler -- abstract interface for context assembly operations.
 * Composes TaskStore + HistoryQuery + RunStore to assemble DiagnosticianContextPayload.
 */
import type { DiagnosticianContextPayload } from '../context-payload.js';
export interface ContextAssembler {
    /**
     * Assemble a DiagnosticianContextPayload for the given task.
     *
     * @param taskId - The task ID identifying the diagnostician task
     * @returns DiagnosticianContextPayload with assembled context
     *
     * Task not found -> throws PDRuntimeError(storage_unavailable).
     * Task is not diagnostician -> throws PDRuntimeError(input_invalid).
     * Empty history -> returns valid payload with empty conversationWindow.
     */
    assemble(taskId: string): Promise<DiagnosticianContextPayload>;
}
//# sourceMappingURL=context-assembler.d.ts.map