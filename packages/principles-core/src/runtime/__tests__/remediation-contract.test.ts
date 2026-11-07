import { describe, expect, it } from 'vitest';
import { createRemediationResult, remediationAction } from '../remediation-contract.js';

describe('RemediationResult contract', () => {
  it('dry-run with actions reports would_change and safeToConfirm', () => {
    const result = createRemediationResult({
      mode: 'dry_run',
      actions: [remediationAction({ action: 'repair', targetId: 'task-1', reason: 'expired lease' })],
    });

    expect(result).toMatchObject({
      mode: 'dry_run',
      status: 'would_change',
      safeToConfirm: true,
      repairedCount: 0,
      skippedCount: 0,
      warnings: [],
    });
  });

  it('confirm with repaired items reports changed and is not safeToConfirm', () => {
    const result = createRemediationResult({
      mode: 'confirm',
      repairedCount: 1,
      actions: [remediationAction({ action: 'repair', targetId: 'task-1', reason: 'expired lease' })],
    });

    expect(result.status).toBe('changed');
    expect(result.safeToConfirm).toBe(false);
  });

  it('explicit refused status is preserved', () => {
    const result = createRemediationResult({
      mode: 'confirm',
      status: 'refused',
      safeToConfirm: false,
      warnings: ['state.db unreadable'],
    });

    expect(result.status).toBe('refused');
    expect(result.safeToConfirm).toBe(false);
    expect(result.warnings).toEqual(['state.db unreadable']);
  });
});

