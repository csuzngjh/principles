import { EventEmitter } from 'events';
import { validateTelemetryEvent, type TelemetryEvent } from '../../telemetry-event.js';

/**
 * Typed event emitter for M2 store state transitions.
 * Wraps Node's EventEmitter with TelemetryEvent validation.
 */
export class StoreEventEmitter extends EventEmitter {
  /**
   * Emit a telemetry event after validating it conforms to TelemetryEventSchema.
   * Validation failures are caught internally and emit a fallback event instead.
   * This method never throws — callers can rely on it completing.
   */
  emitTelemetry(event: TelemetryEvent): true {
    // Narrow try scope to validation only; emit calls must propagate errors
    let validEvent: TelemetryEvent | undefined;
    try {
      const result = validateTelemetryEvent(event);
      if (!result.valid || !result.event) {
        validEvent = undefined;
      } else {
        validEvent = result.event;
      }
    } catch (validationError) {
      // Validation failed — emit fallback event with error context
      const fallbackEvent: TelemetryEvent = {
        eventType: 'degradation_triggered',
        traceId: event?.traceId ? `fallback-${event.traceId}` : `fallback-${Date.now()}`,
        timestamp: new Date().toISOString(),
        sessionId: event?.sessionId ?? '',
        payload: {
          component: 'StoreEventEmitter',
          trigger: 'invalid_event',
          fallback: 'dropped',
          severity: 'warning',
          errors: [String(validationError)],
          originalEventType: event?.eventType ?? 'unknown',
          originalTraceId: event?.traceId ?? 'unknown',
        },
      };
      this.emit('telemetry', fallbackEvent);
      this.emit(fallbackEvent.eventType, fallbackEvent);
      return true;
    }

    if (!validEvent) {
      // Validation result was invalid — emit fallback
      const fallbackEvent: TelemetryEvent = {
        eventType: 'degradation_triggered',
        traceId: event?.traceId ? `fallback-${event.traceId}` : `fallback-${Date.now()}`,
        timestamp: new Date().toISOString(),
        sessionId: event?.sessionId ?? '',
        payload: {
          component: 'StoreEventEmitter',
          trigger: 'invalid_event',
          fallback: 'dropped',
          severity: 'warning',
        },
      };
      this.emit('telemetry', fallbackEvent);
      this.emit(fallbackEvent.eventType, fallbackEvent);
      return true;
    }

    // Emit valid event — listener errors now propagate (not caught here)
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
