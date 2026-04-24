import type { ContextAssembler } from './context-assembler.js';
import type { StoreEventEmitter } from './event-emitter.js';
import { type DiagnosticianContextPayload } from '../context-payload.js';
export declare class ResilientContextAssembler implements ContextAssembler {
    private readonly inner;
    private readonly emitter;
    constructor(inner: ContextAssembler, emitter: StoreEventEmitter);
    assemble(taskId: string): Promise<DiagnosticianContextPayload>;
    private emitDegradation;
    private static buildDegradedPayload;
    private static extractCategory;
}
//# sourceMappingURL=resilient-context-assembler.d.ts.map