/**
 * Shadow Observation Fingerprint Utilities
 *
 * Computes fingerprints for shadow task routing and tracking.
 */

import * as crypto from 'crypto';
import type { PluginHookSubagentSpawningEvent } from '../openclaw-sdk.js';

/**
 * PD local worker profiles that are managed by the shadow routing policy.
 */
const _pdLocalProfiles = new Set(['local-reader', 'local-editor']);
export const PD_LOCAL_PROFILES: ReadonlySet<string> = _pdLocalProfiles;

/**
 * Check if a profile is a local PD profile.
 */
export function isLocalProfile(profile: string): boolean {
  return _pdLocalProfiles.has(profile);
}

const RUNTIME_SHADOW_FINGERPRINT_HEX_LENGTH = 16;

/**
 * Compute a fingerprint for runtime shadow task tracking.
 * Used to correlate shadow routing decisions with subagent lifecycle events.
 */
export function computeRuntimeShadowTaskFingerprint(
  event: PluginHookSubagentSpawningEvent,
): string {
  const payload = {
    childSessionKey: event.childSessionKey,
    agentId: event.agentId,
    label: event.label ?? '',
    mode: event.mode,
    threadRequested: event.threadRequested,
    requesterChannel: event.requester?.channel ?? '',
    requesterThreadId: event.requester?.threadId ?? '',
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, RUNTIME_SHADOW_FINGERPRINT_HEX_LENGTH);
}
