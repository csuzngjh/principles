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
    try {
      const result = validateTelemetryEvent(event);
      if (!result.valid || !result.event) {
        const fallbackEvent: TelemetryEvent = {
          eventType: 'degradation_triggered',
          traceId: `fallback-${Date.now()}`,
          timestamp: new Date().toISOString(),
          sessionId: '',
          payload: { component: 'StoreEventEmitter', trigger: 'invalid_event', fallback: 'dropped', severity: 'warning' },
        };
        this.emit('telemetry', fallbackEvent);
        this.emit(fallbackEvent.eventType, fallbackEvent);
        return true;
      }
      const validEvent = result.event;
      this.emit('telemetry', validEvent);
      this.emit(validEvent.eventType, validEvent);
      return true;
    } catch {
      return true;
    }
  }

  onTelemetry(handler: (event: TelemetryEvent) => void): void {
    this.on('telemetry', handler);
  }

  onEventType(eventType: string, handler: (event: TelemetryEvent) => void): void {
    this.on(eventType, handler);
  }
}

export const storeEmitter = new StoreEventEmitter();
