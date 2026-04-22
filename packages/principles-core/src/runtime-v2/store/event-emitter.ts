import { EventEmitter } from 'events';
import { validateTelemetryEvent, type TelemetryEvent } from '../../telemetry-event.js';

/**
 * Typed event emitter for M2 store state transitions.
 * Wraps Node's EventEmitter with TelemetryEvent validation.
 */
export class StoreEventEmitter extends EventEmitter {
  /**
   * Emit a telemetry event after validating it conforms to TelemetryEventSchema.
   * Returns true if the event was validated and emitted, false if validation failed.
   */
  emitTelemetry(event: TelemetryEvent): boolean {
    const result = validateTelemetryEvent(event);
    if (!result.valid) {
      console.error('[StoreEventEmitter] Invalid telemetry event:', result.errors);
      return false;
    }
    this.emit('telemetry', result.event);
    this.emit(result.event!.eventType, result.event!);
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
