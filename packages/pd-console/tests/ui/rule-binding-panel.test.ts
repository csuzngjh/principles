import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveRuleBindingCardState, groupRuleBindingQueue, canOfferRuleBindingResume,
  RULE_BINDING_CARD_STATE_KEY, RULE_BINDING_CARD_STATE_CLASS,
  type RuleBindingCardState,
} from '../../src/ui/pages/focus/RuleCandidateBindingPanel.js';
import type { RuleBindingQueueItem } from '../../src/shared/rule-candidate-binding-contract.js';
import { parseJsonRecord } from './i18n-test-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const I18N_ROOT = join(__dirname, '..', '..', 'src', 'ui', 'i18n');

function makeItem(overrides: Partial<RuleBindingQueueItem> = {}): RuleBindingQueueItem {
  return {
    candidateId: 'c-1',
    text: '要求先交付设计确认。',
    pain: { painId: 'pain-1', text: 'Owner 原话。', source: 'manual', createdAt: '2026-10-26T00:00:00.000Z' },
    diagnosisStatus: 'succeeded',
    binding: { status: 'unlinked' },
    generation: null,
    resume: null,
    ...overrides,
  };
}

const bound = (generation: RuleBindingQueueItem['generation'], resume: RuleBindingQueueItem['resume']): RuleBindingQueueItem =>
  makeItem({
    binding: { status: 'bound', principle: { principleId: '11111111-2222-4222-8222-222222222222', text: '设计确认门禁。', status: 'candidate', version: 1, revision: 1, decidedAt: '2026-10-26T00:00:00.000Z' } },
    generation,
    resume,
  });

describe('RuleCandidateBindingPanel pure display logic (PRI-1048)', () => {
  it('derives every card state exhaustively from binding × generation', () => {
    expect(deriveRuleBindingCardState(makeItem())).toBe('awaiting_owner');
    expect(deriveRuleBindingCardState(makeItem({ binding: { status: 'binding_revoked' } }))).toBe('revoked');
    expect(deriveRuleBindingCardState(makeItem({ binding: { status: 'attention', reason: 'ledger_unavailable' } }))).toBe('attention');
    expect(deriveRuleBindingCardState(bound(null, null))).toBe('bound_not_built');
    expect(deriveRuleBindingCardState(bound({ stage: 'not_built', stageKind: null, reasonCode: null, detail: null }, null))).toBe('bound_not_built');
    expect(deriveRuleBindingCardState(bound({ stage: 'in_progress', stageKind: 'scribe', reasonCode: null, detail: null }, null))).toBe('bound_generating');
    expect(deriveRuleBindingCardState(bound({ stage: 'blocked', stageKind: 'artificer', reasonCode: 'textual_basis_unanchored', detail: 'd' }, null))).toBe('bound_blocked');
    expect(deriveRuleBindingCardState(bound({ stage: 'advanced', stageKind: 'scribe', reasonCode: null, detail: null }, null))).toBe('bound_advanced');
    expect(deriveRuleBindingCardState(bound({ stage: 'ambiguous', stageKind: null, reasonCode: null, detail: null }, null))).toBe('bound_ambiguous');
  });

  it('groups by pain signal; unattributable candidates get their own group, never merged', () => {
    const items = [
      makeItem(),
      makeItem({ candidateId: 'c-2' }),
      makeItem({ candidateId: 'c-3', pain: { painId: '', text: null, source: 'unknown', createdAt: null } }),
      makeItem({ candidateId: 'c-4', pain: { painId: 'pain-2', text: '另一次反馈。', source: 'manual', createdAt: null } }),
    ];
    const groups = groupRuleBindingQueue(items);
    expect(groups.map(group => group.key)).toEqual(['pain-1', 'candidate:c-3', 'pain-2']);
    expect(groups[0]?.items.map(item => item.candidateId)).toEqual(['c-1', 'c-2']);
    expect(groups[1]?.items).toHaveLength(1);
  });

  it('offers the resume action only on real backend readiness and never during a run', () => {
    const ready = { status: 'ready' as const, reason: null, scribeTaskId: 's-1', taskRevisionEpoch: 0 };
    expect(canOfferRuleBindingResume(bound({ stage: 'blocked', stageKind: 'artificer', reasonCode: 'x', detail: null }, ready))).toBe(true);
    expect(canOfferRuleBindingResume(bound({ stage: 'advanced', stageKind: 'scribe', reasonCode: null, detail: null }, ready))).toBe(true);
    expect(canOfferRuleBindingResume(bound({ stage: 'in_progress', stageKind: 'scribe', reasonCode: null, detail: null }, ready))).toBe(false);
    expect(canOfferRuleBindingResume(bound({ stage: 'ambiguous', stageKind: null, reasonCode: null, detail: null }, ready))).toBe(false);
    expect(canOfferRuleBindingResume(bound({ stage: 'blocked', stageKind: 'artificer', reasonCode: 'x', detail: null }, { status: 'refused', reason: 'revision_budget_exhausted', scribeTaskId: 's-1', taskRevisionEpoch: 1 }))).toBe(false);
    expect(canOfferRuleBindingResume(makeItem({ resume: ready }))).toBe(false);
  });

  it('maps every card state to an i18n key present in BOTH locales (EP-11/ERR-106)', () => {
    const zh = parseJsonRecord(readFileSync(join(I18N_ROOT, 'zh-CN.json'), 'utf8'));
    const en = parseJsonRecord(readFileSync(join(I18N_ROOT, 'en.json'), 'utf8'));
    const states: RuleBindingCardState[] = ['awaiting_owner', 'bound_generating', 'bound_blocked', 'bound_advanced', 'bound_not_built', 'bound_ambiguous', 'revoked', 'attention'];
    const resolve = (root: Record<string, unknown>, key: string): unknown =>
      key.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' && Object.hasOwn(acc as Record<string, unknown>, part) ? (acc as Record<string, unknown>)[part] : undefined), root);
    for (const state of states) {
      const key = RULE_BINDING_CARD_STATE_KEY[state];
      expect(resolve(zh, key), `zh missing ${key}`).toBeTypeOf('string');
      expect(resolve(en, key), `en missing ${key}`).toBeTypeOf('string');
      expect(RULE_BINDING_CARD_STATE_CLASS[state]).toMatch(/border-/);
    }
  });

  it('keeps technical identifiers collapsed and the long text out of the button (source contract)', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'pages', 'focus', 'RuleCandidateBindingPanel.tsx'), 'utf8');
    expect(source).not.toContain('item.text.slice');
    expect(source).toContain('aria-expanded={open}');
    expect(source).toContain('techDetails');
    expect(source).toContain('canOfferRuleBindingResume(');
    // The resume CTA must be gated on real eligibility, not rendered unconditionally.
    expect(source).toMatch(/canOfferRuleBindingResume\(\{ \.\.\.item, resume: review\.resume \}\)/);
    expect(source).toContain('data-testid="rule-binding-counts"');
  });
});
