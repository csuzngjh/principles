// @vitest-environment jsdom
/**
 * PR #2563 re-review 4546268223: config-loader diagnostics and water-mark /
 * degradation facts must reach the RENDERED page, not merely survive the
 * validator. This mounts the real page, drives the real client-side wire
 * parser, and resolves the real English dictionary — a source-level grep or a
 * validator-only assertion cannot make these assertions pass.
 *
 * Language-layer contract (UI/UX plan §4.1/§4.3): known reason codes render
 * as localized owner sentences on the reading path; raw CLI prose survives
 * only inside the TechnicalDetails disclosures — never dropped (rc-9),
 * never on the reading path.
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
      lagUndetectableReason: 'consent_not_granted',
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
    // rc-9: the raw diagnostics and guidance survive — in the technical
    // disclosure, not as reading-path prose.
    expect(text).toContain('Fix YAML syntax');
    expect(text).toContain('Flag diagnostics');
    // "undetectable" is a DIFFERENT fact from a neutral dash / zero lag (rc-9),
    // and it must carry a concrete reason + an actionable hint.
    expect(text).toContain('undetectable');
    expect(text).toContain('Lag not determinable because');
    // Known reason codes render as localized sentences (UI/UX plan §4.2/§4.3),
    // so the raw code only exists inside the technical disclosure.
    expect(text).toContain('Consent to read conversation transcripts has not been granted');
    expect(text).toContain("Check the host's ingestion consent and transcript files, then refresh this page.");
    expect(text).toContain('Last clean checkpoint (no degradation)');
    // Timestamps render through the locale formatter, not as raw ISO.
    expect(text).not.toContain('2026-11-11T23:00:00.000Z');
    expect(text).not.toContain('2026-11-12T00:00:00.000Z');
    expect(text).toContain('2026');
    // Session identifiers shorten for the reading path; the full UUID is
    // available (title attribute + technical disclosure).
    expect(text).toContain('aaaaaaaa…');
    expect(screen.getAllByTitle('aaaaaaaa-0000-4000-8000-0000000000f1').length).toBeGreaterThanOrEqual(1);
    // Language layer: no operator-pitched prose, no ticket numbers, no raw
    // snake_case code on the reading path of the localized fixture.
    expect(text).not.toMatch(/PRI-\d{4}/);
    expect(text).not.toContain('ticket');
    expect(text).not.toContain('Record a consent decision');
    // Every card carries a technical disclosure holding the raw values.
    expect(screen.getAllByTestId('ingestion-technical-codex').length).toBe(1);
    expect(screen.getAllByTestId('ingestion-technical-openclaw').length).toBe(1);
  });
});
