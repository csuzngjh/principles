/**
 * Host installers barrel (ADR-0020 §2.3)
 *
 * Exports HostTarget type + factory for selecting host installers by CLI --host.
 *
 * MVP hosts:
 * - 'openclaw' (default) — OpenClawHostInstaller writes ~/.openclaw/openclaw.json.
 * - 'codex'              — CodexHostInstaller writes ~/.codex/hooks.json.
 * - 'workbuddy'          — WorkBuddyHostInstaller registers the PD plugin into
 *                          WorkBuddy's marketplace/plugin system (quiet, opt-in:
 *                          'all' deliberately does NOT include it — SPEC
 *                          workbuddy-host-adapter §6 install≠enable).
 * - 'all'                — openclaw + codex (both legacy install flows).
 *
 * Runtime Contract Rules:
 * - rc-1-treat-as-unknown: --host CLI value is `unknown` until validated here.
 * - rc-3-fail-loud-missing: invalid --host value throws with valid options.
 * - rc-9-no-silent-fallback: factory returns concrete installers, not nulls.
 */
import type { HostInstaller } from '@principles/core/host';
import { OpenClawHostInstaller } from './openclaw-host-installer.js';
import { CodexHostInstaller } from './codex-host-installer.js';
import { WorkBuddyHostInstaller } from './workbuddy-host-installer.js';

export { OpenClawHostInstaller } from './openclaw-host-installer.js';
export { CodexHostInstaller } from './codex-host-installer.js';
export { WorkBuddyHostInstaller } from './workbuddy-host-installer.js';

/**
 * Host target selector. 'all' runs openclaw + codex. WorkBuddy is an explicit,
 * separate target: installing it is an opt-in decision (OD-03/OD-04), so 'all'
 * must not silently register a third host.
 */
export type HostTarget = 'openclaw' | 'codex' | 'workbuddy' | 'all';

export const HOST_TARGETS: readonly HostTarget[] = ['openclaw', 'codex', 'workbuddy', 'all'];

/**
 * Validate a CLI --host value. rc-1/rc-3: treat input as unknown, fail loud.
 */
export function isHostTarget(value: unknown): value is HostTarget {
  return typeof value === 'string' && (HOST_TARGETS as readonly string[]).includes(value);
}

/**
 * Factory: return the concrete HostInstaller instances for a given target.
 *
 * - 'openclaw'  → [OpenClawHostInstaller]
 * - 'codex'     → [CodexHostInstaller]
 * - 'workbuddy' → [WorkBuddyHostInstaller]
 * - 'all'       → [OpenClawHostInstaller, CodexHostInstaller]
 *
 * Note: uninstall flows that need "every host PD ever registered with" (the
 * uninstall --host all contract) widen the list at their call site to include
 * WorkBuddyHostInstaller — uninstalling a registration is cleanup, not opt-in.
 *
 * Callers iterate the returned array and call install()/uninstall()/detect()
 * on each. This keeps the CLI install/uninstall flow host-agnostic.
 */
export function getHostInstallers(target: HostTarget): HostInstaller[] {
  if (!isHostTarget(target)) {
    throw new Error(`Invalid host target: ${JSON.stringify(target)}. Valid: ${HOST_TARGETS.join(', ')}`);
  }
  switch (target) {
    case 'openclaw':
      return [new OpenClawHostInstaller()];
    case 'codex':
      return [new CodexHostInstaller()];
    case 'workbuddy':
      return [new WorkBuddyHostInstaller()];
    case 'all':
      return [new OpenClawHostInstaller(), new CodexHostInstaller()];
  }
}

