/**
 * Response budget boundary tests — SPEC-PD-MCP-GATE4-001 §4.6 (Gate 4-A
 * freeze; §11.4 acceptance: 32768 passes, 32769 rejected).
 *
 * Uses synthetic envelopes (via an injected capability) padded to exact UTF-8
 * byte sizes, because real capability envelopes are far below the budget —
 * the boundary is an Adapter contract that must hold regardless of future
 * envelope growth. Also pins: over-budget NEVER silently truncates, and the
 * failure envelope itself fits the budget.
 */
import { describe, it, expect } from 'vitest';
import { measureTextBytes, RESPONSE_BUDGET_BYTES } from '../budget.js';
import { assembleResult, adapterFailureEnvelope } from '../envelope.js';
import type { PainRecallCapabilityResult } from '@principles/core/runtime/pain-recall-capability';

function envelopeWithRequestedId(requestedId: string): PainRecallCapabilityResult {
  return {
    schemaVersion: 'pd.capability.v1',
    capability: 'pd_recall_principle_pains',
    disclosureProfile: 'od-a-v1',
    status: 'ok',
    data: {
      principle: { requestedId, identityStatus: 'resolved' },
      query: { limit: 3, contextUsedForRanking: false, truncated: false },
      results: [],
      summary: { returned: 0, availableCandidates: 0, truncated: false },
      sources: { ledger: 'ok', trajectoryDb: 'ok', stateDb: 'ok' },
      unresolvedAssociations: [],
    },
    provenance: { workspaceBinding: 'configured', sources: [] },
    warnings: [],
    error: null,
    nextAction: null,
  };
}

function paddedEnvelope(totalBytes: number): PainRecallCapabilityResult {
  // ASCII-only envelope: JSON string length === UTF-8 byte length.
  const base = envelopeWithRequestedId('x');
  const baseBytes = measureTextBytes(JSON.stringify(base));
  if (baseBytes > totalBytes) throw new Error(`cannot pad down: base=${baseBytes} target=${totalBytes}`);
  return envelopeWithRequestedId('x'.repeat(totalBytes - baseBytes + 1));
}

describe('response budget boundary (§4.6)', () => {
  it('32768 bytes passes with the envelope delivered verbatim (no truncation)', () => {
    const envelope = paddedEnvelope(RESPONSE_BUDGET_BYTES);
    const json = JSON.stringify(envelope);
    expect(measureTextBytes(json)).toBe(RESPONSE_BUDGET_BYTES);
    const assembled = assembleResult(envelope);
    expect(assembled.ok).toBe(true);
    if (assembled.ok) {
      const [block] = assembled.result.content;
      expect(block?.text).toBe(json);
      expect(assembled.result.isError).toBeUndefined();
    }
  });

  it('32769 bytes is rejected as response_budget_exceeded (isError, no truncation)', () => {
    const envelope = paddedEnvelope(RESPONSE_BUDGET_BYTES + 1);
    expect(measureTextBytes(JSON.stringify(envelope))).toBe(RESPONSE_BUDGET_BYTES + 1);
    const assembled = assembleResult(envelope);
    expect(assembled.ok).toBe(false);
    if (!assembled.ok) {
      expect(assembled.overBudgetBytes).toBe(RESPONSE_BUDGET_BYTES + 1);
    }
  });

  it('the response_budget_exceeded failure envelope itself fits the budget', () => {
    const failure = adapterFailureEnvelope(
      'response_budget_exceeded',
      'The response exceeded the 32 KiB MCP budget and was withheld without truncation.'
    );
    const json = JSON.stringify(failure);
    expect(measureTextBytes(json)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const assembled = assembleResult(failure);
    expect(assembled.ok).toBe(true);
  });

  it('multi-byte UTF-8 content is measured in bytes, not code points', () => {
    // '测' is 3 bytes per char; 1 char + 2 ASCII = 5 bytes.
    const s = '测ab';
    expect(measureTextBytes(s)).toBe(5);
  });
});
