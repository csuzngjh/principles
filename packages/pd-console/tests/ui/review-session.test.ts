/**
 * B2/B3 contract: the daily review queue, its session memory, and the single
 * card's narrative limits (REVIEW_SESSION_SPEC §1.3, §2.2).
 *
 * These are pure functions, so they are tested directly rather than through
 * the page: the limits (≤40 chars per paragraph, ≤3 evidence lines, no ids in
 * the first layer) are the acceptance evidence for the batch.
 */
import { describe, expect, it } from 'vitest';
import zhCN from '../../src/ui/i18n/zh-CN.json';
import type { ApprovalGroupData, OwnerDecisionItemData } from '../../src/ui/utils/validators.js';
import { buildReviewItems, splitReviewQueue, type ReviewItem } from '../../src/ui/pages/review/review-items.js';
import { validateReviewSession, localDateKey } from '../../src/ui/pages/review/review-session.js';
import { deriveReviewNarrative, looksTechnical } from '../../src/ui/pages/review/review-narrative.js';

const resources = zhCN as unknown as Record<string, unknown>;

function translate(key: string, options?: Record<string, unknown>): string {
  const value = key.split('.').reduce<unknown>((node, part) => {
    if (typeof node !== 'object' || node === null) return undefined;
    return (node as Record<string, unknown>)[part];
  }, resources);
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''));
}

function decision(overrides: Partial<OwnerDecisionItemData> = {}): OwnerDecisionItemData {
  return {
    reviewKey: 'rulecode:test',
    kind: 'rollout_review',
    taskId: 'task-test',
    title: '共享配置改动前，先写影响说明',
    summary: '这条原则已经完成验证，等你决定是否采用。',
    reasonCode: 'rollout_review_pending',
    legacy: false,
    allowedActions: ['accept_current', 'reject_current'],
    expectedRevisionEpoch: 0,
    expectedSourceRunId: '',
    expectedSourceArtifactId: '',
    expectedSourceArtifactHash: '',
    createdAt: '2026-11-12T10:41:00.000Z',
    principleId: 'p-001',
    ...overrides,
  };
}

function approvalGroup(overrides: Partial<ApprovalGroupData> = {}): ApprovalGroupData {
  return {
    principleId: 'p-002',
    principleTitle: '回复先说结论',
    candidateDescription: '面向我的回复，先用一句结论开头，再补充背景。',
    status: 'pending',
    records: [{
      id: 'apr-1',
      artifactId: 'artifact-1',
      channel: 'prompt',
      createdAt: '2026-11-11T10:20:00.000Z',
      status: 'pending',
    }],
    ...overrides,
  };
}

describe('review narrative limits (B3-01/02/04)', () => {
  it('keeps the three paragraphs and the impact line inside their limits', () => {
    const item: ReviewItem = {
      id: 'd:rulecode:test',
      kind: 'decision',
      title: '共享配置改动前，先写影响说明',
      createdAt: '2026-11-12T10:41:00.000Z',
      decision: decision({
        review: {
          brief: {
            kind: 'rollout',
            principle: {
              statement: '涉及共享配置的改动，先写影响再动手，这样后续回滚时能快速判断范围，也不会让其他人替你猜。',
              scope: ['shared_config'],
            },
            implementation: { summary: '在每次代码修改前检查是否涉及共享配置。', affectedTools: ['shared_config'], risks: [] },
            requiredChanges: [],
            concerns: ['当时的改动没有留下影响说明'],
          },
          evidence: {
            completeness: 'partial',
            deterministicChecks: [],
            items: [],
            digest: 'digest',
          },
          capability: { acceptRequirement: { kind: 'acknowledge_partial_evidence' } },
        },
      }),
    };

    const narrative = deriveReviewNarrative(item, translate);
    expect(Array.from(narrative.happened).length).toBeLessThanOrEqual(40);
    expect(Array.from(narrative.advice).length).toBeLessThanOrEqual(40);
    expect(Array.from(narrative.whyNow).length).toBeLessThanOrEqual(40);
    expect(Array.from(narrative.happened).length + Array.from(narrative.advice).length + Array.from(narrative.whyNow).length)
      .toBeLessThanOrEqual(120);
    expect(Array.from(narrative.impact).length).toBeLessThanOrEqual(30);
    expect(narrative.adviceFull.length).toBeGreaterThan(narrative.advice.length);
  });

  it('caps evidence at three lines of 40 characters and reports the rest', () => {
    const notes = ['一', '二', '三', '四', '五'].map((prefix) => ({
      sourceRef: prefix,
      note: `${prefix}、这是第一条可核对的事实，内容比较长需要被截断处理`,
    }));
    const item: ReviewItem = {
      id: 'd:rulecode:test',
      kind: 'decision',
      title: '共享配置改动前，先写影响说明',
      createdAt: '2026-11-12T10:41:00.000Z',
      decision: decision({
        review: {
          brief: {
            kind: 'rollout',
            formationEvidence: {
              version: '1',
              diagnosis: { rootCause: null, summary: '你在改共享配置时，先改了文件，后补说明。', evidence: notes },
            },
            requiredChanges: [],
          },
          evidence: {
            completeness: 'complete',
            deterministicChecks: [],
            items: [],
            digest: 'digest',
          },
          capability: { acceptRequirement: { kind: 'none' } },
        } as never,
      }),
    };

    const narrative = deriveReviewNarrative(item, translate);
    expect(narrative.evidence.length).toBe(3);
    for (const line of narrative.evidence) expect(Array.from(line).length).toBeLessThanOrEqual(40);
    expect(narrative.evidenceMore).toBe(2);
  });

  it('never puts identifiers or paths in the first layer', () => {
    const item: ReviewItem = {
      id: 'a:apr-1',
      kind: 'approval',
      title: '回复先说结论',
      createdAt: '2026-11-11T10:20:00.000Z',
      approval: { group: approvalGroup(), record: approvalGroup().records[0]! },
    };
    const narrative = deriveReviewNarrative(item, translate);
    for (const text of [narrative.heading, narrative.happened, narrative.advice, narrative.impact]) {
      expect(looksTechnical(text)).toBe(false);
    }
    expect(narrative.heading).toBe('回复先说结论');
    expect(narrative.execution.length).toBeGreaterThanOrEqual(2);
    for (const line of narrative.execution) expect(Array.from(line).length).toBeLessThanOrEqual(30);
    // Identifiers live only in the technical disclosure.
    expect(narrative.technical.map((row) => row.value)).toContain('p-002');
  });

  it('uses the machine grouping key never as a title', () => {
    const group = approvalGroup({ principleTitle: 'unlinked:artifact-1', candidateDescription: undefined });
    const item: ReviewItem = {
      id: 'a:apr-1',
      kind: 'approval',
      title: group.principleTitle,
      createdAt: '2026-11-11T10:20:00.000Z',
      approval: { group, record: group.records[0]! },
    };
    expect(deriveReviewNarrative(item, translate).heading).toBe('一条待判断的原则');
  });

  it('flags technical-looking source text', () => {
    expect(looksTechnical('8f2c1c1e-1111-4222-8333-444455556666')).toBe(true);
    expect(looksTechnical('D:\\Code\\principles\\state.db')).toBe(true);
    expect(looksTechnical('code_tool_hook')).toBe(true);
    expect(looksTechnical('你在改共享配置时，先改了文件，后补说明。')).toBe(false);
  });
});

describe('review queue order (B2-01)', () => {
  // Local-time construction: "today" is the Owner's calendar day, not UTC.
  const now = new Date(2026, 10, 12, 20, 0, 0);
  const todayMorning = new Date(2026, 10, 12, 9, 0, 0).toISOString();
  const todayNoon = new Date(2026, 10, 12, 11, 0, 0).toISOString();
  const yesterday = new Date(2026, 10, 11, 9, 0, 0).toISOString();

  it('puts today first, then leftovers, each oldest first', () => {
    const items = buildReviewItems([
      decision({ reviewKey: 'a', createdAt: todayMorning, title: '今天早' }),
      decision({ reviewKey: 'b', createdAt: yesterday, title: '昨天' }),
      decision({ reviewKey: 'c', createdAt: todayNoon, title: '今天晚' }),
    ], null);
    const queue = splitReviewQueue(items, now);
    expect(queue.ordered.map((item) => item.title)).toEqual(['今天早', '今天晚', '昨天']);
  });

  it('shows one card for a deployment approval instead of duplicating the decision projection', () => {
    const items = buildReviewItems([
      decision({
        reviewKey: 'apr:1',
        kind: 'activation_approval',
        principleId: 'p-002',
        createdAt: '2026-11-12T09:00:00.000Z',
      }),
      decision({
        reviewKey: 'rulecode:shadow',
        kind: 'rulecode_decision',
        createdAt: '2026-11-12T09:30:00.000Z',
      }),
    ], { groups: [approvalGroup()], generatedAt: '2026-11-12T09:00:00.000Z' });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('approval');
    expect(items[0]!.approval?.record.id).toBe('apr-1');
  });
});

describe('session memory validation (rc-1..rc-5)', () => {
  it('accepts a well-formed session', () => {
    const value = {
      date: localDateKey(),
      queueIds: ['d:a'],
      currentIndex: 0,
      skippedIds: [],
      decisions: [{ id: 'd:a', action: 'approve', at: '2026-11-12T10:00:00.000Z' }],
      lastSeenAt: '2026-11-12T10:00:00.000Z',
    };
    expect(validateReviewSession(value)).toEqual(value);
  });

  it('rejects malformed payloads instead of half-reading them', () => {
    expect(validateReviewSession(null)).toBeNull();
    expect(validateReviewSession({})).toBeNull();
    expect(validateReviewSession({
      date: '2026-11-12', queueIds: [1], currentIndex: 0, skippedIds: [], decisions: [], lastSeenAt: 'x',
    })).toBeNull();
    expect(validateReviewSession({
      date: '2026-11-12', queueIds: [], currentIndex: -1, skippedIds: [], decisions: [], lastSeenAt: 'x',
    })).toBeNull();
    expect(validateReviewSession({
      date: '2026-11-12',
      queueIds: [],
      currentIndex: 0,
      skippedIds: [],
      decisions: [{ id: 'd:a', action: 'skip', at: 'x' }],
      lastSeenAt: 'x',
    })).toBeNull();
  });
});
