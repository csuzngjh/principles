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
 */

import { validatePainSignal, deriveSeverity } from './pain-signal.js';
import type { PainSignal } from './pain-signal.js';
import { atomicWriteFileSync, painFlagLock } from './io.js';
import { resolvePainFlagPath } from './pain-flag-resolver.js';

/** Input shape for recordPainSignal. */
export interface PainSignalInput {
  reason: string;
  source?: string; // default: 'manual'
  score?: number;  // default: 80
  sessionId?: string;
  is_risky?: boolean;
}

/** KV-serializable pain flag data shape. */
interface PainFlagData {
  source: string;
  score: string;
  reason: string;
  session_id: string;
  is_risky: string;
  time: string;
  pain_event_id?: string;
}

/**
 * Build pain flag data object from input.
 */
function buildPainFlag(input: PainSignalInput, timestamp: string, painEventId?: string): PainFlagData {
  return {
    source: input.source ?? 'manual',
    score: String(input.score ?? 80),
    reason: input.reason,
    session_id: input.sessionId ?? '',
    is_risky: String(input.is_risky ?? false),
    time: timestamp,
    pain_event_id: painEventId,
  };
}

/**
 * Serialize pain flag data to KV-format string.
 */
function serializeKvLines(data: PainFlagData): string {
  const lines: string[] = [];
  if (data.source) lines.push(`source: ${data.source}`);
  if (data.score) lines.push(`score: ${data.score}`);
  if (data.reason) lines.push(`reason: ${data.reason}`);
  if (data.session_id) lines.push(`session_id: ${data.session_id}`);
  if (data.is_risky) lines.push(`is_risky: ${data.is_risky}`);
  if (data.time) lines.push(`time: ${data.time}`);
  if (data.pain_event_id) lines.push(`pain_event_id: ${data.pain_event_id}`);
  return lines.join('\n');
}

/**
 * Record a pain signal to the workspace's .pain_flag file.
 *
 * This is a pure function — it requires only a workspaceDir string,
 * no OpenClawPluginApi or plugin runtime.
 *
 * @param input - PainSignalInput (reason required, source/score optional)
 * @param workspaceDir - Absolute path to the workspace directory
 * @returns Promise resolving to a validated PainSignal
 */
export async function recordPainSignal(
  input: PainSignalInput,
  workspaceDir: string,
): Promise<PainSignal> {
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

  // Write to .pain_flag (KV format, atomic) — serialized via AsyncQueueLock
  const painFlagPath = resolvePainFlagPath(workspaceDir);
  const painFlagData = buildPainFlag(input, timestamp);
  const serialized = serializeKvLines(painFlagData);
  await painFlagLock.withLock(painFlagPath, async () => {
    atomicWriteFileSync(painFlagPath, serialized);
  });

  return signal;
}
