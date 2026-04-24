import { EventEmitter } from 'events';
import { type TelemetryEvent } from '../../telemetry-event.js';
/**
 * Typed event emitter for M2 store state transitions.
 * Wraps Node's EventEmitter with TelemetryEvent validation.
 */
export declare class StoreEventEmitter extends EventEmitter {
    /**
     * Emit a telemetry event after validating it conforms to TelemetryEventSchema.
     * Validation failures are caught internally and emit a fallback event instead.
     * This method never throws — callers can rely on it completing.
     */
    emitTelemetry(event: TelemetryEvent): true;
    onTelemetry(handler: (event: TelemetryEvent) => void): void;
    onEventType(eventType: string, handler: (event: TelemetryEvent) => void): void;
}
export declare const storeEmitter: StoreEventEmitter;
//# sourceMappingURL=event-emitter.d.ts.map