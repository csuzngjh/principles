import { describe, expect, it } from 'vitest';
import type { ActivatedPrinciple } from '@principles/core/runtime-v2';
import type { PromptActivationCandidates } from '../src/active-principle-prompt.js';
import {
  createAdaptivePrincipleRevalidator,
  revalidateAdaptivePrinciple,
} from '../src/adaptive-principle-revalidation.js';

const expected: ActivatedPrinciple = {
  principleId: 'P-1',
  text: 'Keep the delivery evidence bounded.',
  artifactId: 'artifact-1',
  activationId: 'activation-1',
  artifactContentSha256: 'a'.repeat(64),
  authority: 'owner',
  approvedBy: 'owner-1',
};

function readResult(principles: ActivatedPrinciple[] = [expected], overrides: Partial<PromptActivationCandidates> = {}): PromptActivationCandidates {
  return {
    principles,
    warnings: [],
    aborted: false,
    selfReportEnabled: false,
    abstractionLayerEnabled: false,
    ...overrides,
  };
}

const revalidatorOf = (result: PromptActivationCandidates) =>
  createAdaptivePrincipleRevalidator(async () => result);

describe('revalidateAdaptivePrinciple', () => {
  it('accepts the same currently active body, activation, and authorization', async () => {
    await expect(revalidatorOf(readResult())('workspace', expected, new AbortController().signal))
      .resolves.toBe(true);
  });

  it('rejects revocation, a revised body, or a replacement activation', async () => {
    const revoked = readResult([]);
    const revised = readResult([{ ...expected, text: 'Changed body.' }]);
    const replaced = readResult([{ ...expected, activationId: 'activation-2' }]);
    for (const result of [revoked, revised, replaced]) {
      await expect(revalidatorOf(result)('workspace', expected, new AbortController().signal))
        .resolves.toBe(false);
    }
  });

  it('rejects changed authority or approver', async () => {
    for (const principle of [{ ...expected, authority: 'system_policy' as const }, { ...expected, approvedBy: 'owner-2' }]) {
      await expect(revalidatorOf(readResult([principle]))('workspace', expected, new AbortController().signal))
        .resolves.toBe(false);
    }
  });

  it('fails closed on duplicate target identity, incomplete reads, and reader errors', async () => {
    const duplicate = readResult([expected, { ...expected }]);
    const incomplete = readResult([expected], { warnings: ['artifact_query_failed: artifactId=artifact-2'] });
    const abortedRead = readResult([expected], { aborted: true });
    for (const result of [duplicate, incomplete, abortedRead]) {
      await expect(revalidatorOf(result)('workspace', expected, new AbortController().signal))
        .resolves.toBe(false);
    }
    await expect(createAdaptivePrincipleRevalidator(async () => { throw new Error('read failed'); })('workspace', expected, new AbortController().signal))
      .resolves.toBe(false);
  });

  it('rejects an already aborted signal and returns false if timeout aborts during the read', async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(revalidateAdaptivePrinciple('workspace', expected, alreadyAborted.signal))
      .resolves.toBe(false);

    const duringRead = new AbortController();
    let finishRead!: (result: PromptActivationCandidates) => void;
    const pendingReader = () => new Promise<PromptActivationCandidates>((resolve) => { finishRead = resolve; });
    const revalidation = createAdaptivePrincipleRevalidator(pendingReader)('workspace', expected, duringRead.signal);
    duringRead.abort();
    await expect(revalidation).resolves.toBe(false);
    finishRead(readResult());
  });

  it('uses the real readPromptActivationCandidates reader by default', async () => {
    await expect(revalidateAdaptivePrinciple('missing-workspace', expected, new AbortController().signal))
      .resolves.toBe(false);
  });
});

describe('artifact revision binding', () => {
  it('rejects a metadata-only revision and a legacy snapshot missing the digest', async () => {
    const revised = readResult([{ ...expected, artifactContentSha256: 'b'.repeat(64) }]);
    await expect(revalidatorOf(revised)('workspace', expected, new AbortController().signal)).resolves.toBe(false);
    await expect(revalidatorOf(readResult())('workspace', { ...expected, artifactContentSha256: undefined }, new AbortController().signal)).resolves.toBe(false);
  });
});
