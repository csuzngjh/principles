// @vitest-environment jsdom
/**
 * 行为证据页阅读版式回归（PR #2645 评审 P3-7 / 测试缺口）。
 *
 * 本文件只锁两件"默认阅读行为"，它们此前没有任何测试，改坏也不会被 CI 发现：
 * 1. 触发行为与 PD 结论是同一句话时，不得把同一句话显示两次（去重）。
 * 2. 适用说明与置信度属于第二层信息，必须默认折叠在 <details> 内。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PainPage } from '../../src/ui/pages/pain/PainPage.js';
import type { EvidenceChainData, EvidenceChainRecordData } from '../../src/ui/api.js';

const { tStub, i18nStub, mockFetchEvidenceChain } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'pages.pain.title': 'Behavior Evidence',
    'pages.pain.description': 'Only behavior evidence worth governing enters review.',
    'pages.pain.coverageDisclosure': 'View evidence sources and known limits',
    'pages.pain.honestyNote': 'Evidence comes from real behavior signals.',
    'pages.pain.fieldConclusion': 'PD conclusion',
    'pages.pain.fieldApplicability': 'Applicability',
    'pages.pain.fieldConfidence': 'Confidence',
    'pages.pain.analysisDisclosure': 'View applicability and confidence',
    'pages.pain.group_active_chain': 'Active chain',
    'pages.pain.group_evidence_only': 'Observed only',
    'pages.pain.group_failed': 'Failed',
    'pages.pain.generatedAt': 'Generated at',
    'pages.pain.expandTechDetails': 'Technical details',
    'pages.pain.copyDebugId': 'Copy debug id',
  };
  const t = (key: string) => translations[key] ?? key;
  return { tStub: t, i18nStub: { language: 'en' }, mockFetchEvidenceChain: vi.fn() };
});

vi.mock('../../src/ui/api.js', () => ({
  fetchEvidenceChain: () => mockFetchEvidenceChain(),
  fetchAssistantTurn: vi.fn(async () => ({ success: false, error: 'not used' })),
  recordIntentDecision: vi.fn(),
  listIntentDecisionsByPainId: vi.fn(async () => ({ success: true, data: [] })),
  listIntentDecisionsByTaskId: vi.fn(async () => ({ success: true, data: [] })),
  dispatchFollowUp: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tStub, i18n: i18nStub }),
  // PainPage imports the real i18n singleton, which calls i18n.use(initReactI18next).
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

afterEach(cleanup);

beforeEach(() => {
  mockFetchEvidenceChain.mockReset();
});

function evidenceRecord(overrides: Partial<EvidenceChainRecordData>): EvidenceChainRecordData {
  return {
    id: 'pain-reading-1',
    sourceKind: 'tool_call',
    observedAt: '2026-11-14T02:00:00.000Z',
    state: 'evidence-only',
    summary: 'Agent edited files outside the agreed scope.',
    ...overrides,
  };
}

function chain(records: EvidenceChainRecordData[]): EvidenceChainData {
  return { records, generatedAt: '2026-11-14T02:05:00.000Z' };
}

async function renderPage(data: EvidenceChainData) {
  mockFetchEvidenceChain.mockResolvedValue({ success: true, data });
  const view = render(createElement(MemoryRouter, null, createElement(PainPage)));
  await screen.findByTestId(`pain-record-${data.records[0].id}`);
  return view;
}

describe('PainPage — PD 结论与触发行为去重', () => {
  it('结论与触发行为逐字相同（仅空白不同）时不重复渲染结论块', async () => {
    await renderPage(chain([
      evidenceRecord({
        summary: 'Agent edited files outside the agreed scope.',
        candidateTitle: '  Agent edited files outside the agreed scope.  ',
      }),
    ]));

    expect(screen.getByTestId('pain-record-pain-reading-1')).toBeTruthy();
    expect(screen.queryByText('PD conclusion')).toBeNull();
  });

  it('结论与触发行为不同时仍然渲染结论块', async () => {
    await renderPage(chain([
      evidenceRecord({
        summary: 'Agent edited files outside the agreed scope.',
        candidateTitle: 'Scope agreement is checked after the edit, not before it.',
      }),
    ]));

    expect(screen.getByText('PD conclusion')).toBeTruthy();
    expect(screen.getByText('Scope agreement is checked after the edit, not before it.')).toBeTruthy();
  });
});

describe('PainPage — 适用说明与置信度默认折叠', () => {
  it('适用说明与置信度位于默认关闭的 <details> 内（第二层信息不占默认阅读面）', async () => {
    await renderPage(chain([
      evidenceRecord({
        candidateSummary: 'Applies to multi-file edits in the workspace root.',
        confidence: 0.82,
      }),
    ]));

    const applicability = screen.getByText('Applies to multi-file edits in the workspace root.');
    const details = applicability.closest('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toContain('View applicability and confidence');

    // Confidence is in the same collapsed block, not a separate visible row.
    const confidenceLabel = screen.getByText('Confidence');
    expect(confidenceLabel.closest('details')).toBe(details);
  });

  it('两者都不存在时不渲染折叠块（不出现空的可展开项）', async () => {
    await renderPage(chain([evidenceRecord({})]));

    expect(screen.queryByText('View applicability and confidence')).toBeNull();
  });
});
