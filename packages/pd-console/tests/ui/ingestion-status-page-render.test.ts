// @vitest-environment jsdom
/**
 * PR #2563 re-review 4546268223: config-loader diagnostics and water-mark /
 * degradation facts must reach the RENDERED page, not merely survive the
 * validator. This mounts the real page, drives the real client-side wire
 * parser, and resolves the real English dictionary — a source-level grep or a
 * validator-only assertion cannot make these assertions pass.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { fixture } = vi.hoisted(() => {
  const checkpointSession = {
    rolloutIdentity: 'aaaaaaaa-0000-4000-8000-0000000000f1',
    byteOffset: 1000,
    lagBytes: null,
    incompleteTail: false,
    lastDegradationReason: null,
    updatedAt: '2026-11-11T23:00:00.000Z',
  };
  const monitored = {
    status: 'monitored',
    hostFlag: {
      state: 'UNKNOWN', source: 'malformed',
      reason: 'YAML parse error in .pd/config.yaml', nextAction: 'Fix YAML syntax',
    },
    ingestionFlag: {
      state: 'UNKNOWN', source: 'malformed',
      reason: 'YAML parse error in .pd/config.yaml', nextAction: 'Fix YAML syntax',
    },
    consent: { state: 'not_present' },
    checkpoints: {
      total: 1,
      lastSuccessAt: '2026-11-11T23:00:00.000Z',
      checkpointOffset: 1000,
      lagBytes: null,
      lagUndetectable: true,
      incompleteTailCount: 0,
      lastDegradation: null,
      sessions: [checkpointSession],
      truncated: false,
    },
    liveOnly: { sessions: [], truncated: false },
  };
  return {
    fixture: {
      status: 'ok',
      snapshot: {
        generatedAt: '2026-11-12T00:00:00.000Z',
        workspace: '/synthetic/workspace',
        ingestion: {
          codex: monitored,
          workbuddy: monitored,
          openclaw: { status: 'not_wired', reason: 'p3', nextAction: 'na' },
        },
      },
    },
  };
});

// Drive the REAL client-side whitelist: if it drops reason/nextAction or
// lastSuccessAt again, the page simply cannot render those strings.
vi.mock('../../src/ui/api.js', async () => ({
  fetchIngestionHealth: async () => {
    const { validateIngestionHealth } = await import('../../src/ui/utils/validators.js');
    return { success: true, data: validateIngestionHealth(fixture) };
  },
}));

// Resolve the REAL English dictionary so the test also proves the copy exists.
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

import { IngestionStatusPage } from '../../src/ui/pages/ingestion-status/IngestionStatusPage.js';

afterEach(cleanup);

describe('IngestionStatusPage — degraded facts reach the rendered card', () => {
  it('renders UNKNOWN flag diagnostics, undetectable lag, the clean-checkpoint watermark and report freshness', async () => {
    const { container } = render(
      createElement(MemoryRouter, null, createElement(IngestionStatusPage)),
    );

    // Both monitored hosts carry the same malformed-config diagnostic, so
    // findByText (single match) would throw on a legitimate duplicate.
    const diagnostics = await screen.findAllByText(/YAML parse error in \.pd\/config\.yaml/);
    expect(diagnostics.length).toBeGreaterThanOrEqual(2);
    const text = container.textContent ?? '';
    expect(text).toContain('Fix YAML syntax');
    expect(text).toContain('Flag diagnostics');
    // "undetectable" is a DIFFERENT fact from a neutral dash / zero lag (rc-9).
    expect(text).toContain('undetectable');
    expect(text).toContain('Last clean checkpoint (no degradation)');
    expect(text).toContain('2026-11-11T23:00:00.000Z');
    expect(text).toContain('2026-11-12T00:00:00.000Z');
    expect(text).toContain('aaaaaaaa-0000-4000-8000-0000000000f1');
  });
});
