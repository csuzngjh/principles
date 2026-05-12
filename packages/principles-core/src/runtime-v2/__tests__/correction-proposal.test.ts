/**
 * PRI-114: CorrectionProposal contract + validators
 *
 * TDD tests for validateProposedParams and validateCorrectionProposal.
 */
import { describe, it, expect } from 'vitest';

describe('validateProposedParams', () => {
  async function getModule() {
    return import('../internalization/correction-proposal.js');
  }

  it('accepts valid proposed params that are a subset of original keys', async () => {
    const { validateProposedParams } = await getModule();
    const result = validateProposedParams(
      { content: 'fixed' },
      { content: 'broken', path: '/foo.ts' },
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts valid proposed params with nested serializable objects', async () => {
    const { validateProposedParams } = await getModule();
    const result = validateProposedParams(
      { options: { encoding: 'utf-8' } },
      { options: { encoding: 'ascii' }, path: '/foo.ts' },
    );
    expect(result.valid).toBe(true);
  });

  it('rejects null', async () => {
    const { validateProposedParams } = await getModule();
    const result = validateProposedParams(null, { path: '/foo.ts' });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects undefined', async () => {
    const { validateProposedParams } = await getModule();
    const result = validateProposedParams(undefined, { path: '/foo.ts' });
    expect(result.valid).toBe(false);
  });

  it('rejects arrays', async () => {
    const { validateProposedParams } = await getModule();
    const result = validateProposedParams([1, 2, 3], { path: '/foo.ts' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('plain object'))).toBe(true);
  });

  it('rejects string', async () => {
    const { validateProposedParams } = await getModule();
    const result = validateProposedParams('not an object', { path: '/foo.ts' });
    expect(result.valid).toBe(false);
  });

  it('rejects function values', async () => {
    const { validateProposedParams } = await getModule();
    const result = validateProposedParams(
      { callback: (() => null) as unknown as Function },
      { callback: null, path: '/foo.ts' },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('function') || e.includes('Function'))).toBe(true);
  });

  it('rejects undefined values', async () => {
    const { validateProposedParams } = await getModule();
    const result = validateProposedParams(
      { content: undefined },
      { content: 'original', path: '/foo.ts' },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('undefined'))).toBe(true);
  });

  it('rejects Symbol values', async () => {
    const { validateProposedParams } = await getModule();
    const result = validateProposedParams(
      { tag: Symbol('test') },
      { tag: 'original', path: '/foo.ts' },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('symbol') || e.includes('Symbol'))).toBe(true);
  });

  it('rejects circular references', async () => {
    const { validateProposedParams } = await getModule();
    const original: Record<string, unknown> = { path: '/bar.ts', self: null };
    const circular: Record<string, unknown> = { path: '/foo.ts' };
    circular.self = circular;
    const result = validateProposedParams(circular, original);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('circular') || e.includes('JSON'))).toBe(true);
  });

  it('rejects keys absent from original params', async () => {
    const { validateProposedParams } = await getModule();
    const result = validateProposedParams(
      { unknown_key: 'value' },
      { path: '/foo.ts' },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('unknown_key') || e.includes('not present'))).toBe(true);
  });

  it('rejects proposed toolName modification', async () => {
    const { validateProposedParams } = await getModule();
    const result = validateProposedParams(
      { toolName: 'dangerous_tool' },
      { toolName: 'write', path: '/foo.ts' },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('toolName') || e.includes('identity'))).toBe(true);
  });

  it('accepts empty proposed params (no-op correction)', async () => {
    const { validateProposedParams } = await getModule();
    const result = validateProposedParams({}, { path: '/foo.ts' });
    expect(result.valid).toBe(true);
  });

  it('rejects BigInt values', async () => {
    const { validateProposedParams } = await getModule();
    const result = validateProposedParams(
      { size: BigInt(9007199254740991) },
      { size: 100, path: '/foo.ts' },
    );
    expect(result.valid).toBe(false);
  });
});

describe('validateCorrectionProposal', () => {
  async function getModule() {
    return import('../internalization/correction-proposal.js');
  }

  function makeValidProposal() {
    return {
      proposedParams: { content: 'fixed' },
      correctedFields: [
        { field: 'content', original: 'broken', proposed: 'fixed', reason: 'typo fix' },
      ],
      applicationMode: 'shadow' as const,
      confidence: 0.85,
      ruleId: 'R_test_001',
      principleId: 'P_001',
      notifyAgent: true,
    };
  }

  it('accepts valid complete proposal', async () => {
    const { validateCorrectionProposal } = await getModule();
    const result = validateCorrectionProposal(makeValidProposal());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects null', async () => {
    const { validateCorrectionProposal } = await getModule();
    const result = validateCorrectionProposal(null);
    expect(result.valid).toBe(false);
  });

  it('rejects missing proposedParams', async () => {
    const { validateCorrectionProposal } = await getModule();
    const proposal = makeValidProposal();
    delete (proposal as Record<string, unknown>).proposedParams;
    const result = validateCorrectionProposal(proposal);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('proposedParams'))).toBe(true);
  });

  it('rejects missing correctedFields', async () => {
    const { validateCorrectionProposal } = await getModule();
    const proposal = makeValidProposal();
    delete (proposal as Record<string, unknown>).correctedFields;
    const result = validateCorrectionProposal(proposal);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('correctedFields'))).toBe(true);
  });

  it('rejects missing applicationMode', async () => {
    const { validateCorrectionProposal } = await getModule();
    const proposal = makeValidProposal();
    delete (proposal as Record<string, unknown>).applicationMode;
    const result = validateCorrectionProposal(proposal);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('applicationMode'))).toBe(true);
  });

  it('rejects invalid applicationMode', async () => {
    const { validateCorrectionProposal } = await getModule();
    const proposal = { ...makeValidProposal(), applicationMode: 'maybe' };
    const result = validateCorrectionProposal(proposal);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('applicationMode'))).toBe(true);
  });

  it('rejects confidence below 0', async () => {
    const { validateCorrectionProposal } = await getModule();
    const proposal = { ...makeValidProposal(), confidence: -0.1 };
    const result = validateCorrectionProposal(proposal);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence'))).toBe(true);
  });

  it('rejects confidence above 1', async () => {
    const { validateCorrectionProposal } = await getModule();
    const proposal = { ...makeValidProposal(), confidence: 1.5 };
    const result = validateCorrectionProposal(proposal);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('confidence'))).toBe(true);
  });

  it('accepts confidence at boundaries (0 and 1)', async () => {
    const { validateCorrectionProposal } = await getModule();
    const r0 = validateCorrectionProposal({ ...makeValidProposal(), confidence: 0 });
    expect(r0.valid).toBe(true);
    const r1 = validateCorrectionProposal({ ...makeValidProposal(), confidence: 1 });
    expect(r1.valid).toBe(true);
  });

  it('rejects missing ruleId', async () => {
    const { validateCorrectionProposal } = await getModule();
    const proposal = makeValidProposal();
    delete (proposal as Record<string, unknown>).ruleId;
    const result = validateCorrectionProposal(proposal);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('ruleId'))).toBe(true);
  });

  it('rejects empty ruleId', async () => {
    const { validateCorrectionProposal } = await getModule();
    const proposal = { ...makeValidProposal(), ruleId: '' };
    const result = validateCorrectionProposal(proposal);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('ruleId'))).toBe(true);
  });

  it('rejects missing notifyAgent', async () => {
    const { validateCorrectionProposal } = await getModule();
    const proposal = makeValidProposal();
    delete (proposal as Record<string, unknown>).notifyAgent;
    const result = validateCorrectionProposal(proposal);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('notifyAgent'))).toBe(true);
  });

  it('rejects non-boolean notifyAgent', async () => {
    const { validateCorrectionProposal } = await getModule();
    const proposal = { ...makeValidProposal(), notifyAgent: 'yes' };
    const result = validateCorrectionProposal(proposal);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('notifyAgent'))).toBe(true);
  });

  it('rejects non-JSON-serializable proposedParams', async () => {
    const { validateCorrectionProposal } = await getModule();
    const circular: Record<string, unknown> = { content: 'test' };
    circular.self = circular;
    const proposal = { ...makeValidProposal(), proposedParams: circular };
    const result = validateCorrectionProposal(proposal);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('proposedParams') || e.includes('serializable'))).toBe(true);
  });

  it('accepts proposal without principleId (optional)', async () => {
    const { validateCorrectionProposal } = await getModule();
    const proposal = makeValidProposal();
    delete (proposal as Record<string, unknown>).principleId;
    const result = validateCorrectionProposal(proposal);
    expect(result.valid).toBe(true);
  });
});
