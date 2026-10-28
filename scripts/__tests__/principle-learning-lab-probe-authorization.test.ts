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
import { ZHIPU_CODING_PROVIDER, buildZhipuCodexOverrides, ensureZhipuProviderReady } from '../dev/principle-learning-lab/lib/challenge-zhipu-host-provider.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const ceb001 = path.join(labRoot, 'challenge-studies', 'CEB-001');
const committed = JSON.parse(fs.readFileSync(path.join(ceb001, 'probe-authorization.json'), 'utf8'));

const T0 = Date.parse('2026-10-28T03:00:00Z');
const approvedOver = (over = {}) => JSON.parse(JSON.stringify({
  ...committed,
  status: 'APPROVED',
  targetHost: { ...committed.targetHost, requestedModelIdentity: 'glm-5.3-flash' },
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

  it('PIN: the committed record stays NOT_ISSUED with a structured blockage until the Owner review lands', () => {
    expect(committed.status).toBe('NOT_ISSUED');
    expect(committed.blockage.pendingDecision).toContain('Owner');
    expect(committed.targetHost.provider).toBe('zhipu-coding'); // S3 route A, pinned
    expect(committed.targetHost.requestedModelIdentity).toBe('glm-5.3-flash');
    // the frozen binding it will enforce must equal the live study
    const manifest = JSON.parse(fs.readFileSync(path.join(ceb001, 'suite-manifest.json'), 'utf8'));
    expect(committed.frozenHashes.suiteHash).toBe(manifest.suiteHash);
    expect(committed.frozenHashes.mappingHash).toBe(manifest.mappingHash);
    expect(committed.frozenHashes.graderHash).toBe(manifest.graderHash);
  });

  it('gate: APPROVED records must name the single approved provider and model — OpenAI-default host models are refused', () => {
    const openaiHost = approvedOver({ targetHost: { ...committed.targetHost, provider: 'openai-default', requestedModelIdentity: 'gpt-6-astra' } });
    const v1 = verifyProbeAuthorization({ record: withExactKeys(openaiHost), studyDir: ceb001, now: T0 });
    expect(v1.ok).toBe(false);
    expect(v1.reasons.some((r) => r.includes("provider must be 'zhipu-coding'"))).toBe(true);
    const wrongModel = approvedOver({ targetHost: { ...committed.targetHost, requestedModelIdentity: 'glm-4.7' } });
    const v2 = verifyProbeAuthorization({ record: withExactKeys(wrongModel), studyDir: ceb001, now: T0 });
    expect(v2.ok).toBe(false);
    expect(v2.reasons.some((r) => r.includes('requestedModelIdentity must be'))).toBe(true);
  });
});

describe('zhipu host-provider adapter (offline; zero spawns, zero model calls)', () => {
  it('maps the single approved channel in one frozen place — same endpoint/model/key source the F1 transport proved', () => {
    expect(ZHIPU_CODING_PROVIDER.baseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
    expect(ZHIPU_CODING_PROVIDER.modelId).toBe('glm-5.3-flash');
    expect(ZHIPU_CODING_PROVIDER.envKey).toBe('BIGMODEL_CODING_API_KEY');
    expect(ZHIPU_CODING_PROVIDER.wireApi).toBe('chat');
  });

  it('builds order-stable per-spawn -c overrides (owner config.toml untouched)', () => {
    const args = buildZhipuCodexOverrides();
    expect(args).toEqual([
      '-c', 'model_provider=zhipu-coding',
      '-c', 'model_providers.zhipu-coding.name=Zhipu BigModel Coding Plan',
      '-c', `model_providers.zhipu-coding.base_url=${ZHIPU_CODING_PROVIDER.baseUrl}`,
      '-c', 'model_providers.zhipu-coding.env_key=BIGMODEL_CODING_API_KEY',
      '-c', 'model_providers.zhipu-coding.wire_api=chat',
    ]);
  });

  it('is fail-closed on missing credentials and never surfaces the key value', () => {
    const v = ensureZhipuProviderReady({ env: {}, keyFile: path.join(os.tmpdir(), 'no-such-zhipu-key-file') });
    expect(v.ready).toBe(false);
    expect(v.reason).toContain('fail-closed');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhipu-prov-'));
    const kf = path.join(dir, 'key');
    fs.writeFileSync(kf, 'test-key-value\n');
    const ok = ensureZhipuProviderReady({ env: {}, keyFile: kf });
    expect(ok.ready).toBe(true);
    expect(ok.source).toBe(`file:${kf}`);
    expect(JSON.stringify(ok)).not.toContain('test-key-value'); // value never carried in the result
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
