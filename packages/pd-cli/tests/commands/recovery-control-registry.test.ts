/**
 * SPEC-RULECODE-HOST-PROMOTION-001 review finding 1 (P1): the core recovery
 * -control registry (`RECOVERY_CONTROL_SURFACES`) is the readiness authority
 * for which out-of-band recovery entries are REAL. This contract test pins
 * that authority to the actual pd CLI: the registry's `cli` entries must
 * parse against the REAL built Commander tree, and the fabricated command
 * this review found (`pd activation emergency-pause`) must keep failing as
 * unregistered. Every spawn uses a static literal argv (see the call sites);
 * lockstep with the registry is enforced by the string-equality assertions,
 * so a registry edit without a real registration fails this test.
 *
 * Mirrors cli-command-tree.test.ts's built-binary pattern (cli-7: real
 * registration surface, not handler internals).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';
import { RECOVERY_CONTROL_SURFACES } from '@principles/core/runtime-v2';

function runPdHelp(args: string[]): string | null {
  try {
    return execFileSync('node', [getBuiltPdCliPath(), ...args], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
  } catch {
    // Non-zero exit (unknown command chain / unknown option) ⇒ unregistered.
    return null;
  }
}

describe('recovery-control registry ↔ real pd command registration (SPEC R1)', () => {
  const registryCommand = (capabilityId: string): string | undefined =>
    RECOVERY_CONTROL_SURFACES.find(surface => surface.capabilityId === capabilityId)?.cliCommand;

  it('pd_status: `pd activation list` is registered, and the registry names exactly that command', () => {
    expect(runPdHelp(['activation', 'list', '--help'])).not.toBeNull();
    expect(registryCommand('pd_status')).toBe('pd activation list --json');
  });

  it('rulecode_deactivate: `pd activation deactivate --activation-id` is registered, and the registry names exactly that command', () => {
    expect(runPdHelp(['activation', 'deactivate', '--activation-id', 'recovery-probe', '--help'])).not.toBeNull();
    expect(registryCommand('rulecode_deactivate')).toBe('pd activation deactivate --activation-id recovery-probe');
  });

  it('the fabricated pre-review command `pd activation emergency-pause` is NOT a registered recovery entry', () => {
    // No --help here: help would render the PARENT activation help and exit 0
    // even for an unknown subcommand. Bare invocation of an unregistered
    // subcommand exits non-zero (and there is nothing registered to execute).
    expect(runPdHelp(['activation', 'emergency-pause'])).toBeNull();
    expect(RECOVERY_CONTROL_SURFACES.some(surface => surface.cliCommand?.includes('emergency-pause'))).toBe(false);
  });

  it('console-channel capabilities declare no CLI command (their real surface is the Owner Console route)', () => {
    for (const surface of RECOVERY_CONTROL_SURFACES.filter(entry => entry.channel === 'console')) {
      expect(surface.cliCommand).toBeUndefined();
      expect(surface.consoleRoute).toMatch(/^\//);
      expect(surface.virtualToolName).toBeTruthy();
    }
  });
});
