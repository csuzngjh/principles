import { describe, expect, it } from 'vitest';
import {
  deriveGovernanceControlBlock,
  GOVERNANCE_BLOCK_I18N_KEYS,
} from '../../src/ui/pages/principles/PrincipleDetailPage.js';
import en from '../../src/ui/i18n/en.json' with { type: 'json' };
import zhCN from '../../src/ui/i18n/zh-CN.json' with { type: 'json' };

const viewWith = (primary: 'none' | 'owner_required' | 'recovery_required') =>
  ({ attention: { primary } });

describe('PRI-582 PrincipleDetailPage governance control gating', () => {
  it('keeps controls available when the projection is flag-off (no error)', () => {
    // ERR-102: disabled ≠ unavailable. Flag-off must preserve the pre-projection
    // experience, so no blocked notice is derived.
    expect(deriveGovernanceControlBlock({ governance: null, governanceUnavailable: null })).toBeNull();
  });

  it('keeps controls available when the projection asks for an Owner decision', () => {
    expect(deriveGovernanceControlBlock({ governance: viewWith('owner_required'), governanceUnavailable: null })).toBeNull();
  });

  it('surfaces the real server reason when the projection failed (ERR-002)', () => {
    const block = deriveGovernanceControlBlock({
      governance: null,
      governanceUnavailable: { reason: 'state.db is locked' },
    });
    expect(block).toEqual({ source: 'server', reason: 'state.db is locked' });
  });

  it('carries the server next action through when the API provided one', () => {
    const block = deriveGovernanceControlBlock({
      governance: null,
      governanceUnavailable: { reason: 'state.db is locked', nextAction: 'Retry after the writer exits.' },
    });
    expect(block).toEqual({
      source: 'server',
      reason: 'state.db is locked',
      nextAction: 'Retry after the writer exits.',
    });
  });

  it('never substitutes the generic no-decision copy for a projection failure', () => {
    // The defect PRI-582 was filed against: a failed projection reported
    // “No current Owner decision is required.”, which inverted the real cause.
    const block = deriveGovernanceControlBlock({
      governance: null,
      governanceUnavailable: { reason: 'projection query failed' },
    });
    expect(block).not.toBeNull();
    if (block === null || block.source !== 'server') throw new Error('expected a server-sourced block');
    expect(block.reason).toBe('projection query failed');
    expect(block.reason).not.toContain('No current Owner decision');
  });

  it('explains recovery_required instead of reporting “no decision needed”', () => {
    expect(deriveGovernanceControlBlock({ governance: viewWith('recovery_required'), governanceUnavailable: null })).toEqual({
      source: 'i18n',
      reasonKey: GOVERNANCE_BLOCK_I18N_KEYS.recoveryReason,
      nextActionKey: GOVERNANCE_BLOCK_I18N_KEYS.recoveryNextAction,
    });
  });

  it('only uses the no-decision copy when the projection genuinely has none', () => {
    expect(deriveGovernanceControlBlock({ governance: viewWith('none'), governanceUnavailable: null })).toEqual({
      source: 'i18n',
      reasonKey: GOVERNANCE_BLOCK_I18N_KEYS.noDecisionReason,
    });
  });
});

describe('PRI-582 blocked-notice i18n parity (cr10)', () => {
  const resolveKey = (locale: unknown, keyPath: string): unknown =>
    keyPath.split('.').reduce<unknown>((node, segment) => {
      if (node !== null && typeof node === 'object' && Object.hasOwn(node as Record<string, unknown>, segment)) {
        return (node as Record<string, unknown>)[segment];
      }
      return undefined;
    }, locale);

  // i18n/index.ts registers `pages: <locale>.pages`, so component keys are
  // namespace-relative (`principles.detail.…`) while the JSON fixture is
  // reached through the `pages.` root.
  it('every blocked-notice key resolves in BOTH locales', () => {
    for (const keyPath of Object.values(GOVERNANCE_BLOCK_I18N_KEYS)) {
      expect(resolveKey(en, `pages.${keyPath}`), `en.json missing ${keyPath}`).toEqual(expect.any(String));
      expect(resolveKey(zhCN, `pages.${keyPath}`), `zh-CN.json missing ${keyPath}`).toEqual(expect.any(String));
    }
  });

  it('reuses projection key paths that already exist under principles.detail.governance', () => {
    for (const key of [GOVERNANCE_BLOCK_I18N_KEYS.recoveryReason, GOVERNANCE_BLOCK_I18N_KEYS.recoveryNextAction]) {
      expect(key.startsWith('principles.detail.governance.')).toBe(true);
    }
  });
});
