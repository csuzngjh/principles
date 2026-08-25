import { describe, expect, it } from 'vitest';
import { validateGovernanceExperienceSnapshot } from '../../src/ui/utils/validators.js';
import { EXPERIENCE_ATTENTION, EXPERIENCE_REASON, EXPERIENCE_NEXT_ACTION } from '../../src/ui/pages/focus/FocusPage.js';
import en from '../../src/ui/i18n/en.json' with { type: 'json' };
import zhCN from '../../src/ui/i18n/zh-CN.json' with { type: 'json' };
import type { GovernanceExperienceSnapshot } from '@principles/core/runtime-v2';

const VALID_SNAPSHOT: GovernanceExperienceSnapshot = {
  schemaVersion: '1',
  snapshotId: 'gov-exp:0123456789abcdef:2026-08-24T10:00:00.000Z',
  asOf: '2026-08-24T10:00:00.000Z',
  summary: {
    primaryAttention: 'owner_decision_required',
    headlineCode: 'govexp.headline.owner_decision_required',
    reasonCode: 'governance.exp.reason.approval_pending',
    nextActionCode: 'governance.exp.next.review_approvals',
  },
  readiness: {
    authenticationMode: 'no_auth',
    ownerIdentityConfiguration: 'missing',
    governanceActions: [
      { kind: 'principle_approval', observedAuthority: 'operator_legacy', status: 'entry_conditions_met', reasonCode: 'governance.exp.reason.approval_pending', nextActionCode: 'governance.exp.next.review_approvals' },
      { kind: 'rulecode_owner_decision', observedAuthority: 'configured_owner', status: 'blocked', reasonCode: 'governance.exp.reason.owner_identity_missing', nextActionCode: 'governance.exp.next.configure_owner' },
      { kind: 'emergency_pause', observedAuthority: 'break_glass', status: 'entry_conditions_met', reasonCode: 'governance.exp.reason.break_glass_entry', nextActionCode: 'governance.exp.next.none' },
    ],
  },
  activity: {
    primaryAttention: 'owner_decision_required',
    categories: [
      {
        category: 'needs_decision',
        count: 1,
        items: [{ principleId: 'principle-1', category: 'needs_decision', reasonCode: 'governance.reason.approval_pending', sourceRefs: [{ type: 'approval', id: 'approval-1' }] }],
        hasMore: false,
      },
    ],
  },
  trustContext: {
    environmentContext: { environment: 'unknown', source: 'missing' },
    lineageTransparency: { confidence: 'unknown', strongViewCount: 0, weakViewCount: 0, unknownViewCount: 1 },
  },
  dataQuality: { degraded: false, issueGroups: [], hasMore: false },
};

describe('PRI-586 browser-local GovernanceExperienceSnapshot validator (ERR-100)', () => {
  it('accepts a valid snapshot', () => {
    expect(validateGovernanceExperienceSnapshot(VALID_SNAPSHOT)).toEqual(VALID_SNAPSHOT);
  });

  it('rejects corrupt envelopes, wrong enums, and over-long bounded lists', () => {
    expect(validateGovernanceExperienceSnapshot(null)).toBeNull();
    expect(validateGovernanceExperienceSnapshot({ schemaVersion: '2' })).toBeNull();
    const wrongAttention: unknown = { ...VALID_SNAPSHOT, summary: { ...VALID_SNAPSHOT.summary, primaryAttention: 'on_fire' } };
    expect(validateGovernanceExperienceSnapshot(wrongAttention)).toBeNull();
    const wrongAuthority: unknown = {
      ...VALID_SNAPSHOT,
      readiness: { ...VALID_SNAPSHOT.readiness, governanceActions: VALID_SNAPSHOT.readiness.governanceActions.map(action => ({ ...action, observedAuthority: 'root' })) },
    };
    expect(validateGovernanceExperienceSnapshot(wrongAuthority)).toBeNull();
    const tooManyItems: unknown = {
      ...VALID_SNAPSHOT,
      activity: {
        primaryAttention: 'owner_decision_required',
        categories: [{
          category: 'needs_decision', count: 11, hasMore: true,
          items: Array.from({ length: 11 }, (_, index) => ({ principleId: `p${index}`, category: 'needs_decision', reasonCode: 'governance.reason.approval_pending', sourceRefs: [] })),
        }],
      },
    };
    expect(validateGovernanceExperienceSnapshot(tooManyItems)).toBeNull();
    const blockedRulecodeReason: unknown = {
      ...VALID_SNAPSHOT,
      summary: { ...VALID_SNAPSHOT.summary, reasonCode: 'governance.exp.reason.not_a_code' },
    };
    expect(validateGovernanceExperienceSnapshot(blockedRulecodeReason)).toBeNull();
  });

  it('accepts workspace-level items without principleId (rulecode decision marker)', () => {
    const withMarker: unknown = {
      ...VALID_SNAPSHOT,
      activity: {
        primaryAttention: 'owner_decision_required',
        categories: [{
          category: 'needs_decision', count: 1, hasMore: false,
          items: [{ category: 'needs_decision', reasonCode: 'governance.exp.reason.rulecode_owner_decision', sourceRefs: [{ type: 'activation', id: 'act-1' }] }],
        }],
      },
    };
    expect(validateGovernanceExperienceSnapshot(withMarker)).not.toBeNull();
  });
});

describe('PRI-586 FocusPage experience display maps — i18n parity (cr10)', () => {
  const resolveKey = (locale: unknown, keyPath: string): unknown =>
    keyPath.split('.').reduce<unknown>((node, segment) => {
      if (node !== null && typeof node === 'object' && Object.hasOwn(node as Record<string, unknown>, segment)) {
        return (node as Record<string, unknown>)[segment];
      }
      return undefined;
    }, locale);

  const expectKeyExists = (keyPath: string): void => {
    expect(resolveKey(en, keyPath), `en.json missing ${keyPath}`).toEqual(expect.any(String));
    expect(resolveKey(zhCN, keyPath), `zh-CN.json missing ${keyPath}`).toEqual(expect.any(String));
  };

  it('every attention/reason/nextAction map entry resolves in BOTH locales', () => {
    for (const definition of Object.values(EXPERIENCE_ATTENTION)) expectKeyExists(definition.labelKey);
    for (const keyPath of Object.values(EXPERIENCE_REASON)) expectKeyExists(keyPath);
    for (const keyPath of Object.values(EXPERIENCE_NEXT_ACTION)) expectKeyExists(keyPath);
    // Readiness / trust / data-quality dynamic keys (FocusPage template strings)
    for (const identity of ['configured', 'missing']) expectKeyExists(`pages.focus.experience.readiness.identity.${identity}`);
    for (const rulecode of ['ready', 'blocked']) expectKeyExists(`pages.focus.experience.readiness.rulecode.${rulecode}`);
    for (const pause of ['owner', 'breakGlass']) expectKeyExists(`pages.focus.experience.readiness.pause.${pause}`);
    for (const environment of ['production', 'development', 'demo', 'test', 'unknown']) expectKeyExists(`pages.focus.experience.trust.environment.${environment}`);
    for (const lineage of ['strong', 'weak', 'unknown']) expectKeyExists(`pages.focus.experience.trust.lineage.${lineage}`);
    for (const activity of ['needsDecision', 'needsRecovery', 'blocked', 'processing']) expectKeyExists(`pages.focus.experience.activity.${activity}`);
  });

  it('the attention map covers every primary attention the API can return (ERR-106 exhaustiveness)', () => {
    const expected = ['setup_required', 'owner_decision_required', 'recovery_required', 'degraded', 'background_processing', 'all_clear'];
    expect(Object.keys(EXPERIENCE_ATTENTION).sort()).toEqual(expected.sort());
  });
});
