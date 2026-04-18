/**
 * PainSignalAdapter interface for the Evolution SDK.
 *
 * This interface decouples the evolution engine from specific AI agent
 * frameworks (OpenClaw, Claude Code, etc.). All modules that need to
 * capture pain signals from tool failures should depend on this interface
 * rather than importing framework-specific event types directly.
 *
 * The interface uses a generic type parameter for the raw framework event,
 * so each framework implementation provides its own concrete type.
 */
import type { PainSignal } from './pain-signal.js';

// ---------------------------------------------------------------------------
// PainSignalAdapter Interface
// ---------------------------------------------------------------------------

/**
 * Framework-agnostic adapter for capturing pain signals.
 *
 * @typeParam TRawEvent - The framework-specific event type
 * (e.g., PluginHookAfterToolCallEvent for OpenClaw)
 */
export interface PainSignalAdapter<TRawEvent> {
  /**
   * Translate a framework-specific event into a universal PainSignal.
   *
   * Returns null when the event does not constitute a pain signal:
   *  - "Not applicable": event type is not a failure (e.g., tool succeeded)
   *  - "Malformed": required fields are missing or invalid (e.g., no sessionId)
   *
   * In both cases null is returned -- callers do not need to distinguish.
   * This method performs pure translation only. Trigger decision logic
   * (e.g., GFI threshold checks, tool name filtering) stays in the
   * framework-side hook logic. Per D-02, capture() only translates.
   *
   * @param rawEvent - The framework-specific event to translate
   * @returns A valid PainSignal, or null if the event does not produce one
   */
  capture(rawEvent: TRawEvent): PainSignal | null;
}
