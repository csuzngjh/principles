import { EventEmitter } from 'events';
import { validateTelemetryEvent, type TelemetryEvent } from '../../telemetry-event.js';

/**
 * Typed event emitter for M2 store state transitions.
 * Wraps Node's EventEmitter with TelemetryEvent validation.
 */
export class StoreEventEmitter extends EventEmitter {
  /**
   * Emit a telemetry event after validating it conforms to TelemetryEventSchema.
   * Throws if validation fails — callers must ensure event shape is correct.
   */
  emitTelemetry(event: TelemetryEvent): true {
    const result = validateTelemetryEvent(event);
    if (!result.valid || !result.event) {
      throw new Error(`[StoreEventEmitter] Invalid telemetry event: ${JSON.stringify(result.errors)}`);
    }
    const validEvent = result.event;
    this.emit('telemetry', validEvent);
    this.emit(validEvent.eventType, validEvent);
    return true;
  }

  onTelemetry(handler: (event: TelemetryEvent) => void): void {
    this.on('telemetry', handler);
  }

  onEventType(eventType: string, handler: (event: TelemetryEvent) => void): void {
    this.on(eventType, handler);
  }
}

export const storeEmitter = new StoreEventEmitter();
