/**
 * EvolutionHook interface for the Evolution SDK.
 *
 * Provides a callback-based interface for observing evolution lifecycle
 * events: pain detection, principle creation, and principle promotion.
 *
 * Per D-03, this interface contains only the 3 core event methods.
 * Per D-04, consumers implement the interface directly (no EventEmitter).
 * Hooks not needed can use the provided noOpEvolutionHook and override
 * individual methods.
 */
import type { PainSignal } from './pain-signal.js';

// ---------------------------------------------------------------------------
// Event Types
// ---------------------------------------------------------------------------

/** Event payload for principle creation lifecycle events. */
export interface PrincipleCreatedEvent {
  /** Unique principle identifier */
  id: string;
  /** Principle text ("When X, then Y.") */
  text: string;
  /** What triggered this principle's creation */
  trigger: string;
}

/** Event payload for principle promotion lifecycle events. */
export interface PrinciplePromotedEvent {
  /** Unique principle identifier */
  id: string;
  /** Previous status tier */
  from: string;
  /** New status tier */
  to: string;
}

// ---------------------------------------------------------------------------
// EvolutionHook Interface
// ---------------------------------------------------------------------------

/**
 * Callback interface for observing evolution lifecycle events.
 *
 * Implement all 3 methods, or spread noOpEvolutionHook and override
 * only the methods you need:
 *
 * @example
 * ```ts
 * const myHook: EvolutionHook = {
 *   ...noOpEvolutionHook,
 *   onPainDetected(signal) { console.log(signal); },
 * };
 * ```
 */
export interface EvolutionHook {
  /** Called when a pain signal is detected and recorded. */
  onPainDetected(signal: PainSignal): void;
  /** Called when a new principle candidate is created. */
  onPrincipleCreated(event: PrincipleCreatedEvent): void;
  /** Called when a principle is promoted to a higher tier. */
  onPrinciplePromoted(event: PrinciplePromotedEvent): void;
}

// ---------------------------------------------------------------------------
// No-op Helper
// ---------------------------------------------------------------------------

/** No-op implementation -- consumers can spread and override individual methods. */
export const noOpEvolutionHook: EvolutionHook = {
  onPainDetected(_signal: PainSignal): void { /* noop */ },
  onPrincipleCreated(_event: PrincipleCreatedEvent): void { /* noop */ },
  onPrinciplePromoted(_event: PrinciplePromotedEvent): void { /* noop */ },
};
