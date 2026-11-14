// @vitest-environment jsdom
/**
 * 5B: the explainable promotion projection must reach the rendered page.
 *
 * The server (core evaluator → Console model → route) now carries
 * `readiness.criteria`; the browser whitelist used to drop unknown fields and
 * the page only rendered `safetyGateResults`. These assertions mount the REAL
 * card and the REAL wire parser, and resolve the REAL English dictionary, so a
 * source-level grep would not be enough to pass.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ActivationFactCard } from '../../src/ui/pages/activation/ActivationPage.js';

const { reviewFixture } = vi.hoisted(() => ({
  reviewFixture: {
    activation: { activationId: 'act-1', artifactId: 'artifact-1', action: 'code_tool_hook_shadow_activate' },
    artifact: { artifactId: 'artifact-1', digest: 'sha256:artifact-1', content: {} },
    readiness: {
      status: 'blocked',
      evaluationId: 'eval-1',
      failedChecks: [{ checkId: 'golden_trace', reasonCode: 'hard_check_failed' }],
      criteria: [
        { criterionId: 'activation_eligibility', kind: 'hard_check', status: 'passed' },
        { criterionId: 'golden_trace', kind: 'hard_check', status: 'failed', reasonCode: 'hard_check_failed' },
        { criterionId: 'bounded_scope', kind: 'hard_check', status: 'not_evaluated' },
        { criterionId: 'shadow_observed', kind: 'evidence', status: 'failed', current: 19, threshold: 20, shortfall: 1 },
      ],
      evidenceSnapshot: {
        snapshotDigest: 'sha256:snapshot',
        shadowSummary: {
          observed: 19, matched: 12, wouldBlock: 2, wouldAllow: 10, requireApproval: 0,
          autoCorrect: 0, errors: 0, neutralControl: 3,
          firstObservedAt: '2026-06-01T10:00:00.000Z', lastObservedAt: '2026-06-02T10:00:00.000Z',
        },
        safetyGateResults: [{ checkId: 'golden_trace', status: 'failed', reasonCode: 'hard_check_failed' }],
      },
    },
    controlState: { enforcement: 'eligible', version: 1 },
    globalPause: null,
    decisions: [],
    ownerDecisionEnabled: true,
    runtimeCapability: { hostRuntimeVersion: 'openclaw-legacy@1', shadowEvidence: true },
    liveMetrics: {
      last24Hours: { eligible: null, matched: null, blocked: null, unhealthy: null, circuitTrips: 0, toolDistribution: null },
      last7Days: { eligible: null, matched: null, blocked: null, unhealthy: null, circuitTrips: 0, toolDistribution: null },
      representativeSamples: [],
    },
    behaviorDrift: { approvedBlockRate: null, liveBlockRate: null, delta: null },
  },
}));

vi.mock('../../src/ui/api.js', () => ({
  fetchAllActivations: vi.fn(),
  disableActivation: vi.fn(),
  fetchLifecycleMetrics: vi.fn(),
  fetchReceiptCounts: vi.fn(),
  fetchRuleCodeOwnerReview: vi.fn(async () => ({ success: true, data: reviewFixture })),
  fetchApprovedRuleRevisionPreview: vi.fn(),
  reviseApprovedRuleOnce: vi.fn(),
  proposePromptRevision: vi.fn(),
  ruleCodeDecision: vi.fn(),
  pauseAllRuleCode: vi.fn(),
  releaseRuleCodePause: vi.fn(),
}));

// Resolve the REAL English dictionary so the test also proves the copy exists
// and interpolates, not just that a key was passed.
vi.mock('react-i18next', async () => {
  const en = (await import('../../src/ui/i18n/en.json')).default as Record<string, unknown>;
  const resolve = (key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), en);
  return {
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string } & Record<string, unknown>) => {
        const value = resolve(key);
        const text = typeof value === 'string' ? value : (options?.defaultValue ?? key);
        return text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''));
      },
      i18n: { language: 'en' },
    }),
  };
});

afterEach(() => { cleanup(); reviewFixture.ownerDecisionEnabled = true; });

function makeRecord(): Record<string, unknown> {
  return {
    activationId: 'act-1',
    artifactId: 'artifact-1',
    principleId: 'principle-1',
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: 'impl://rule-1',
    activatedAt: '2026-06-01T10:00:00.000Z',
    status: 'active',
  };
}

describe('ActivationFactCard — promotion criteria (5B)', () => {
  it('renders each criterion, its reason, and the evidence shortfall', async () => {
    const { container } = render(
      createElement(
        MemoryRouter,
        null,
        createElement(ActivationFactCard, {
          record: makeRecord(),
          lifecycleData: null,
          onDisable: () => undefined,
          disabling: false,
          onChanged: () => undefined,
        }),
      ),
    );

    await screen.findByTestId('activation-check-summary');
    const disclosure = screen.getByText('View runtime evidence').closest('details');
    expect(disclosure?.open).toBe(false);
    fireEvent.click(screen.getByText('View runtime evidence'));
    expect(disclosure?.open).toBe(true);
    const text = container.textContent ?? '';
    expect(text).toContain('Activation Eligibility: Passed');
    expect(text).toContain('Golden Trace Evaluation: Failed · Hard safety check failed');
    expect(text).toContain('Bounded Tool Scope: Not evaluated');
    expect(text).toContain('Shadow samples observed: 19 / 20 · shortfall 1');
  });

  it('removes unavailable decision inputs and keeps emergency stop when decisions are disabled', async () => {
    reviewFixture.ownerDecisionEnabled = false;
    render(createElement(MemoryRouter, null, createElement(ActivationFactCard, {
      record: makeRecord(),
      lifecycleData: null,
      onDisable: () => undefined,
      disabling: false,
      onChanged: () => undefined,
    })));
    await screen.findByTestId('activation-check-summary');
    expect(screen.queryByRole('textbox')).toBeNull();
    const stop = screen.getByRole('button', { name: /emergency/i });
    expect(stop.hasAttribute('disabled')).toBe(false);
    expect(screen.getAllByText('View runtime evidence')).toHaveLength(1);
  });
});
