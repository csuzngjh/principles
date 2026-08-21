/**
 * Regression test for nextAction CLI hints in `pd activation list`.
 *
 * Bug #1367: `pd activation list` emitted `--confirm` in the deactivate
 * nextAction, but the `deactivate` command has no `--confirm` option
 * (`error: unknown option '--confirm'`).
 *
 * Root cause: the nextAction template was copy-pasted from `promote`
 * (which DOES support --confirm) without adjusting the deactivate variant.
 *
 * Guard: deactivate nextAction must never contain `--confirm`;
 * promote nextAction must always contain `--confirm`.
 */

import { describe, it, expect } from 'vitest';
import { deriveActivationStatusAndNextAction } from '../runtime-activation.js';

describe('deriveActivationStatusAndNextAction', () => {
  const base = {
    deactivatedAt: null,
    contextVersion: 'v1' as const,
    v2FlagEnabled: true,
    activationId: 'act_code_rule-test-123',
  };

  it('live mode: deactivate nextAction must NOT contain --confirm (bug #1367)', () => {
    const { status, nextAction } = deriveActivationStatusAndNextAction({
      ...base,
      mode: 'live',
    });
    expect(status).toBe('active');
    expect(nextAction).toBeDefined();
    expect(nextAction).toContain('pd activation deactivate');
    expect(nextAction).not.toContain('--confirm');
  });

  it('shadow mode: nextAction requires Owner review instead of advertising direct mutation', () => {
    const { status, nextAction } = deriveActivationStatusAndNextAction({
      ...base,
      mode: 'shadow',
    });
    expect(status).toBe('active');
    expect(nextAction).toBeDefined();
    expect(nextAction).toBe(
      'Keep shadow; promotion requires an authenticated Owner decision, immutable evidence bindings, and a passing Promotion Readiness result.',
    );
    expect(nextAction).not.toContain('pd activation promote');
  });

  it('deactivated record: status deactivated, no nextAction', () => {
    const { status, nextAction } = deriveActivationStatusAndNextAction({
      ...base,
      mode: 'live',
      deactivatedAt: '2026-08-21T00:51:10.026Z',
    });
    expect(status).toBe('deactivated');
    expect(nextAction).toBeUndefined();
  });

  it('v2 activation with flag off: suspended_by_flag, deactivate hint without --confirm', () => {
    const { status, nextAction } = deriveActivationStatusAndNextAction({
      ...base,
      mode: 'live',
      contextVersion: 'v2',
      v2FlagEnabled: false,
    });
    expect(status).toBe('suspended_by_flag');
    expect(nextAction).toBeDefined();
    expect(nextAction).toContain('pd activation deactivate');
    expect(nextAction).not.toContain('--confirm');
  });

  it('unknown mode: active with no nextAction', () => {
    const { status, nextAction } = deriveActivationStatusAndNextAction({
      ...base,
      mode: undefined,
    });
    expect(status).toBe('active');
    expect(nextAction).toBeUndefined();
  });
});
