/**
 * PainRecorder — Pure function for recording pain signals.
 *
 * D-02: PainRecorder as pure function, decoupled from OpenClawPluginApi.
 *
 * Usage:
 *   import { recordPainSignal } from '@principles/core';
 *   const signal = await recordPainSignal(
 *     { reason: 'edited file without reading first', source: 'manual', score: 75 },
 *     '/path/to/workspace'
 *   );
 *
 * Runtime V2 note:
 * This helper no longer writes .state/.pain_flag. Manual diagnosis requests
 * must use `pd pain record`, and OpenClaw runtime events must use
 * PainSignalBridge/emitPainDetectedEvent.
 */

import { validatePainSignal, deriveSeverity } from './pain-signal.js';
import type { PainSignal } from './pain-signal.js';

/** Input shape for recordPainSignal. */
export interface PainSignalInput {
  reason: string;
  source?: string; // default: 'manual'
  score?: number;  // default: 80
  sessionId?: string;
  is_risky?: boolean;
}

/**
 * Validate and normalize a pain signal.
 *
 * This does not write .state/.pain_flag. It remains as an SDK validation
 * helper for callers that need a framework-agnostic PainSignal object.
 *
 * @param input - PainSignalInput (reason required, source/score optional)
 * @param workspaceDir - Kept for API compatibility; not used for file writes.
 * @returns Promise resolving to a validated PainSignal
 */
export async function recordPainSignal(
  input: PainSignalInput,
  workspaceDir: string,
): Promise<PainSignal> {
  void workspaceDir;
  // Validate required fields
  if (!input.reason || !input.reason.trim()) {
    throw new Error('PainSignalInput.reason is required and must be non-empty');
  }

  const timestamp = new Date().toISOString();
  const severity = deriveSeverity(input.score ?? 80);

  // Build PainSignal-compatible object for schema validation
  const rawSignal = {
    source: input.source ?? 'manual',
    score: input.score ?? 80,
    timestamp,
    reason: input.reason.trim(),
    sessionId: input.sessionId ?? 'unknown',
    agentId: 'principles-core', // SDK does not have agent identity
    traceId: 'sdk',             // SDK does not have trace context
    triggerTextPreview: input.reason.slice(0, 100),
    version: '0.1.0',
    domain: 'coding',
    severity,
    context: {},
  };

  // Validate against schema (fills defaults for optional fields)
  const result = validatePainSignal(rawSignal);
  if (!result.valid) {
    throw new Error(`Invalid PainSignal: ${result.errors.join(', ')}`);
  }

  const {signal} = result;
  if (!signal) throw new Error('Unexpected: validated PainSignal is undefined');

  return signal;
}
