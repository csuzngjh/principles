import { describe, expect, it } from 'vitest';
import type { DiagnosticianContextPayload } from '../../context-payload.js';
import {
  collectTrustedEvidenceRefs,
  findUnboundEvidenceRefs,
  formatUnboundEvidenceRefErrors,
} from '../evidence-ref-binding.js';

const TASK_ID = 'diagnosis_pain_host_abc';
const REAL_REF = 'owner_message:2026-10-30T13:22:00.000Z';

function makePayload(
  overrides: Partial<DiagnosticianContextPayload> = {},
): DiagnosticianContextPayload {
  return {
    contextId: 'ctx-1',
    contextHash: 'hash-1',
    taskId: TASK_ID,
    workspaceDir: 'D:/workspace',
    sourceRefs: [TASK_ID, 'run-1', REAL_REF, 'signal_collector'],
    diagnosisTarget: {
      reasonSummary: 'Owner correction',
      evidence: [{ sourceRef: REAL_REF, note: 'Owner said the answer was wrong' }],
    },
    conversationWindow: [
      { ts: '2026-10-30T13:22:00.000Z', role: 'user', text: 'why is this wrong?' },
      { ts: '2026-10-30T13:22:05.000Z', role: 'assistant', text: 'I will investigate' },
      { ts: '2026-10-30T13:22:06.000Z', role: 'tool', toolName: 'bash' },
    ],
    ...overrides,
  };
}

function makeOutput(
  evidenceRef = REAL_REF,
  causalRefs: string[] = [REAL_REF],
): Record<string, unknown> {
  return {
    evidence: [{ sourceRef: evidenceRef, note: 'analysis' }],
    causalChain: [{ why: 1, statement: 'surface', evidenceRefs: causalRefs }],
  };
}

describe('evidence reference binding (PRI-1059)', () => {
  it('rejects the Stage A prompt-example references from the incident replay', () => {
    const payload = makePayload();
    const trusted = collectTrustedEvidenceRefs(payload);
    const output = {
      evidence: [{ sourceRef: 'example', note: 'example' }],
      causalChain: [{ why: 1, statement: 'example', evidenceRefs: ['example'] }],
    };

    expect(findUnboundEvidenceRefs(output, trusted)).toEqual([
      { path: 'evidence[0].sourceRef', ref: 'example' },
      { path: 'causalChain[0].evidenceRefs[0]', ref: 'example' },
    ]);
  });

  it('accepts refs that are present in the real diagnosis context', () => {
    const payload = makePayload();
    const trusted = collectTrustedEvidenceRefs(payload);

    expect(findUnboundEvidenceRefs(makeOutput(), trusted)).toEqual([]);
  });

  it('accepts owner_correction only when correction evidence exists', () => {
    const withoutCorrection = makePayload();
    const withCorrection = makePayload({
      diagnosisTarget: {
        correctionEvidence: { text: '不要再给错误信息' },
      },
    });

    expect(
      findUnboundEvidenceRefs(
        makeOutput('owner_correction', ['owner_correction']),
        collectTrustedEvidenceRefs(withoutCorrection),
      ),
    ).not.toEqual([]);
    expect(
      findUnboundEvidenceRefs(
        makeOutput('owner_correction', ['owner_correction']),
        collectTrustedEvidenceRefs(withCorrection),
      ),
    ).toEqual([]);
  });

  it('does not trust a reserved owner_correction ref smuggled through pain evidence', () => {
    const payload = makePayload({
      sourceRefs: [TASK_ID, 'owner_correction'],
      diagnosisTarget: {
        evidence: [{ sourceRef: 'owner_correction', note: 'not a real correction' }],
      },
    });

    expect(
      findUnboundEvidenceRefs(
        makeOutput('owner_correction', ['owner_correction']),
        collectTrustedEvidenceRefs(payload),
      ),
    ).not.toEqual([]);
  });

  it('accepts conversation timestamp refs only for the matching role and entry', () => {
    const trusted = collectTrustedEvidenceRefs(makePayload());

    expect(findUnboundEvidenceRefs(makeOutput('owner_message:2026-10-30T13:22:00.000Z'), trusted)).toEqual([]);
    expect(findUnboundEvidenceRefs(makeOutput('agent_turn:2026-10-30T13:22:05.000Z'), trusted)).toEqual([]);
    expect(findUnboundEvidenceRefs(makeOutput('tool_call_failure:2026-10-30T13:22:06.000Z'), trusted)).toEqual([]);
    expect(findUnboundEvidenceRefs(makeOutput('owner_message:2026-10-30T13:22:05.000Z'), trusted)).not.toEqual([]);
    expect(findUnboundEvidenceRefs(makeOutput('agent_turn:does-not-exist'), trusted)).not.toEqual([]);
  });

  it('reports a machine-greppable error and no error for malformed output', () => {
    const trusted = collectTrustedEvidenceRefs(makePayload());
    const errors = formatUnboundEvidenceRefErrors(
      findUnboundEvidenceRefs(makeOutput('fabricated:ref'), trusted),
    );

    expect(errors[0]).toContain('evidence_ref_unbound');
    expect(errors[0]).toContain('evidence[0].sourceRef');
    expect(findUnboundEvidenceRefs(null, trusted)).toEqual([]);
    expect(findUnboundEvidenceRefs({ evidence: 'not-an-array' }, trusted)).toEqual([]);
  });
});
