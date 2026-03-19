// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { App } from '../../ui/src/App';

describe('Principles Console App', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  it('renders the overview page inside the plugin basename', async () => {
    window.history.replaceState({}, '', '/plugins/principles/overview');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/overview')) {
        return Promise.resolve(new Response(JSON.stringify({
          workspaceDir: '/workspace',
          generatedAt: '2026-03-19T10:00:00.000Z',
          dataFreshness: '2026-03-19T10:00:00.000Z',
          summary: {
            repeatErrorRate: 0.2,
            userCorrectionRate: 0.1,
            pendingSamples: 2,
            approvedSamples: 1,
            thinkingCoverageRate: 0.4,
            painEvents: 3,
            principleEventCount: 5,
          },
          dailyTrend: [],
          topRegressions: [],
          sampleQueue: { counters: { pending: 2 }, preview: [] },
          thinkingSummary: { activeModels: 2, dormantModels: 7, effectiveModels: 1, coverageRate: 0.4 },
        }), { status: 200 }));
      }

      return Promise.resolve(new Response(JSON.stringify({
        summary: { totalModels: 0, activeModels: 0, dormantModels: 0, effectiveModels: 0, coverageRate: 0 },
        topModels: [],
        dormantModels: [],
        effectiveModels: [],
        scenarioMatrix: [],
        coverageTrend: [],
      }), { status: 200 }));
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Workspace health and queue pressure')).toBeTruthy();
      expect(screen.getByText('Pending Samples')).toBeTruthy();
    });
  });
});
