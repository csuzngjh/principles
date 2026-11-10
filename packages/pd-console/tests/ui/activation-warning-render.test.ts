// @vitest-environment jsdom
/**
 * 5B-D: per-row server degradation must reach the rendered card.
 *
 * The server has always computed `warning` for an activation whose artifact
 * row is gone; the browser whitelist (`validateActivationRecord`) dropped the
 * field, so the row rendered as healthy. These assertions mount the REAL card
 * and the REAL wire parser — a passing source-level grep would not prove the
 * data reaches the page.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ActivationFactCard } from '../../src/ui/pages/activation/ActivationPage.js';
import { validateActivations } from '../../src/ui/utils/validators.js';

// The card loads its owner-review panel on mount; a bare vi.fn() would resolve
// `undefined` and throw outside the assertions.
vi.mock('../../src/ui/api.js', () => ({
  fetchAllActivations: vi.fn(),
  disableActivation: vi.fn(),
  fetchLifecycleMetrics: vi.fn(),
  fetchReceiptCounts: vi.fn(),
  fetchRuleCodeOwnerReview: vi.fn(async () => ({ success: true, data: null })),
  fetchApprovedRuleRevisionPreview: vi.fn(),
  reviseApprovedRuleOnce: vi.fn(),
  proposePromptRevision: vi.fn(),
  ruleCodeDecision: vi.fn(),
  pauseAllRuleCode: vi.fn(),
  releaseRuleCodePause: vi.fn(),
}));

// The copy is irrelevant to reachability: resolve keys to their defaultValue.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

afterEach(cleanup);

function makeRecord(overrides?: Record<string, unknown>) {
  return {
    activationId: 'act-1',
    artifactId: 'artifact-missing',
    principleId: 'principle-1',
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: 'impl://rule-1',
    activatedAt: '2026-06-01T10:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

function renderCard(record: Record<string, unknown>) {
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(ActivationFactCard, {
        record,
        lifecycleData: null,
        onDisable: () => undefined,
        disabling: false,
        onChanged: () => undefined,
      }),
    ),
  );
}

describe('ActivationFactCard — per-row warning (5B-D)', () => {
  it('renders the server warning text for the row that carries it', () => {
    const warning = 'artifact_id "artifact-missing" does not exist in pi_artifacts - activation is orphaned';
    renderCard(makeRecord({ warning }));
    const block = screen.getByTestId('activation-warning-act-1');
    expect(block.textContent).toContain(warning);
    expect(block.getAttribute('role')).toBe('alert');
  });

  it('renders no warning block when the row is healthy', () => {
    renderCard(makeRecord());
    expect(screen.queryByTestId('activation-warning-act-1')).toBeNull();
  });
});

describe('validateActivations — warning survives the browser whitelist (5B-D)', () => {
  const base = {
    activations: [makeRecord({ warning: 'activation is orphaned' })],
    status: 'ok',
  };

  it('preserves a non-empty warning string', () => {
    const parsed = validateActivations(base);
    expect(parsed?.activations[0]).toMatchObject({ warning: 'activation is orphaned' });
  });

  it('drops a malformed warning instead of rendering garbage', () => {
    const parsed = validateActivations({
      ...base,
      activations: [makeRecord({ warning: { text: 'nope' } })],
    });
    expect(parsed?.activations[0]?.warning).toBeUndefined();
  });

  it('drops an empty warning string', () => {
    const parsed = validateActivations({ ...base, activations: [makeRecord({ warning: '   '.trim() })] });
    expect(parsed?.activations[0]?.warning).toBeUndefined();
  });
});
