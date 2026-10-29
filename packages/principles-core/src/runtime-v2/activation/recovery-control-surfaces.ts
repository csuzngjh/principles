import type { HostLivenessContract } from './openclaw-promotion-checks.js';

/**
 * SPEC-RULECODE-HOST-PROMOTION-001 review finding 1 (P1): a capability
 * CONTRACT declares mappings; it must never by itself certify that the
 * out-of-band recovery controls are REAL. This registry is the core-owned
 * inventory of each recovery control's ACTUAL, currently-registered entry
 * surface — verified against the real command/route registrations by the
 * cross-package contract tests that import it (pd-cli proves every `cli`
 * entry parses against the real Commander tree; pd-console proves every
 * `console` entry dispatches to its model handler). Readiness validates
 * every host contract's probes against THIS table before
 * `emergency_controls` may pass: a probe naming a command or route that is
 * not registered here (or anywhere) is a fabricated recovery entry and
 * fails the check.
 *
 * Inventory basis (2026-10-29 audit of this repository):
 * - `pd activation list --json` — registered (pd-cli runtime-activation.ts,
 *   read-only RuleCode status surface);
 * - `pd activation deactivate --activation-id <id>` — registered
 *   (pd-cli runtime-activation.ts, idempotent rollback);
 * - global emergency pause — NO pd CLI command exists; the real surface is
 *   the authenticated Owner Console route POST /api/v1/activations/
 *   emergency-pause (server/routes/activations.ts → pauseAllRuleCode →
 *   SqliteActivationSafetyStore.pauseAllLive, honored by the shared gate's
 *   global_rulecode_pauses read);
 * - Owner review — Console owner-review route (e2e-proven).
 * A capability whose real surface is missing from this registry must stay
 * unsupported — never papered over with a constant or a stub probe.
 */
export type RecoveryControlCapability =
  | 'pd_status'
  | 'rulecode_deactivate'
  | 'rulecode_global_pause'
  | 'owner_review_access';

export interface RecoveryControlSurface {
  readonly capabilityId: RecoveryControlCapability;
  readonly channel: 'cli' | 'console';
  /** channel 'cli': the exact canonical probe command (never executed by readiness — replay-only). */
  readonly cliCommand?: string;
  /** channel 'console': the console route backing the control. */
  readonly consoleRoute?: string;
}

export const RECOVERY_CONTROL_SURFACES: readonly RecoveryControlSurface[] = Object.freeze([
  Object.freeze({
    capabilityId: 'pd_status',
    channel: 'cli',
    cliCommand: 'pd activation list --json',
  } satisfies RecoveryControlSurface),
  Object.freeze({
    capabilityId: 'rulecode_deactivate',
    channel: 'cli',
    cliCommand: 'pd activation deactivate --activation-id recovery-probe',
  } satisfies RecoveryControlSurface),
  Object.freeze({
    capabilityId: 'rulecode_global_pause',
    channel: 'console',
    consoleRoute: '/api/v1/activations/emergency-pause',
  } satisfies RecoveryControlSurface),
  Object.freeze({
    capabilityId: 'owner_review_access',
    channel: 'console',
    consoleRoute: '/api/v1/activations/{activationId}/owner-review',
  } satisfies RecoveryControlSurface),
]);

export type RecoveryControlValidation =
  | { ok: true }
  | { ok: false; reason: 'recovery_control_surface_unregistered' | 'recovery_control_probe_mismatch'; capabilityId: string; nextAction: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a host contract's recovery-control declaration against the real
 * surface registry:
 * - every registry capability must be declared as a protected capability;
 * - every neutral probe for a CLI-channel capability must replay EXACTLY the
 *   registry's canonical command (no invented `pd status`,
 *   no non-existent `pd activation emergency-pause`);
 * - console-channel capabilities must carry NO probe: their recovery path
 *   never passes through the RuleHost gate, so a virtual-tool allow replay
 *   would misrepresent rule-side verification as control verification
 *   (review R3/P1 — their independence is structural and their real-world
 *   reachability is supplied as target-environment evidence instead).
 */
export function validateRecoveryControlSurfaces(contract: HostLivenessContract): RecoveryControlValidation {
  const protectedIds = new Set(contract.protectedCapabilities.map((capability) => capability.capabilityId));
  for (const surface of RECOVERY_CONTROL_SURFACES) {
    if (!protectedIds.has(surface.capabilityId)) {
      return {
        ok: false,
        reason: 'recovery_control_surface_unregistered',
        capabilityId: surface.capabilityId,
        nextAction: `the contract must declare the ${surface.capabilityId} recovery capability with its real ${surface.channel} surface`,
      };
    }
  }
  const byCapability = new Map(contract.neutralProbes.map((probe) => [probe.capabilityId, probe]));
  for (const surface of RECOVERY_CONTROL_SURFACES) {
    const probe = byCapability.get(surface.capabilityId);
    if (surface.channel === 'cli') {
      if (probe === undefined) {
        return {
          ok: false,
          reason: 'recovery_control_probe_mismatch',
          capabilityId: surface.capabilityId,
          nextAction: `the contract must carry a neutral probe for ${surface.capabilityId}`,
        };
      }
      const command = isRecord(probe.params) && typeof probe.params.command === 'string' ? probe.params.command : undefined;
      if (command !== surface.cliCommand) {
        return {
          ok: false,
          reason: 'recovery_control_probe_mismatch',
          capabilityId: surface.capabilityId,
          nextAction: `the ${surface.capabilityId} probe must replay the registered command "${surface.cliCommand}" — a command that is not registered is a fabricated recovery entry`,
        };
      }
    } else if (probe !== undefined) {
      return {
        ok: false,
        reason: 'recovery_control_probe_mismatch',
        capabilityId: surface.capabilityId,
        nextAction: `the ${surface.capabilityId} control never passes through the RuleHost gate; a virtual-tool probe would misrepresent its verification — remove the probe (real surface: ${surface.consoleRoute})`,
      };
    }
  }
  return { ok: true };
}
