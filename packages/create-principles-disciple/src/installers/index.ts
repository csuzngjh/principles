/**
 * Host installers barrel (ADR-0020 §2.3)
 *
 * Exports HostTarget type + factory for selecting host installers by CLI --host.
 *
 * MVP hosts:
 * - 'openclaw' (default) — OpenClawHostInstaller writes ~/.openclaw/openclaw.json.
 * - 'codex'              — CodexHostInstaller writes ~/.codex/hooks.json.
 * - 'all'                — both installers run (for operators using multiple hosts).
 *
 * Runtime Contract Rules:
 * - rc-1-treat-as-unknown: --host CLI value is `unknown` until validated here.
 * - rc-3-fail-loud-missing: invalid --host value throws with valid options.
 * - rc-9-no-silent-fallback: factory returns concrete installers, not nulls.
 */
import type { HostInstaller } from '@principles/core/host';
import { OpenClawHostInstaller } from './openclaw-host-installer.js';
import { CodexHostInstaller } from './codex-host-installer.js';

export { OpenClawHostInstaller } from './openclaw-host-installer.js';
export { CodexHostInstaller } from './codex-host-installer.js';

/**
 * Host target selector. 'all' runs every registered installer.
 * Add new host IDs here when new HostInstaller implementations land.
 */
export type HostTarget = 'openclaw' | 'codex' | 'all';

export const HOST_TARGETS: readonly HostTarget[] = ['openclaw', 'codex', 'all'];

/**
 * Validate a CLI --host value. rc-1/rc-3: treat input as unknown, fail loud.
 */
export function isHostTarget(value: unknown): value is HostTarget {
  return typeof value === 'string' && (HOST_TARGETS as readonly string[]).includes(value);
}

/**
 * Factory: return the concrete HostInstaller instances for a given target.
 *
 * - 'openclaw' → [OpenClawHostInstaller]
 * - 'codex'    → [CodexHostInstaller]
 * - 'all'      → [OpenClawHostInstaller, CodexHostInstaller]
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
    case 'all':
      return [new OpenClawHostInstaller(), new CodexHostInstaller()];
  }
}
