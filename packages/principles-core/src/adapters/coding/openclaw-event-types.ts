/**
 * OpenClaw event type shims for principles-core.
 *
 * These are DUPLICATED minimal type shapes, NOT imports from openclaw-plugin.
 * principles-core must NOT import from openclaw-plugin.
 * If OpenClaw SDK changes event shapes, these shims must be updated manually.
 */

/**
 * Minimal shape of OpenClaw's after_tool_call hook event.
 * Only includes fields used by OpenClawPainAdapter.capture().
 */
export interface PluginHookAfterToolCallEvent {
  /** Name of the tool that was called */
  toolName: string;
  /** Error message if the tool call failed */
  error?: string;
  /** Tool call parameters */
  params?: Record<string, unknown>;
  /** Result returned by the tool (success) */
  result?: unknown;
  /** Session ID from the hook context */
  sessionId?: string;
  /** Agent ID from the hook context */
  agentId?: string;
}
