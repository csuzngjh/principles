import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION,
  CONVERSATION_INGESTION_CONSENT_SUPERSEDED_SUFFIX,
  deriveConversationIngestionConsentState,
  getConversationIngestionConsentPath,
  readConversationIngestionConsent,
  recordConversationIngestionConsent,
} from '../src/conversation-ingestion/consent.js';

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-conv-consent-'));
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

/** Write a legacy v2 Codex consent file at <workspace>/.pd/codex-ingestion-consent.json. */
function writeLegacyV2File(body: unknown): string {
  const legacyDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyPath = path.join(legacyDir, 'codex-ingestion-consent.json');
  fs.writeFileSync(legacyPath, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return legacyPath;
}

const V2_GRANTED = {
  decision: 'granted',
  disclosureVersion: 'g2a-2026-08-28',
  decidedAt: '2026-09-06T00:00:00Z',
  decidedVia: 'pd_codex_setup',
  schemaVersion: '2',
};

describe('conversation-ingestion consent ledger v3 — legacy migration (PRI-1171 工单②)', () => {
  it('migrates a legacy v2 Codex file on first read: v3 written, legacy renamed .superseded, record preserved', () => {
    const legacyPath = writeLegacyV2File(V2_GRANTED);
    const read = readConversationIngestionConsent(workspaceDir, 'codex');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.existed).toBe(true);
    expect(read.migratedFromLegacy).toBe(true);
    expect(read.record).toMatchObject({
      decision: 'granted',
      disclosureVersion: 'g2a-2026-08-28',
      decidedAt: '2026-09-06T00:00:00Z',
      decidedVia: 'pd_codex_setup',
      schemaVersion: CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION,
    });
    // Single authority: v3 exists, legacy renamed (kept for audit, never read).
    expect(fs.existsSync(getConversationIngestionConsentPath(workspaceDir))).toBe(true);
    expect(fs.existsSync(`${legacyPath}${CONVERSATION_INGESTION_CONSENT_SUPERSEDED_SUFFIX}`)).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(false);
    // Migration is one-shot: second read is a plain v3 read (no migration flag).
    const again = readConversationIngestionConsent(workspaceDir, 'codex');
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.migratedFromLegacy).toBeUndefined();
  });

  it('a malformed legacy file fails loud and blocks migration (never silently never-asked)', () => {
    writeLegacyV2File('{broken');
    const read = readConversationIngestionConsent(workspaceDir, 'codex');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/^legacy_codex_consent_malformed/);
    // No v3 was written; the legacy file is untouched for manual repair.
    expect(fs.existsSync(getConversationIngestionConsentPath(workspaceDir))).toBe(false);
  });

  it('a legacy file with the wrong schema version is refused, not guessed', () => {
    writeLegacyV2File({ ...V2_GRANTED, schemaVersion: '1' });
    const read = readConversationIngestionConsent(workspaceDir, 'codex');
    expect(read.ok).toBe(false);
  });

  it('recording a new codex decision migrates the legacy file first (no orphaned history)', () => {
    const legacyPath = writeLegacyV2File(V2_GRANTED);
    const written = recordConversationIngestionConsent(workspaceDir, 'codex', {
      decision: 'revoked',
      decidedVia: 'pd_codex_setup',
      disclosureVersion: 'g2a-2026-08-28',
    });
    expect(written.ok).toBe(true);
    expect(fs.existsSync(`${legacyPath}${CONVERSATION_INGESTION_CONSENT_SUPERSEDED_SUFFIX}`)).toBe(true);
    const read = readConversationIngestionConsent(workspaceDir, 'codex');
    expect(read.ok && read.record?.decision).toBe('revoked');
  });

  it('non-codex hosts never consult the legacy file on READ', () => {
    writeLegacyV2File(V2_GRANTED);
    const read = readConversationIngestionConsent(workspaceDir, 'workbuddy');
    expect(read).toEqual({ ok: true, existed: false, record: null });
    expect(fs.existsSync(getConversationIngestionConsentPath(workspaceDir))).toBe(false);
  });

  it('the FIRST v3 write for ANY host migrates the legacy codex record first (review Major: no abandoned decision)', () => {
    const legacyPath = writeLegacyV2File(V2_GRANTED);
    const wb = recordConversationIngestionConsent(workspaceDir, 'workbuddy', {
      decision: 'granted',
      decidedVia: 'owner_directive',
      disclosureVersion: 'pri-1171-2026-11-11',
      evidenceRef: 'PRI-1171 SPEC 修订记录 2026-11-11',
    });
    expect(wb.ok).toBe(true);
    // The codex history rode along into the same ledger — nothing orphaned.
    const codex = readConversationIngestionConsent(workspaceDir, 'codex');
    expect(codex).toMatchObject({ ok: true, existed: true, record: { decision: 'granted', decidedVia: 'pd_codex_setup' } });
    expect(fs.existsSync(`${legacyPath}${CONVERSATION_INGESTION_CONSENT_SUPERSEDED_SUFFIX}`)).toBe(true);
  });

  it('a pre-existing v3 ledger WINS over the legacy file (migration never clobbers a newer decision)', () => {
    const legacyPath = writeLegacyV2File(V2_GRANTED);
    // Simulate the outcome of a concurrent writer that already landed a NEWER
    // decision in v3: reads consult v3 FIRST and never resurrect the legacy
    // grant. (The migration's create-if-absent link makes the mid-flight race
    // behave the same way — an EEXIST adopts the existing ledger — but that
    // interleave cannot be deterministically injected here; this test pins
    // the resulting contract: the existing v3 authority is final.)
    const ledgerDir = path.dirname(getConversationIngestionConsentPath(workspaceDir));
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(getConversationIngestionConsentPath(workspaceDir), JSON.stringify({
      schemaVersion: CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION,
      hosts: { codex: { decision: 'revoked', disclosureVersion: 'g2a-2026-08-28', decidedAt: '2026-11-11T00:00:00Z', decidedVia: 'pd_codex_setup', schemaVersion: CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION } },
    }), 'utf8');
    const read = readConversationIngestionConsent(workspaceDir, 'codex');
    // The revoke survives; the stale grant is NOT resurrected over it.
    expect(read).toMatchObject({ ok: true, existed: true, record: { decision: 'revoked' } });
    // The legacy file is inert residue (v3 exists, so it is never consulted
    // again); the invariant under test is authority, not its renaming.
    expect(read.ok && read.migratedFromLegacy).toBeUndefined();
    void legacyPath;
  });
});

describe('conversation-ingestion consent ledger v3 — host-keyed slots', () => {
  it('keeps per-host slots independent in ONE file', () => {
    const codex = recordConversationIngestionConsent(workspaceDir, 'codex', { decision: 'granted', decidedVia: 'pd_codex_setup', disclosureVersion: 'g2a-2026-08-28' });
    const wb = recordConversationIngestionConsent(workspaceDir, 'workbuddy', {
      decision: 'granted',
      decidedVia: 'owner_directive',
      disclosureVersion: 'pri-1171-2026-11-11',
      evidenceRef: 'PRI-1171 SPEC 修订记录 2026-11-11',
    });
    expect(codex.ok).toBe(true);
    expect(wb.ok).toBe(true);
    expect(readConversationIngestionConsent(workspaceDir, 'codex')).toMatchObject({ ok: true, existed: true, record: { decision: 'granted', decidedVia: 'pd_codex_setup' } });
    const wbRead = readConversationIngestionConsent(workspaceDir, 'workbuddy');
    expect(wbRead).toMatchObject({ ok: true, existed: true });
    if (wbRead.ok) {
      expect(wbRead.record?.evidenceRef).toBe('PRI-1171 SPEC 修订记录 2026-11-11');
      expect(wbRead.record?.disclosureVersion).toBe('pri-1171-2026-11-11');
    }
    // Overwriting workbuddy leaves codex intact.
    recordConversationIngestionConsent(workspaceDir, 'workbuddy', { decision: 'revoked', decidedVia: 'owner_directive', disclosureVersion: 'pri-1171-2026-11-11', evidenceRef: 'manual revoke test' });
    expect(readConversationIngestionConsent(workspaceDir, 'codex')).toMatchObject({ ok: true, existed: true, record: { decision: 'granted' } });
    expect(readConversationIngestionConsent(workspaceDir, 'workbuddy')).toMatchObject({ ok: true, record: { decision: 'revoked' } });
    // openclaw slot still absent.
    expect(readConversationIngestionConsent(workspaceDir, 'openclaw')).toEqual({ ok: true, existed: false, record: null });
  });

  it('owner_directive requires an evidenceRef; disclosureVersion is mandatory (consent binds to a disclosure)', () => {
    const noRef = recordConversationIngestionConsent(workspaceDir, 'workbuddy', { decision: 'granted', decidedVia: 'owner_directive', disclosureVersion: 'd1' });
    expect(noRef.ok).toBe(false);
    if (!noRef.ok) expect(noRef.reason).toContain('evidenceRef');
    const noDisclosure = recordConversationIngestionConsent(workspaceDir, 'codex', { decision: 'granted', decidedVia: 'pd_codex_setup' });
    expect(noDisclosure.ok).toBe(false);
    if (!noDisclosure.ok) expect(noDisclosure.reason).toContain('disclosureVersion');
  });

  it('a malformed v3 ledger blocks writes instead of being clobbered (rc-3)', () => {
    fs.mkdirSync(path.dirname(getConversationIngestionConsentPath(workspaceDir)), { recursive: true });
    fs.writeFileSync(getConversationIngestionConsentPath(workspaceDir), '{broken', 'utf8');
    const written = recordConversationIngestionConsent(workspaceDir, 'workbuddy', { decision: 'granted', decidedVia: 'owner_directive', disclosureVersion: 'd', evidenceRef: 'x' });
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.reason).toMatch(/^conversation_ingestion_consent_malformed/);
  });

  it('derive state mapping stays interpretable for every flag×record combination', () => {
    const rec = { decision: 'granted' as const, disclosureVersion: 'd', decidedAt: '2026-11-11T00:00:00Z', decidedVia: 'owner_directive' as const, evidenceRef: 'r', schemaVersion: CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION };
    expect(deriveConversationIngestionConsentState(rec, true)).toBe('granted');
    expect(deriveConversationIngestionConsentState({ ...rec, decision: 'revoked' }, true)).toBe('revoked');
    expect(deriveConversationIngestionConsentState(null, false)).toBe('not_present');
    expect(deriveConversationIngestionConsentState(null, true)).toBe('flag_on_without_grant');
  });
});
