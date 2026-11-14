// @vitest-environment jsdom
/**
 * 生效页阅读版式回归（PR #2645 评审 P2-2 / P3-3 / P3-4 / P3-5）。
 *
 * 这些断言各自拦住一类已发生过的回归：
 * 1. 两栏由容器宽度决定，且每栏不低于 640px 阅读下限（不是 96rem 视口媒体查询）。
 * 2. 分栏容器恒定存在：待上线列表增删不会让"已激活"在整栏/半栏之间跳。
 * 3. 加载失败与加载成功共用同一外壳与页头（失败不换一套外观）。
 * 4. PRI-590 的"页面级"证据覆盖披露留在页面级，不被塞进"已激活"分区。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ActivationPage } from '../../src/ui/pages/activation/ActivationPage.js';
import type { ActivationRecordData } from '../../src/ui/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/pd-console/tests/ui
const SRC_ROOT = join(__dirname, '..', '..', 'src', 'ui');

const { tStub, i18nStub, mockFetchAllActivations } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'pages.activation.title': 'Activation Status',
    'pages.activation.subtitle': 'Which approved principles are actually in effect?',
    'pages.activation.summaryActive': 'active',
    'pages.activation.summaryInactive': 'inactive',
    'pages.activation.summaryNeverActivated': 'never activated',
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

describe('ActivationPage — 两栏阅读宽度契约', () => {
  const css = readFileSync(join(SRC_ROOT, 'styles', 'globals.css'), 'utf-8');

  it('由容器宽度触发分栏，且每栏不低于 640px 阅读下限', () => {
    // No viewport media query may own this class: the shell caps the content
    // width, so a viewport rule produced 520px columns on a 1536px window.
    expect(css).not.toMatch(/@media[^{]*\{[^}]*\.activation-reading-columns/);

    const rule = /@container \(min-width: ([\d.]+)rem\)\s*\{\s*\.activation-reading-columns\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, ([\d.]+)rem\)\)/.exec(css);
    expect(rule, 'missing container-query split rule').not.toBeNull();

    const gap = /\.activation-reading-columns\s*\{[^}]*gap: ([\d.]+)rem/.exec(css);
    expect(gap, 'missing column gap').not.toBeNull();

    const minContainerPx = Number(rule![1]) * 16;
    const gapPx = Number(gap![1]) * 16;
    const columnCapPx = Number(rule![2]) * 16;
    const columnPx = (minContainerPx - gapPx) / 2;

    // PageShell documents a 640–760px reading measure; the split must keep it.
    expect(columnPx).toBeGreaterThanOrEqual(640);
    expect(columnCapPx).toBeLessThanOrEqual(760);
  });

  it('页面内容宽度用 table 档（分栏所需容器宽度只能由它提供）', () => {
    const page = readFileSync(join(SRC_ROOT, 'pages', 'activation', 'ActivationPage.tsx'), 'utf-8');
    const shells = page.match(/<PageShell[^>]*>/g) ?? [];
    expect(shells.length).toBeGreaterThan(0);
    for (const shell of shells) expect(shell).toContain('width="table"');
  });
});

describe('ActivationPage — 分栏容器恒定', () => {
  it('没有待上线规则时，分栏容器仍在，并给出显式空态而不是塌成整栏', async () => {
    renderPage([activationRecord({})]);

    await screen.findByTestId('activation-card-act-1');
    const columns = document.querySelector('.activation-reading-columns');
    expect(columns).not.toBeNull();
    expect(document.querySelector('.activation-reading-region')?.contains(columns!)).toBe(true);
    expect(columns!.querySelectorAll('section').length).toBe(2);
    expect(screen.getByText('No shadow-observed rules are awaiting rollout right now.')).toBeTruthy();
  });

  it('有待上线规则时，两栏结构与无待上线时一致', async () => {
    renderPage([PENDING_RULE, activationRecord({})]);

    await screen.findByTestId('activation-card-act-pending');
    const columns = document.querySelector('.activation-reading-columns');
    expect(columns).not.toBeNull();
    expect(columns!.querySelectorAll('section').length).toBe(2);
    expect(screen.queryByText('No shadow-observed rules are awaiting rollout right now.')).toBeNull();
  });
});

describe('ActivationPage — 加载失败与成功共用外壳', () => {
  it('失败态与成功态使用同一 PageShell 宽度与同一页头', async () => {
    const loaded = renderPage([activationRecord({})]);
    await screen.findByTestId('activation-card-act-1');
    const loadedShellClass = (loaded.container.firstElementChild as HTMLElement).className;
    expect(loaded.container.querySelector('.governance-reading-header')).not.toBeNull();
    loaded.unmount();

    mockFetchAllActivations.mockResolvedValue({ success: false, error: 'api_unreachable' });
    const failed = render(createElement(MemoryRouter, null, createElement(ActivationPage)));
    await screen.findByTestId('activation-error-state');

    const failedShellClass = (failed.container.firstElementChild as HTMLElement).className;
    expect(failedShellClass).toBe(loadedShellClass);
    expect(failed.container.querySelector('.governance-reading-header')).not.toBeNull();
  });
});

describe('ActivationPage — PRI-590 覆盖披露保持页面级', () => {
  it('披露块不在"已激活"分区内，且排在分栏容器之前', async () => {
    renderPage([PENDING_RULE, activationRecord({})]);

    const disclosure = await screen.findByTestId('receipt-counts-coverage');
    const activeSection = document.querySelector('section[aria-labelledby="section-active"]');
    const columns = document.querySelector('.activation-reading-columns');
    expect(activeSection).not.toBeNull();
    expect(columns).not.toBeNull();

    expect(activeSection!.contains(disclosure)).toBe(false);
    expect(columns!.contains(disclosure)).toBe(false);
    // Document order: the page-level disclosure precedes both reading columns.
    expect(disclosure.compareDocumentPosition(columns!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
