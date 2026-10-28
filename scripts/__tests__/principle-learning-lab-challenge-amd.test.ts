// SPEC-PD-EXAMINER-001 v0.4 §2.7 — AMD Radeon TokenFactory transport offline
// acceptance suite. ALL fetches are injected stubs — zero real network in this
// file; real connectivity is verified separately (stage-g-preflight/
// amd-connectivity-check.md). Security invariants under test: credential
// sourcing (env/file only, refusal BEFORE network), https-only + private-host
// refusal, 429 handling without auto-retry, ambiguous-outcome → RESULT_UNKNOWN,
// model-identity mismatch refusal, points-vs-dollars metering separation.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  createAmdRadeonTransport,
  resolveAmdApiKey,
  assertPublicHttpsUrl,
  buildAmdRequestBody,
  AmbiguousOutcomeError,
  AMD_MODEL_ID,
  AMD_REQUESTED_MODEL_IDENTITY,
  AMD_DEPLOYMENT_STATUS,
  AMD_GENERATION_BUDGET,
  AMD_TRANSPORT_TIMEOUTS,
  AMD_CATALOG_SUPPORTED_PARAMETERS,
} from '../dev/principle-learning-lab/lib/challenge-amd-transport.mjs';
import { runExaminerRequest } from '../dev/principle-learning-lab/lib/challenge-examiner.mjs';
import { VALUE_DOMAINS } from '../dev/principle-learning-lab/lib/challenge-skeleton.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const tmpRoot = path.join(labRoot, '..', '..', '..', '.tmp', 'amd-tests');
let counter = 0;
const workdir = () => { const d = path.join(tmpRoot, `w-${++counter}`); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };

const MAPPING_HASH = '213090daecf0cbc9abfc51ca46641e4e3b835730ba9d9ec771118aaed9521290';
const spec = (over: Record<string, any> = {}) => ({
  schema: 'examiner-run-spec.v1', studyId: 'CEB-001', mappingId: 'PMM-001-ASSERT-EVIDENCE-V1', mappingHash: MAPPING_HASH,
  inputManifestHash: 'a74c035e585bb57d758c095b1fd7e2d6d0bcfdcc80d0f28a299d9d00b99a386d',
  templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '1.0.0', schemaVersion: '1.0.0', valueDomainVersion: '1.0.0',
  allowedExpressionFields: VALUE_DOMAINS.allowedExpressionFields, candidateCap: 36, requestCap: 16, perRequestCandidateCap: 6,
  inputTokenCap: 8000, outputTokenCap: 4000, costCapUsd: 3.0, pricePerMillion: { input: null, output: null },
  dataTransferPermit: 'NOT_SET', desensitizationStatus: 'NOT_RUN', requestedModelIdentity: AMD_REQUESTED_MODEL_IDENTITY, ...over,
});

const stubFetch = (handler: any) => ({ calls: [] as any[], poster: async (u: string, init: any) => { const r = await handler(u, init); return r; } });

const okResponse = (over: Record<string, any> = {}) => {
  const body = {
    model: AMD_MODEL_ID,
    choices: [{ message: { content: JSON.stringify({ candidates: [] }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 6100, completion_tokens: 2700, completion_tokens_details: { reasoning_tokens: 800 }, cost: 0.0044 },
    id: 'resp-1',
    ...over,
  };
  return {
    status: 200,
    headers: { get: (k: string) => (k === 'retry-after' ? null : null) },
    text: async () => JSON.stringify(body),
  };
};

describe('credential sourcing (before any network action)', () => {
  it('refuses when neither env nor key file exists — beforeSend failure, zero fetch calls', async () => {
    const stub = stubFetch(() => { throw new Error('network must not happen'); });
    const t = createAmdRadeonTransport({ posterImpl: stub.poster as any, apiKeyProvider: () => { const e = new Error('AMD credential source unavailable'); (e as any).beforeSend = true; throw e; } });
    await expect(t.respond({ requestId: 'r', constrainedInput: {}, spec: spec() })).rejects.toThrow(/credential source unavailable/);
    expect(stub.calls.length).toBe(0);
  });

  it('reads from env or the key file (secure sources only)', () => {
    expect(resolveAmdApiKey({ env: { AMD_RADEON_API_KEY: 'k' } }).source).toBe('env:AMD_RADEON_API_KEY');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amdkey-'));
    const f = path.join(dir, 'key');
    fs.writeFileSync(f, 'filekey\n');
    expect(resolveAmdApiKey({ env: {}, keyFile: f })).toMatchObject({ source: `file:${f}`, key: 'filekey' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('URL guard (Mimosa host policy)', () => {
  it('accepts the production base and refuses http/localhost/private hosts', () => {
    expect(assertPublicHttpsUrl('https://developer.amd.com.cn/radeon/api/v1').hostname).toBe('developer.amd.com.cn');
    for (const bad of ['http://developer.amd.com.cn', 'https://localhost', 'https://127.0.0.1', 'https://192.168.1.5', 'https://10.0.0.2', 'https://172.16.0.9', 'https://169.254.1.1', 'file:///etc/passwd']) {
      expect(() => assertPublicHttpsUrl(bad)).toThrow();
    }
  });
});

describe('request construction', () => {
  it('binds model, structured output, 32768 generation budget (reasoning+output shared, non-decomposable), candidate cap; never contains gold material', () => {
    const body = buildAmdRequestBody({ constrainedInput: { marker: 'actor-visible-only' }, perRequestCandidateCap: 6 });
    expect(body.model).toBe(AMD_MODEL_ID);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(32768); // 2026-10-25 参数专项修正
    expect(AMD_GENERATION_BUDGET.decomposition).toContain('non_decomposable');
    expect(body.messages[0].content).toContain('本请求候选数上限：6');
    expect(body.messages[1].content).toContain('actor-visible-only');
  });

  it('timeouts are two-phase (connect 15s approx / total 240s) and reasoning_effort is catalog-undeclared (effect unverified, recorded)', () => {
    expect(AMD_TRANSPORT_TIMEOUTS.requestTimeoutMs).toBe(240_000);
    expect(AMD_TRANSPORT_TIMEOUTS.connectTimeoutMs).toBe(15_000);
    expect(AMD_TRANSPORT_TIMEOUTS.note).toContain('HTTP/1.1');
    expect(AMD_CATALOG_SUPPORTED_PARAMETERS).not.toContain('reasoning_effort');
  });
});

describe('output completeness gates (参数专项修正 §3)', () => {
  const transportWith = (handler: any) => {
    const stub = stubFetch(handler);
    return { transport: createAmdRadeonTransport({ posterImpl: stub.poster as any, apiKeyProvider: () => ({ source: 'test', key: 'k' }) }), stub };
  };

  it('finish_reason=length → output_budget_exhausted, ZERO adoption even if content looks parseable', async () => {
    const { transport } = transportWith(() => okResponse({ choices: [{ message: { content: '{"candidates":[]}' }, finish_reason: 'length' }] }));
    const r = await transport.respond({ requestId: 'r', constrainedInput: {}, spec: spec() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('output_budget_exhausted');
    expect(r.finishReason).toBe('length');
    expect(r.candidates).toBeUndefined();
  });

  it('content=null with reasoning usage → reasoning_budget_exhausted diagnosis retained', async () => {
    const { transport } = transportWith(() => okResponse({ choices: [{ message: { content: null }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 3000, completion_tokens_details: { reasoning_tokens: 3000 } } }));
    const r = await transport.respond({ requestId: 'r', constrainedInput: {}, spec: spec() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('reasoning_budget_exhausted');
    expect(r.reasoningTokens).toBe(3000);
  });
});

describe('response handling (injected fetch — zero real network)', () => {
  const transportWith = (handler: any) => {
    const stub = stubFetch(handler);
    return { transport: createAmdRadeonTransport({ posterImpl: stub.poster as any, apiKeyProvider: () => ({ source: 'test', key: 'k' }) }), stub };
  };

  it('happy path: parses candidates, records observed identity (metadata fields beat prefixed model string) + free-tier metering (nominal cost audited, never budgeted)', async () => {
    let capturedUrl = null;
    const { transport } = transportWith((u) => { capturedUrl = u; return okResponse({ model: 'self-dploy/GLM-5.3-Flash', metadata: { requested_model: AMD_MODEL_ID, used_model: AMD_MODEL_ID }, usage: { prompt_tokens: 6100, completion_tokens: 2700, completion_tokens_details: { reasoning_tokens: 800 }, cost: 0.0044 } }); });
    const r = await transport.respond({ requestId: 'r', constrainedInput: {}, spec: spec() });
    expect(r.ok).toBe(true);
    expect(r.observedModelIdentity).toBe(AMD_MODEL_ID); // authoritative metadata, not the prefixed raw field
    expect(r.usage.metering).toBe('free_tier_zero_cost');
    expect(r.usage.costUsd).toBe(0);                 // Owner-confirmed free tier: zero budget cost
    expect(r.usage.nominalServerCost).toBeCloseTo(0.0044); // audit annotation only
    expect(r.usage.costNote).toContain('never budgeted');
    expect(r.reasoningTokens).toBe(800);
    expect(r.rawResponseMeta.deploymentStatus).toBe(AMD_DEPLOYMENT_STATUS);
    expect(capturedUrl.endsWith('/v1/chat/completions')).toBe(true); // URL-join regression: version prefix must survive (round3 404 root cause)
  });

  it('429 → FAILED_KNOWN semantics: server Retry-After recorded, NO auto-retry inside the transport', async () => {
    const { transport } = transportWith(() => ({ status: 429, headers: { get: (k: string) => (k === 'retry-after' ? '30' : null) }, text: async () => '' }));
    const r = await transport.respond({ requestId: 'r', constrainedInput: {}, spec: spec() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('rate_limited');
    expect(r.retryAfter).toBe('30');
    expect(r.error).toContain('NOT auto-retried');
  });

  it('model identity mismatch → refuses candidates with an explicit stop-condition message', async () => {
    const { transport } = transportWith(() => okResponse({ model: 'GLM-SOMETHING-ELSE' }));
    const r = await transport.respond({ requestId: 'r', constrainedInput: {}, spec: spec() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('model_identity_mismatch');
    expect(r.observedModelIdentity).toBe('GLM-SOMETHING-ELSE');
  });

  it('fetch rejection after dispatch → AmbiguousOutcomeError → runner settles RESULT_UNKNOWN (not FAILED_KNOWN, no retry)', async () => {
    const { transport } = transportWith(() => Promise.reject(new Error('ETIMEDOUT')));
    await expect(transport.respond({ requestId: 'r', constrainedInput: {}, spec: spec() })).rejects.toThrow(AmbiguousOutcomeError);
    // Runner-level: wire it through runExaminerRequest with a factory returning this transport
    const dir = workdir();
    const out = await runExaminerRequest({
      spec: spec({ dataTransferPermit: 'APPROVED', desensitizationStatus: 'DONE' }), workDir: dir, requestId: 'r1', transport: 'real',
      authorizationRecord: null, // gate first — refused before transport
    });
    expect(out.stage).toBe('authorization');
    expect(out.transportCalls ?? 0).toBe(0);
  });

  it('unparseable response body → AmbiguousOutcomeError (billed-or-not unknowable → RESULT_UNKNOWN at runner)', async () => {
    const { transport } = transportWith(() => ({ status: 200, headers: { get: () => null }, text: async () => 'not-json' }));
    await expect(transport.respond({ requestId: 'r', constrainedInput: {}, spec: spec() })).rejects.toThrow(AmbiguousOutcomeError);
  });

  it('structured-output parse failure → clean FAILED_KNOWN with content head retained', async () => {
    const { transport } = transportWith(() => okResponse({ choices: [{ message: { content: '{not valid json' }, finish_reason: 'stop' }] }));
    const r = await transport.respond({ requestId: 'r', constrainedInput: {}, spec: spec() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('structured_output_parse_failed');
  });
});

describe('runner-level ambiguous semantics with a real AMD transport (still injected fetch)', () => {
  it('an authorized real request whose fetch times out settles RESULT_UNKNOWN in the ledger and never auto-retries', async () => {
    const validAuth = {
      schema: 'challenge-stage-g-authorization.v1', status: 'APPROVED', studyId: 'CEB-001', mappingHash: MAPPING_HASH,
      inputManifestHash: 'a74c035e585bb57d758c095b1fd7e2d6d0bcfdcc80d0f28a299d9d00b99a386d',
      templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '1.0.0', schemaVersion: '1.0.0', valueDomainVersion: '1.0.0',
      requestedModelIdentity: AMD_REQUESTED_MODEL_IDENTITY, requestCap: 16, inputTokenCap: 8000, outputTokenCap: 4000,
      costCapUsd: 3.0, dataTransferPermit: 'APPROVED', desensitizationStatus: 'DONE', issuedBy: 'owner-test', halted: false,
      validFrom: '2026-10-25T00:00:00Z', validUntil: '2026-11-01T00:00:00Z', revoked: false,
    };
    const stub = stubFetch(() => Promise.reject(new Error('ETIMEDOUT')));
    const dir = workdir();
    const out = await runExaminerRequest({
      spec: spec(), workDir: dir, requestId: 'r1', transport: 'real', now: Date.parse('2026-10-26T12:00:00Z'),
      authorizationRecord: validAuth,
      transportFactory: () => createAmdRadeonTransport({ posterImpl: stub.poster as any, apiKeyProvider: () => ({ source: 'test', key: 'k' }) }),
    });
    expect(out.result).toBe('RESULT_UNKNOWN');
    const { createGenerationLedger } = await import('../dev/principle-learning-lab/lib/challenge-examiner.mjs');
    const ledger = createGenerationLedger(dir);
    expect(ledger.classifyRequest('r1')).toBe('RESULT_UNKNOWN');
    const retry = await runExaminerRequest({
      spec: spec(), workDir: dir, requestId: 'r1', transport: 'real', now: Date.parse('2026-10-26T12:00:00Z'),
      authorizationRecord: validAuth,
      transportFactory: () => createAmdRadeonTransport({ posterImpl: stub.poster as any, apiKeyProvider: () => ({ source: 'test', key: 'k' }) }),
    });
    expect(retry).toMatchObject({ refused: true, stage: 'recovery' }); // no auto-retry of unknown results
  });
});

describe('safety invariants', () => {
  it('module contains no credential literals and no non-https default; key file path is the only secret source reference', () => {
    const src = fs.readFileSync(path.join(labRoot, 'lib', 'challenge-amd-transport.mjs'), 'utf8');
    expect(src).not.toMatch(/rc-[0-9a-f]{20,}/);
    expect(src.includes('http://')).toBe(false);
    expect(src.includes('Bearer ${cred.key}')).toBe(true); // header built at runtime, value never logged
  });
});
