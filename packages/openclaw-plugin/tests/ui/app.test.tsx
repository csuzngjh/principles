// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { App } from '../../ui/src/App';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

describe('Principles Console App', () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  it('shows login page when not authenticated', async () => {
    window.history.replaceState({}, '', '/plugins/principles/');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Principles Console')).toBeTruthy();
      expect(screen.getByText('AI Agent 进化流程监控平台')).toBeTruthy();
    });
  });

  it('renders the overview page after successful login', async () => {
    window.history.replaceState({}, '', '/plugins/principles/overview');
    let overviewCallCount = 0;

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/api/central/overview') || url.includes('/api/overview')) {
        overviewCallCount++;
        const hasAuth = init?.headers && JSON.stringify(init.headers).includes('Bearer');

        if (hasAuth || overviewCallCount > 1) {
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
            centralInfo: { workspaceCount: 3, workspaces: ['workspace-main', 'workspace-builder', 'workspace-pm'] },
          }), { status: 200 }));
        }

        return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
      }

      return Promise.resolve(new Response(JSON.stringify({
        configs: [],
        workspaces: [],
        summary: { totalModels: 0, activeModels: 0, dormantModels: 0, effectiveModels: 0, coverageRate: 0 },
        topModels: [],
        dormantModels: [],
        effectiveModels: [],
        scenarioMatrix: [],
        coverageTrend: [],
      }), { status: 200 }));
    }));

    render(<App />);

    // Wait for login page
    await waitFor(() => {
      expect(screen.getByPlaceholderText('请输入您的 Gateway Token')).toBeTruthy();
    });

    // Enter token and submit
    const input = screen.getByPlaceholderText('请输入您的 Gateway Token');
    fireEvent.change(input, { target: { value: 'test-token-123' } });

    const loginButton = screen.getByRole('button', { name: /登 录/ });
    fireEvent.click(loginButton);

    // Wait for overview page
    await waitFor(() => {
      expect(screen.getByText('Workspace health and queue pressure')).toBeTruthy();
      expect(screen.getByText('Pending Samples')).toBeTruthy();
    }, { timeout: 5000 });
  });
});