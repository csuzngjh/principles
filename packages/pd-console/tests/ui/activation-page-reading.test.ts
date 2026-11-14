// @vitest-environment jsdom
/**
 * 生效页阅读版式回归（PR #2646，Owner 决策 B）。
 *
 * 版式采用本 PR 的精简版本：无摘要行、无统一 Hero 页头、待上线与已激活各自
 * 独立分区。主线 #2645 中与版式无关的正确性修复仍然保留，因此这里锁的是：
 * 1. 加载/失败/成功共用同一外壳与同一页头（失败不换一套外观）。
 * 2. 待上线与已激活是各自独立的分区；没有待上线规则时该分区不渲染，也不存在
 *    隐藏的分栏外壳（本 PR 版式没有两栏）。
 * 3. PRI-590 的"页面级"证据覆盖披露留在页面级，不被塞进"已激活"分区。
 * 4. F.5 能力边界声明始终可见，且不在任何分区内部。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ActivationPage } from '../../src/ui/pages/activation/ActivationPage.js';
import type { ActivationRecordData } from '../../src/ui/api.js';

const { tStub, i18nStub, mockFetchAllActivations } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'pages.activation.title': 'Activation Status',
    'pages.activation.subtitle': 'Which approved principles are actually in effect?',
    'pages.activation.sectionActive': 'Active principles',
    'pages.activation.sectionInactive': 'Inactive principles',
    'pages.activation.sectionNeverActivated': 'Approved but never activated',
    'pages.activation.pendingRules': 'Rules awaiting live decision',
    'pages.activation.pendingRulesDescription': 'Shadow Observation has produced a separate queue.',
    'pages.activation.emptyPendingRules': 'No shadow-observed rules are awaiting rollout right now.',
    'pages.activation.emptyActive': 'No active principles yet.',
    'pages.activation.loadError': 'Failed to load activation status',
    'pages.activation.compatibilityScanTitle': 'Rule compatibility scan',
    'pages.activation.compatibilityScanEmpty': 'No unscannable rows were found.',
    'pages.activation.boundaryLabel': 'Capability boundary',
    'pages.activation.boundaryText': 'Counts are retention-bounded and may include agent self-reports.',
  };
  const t = (key: string) => translations[key] ?? key;
  return { tStub: t, i18nStub: { language: 'en' }, mockFetchAllActivations: vi.fn() };
});

const RECEIPT_COUNTS_OK = {
  success: true,
  data: {
    status: 'ok',
    counts: [{ principleId: 'p-active', effectCount: 1, presenceCount: 2, lastEffectAt: null }],
    coverage: {
      sourceStatus: 'available',
      validationStatus: 'valid',
      observedFrom: '2026-11-01T00:00:00.000Z',
      asOf: '2026-11-14T00:00:00.000Z',
      retentionPolicyDays: 30,
    },
  },
};

vi.mock('../../src/ui/api.js', () => ({
  fetchAllActivations: () => mockFetchAllActivations(),
  fetchReceiptCounts: vi.fn(async () => RECEIPT_COUNTS_OK),
  fetchLifecycleMetrics: vi.fn(async () => ({ success: false, error: 'not used' })),
  fetchOwnerDecisionLibrary: vi.fn(async () => ({ success: false, error: 'not used' })),
  fetchCompatibilityScan: vi.fn(async () => ({ success: false, error: 'not used' })),
  disableActivation: vi.fn(),
  fetchRuleCodeOwnerReview: vi.fn(async () => ({ success: true, data: null })),
  fetchApprovedRuleRevisionPreview: vi.fn(),
  reviseApprovedRuleOnce: vi.fn(),
  proposePromptRevision: vi.fn(),
  ruleCodeDecision: vi.fn(),
  pauseAllRuleCode: vi.fn(),
  releaseRuleCodePause: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tStub, i18n: i18nStub }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

afterEach(cleanup);

beforeEach(() => {
  mockFetchAllActivations.mockReset();
  // jsdom ships no `matchMedia`; ShinyText calls it inside an effect.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

function activationRecord(overrides: Partial<ActivationRecordData>): ActivationRecordData {
  return {
    activationId: 'act-1',
    artifactId: 'artifact-1',
    principleId: 'p-active',
    channel: 'prompt',
    action: 'prompt_injection_activate',
    targetRef: 'prompt://p-active',
    activatedAt: '2026-11-01T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

const PENDING_RULE = activationRecord({
  activationId: 'act-pending',
  principleId: 'p-pending',
  channel: 'code_tool_hook',
  action: 'code_tool_hook_shadow_activate',
  targetRef: 'impl://rule-pending',
});

function renderPage(records: ActivationRecordData[]) {
  mockFetchAllActivations.mockResolvedValue({
    success: true,
    data: { activations: records, status: 'ok' },
  });
  return render(createElement(MemoryRouter, null, createElement(ActivationPage)));
}

describe('ActivationPage — 加载失败与成功共用外壳与页头', () => {
  it('失败态与成功态使用同一 PageShell 与同一页头（失败不换一套外观）', async () => {
    const loaded = renderPage([activationRecord({})]);
    await screen.findByTestId('activation-card-act-1');
    const loadedShellClass = (loaded.container.firstElementChild as HTMLElement).className;
    const loadedTitle = loaded.container.querySelector('h1')?.textContent;
    expect(loadedTitle).toBe('Activation Status');
    // 本 PR 版式没有统一 Hero/木刻页头。
    expect(loaded.container.querySelector('.governance-reading-header')).toBeNull();
    loaded.unmount();

    mockFetchAllActivations.mockResolvedValue({ success: false, error: 'api_unreachable' });
    const failed = render(createElement(MemoryRouter, null, createElement(ActivationPage)));
    await screen.findByTestId('activation-error-state');

    const failedShellClass = (failed.container.firstElementChild as HTMLElement).className;
    expect(failedShellClass).toBe(loadedShellClass);
    expect(failed.container.querySelector('h1')?.textContent).toBe(loadedTitle);
  });
});

describe('ActivationPage — 待上线与已激活各自独立分区', () => {
  it('有待上线规则时，两个分区是同级 section，不存在隐藏的分栏外壳', async () => {
    renderPage([PENDING_RULE, activationRecord({})]);

    await screen.findByTestId('activation-card-act-pending');
    const pending = document.querySelector('section[aria-labelledby="section-pending-rulecode"]');
    const active = document.querySelector('section[aria-labelledby="section-active"]');
    expect(pending).not.toBeNull();
    expect(active).not.toBeNull();
    expect(pending!.parentElement).toBe(active!.parentElement);
    expect(document.querySelector('.activation-reading-columns')).toBeNull();
    expect(document.querySelector('.activation-reading-region')).toBeNull();
  });

  it('没有待上线规则时该分区不渲染，已激活分区仍给出显式空态', async () => {
    renderPage([activationRecord({ status: 'inactive' })]);

    await screen.findByTestId('activation-card-act-1');
    expect(document.querySelector('section[aria-labelledby="section-pending-rulecode"]')).toBeNull();
    expect(document.querySelector('section[aria-labelledby="section-active"]')).not.toBeNull();
    expect(screen.getByText('No active principles yet.')).toBeTruthy();
    expect(document.querySelector('.activation-reading-columns')).toBeNull();
  });
});

describe('ActivationPage — PRI-590 覆盖披露保持页面级', () => {
  it('披露块不在"已激活"分区内，且排在它之前', async () => {
    renderPage([PENDING_RULE, activationRecord({})]);

    const disclosure = await screen.findByTestId('receipt-counts-coverage');
    const activeSection = document.querySelector('section[aria-labelledby="section-active"]');
    expect(activeSection).not.toBeNull();

    expect(activeSection!.contains(disclosure)).toBe(false);
    // Document order: the page-level disclosure precedes the active section.
    expect(disclosure.compareDocumentPosition(activeSection!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('ActivationPage — F.5 能力边界声明常显', () => {
  it('加载成功时声明存在，且不属于任何治理分区', async () => {
    renderPage([activationRecord({})]);

    await screen.findByTestId('activation-card-act-1');
    const declaration = screen.getByRole('note', { name: 'Capability boundary' });
    expect(declaration.textContent).toContain('retention-bounded');
    expect(declaration.closest('section')).toBeNull();
  });
});
