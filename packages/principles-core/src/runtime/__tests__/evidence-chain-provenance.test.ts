import { describe, expect, it } from 'vitest';
import { assembleEvidenceChain } from '../types/evidence-chain-contract.js';

/**
 * SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8 §6.6.4: provenance enters the read-only
 * evidence-chain model.
 *
 * The ONLY source is the provenance already persisted in the diagnostician
 * task's diagnostic_json (the observability payload). The module must not add a
 * pain_events column, re-derive provenance, or invent a second truth.
 */

function makeBaseParams(overrides: Partial<Parameters<typeof assembleEvidenceChain>[0]> = {}) {
  return {
    workspaceDir: '/workspace/test',
    painEvents: [
      {
        id: 1,
        source: 'mcp_agent_assisted',
        reason: 'Agent modified config without approval',
        text: 'Agent modified config without approval',
        created_at: '2026-11-10T10:00:00.000Z',
        score: 40,
      },
    ],
    tasks: [
      {
        task_id: 'diagnosis_pain_1',
        status: 'pending',
        created_at: '2026-11-10T10:00:01.000Z',
        input_ref: 'pain_1',
        diagnostic_json: JSON.stringify({ provenance: 'agent_reported_owner_approved' }),
      },
    ],
    candidates: [],
    dreamerTasks: [],
    ledgerPrinciples: [],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
    ...overrides,
  };
}

describe('evidence chain — provenance passthrough (SPEC v0.8 §6.6.4)', () => {
  it('carries agent_reported_owner_approved from the linked task diagnostic_json', () => {
    const response = assembleEvidenceChain(makeBaseParams());
    expect(response.records).toHaveLength(1);
    expect(response.records[0]?.provenance).toBe('agent_reported_owner_approved');
  });

  it('passes the three legacy provenance values through unchanged', () => {
    for (const provenance of ['host_context_bound', 'owner_reported_no_host_trace', 'automatic_hook']) {
      const response = assembleEvidenceChain(makeBaseParams({
        tasks: [
          {
            task_id: 'diagnosis_pain_1',
            status: 'pending',
            created_at: '2026-11-10T10:00:01.000Z',
            input_ref: 'pain_1',
            diagnostic_json: JSON.stringify({ provenance }),
          },
        ],
      }));
      expect(response.records[0]?.provenance).toBe(provenance);
    }
  });

  it('normalizes the legacy openclaw_context_bound spelling instead of dropping it', () => {
    const response = assembleEvidenceChain(makeBaseParams({
      tasks: [
        {
          task_id: 'diagnosis_pain_1',
          status: 'pending',
          created_at: '2026-11-10T10:00:01.000Z',
          input_ref: 'pain_1',
          diagnostic_json: JSON.stringify({ provenance: 'openclaw_context_bound' }),
        },
      ],
    }));
    expect(response.records[0]?.provenance).toBe('host_context_bound');
  });

  it('omits provenance for unknown values without dropping the record', () => {
    const response = assembleEvidenceChain(makeBaseParams({
      tasks: [
        {
          task_id: 'diagnosis_pain_1',
          status: 'pending',
          created_at: '2026-11-10T10:00:01.000Z',
          input_ref: 'pain_1',
          diagnostic_json: JSON.stringify({ provenance: 'owner_observed_directly' }),
        },
      ],
    }));
    expect(response.records).toHaveLength(1);
    expect(response.records[0]?.provenance).toBeUndefined();
  });

  it('reads provenance even when the artifact already supplied the rootCause', () => {
    const response = assembleEvidenceChain(makeBaseParams({
      diagnosticArtifacts: [
        {
          task_id: 'diagnosis_pain_1',
          content_json: JSON.stringify({ rootCause: { summary: 'artifact root cause' } }),
        },
      ],
    }));
    expect(response.records[0]?.rootCauseSummary).toBe('artifact root cause');
    expect(response.records[0]?.provenance).toBe('agent_reported_owner_approved');
  });

  it('carries provenance on task-only records (no matching pain_event)', () => {
    const response = assembleEvidenceChain(makeBaseParams({
      painEvents: [],
      tasks: [
        {
          task_id: 'diagnosis_manual_abc',
          status: 'pending',
          created_at: '2026-11-10T10:00:01.000Z',
          diagnostic_json: JSON.stringify({ provenance: 'agent_reported_owner_approved' }),
        },
      ],
    }));
    expect(response.records).toHaveLength(1);
    expect(response.records[0]?.id).toBe('manual_abc');
    expect(response.records[0]?.provenance).toBe('agent_reported_owner_approved');
  });

  it('keeps the pre-existing degrade semantics when diagnostic_json is unparseable', () => {
    const withoutArtifact = assembleEvidenceChain(makeBaseParams({
      tasks: [
        {
          task_id: 'diagnosis_pain_1',
          status: 'pending',
          created_at: '2026-11-10T10:00:01.000Z',
          input_ref: 'pain_1',
          diagnostic_json: '{not json',
        },
      ],
    }));
    expect(withoutArtifact.records[0]?.degradedReason).toBe('Diagnostic data for this record could not be parsed');

    const withArtifact = assembleEvidenceChain(makeBaseParams({
      tasks: [
        {
          task_id: 'diagnosis_pain_1',
          status: 'pending',
          created_at: '2026-11-10T10:00:01.000Z',
          input_ref: 'pain_1',
          diagnostic_json: '{not json',
        },
      ],
      diagnosticArtifacts: [
        {
          task_id: 'diagnosis_pain_1',
          content_json: JSON.stringify({ rootCause: { summary: 'artifact root cause' } }),
        },
      ],
    }));
    expect(withArtifact.records[0]?.rootCauseSummary).toBe('artifact root cause');
    expect(withArtifact.records[0]?.degradedReason).toBeUndefined();
  });
});
