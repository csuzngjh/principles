import type { PainSignalAdapter } from '../../pain-signal-adapter.js';
import type { PainSignal } from '../../pain-signal.js';
import { deriveSeverity } from '../../pain-signal.js';
import type { PluginHookAfterToolCallEvent } from './openclaw-event-types.js';

/**
 * OpenClaw-specific PainSignal adapter.
 *
 * Translates OpenClaw after_tool_call hook events to PainSignals.
 * Per D-02: pure translation only. No GFI checks, no session logic.
 *
 * @example
 * const adapter = new OpenClawPainAdapter();
 * const signal = adapter.capture({ toolName: 'write', error: 'ENOENT' });
 * if (signal) { /* process signal *\/ }
 */
export class OpenClawPainAdapter implements PainSignalAdapter<PluginHookAfterToolCallEvent> {
  capture(rawEvent: PluginHookAfterToolCallEvent): PainSignal | null {
    // Non-failure: return null
    if (!rawEvent.error) {
      return null;
    }

    // Malformed: missing required fields
    if (!rawEvent.toolName || typeof rawEvent.toolName !== 'string') {
      return null;
    }

    // Derive score from error characteristics
    const score = this.deriveScoreFromError(rawEvent.error, rawEvent.toolName);

    return {
      source: 'tool_failure',
      score,
      timestamp: new Date().toISOString(),
      reason: `Tool ${rawEvent.toolName} failed: ${rawEvent.error}`,
      sessionId: rawEvent.sessionId ?? 'unknown',
      agentId: rawEvent.agentId ?? 'unknown',
      traceId: rawEvent.sessionId ?? 'unknown', // Use sessionId as traceId proxy
      triggerTextPreview: this.buildTriggerPreview(rawEvent),
      domain: 'coding',
      severity: deriveSeverity(score),
      context: {
        toolName: rawEvent.toolName,
        hasParams: !!rawEvent.params,
      },
    };
  }

  /**
   * Derive pain score from error message and tool name.
   * Higher scores for more severe/critical errors.
   */
  private deriveScoreFromError(error: string, _toolName: string): number {
    const err = error.toLowerCase();

    // Critical errors: file system corruption, security violations
    if (err.includes('permission denied') || err.includes('eacces')) {
      return 95;
    }
    if (err.includes('enoent') || err.includes('no such file')) {
      return 80; // Common but severe in coding context
    }
    if (err.includes('eisdir') || err.includes('eisfdir')) {
      return 85;
    }

    // High severity: validation failures, type errors
    if (err.includes('syntaxerror') || err.includes('parseerror')) {
      return 82;
    }
    if (err.includes('typeerror') || err.includes('invalid type')) {
      return 75;
    }
    if (err.includes('referenceerror')) {
      return 72;
    }

    // Medium severity: operational failures
    if (err.includes('timeout') || err.includes('etimedout')) {
      return 60;
    }
    if (err.includes('econnrefused') || err.includes('network')) {
      return 65;
    }
    if (err.includes('enotempty') || err.includes('eexist')) {
      return 55;
    }

    // Default: treat as moderate operational failure
    return 50;
  }

  /**
   * Build trigger text preview from tool params.
   */
  private buildTriggerPreview(event: PluginHookAfterToolCallEvent): string {
    if (!event.params) return '';

    const p = event.params;
    // Common params across write/edit tools
    const filePath = (p.file_path as string) || (p.path as string) || (p.file as string) || '';
    const newString = (p.new_string as string) || (p.content as string) || '';

    if (filePath) {
      return `${event.toolName}(${filePath})`;
    }
    if (newString && newString.length > 50) {
      return `${event.toolName}(${newString.slice(0, 50)}...)`;
    }
    return event.toolName;
  }
}
