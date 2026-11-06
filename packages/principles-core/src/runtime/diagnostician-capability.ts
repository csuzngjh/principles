/**
 * PRI-638 — Canonical Diagnostician capability authority.
 *
 * One Owner intent ("may the Diagnostician work?") must have exactly one
 * authority. That authority is the existing internal-agent capability contract:
 *
 *     internalAgents.agents.diagnostician.enabled  (.pd/config.yaml)
 *
 * resolved through `resolveAgentRuntimeBinding()` — the same seam every other
 * internal agent (dreamer / philosopher / scribe / artificer / evaluator /
 * rolloutReviewer) already uses. No new truth source, no new flag, no new
 * persisted state: this is a thin pure read over an existing resolver.
 *
 * Explicitly NOT this module's job:
 *   - choosing an implementation (there is one: SplitDiagnosticianRunner);
 *   - deciding whether a runtime PROFILE is ready (that stays in
 *     `resolveRuntimeConfigFromPdConfig` and is a different failure class);
 *   - anything that touches Pain identity, admission or attribution.
 *
 * `Owner disabled` is a different failure class from `runtime not configured`.
 * Callers MUST keep them apart so a deliberate kill switch never shows up in
 * telemetry or CLI output as a provider/runtime failure.
 */

import { resolveAgentRuntimeBinding } from './config/pd-config-agent-binding.js';
import type { EffectivePdConfig } from './config/pd-config-types.js';

/**
 * Discriminator for the unified disabled state. Distinct from the
 * `PDErrorCategory` values, which describe *how* a run failed.
 */
export const DIAGNOSTICIAN_CAPABILITY_DISABLED = 'capability_disabled' as const;

export type DiagnosticianCapability =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly reason: typeof DIAGNOSTICIAN_CAPABILITY_DISABLED;
      readonly message: string;
      readonly nextAction: string;
    };

/**
 * Resolve whether the Owner allows the Diagnostician to run.
 *
 * @param effectiveConfig Effective PD config. When absent (legacy
 *   WorkflowFunnelLoader path with no config-driven binding) there is no Owner
 *   capability signal to read, so the capability is treated as available — the
 *   pre-PRI-306 default, deliberately unchanged.
 */
export function resolveDiagnosticianCapability(
  effectiveConfig: EffectivePdConfig | undefined,
): DiagnosticianCapability {
  if (!effectiveConfig) {
    return { available: true };
  }

  const binding = resolveAgentRuntimeBinding(effectiveConfig, 'diagnostician');
  if (!binding.ok && binding.readiness === 'disabled') {
    return {
      available: false,
      reason: DIAGNOSTICIAN_CAPABILITY_DISABLED,
      message: binding.reason,
      nextAction: binding.nextAction,
    };
  }

  return { available: true };
}
