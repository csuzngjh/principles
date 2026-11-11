import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertFreshResults,
  claimApproval,
  reserveRequest,
  verifyApproval,
} from '../dev/adaptive-activation/approval-gate.mjs';

const binding = {
  codeHead: 'a'.repeat(40),
  treeHash: 'b'.repeat(40),
  manifestSha256: 'c'.repeat(64),
  isolatedConfigSha256: 'd'.repeat(64),
  route: {
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    model: 'respan/span-01-lite:free',
    provider: 'Respan',
    responseModels: ['respan/span-01-lite:free', 'respan/span-01-lite-20260925'],
  },
  envelopeTotalMs: 1000,
  criteriaVersion: 'v1-20261111',
  cardExpiresAt: '2099-01-01T00:00:00+08:00',
  maxRequests: 4,
};

const approval = () => ({
  codeHead: binding.codeHead,
  treeHash: binding.treeHash,
  manifestSha256: binding.manifestSha256,
  isolatedConfigSha256: binding.isolatedConfigSha256,
  route: {
    endpoint: binding.route.endpoint,
    model: binding.route.model,
    provider: binding.route.provider,
    responseModels: [...binding.route.responseModels],
  },
  envelopeTotalMs: binding.envelopeTotalMs,
  criteriaVersion: binding.criteriaVersion,
  maxRequests: binding.maxRequests,
  expiresAt: '2099-01-01T00:00:00+08:00',
});

describe('verifyApproval', () => {
  it('accepts an approval that binds every frozen input', () => {
    expect(verifyApproval({approval: approval(), binding})).toEqual({ok: true, problems: []});
  });

  it('refuses a missing isolated config binding', () => {
    const candidate = approval();
    delete candidate.isolatedConfigSha256;
    const verdict = verifyApproval({approval: candidate, binding});
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContainEqual({code: 'APPROVAL_FIELD_MISSING', field: 'isolatedConfigSha256'});
  });

  it('refuses a config hash that differs from the file the runner loads', () => {
    const candidate = approval();
    candidate.isolatedConfigSha256 = 'e'.repeat(64);
    const verdict = verifyApproval({approval: candidate, binding});
    expect(verdict.problems).toContainEqual({
      code: 'APPROVAL_MISMATCH',
      field: 'isolatedConfigSha256',
      approved: 'e'.repeat(64),
      actual: binding.isolatedConfigSha256,
    });
  });

  it('refuses a different model allowlist', () => {
    const candidate = approval();
    candidate.route.responseModels = ['respan/span-01-lite:free'];
    const verdict = verifyApproval({approval: candidate, binding});
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.some((problem) => problem.field === 'route.responseModels')).toBe(true);
  });

  it('refuses an expired approval', () => {
    const candidate = approval();
    candidate.expiresAt = '2020-01-01T00:00:00+08:00';
    const verdict = verifyApproval({approval: candidate, binding});
    expect(verdict.problems).toContainEqual({
      code: 'APPROVAL_EXPIRED',
      expiresAt: candidate.expiresAt,
    });
  });

  it('refuses an approval that outlives the frozen card', () => {
    const candidate = approval();
    candidate.expiresAt = '2100-01-01T00:00:00+08:00';
    const verdict = verifyApproval({approval: candidate, binding});
    expect(verdict.problems.some((problem) => problem.code === 'APPROVAL_EXPIRY_AFTER_CARD')).toBe(true);
  });

  it('refuses a request cap that differs from the frozen budget', () => {
    const candidate = approval();
    candidate.maxRequests = 6;
    const verdict = verifyApproval({approval: candidate, binding});
    expect(verdict.problems).toContainEqual({
      code: 'APPROVAL_CAP_MISMATCH',
      field: 'maxRequests',
      approved: 6,
      actual: 4,
    });
  });
});

describe('claimApproval', () => {
  it('claims once and refuses the duplicate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri-1182-claim-'));
    const claimPath = path.join(dir, 'approval-claim.json');
    const record = {approvalSha256: 'f'.repeat(64), maxRequests: 4};

    expect(claimApproval({claimPath, record})).toEqual({ok: true, claimPath});
    expect(JSON.parse(fs.readFileSync(claimPath, 'utf8'))).toEqual(record);
    expect(claimApproval({claimPath, record})).toEqual({
      ok: false,
      reason: 'CLAIM_ALREADY_EXISTS',
      claimPath,
    });
  });
});

describe('assertFreshResults', () => {
  it('refuses to treat an existing results artifact as overwritable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri-1182-results-'));
    const resultsPath = path.join(dir, 'results.json');
    expect(assertFreshResults(resultsPath)).toEqual({ok: true});

    fs.writeFileSync(resultsPath, '{}\n');
    expect(assertFreshResults(resultsPath)).toEqual({
      ok: false,
      reason: 'RESULTS_ALREADY_EXISTS',
      resultsPath,
    });
  });
});

describe('reserveRequest', () => {
  it('allows the fourth request and refuses the fifth before it is sent', () => {
    expect(reserveRequest({sentSoFar: 0, cap: 4, caseId: 'c1'}).ok).toBe(true);
    expect(reserveRequest({sentSoFar: 3, cap: 4, caseId: 'c4'}).ok).toBe(true);
    expect(reserveRequest({sentSoFar: 4, cap: 4, caseId: 'c5'})).toEqual({
      ok: false,
      reason: 'REQUEST_CAP_EXCEEDED',
      caseId: 'c5',
      sentSoFar: 4,
      cap: 4,
    });
  });

  it('refuses a nonsensical cap', () => {
    expect(reserveRequest({sentSoFar: 0, cap: Number.NaN, caseId: 'c1'}).reason)
      .toBe('REQUEST_CAP_INVALID');
  });
});
