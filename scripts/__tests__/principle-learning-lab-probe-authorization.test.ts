// SPEC-PD-EXAMINER-001 v0.4 §6.4 / PRI-1037 — probe-authorization chain suite.
//
// Proves offline (zero spawns, zero model calls): the fail-closed gate refuses
// the committed NOT_ISSUED authorization with its recorded blockage; APPROVED
// records are only accepted with strict clock window, recomputed frozen-hash
// binding and closed key set; a transport-factory invocation before/without a
// valid authorization is itself a refusal reason (gate-order invariant); the
// committed record stays NOT_ISSUED until the Owner decides the host-provider
// question (flipping it accidentally turns this suite red).

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProbeAuthorization, PROBE_AUTH_KEYS } from '../dev/principle-learning-lab/lib/challenge-probe-authorization.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const ceb001 = path.join(labRoot, 'challenge-studies', 'CEB-001');
const committed = JSON.parse(fs.readFileSync(path.join(ceb001, 'probe-authorization.json'), 'utf8'));

const T0 = Date.parse('2026-10-28T03:00:00Z');
const approvedOver = (over = {}) => JSON.parse(JSON.stringify({
  ...committed,
  status: 'APPROVED',
  targetHost: { ...committed.targetHost, requestedModelIdentity: 'zhipu/glm-5.3-flash' },
  validFrom: '2026-10-28T00:00:00Z',
  validUntil: '2026-10-29T00:00:00Z',
  blockage: undefined,
  ...over,
}));

// prune undefined blockage key so the closed key set stays exact
function withExactKeys(rec) {
  const r = JSON.parse(JSON.stringify(rec));
  if (r.blockage === undefined || r.blockage === null) {
    r.blockage = { reason: 'n/a (issued)' };
  }
  return r;
}

describe('probe authorization gate (fail-closed, PRI-1037 / S2-D3)', () => {
  it('refuses the committed NOT_ISSUED record and carries the host-provider blockage verbatim', () => {
    const v = verifyProbeAuthorization({ record: committed, studyDir: ceb001, now: T0, transportFactoryCalls: 0 });
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => r.includes("status is 'NOT_ISSUED'"))).toBe(true);
    expect(v.reasons.some((r) => r.includes('OpenAI'))).toBe(true); // the recorded blockage reason must surface
  });

  it('accepts an APPROVED record only with exact closed key set, live window, and recomputed frozen binding', () => {
    const v = verifyProbeAuthorization({ record: withExactKeys(approvedOver()), studyDir: ceb001, now: T0, transportFactoryCalls: 0 });
    expect(v.ok).toBe(true);
  });

  it('refuses hash-binding mismatch (suite or plan drift)', () => {
    const bad = approvedOver({ frozenHashes: { ...committed.frozenHashes, suiteHash: 'deadbeef'.repeat(8) } });
    const v = verifyProbeAuthorization({ record: withExactKeys(bad), studyDir: ceb001, now: T0 });
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => r.includes('suiteHash binding mismatch'))).toBe(true);
  });

  it('refuses outside the validity window (before and after)', () => {
    expect(verifyProbeAuthorization({ record: withExactKeys(approvedOver()), studyDir: ceb001, now: Date.parse('2026-10-27T00:00:00Z') }).ok).toBe(false);
    expect(verifyProbeAuthorization({ record: withExactKeys(approvedOver()), studyDir: ceb001, now: Date.parse('2026-10-30T00:00:00Z') }).ok).toBe(false);
  });

  it('refuses unknown/missing keys (closed key set)', () => {
    const extra = withExactKeys(approvedOver()); extra.sneakyField = true;
    expect(verifyProbeAuthorization({ record: extra, studyDir: ceb001, now: T0 }).ok).toBe(false);
    const missing = withExactKeys(approvedOver()); delete missing.stopConditions;
    expect(verifyProbeAuthorization({ record: missing, studyDir: ceb001, now: T0 }).ok).toBe(false);
    expect(PROBE_AUTH_KEYS).toHaveLength(13);
  });

  it('gate-order invariant: any transport factory call without a valid authorization is itself a refusal', () => {
    const v = verifyProbeAuthorization({ record: committed, studyDir: ceb001, now: T0, transportFactoryCalls: 1 });
    expect(v.ok).toBe(false);
  });

  it('binds to a real frozen study copy: a synthesized copy of CEB-001 accepts the same binding (no hash recomputation shortcuts)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-auth-'));
    fs.cpSync(ceb001, dir, { recursive: true, filter: (f) => !f.endsWith('probe-authorization.json') });
    const v = verifyProbeAuthorization({ record: withExactKeys(approvedOver()), studyDir: dir, now: T0 });
    expect(v.ok).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('PIN: the committed record stays NOT_ISSUED with a structured blockage until the Owner decision lands', () => {
    expect(committed.status).toBe('NOT_ISSUED');
    expect(committed.blockage.pendingDecision).toContain('Owner');
    expect(committed.targetHost.requestedModelIdentity).toBe('PENDING-OWNER-DECISION');
    // the frozen binding it will enforce must equal the live study
    const manifest = JSON.parse(fs.readFileSync(path.join(ceb001, 'suite-manifest.json'), 'utf8'));
    expect(committed.frozenHashes.suiteHash).toBe(manifest.suiteHash);
    expect(committed.frozenHashes.mappingHash).toBe(manifest.mappingHash);
    expect(committed.frozenHashes.graderHash).toBe(manifest.graderHash);
  });
});
