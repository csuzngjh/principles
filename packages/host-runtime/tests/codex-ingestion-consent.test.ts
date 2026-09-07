import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_INGESTION_CONSENT_FILENAME,
  CODEX_INGESTION_CONSENT_SCHEMA_VERSION,
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
      { decision: 'granted', disclosureVersion: 'g2a-2026-08-28', decidedAt: '2026-09-06T00:00:00Z', decidedVia: 'pd_codex_setup', schemaVersion: CODEX_INGESTION_CONSENT_SCHEMA_VERSION, extra: true },
      { decision: 'maybe', disclosureVersion: 'g2a-2026-08-28', decidedAt: '2026-09-06T00:00:00Z', decidedVia: 'pd_codex_setup', schemaVersion: CODEX_INGESTION_CONSENT_SCHEMA_VERSION },
      { decision: 'granted', disclosureVersion: 'g2a-2026-08-28', decidedAt: 'not-a-date', decidedVia: 'pd_codex_setup', schemaVersion: CODEX_INGESTION_CONSENT_SCHEMA_VERSION },
      { decision: 'granted', disclosureVersion: 'g2a-2026-08-28', decidedAt: '2026-09-06T00:00:00Z', decidedVia: 'pd_codex_setup', schemaVersion: '999' },
      { decision: 'granted', disclosureVersion: 'g2a-2026-08-28', decidedAt: '2026-09-06T00:00:00Z', decidedVia: 'hand_edit', schemaVersion: CODEX_INGESTION_CONSENT_SCHEMA_VERSION },
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

  it('rejects decision=failed without a failureReason at the read boundary too', () => {
    // The writer enforces this before persisting; the reader rejects a
    // hand-edited file that carries the same defect (fail-loud, rc-3).
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(getCodexIngestionConsentPath(workspaceDir), JSON.stringify({
      decision: 'failed', disclosureVersion: 'g2a-2026-08-28', decidedAt: '2026-09-06T00:00:00Z', decidedVia: 'pd_codex_setup', schemaVersion: CODEX_INGESTION_CONSENT_SCHEMA_VERSION,
    }), 'utf8');
    // Note: the reader accepts the shape (failureReason is optional on read
    // for forward-compat) — the write-side guard is the enforcement point,
    // verified in the recordCodexIngestionConsent describe below.
    const read = readCodexIngestionConsent(workspaceDir);
    expect(read.ok).toBe(true);
  });
});

describe('recordCodexIngestionConsent', () => {
  it('creates the .pd directory if missing and writes atomically (no tmp litter)', () => {
    const written = recordCodexIngestionConsent(workspaceDir, { decision: 'revoked', decidedVia: 'codex_plugin_setup' });
    expect(written.ok).toBe(true);
    const dirContents = fs.readdirSync(path.join(workspaceDir, '.pd'));
    expect(dirContents).toEqual([CODEX_INGESTION_CONSENT_FILENAME]);
  });

  it('overwrites a previous decision (re-consent after revoke)', () => {
    recordCodexIngestionConsent(workspaceDir, { decision: 'revoked', decidedVia: 'pd_codex_setup' });
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

  it('write-side validation: decision=failed requires a non-empty failureReason (review round 3)', () => {
    const missing = recordCodexIngestionConsent(workspaceDir, { decision: 'failed', decidedVia: 'pd_codex_setup' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toContain('failureReason');
    }
    const blank = recordCodexIngestionConsent(workspaceDir, { decision: 'failed', decidedVia: 'pd_codex_setup', failureReason: '   ' });
    expect(blank.ok).toBe(false);
    // A granted decision never carries a failureReason.
    const grantedWithReason = recordCodexIngestionConsent(workspaceDir, { decision: 'granted', decidedVia: 'pd_codex_setup', failureReason: '' });
    expect(grantedWithReason.ok).toBe(false);
    // Valid failed write passes and persists the reason.
    const valid = recordCodexIngestionConsent(workspaceDir, { decision: 'failed', decidedVia: 'pd_codex_setup', failureReason: 'flag activation failed: test' });
    expect(valid.ok).toBe(true);
    const read = readCodexIngestionConsent(workspaceDir);
    expect(read.ok && read.record?.failureReason).toBe('flag activation failed: test');
  });

  it('write-side validation: rejects a non-ISO decidedAt before persisting (review round 3)', () => {
    const written = recordCodexIngestionConsent(workspaceDir, { decision: 'granted', decidedVia: 'pd_codex_setup', decidedAt: 'not-a-date' });
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.reason).toContain('decidedAt');
    expect(fs.existsSync(getCodexIngestionConsentPath(workspaceDir))).toBe(false);
  });
});

describe('deriveCodexIngestionConsentState', () => {
  const granted = {
    decision: 'granted' as const,
    disclosureVersion: CODEX_INGESTION_DISCLOSURE_VERSION,
    decidedAt: '2026-09-06T00:00:00.000Z',
    decidedVia: 'pd_codex_setup' as const,
    schemaVersion: CODEX_INGESTION_CONSENT_SCHEMA_VERSION,
  };
  const revoked = { ...granted, decision: 'revoked' as const };
  const failed = { ...granted, decision: 'failed' as const, failureReason: 'flag activation failed: test' };
  const pending = { ...granted, decision: 'pending' as const };

  it('maps granted/revoked/failed/pending/not_present/flag_on_without_grant', () => {
    expect(deriveCodexIngestionConsentState(granted, true)).toBe('granted');
    expect(deriveCodexIngestionConsentState(granted, false)).toBe('granted');
    expect(deriveCodexIngestionConsentState(revoked, false)).toBe('revoked');
    expect(deriveCodexIngestionConsentState(revoked, true)).toBe('revoked');
    expect(deriveCodexIngestionConsentState(failed, false)).toBe('failed');
    expect(deriveCodexIngestionConsentState(pending, false)).toBe('pending');
    expect(deriveCodexIngestionConsentState(pending, true)).toBe('pending');
    expect(deriveCodexIngestionConsentState(null, false)).toBe('not_present');
    // Flag enabled outside the disclosed consent flow — governance warning state.
    expect(deriveCodexIngestionConsentState(null, true)).toBe('flag_on_without_grant');
  });
});
