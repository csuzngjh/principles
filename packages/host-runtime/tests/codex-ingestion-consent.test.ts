import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_INGESTION_CONSENT_FILENAME,
  deriveCodexIngestionConsentState,
  getCodexIngestionConsentPath,
  readCodexIngestionConsent,
  recordCodexIngestionConsent,
} from '../src/codex-ingestion-consent.js';
import { CODEX_INGESTION_DISCLOSURE_VERSION } from '../src/codex-disclosure.js';

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-consent-'));
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('readCodexIngestionConsent', () => {
  it('returns not-present (existed=false, record=null) when no consent file exists', () => {
    const read = readCodexIngestionConsent(workspaceDir);
    expect(read).toEqual({ ok: true, existed: false, record: null });
  });

  it('round-trips a recorded decision', () => {
    const written = recordCodexIngestionConsent(workspaceDir, { decision: 'granted', decidedVia: 'pd_codex_setup' });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const read = readCodexIngestionConsent(workspaceDir);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.existed).toBe(true);
    expect(read.record).toEqual(written.record);
    expect(read.record?.disclosureVersion).toBe(CODEX_INGESTION_DISCLOSURE_VERSION);
  });

  it('fails loud on malformed JSON instead of degrading to never-asked (rc-3/rc-9)', () => {
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(getCodexIngestionConsentPath(workspaceDir), '{not json', 'utf8');
    const read = readCodexIngestionConsent(workspaceDir);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe('codex_ingestion_consent_malformed_json');
    expect(read.nextAction).toContain(CODEX_INGESTION_CONSENT_FILENAME);
  });

  it('fails loud on unknown fields, bad decision, bad timestamp, and bad schemaVersion', () => {
    const cases: Record<string, unknown>[] = [
      { decision: 'granted', disclosureVersion: 'g2a-2026-08-28', decidedAt: '2026-09-06T00:00:00Z', decidedVia: 'pd_codex_setup', schemaVersion: '1', extra: true },
      { decision: 'maybe', disclosureVersion: 'g2a-2026-08-28', decidedAt: '2026-09-06T00:00:00Z', decidedVia: 'pd_codex_setup', schemaVersion: '1' },
      { decision: 'granted', disclosureVersion: 'g2a-2026-08-28', decidedAt: 'not-a-date', decidedVia: 'pd_codex_setup', schemaVersion: '1' },
      { decision: 'granted', disclosureVersion: 'g2a-2026-08-28', decidedAt: '2026-09-06T00:00:00Z', decidedVia: 'pd_codex_setup', schemaVersion: '2' },
      { decision: 'granted', disclosureVersion: 'g2a-2026-08-28', decidedAt: '2026-09-06T00:00:00Z', decidedVia: 'hand_edit', schemaVersion: '1' },
    ];
    for (const invalid of cases) {
      fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
      fs.writeFileSync(getCodexIngestionConsentPath(workspaceDir), JSON.stringify(invalid), 'utf8');
      const read = readCodexIngestionConsent(workspaceDir);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.reason).toMatch(/^codex_ingestion_consent_malformed/);
        expect(read.nextAction.length).toBeGreaterThan(0);
      }
      fs.rmSync(getCodexIngestionConsentPath(workspaceDir), { force: true });
    }
  });
});

describe('recordCodexIngestionConsent', () => {
  it('creates the .pd directory if missing and writes atomically (no tmp litter)', () => {
    const written = recordCodexIngestionConsent(workspaceDir, { decision: 'declined', decidedVia: 'codex_plugin_setup' });
    expect(written.ok).toBe(true);
    const dirContents = fs.readdirSync(path.join(workspaceDir, '.pd'));
    expect(dirContents).toEqual([CODEX_INGESTION_CONSENT_FILENAME]);
  });

  it('overwrites a previous decision (re-consent after decline)', () => {
    recordCodexIngestionConsent(workspaceDir, { decision: 'declined', decidedVia: 'pd_codex_setup' });
    const next = recordCodexIngestionConsent(workspaceDir, { decision: 'granted', decidedVia: 'pd_codex_setup' });
    expect(next.ok).toBe(true);
    const read = readCodexIngestionConsent(workspaceDir);
    expect(read.ok && read.record?.decision).toBe('granted');
  });

  it('returns a structured failure when the workspace root is not writable', () => {
    const blocked = path.join(workspaceDir, 'file-blocks-dir');
    fs.writeFileSync(blocked, 'x', 'utf8');
    // <blocked>/.pd cannot be created: consent write must fail with reason+nextAction, not throw.
    const written = recordCodexIngestionConsent(blocked, { decision: 'granted', decidedVia: 'pd_codex_setup' });
    expect(written.ok).toBe(false);
    if (!written.ok) {
      expect(written.reason).toMatch(/^codex_ingestion_consent_write_failed/);
      expect(written.nextAction).toContain('permissions');
    }
  });
});

describe('deriveCodexIngestionConsentState', () => {
  const granted = {
    decision: 'granted' as const,
    disclosureVersion: CODEX_INGESTION_DISCLOSURE_VERSION,
    decidedAt: '2026-09-06T00:00:00.000Z',
    decidedVia: 'pd_codex_setup' as const,
    schemaVersion: '1',
  };
  const declined = { ...granted, decision: 'declined' as const };

  it('maps granted/declined/not_present/flag_on_without_consent', () => {
    expect(deriveCodexIngestionConsentState(granted, true)).toBe('granted');
    expect(deriveCodexIngestionConsentState(granted, false)).toBe('granted');
    expect(deriveCodexIngestionConsentState(declined, false)).toBe('declined');
    expect(deriveCodexIngestionConsentState(declined, true)).toBe('declined');
    expect(deriveCodexIngestionConsentState(null, false)).toBe('not_present');
    // Flag enabled outside the disclosed consent flow — governance warning state.
    expect(deriveCodexIngestionConsentState(null, true)).toBe('flag_on_without_consent');
  });
});
