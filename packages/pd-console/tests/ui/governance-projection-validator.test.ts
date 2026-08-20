import { describe, expect, it } from 'vitest';
import { validateOwnerGovernanceView } from '../../src/ui/utils/validators.js';

const valid = {
  schemaVersion: '1', principleId: 'principle-1', asOf: '2026-08-20T10:00:00.000Z',
  summary: { headlineCode: 'governance.headline.recorded', reasonCode: 'governance.reason.no_current_process', nextActionCode: 'governance.next.none', ownerActionRequired: false, sourceRefs: [{ type: 'principle', id: 'principle-1' }] },
  principleState: { value: 'candidate', sourceRefs: [{ type: 'principle', id: 'principle-1' }] },
  process: { sourceRefs: [] }, automation: { state: 'idle', sourceRefs: [] }, attention: { primary: 'none', items: [] },
  activationSummary: { state: 'none', channels: [], observedChannels: [], sourceRefs: [] }, timeline: [],
  sourceRefs: [{ type: 'principle', id: 'principle-1' }], dataQuality: { degraded: false, issues: [] },
};

describe('PRI-552 governance projection client validator', () => {
  it('accepts the shared strict contract', () => {
    expect(validateOwnerGovernanceView(valid)).toEqual(valid);
  });

  it('rejects corrupt nested arrays and inherited-key substitutes', () => {
    expect(validateOwnerGovernanceView({ ...valid, sourceRefs: [{ type: 'principle', id: 42 }] })).toBeNull();
    const inherited = Object.create({ summary: valid.summary });
    Object.assign(inherited, { ...valid, summary: undefined });
    expect(validateOwnerGovernanceView(inherited)).toBeNull();
  });

  it.each(['headlineCode', 'reasonCode', 'nextActionCode'] as const)('rejects an unregistered summary %s', codeField => {
    expect(validateOwnerGovernanceView({
      ...valid,
      summary: { ...valid.summary, [codeField]: 'governance.unregistered' },
    })).toBeNull();
  });
});
