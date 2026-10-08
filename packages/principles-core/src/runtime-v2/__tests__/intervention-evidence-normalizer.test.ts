/**
 * Intervention Evidence Normalizer validation matrix (PD v2 Phase 1).
 *
 * Every case maps to an ADR-0027 / SPEC §13 anti-forgery rule:
 * self-reports cannot upgrade, prepared/submitted cannot become delivered,
 * runtime_verified requires trusted activation + explicit boundary, effects
 * require exact episode references, and unknown inputs fail with structured
 * reasons instead of being coerced.
 */
import { describe, it, expect } from 'vitest';
import { normalizeInterventionEvidenceBatch } from '../intervention-evidence-normalizer.js';
import type { InterventionNormalization } from '../intervention-evidence-normalizer.js';
import type {
  InterventionEvidenceBatchInput,
  InterventionObservationInput,
} from '../types/intervention-evidence-contract.js';

function baseObservation(): InterventionObservationInput {
  return {
    observationKey: 'openclaw|delivery|prompt|sess-1|run-1|act-1',
    sourceLocator: 'logs/events_2026-10-07.jsonl',
    kind: 'delivery',
    occurredAt: '2026-10-07T07:59:59Z',
    nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-1', runId: 'run-1' },
    principleId: 'T-01',
    contentRef: {
      principleId: 'T-01',
      artifactId: 'art-1',
      payloadDigest: 'sha256:aa00000000000000000000000000000000000000000000000000000000000000',
      resolution: 'resolved',
    },
    activationRef: {
      activationId: 'act-1',
      artifactId: 'art-1',
      channel: 'prompt',
      activatedAt: '2026-10-01T00:00:00Z',
      sourceSnapshotDigest: 'sha256:bb00000000000000000000000000000000000000000000000000000000000000',
    },
    payload: {
      targetKind: 'agent_context',
      confirmation: 'submitted',
      outcome: 'attempted',
    },
  };
}

function validBatch(overrides: Partial<InterventionEvidenceBatchInput> = {}): InterventionEvidenceBatchInput {
  return {
    evidenceScopeId: 'ws-scope-1',
    sourceKind: 'openclaw_plugin_event_log',
    adapterVersion: 'openclaw-plugin@2.2.2',
    recordedAt: '2026-10-07T08:00:00Z',
    observations: [baseObservation()],
    ...overrides,
  };
}

function firstRecord(result: InterventionNormalization) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected normalization to succeed');
  const record = result.batch.records.at(0);
  expect(record).toBeDefined();
  if (!record) throw new Error('expected at least one record');
  return record;
}

describe('normalizeInterventionEvidenceBatch — happy paths', () => {
  it('normalizes a valid delivery attempt batch', () => {
    const record = firstRecord(normalizeInterventionEvidenceBatch(validBatch()));
    expect(record.evidenceId.startsWith('sha256:')).toBe(true);
    expect(record.recordDigest.startsWith('sha256:')).toBe(true);
    expect(record.payload).toEqual({
      targetKind: 'agent_context',
      confirmation: 'submitted',
      outcome: 'attempted',
    });
  });

  it('is deterministic: identical input yields identical evidenceId and digest', () => {
    const first = firstRecord(normalizeInterventionEvidenceBatch(validBatch()));
    const second = firstRecord(normalizeInterventionEvidenceBatch(validBatch()));
    expect(first.evidenceId).toBe(second.evidenceId);
    expect(first.recordDigest).toBe(second.recordDigest);
  });

  it('preserves an unresolved content reference without inventing a digest, while resolved references still require one', () => {
    const unresolved = firstRecord(normalizeInterventionEvidenceBatch(validBatch({
      observations: [{
        ...baseObservation(),
        contentRef: { principleId: 'T-01', resolution: 'revision_reference_unresolved' },
      }],
    })));
    expect(unresolved.contentRef).toEqual({ principleId: 'T-01', resolution: 'revision_reference_unresolved' });

    const resolved = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{
        ...baseObservation(),
        contentRef: { principleId: 'T-01', resolution: 'resolved' },
      }],
    }));
    expect(resolved).toEqual({ ok: false, reason: 'observation_contentRef_resolved_requires_payloadDigest' });

    const malformed = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{
        ...baseObservation(),
        contentRef: { principleId: 'T-01', payloadDigest: 'sha256:not-a-digest', resolution: 'resolved' },
      }],
    }));
    expect(malformed).toEqual({ ok: false, reason: 'observation_contentRef_payloadDigest_not_sha256' });
  });

  it('does not copy claim or input text from the short-lived Codex hook source', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      sourceKind: 'codex_pd_hook_event_log',
      observations: [{
        observationKey: 'codex|application|claim|session|tool',
        sourceLocator: 'codex-pd-hook-event-log:session',
        kind: 'application',
        nativeRefs: { hostKind: 'codex', sessionId: 'session', toolCallId: 'tool' },
        principleId: 'T-01',
        payload: { proofMethod: 'agent_claimed', action: 'self_reported', claimText: 'private task text' },
      }],
    }));
    expect(result).toEqual({ ok: false, reason: 'codex_hook_evidence_forbids_source_content:claimText' });
  });

  it('accepts a runtime_verified application with activation ref and boundary', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{
        observationKey: 'openclaw|application|gate|sess-1|run-1|act-1',
        sourceLocator: 'logs/events_2026-10-07.jsonl',
        kind: 'application',
        nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-1', runId: 'run-1', toolName: 'write_file' },
        principleId: 'T-01',
        activationRef: {
          activationId: 'act-1',
          sourceSnapshotDigest: 'sha256:bb00000000000000000000000000000000000000000000000000000000000000',
        },
        payload: {
          proofMethod: 'runtime_verified',
          action: 'tool_blocked',
          enforcementBoundary: 'pd_gate_block_returned',
        },
      }],
    }));
    expect(result.ok).toBe(true);
  });

  it('accepts an owner outcome with a resolved actor', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      sourceKind: 'owner_console_input',
      observations: [{
        observationKey: 'owner|outcome|ep-1|1',
        sourceLocator: 'console:evidence-outcomes',
        kind: 'outcome',
        nativeRefs: { hostKind: 'openclaw' },
        episodeKey: 'openclaw|episode|sess-1|tool-1',
        payload: {
          outcomeSource: 'owner_feedback',
          observationSummary: 'Test file was not created.',
          feedbackText: '阻止符合预期',
          actorId: 'owner-1',
        },
      }],
    }));
    expect(result.ok).toBe(true);
  });
});

describe('delivery semantics (ADR-0027 §2.4)', () => {
  it('rejects delivered under a pre-confirmation strength', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{ ...baseObservation(), payload: { targetKind: 'agent_context', confirmation: 'submitted', outcome: 'delivered' } }],
    }));
    expect(result).toEqual({ ok: false, reason: 'delivery_delivered_requires_confirmed_boundary' });
  });

  it('accepts delivered only at host_accepted or stronger', () => {
    for (const confirmation of ['host_accepted', 'context_present', 'runtime_loaded'] as const) {
      const result = normalizeInterventionEvidenceBatch(validBatch({
        observations: [{ ...baseObservation(), payload: { targetKind: 'runtime_enforcement', confirmation, outcome: 'delivered' } }],
      }));
      expect(result.ok).toBe(true);
    }
  });

  it('rejects failed without an explicit failure reason', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{ ...baseObservation(), payload: { targetKind: 'agent_context', confirmation: 'prepared', outcome: 'failed' } }],
    }));
    expect(result).toEqual({ ok: false, reason: 'delivery_failed_requires_failure_reason' });
  });

  it('rejects unsupported without a boundary note', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{ ...baseObservation(), payload: { targetKind: 'agent_context', confirmation: 'prepared', outcome: 'unsupported' } }],
    }));
    expect(result).toEqual({ ok: false, reason: 'delivery_unsupported_requires_boundary_note' });
  });

  it('rejects a delivery attempt without content or activation reference', () => {
    const noContent = { ...baseObservation(), contentRef: undefined };
    expect(normalizeInterventionEvidenceBatch(validBatch({ observations: [noContent] })))
      .toEqual({ ok: false, reason: 'delivery_requires_content_and_activation_reference' });
    const noActivation = { ...baseObservation(), activationRef: undefined };
    expect(normalizeInterventionEvidenceBatch(validBatch({ observations: [noActivation] })))
      .toEqual({ ok: false, reason: 'delivery_requires_content_and_activation_reference' });
  });
});

describe('application proof boundary (ADR-0027 §2.3)', () => {
  const agentClaim: InterventionObservationInput = {
    observationKey: 'openclaw|application|selfreport|sess-1|T-01',
    sourceLocator: 'principle_applications:17',
    kind: 'application',
    nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-1' },
    principleId: 'T-01',
    payload: { proofMethod: 'agent_claimed', action: 'self_reported', claimText: '应用了你的原则「T-01」' },
  };

  it('accepts an agent_claimed self-report with its verbatim claim', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({ observations: [agentClaim] }));
    expect(result.ok).toBe(true);
  });

  it('rejects agent_claimed that smuggles an enforcement boundary', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{ ...agentClaim, payload: { ...agentClaim.payload, enforcementBoundary: 'runtime' } }],
    }));
    expect(result).toEqual({ ok: false, reason: 'agent_claimed_forbids_enforcement_boundary' });
  });

  it('rejects a self-report claiming a runtime action', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{ ...agentClaim, payload: { proofMethod: 'agent_claimed', action: 'tool_blocked', claimText: 'x' } }],
    }));
    expect(result).toEqual({ ok: false, reason: 'agent_claimed_requires_self_reported_action' });
  });

  it('rejects runtime_verified without an activation reference', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{
        observationKey: 'k', sourceLocator: 'l', kind: 'application',
        nativeRefs: { hostKind: 'openclaw' }, principleId: 'T-01',
        payload: { proofMethod: 'runtime_verified', action: 'tool_blocked', enforcementBoundary: 'pd_gate_block_returned' },
      }],
    }));
    expect(result).toEqual({ ok: false, reason: 'runtime_verified_application_requires_activation_reference' });
  });

  it('rejects runtime_verified without an explicit enforcement boundary', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{
        observationKey: 'k', sourceLocator: 'l', kind: 'application',
        nativeRefs: { hostKind: 'openclaw' }, principleId: 'T-01',
        activationRef: { activationId: 'act-1', sourceSnapshotDigest: 'sha256:b000000000000000000000000000000000000000000000000000000000000000' },
        payload: { proofMethod: 'runtime_verified', action: 'tool_blocked' },
      }],
    }));
    expect(result).toEqual({ ok: false, reason: 'runtime_verified_requires_enforcement_boundary' });
  });

  it('rejects shadow/match-style actions that are not real application actions', () => {
    const result = normalizeInterventionEvidenceBatch({
      ...validBatch(),
      observations: [{
        observationKey: 'k', sourceLocator: 'l', kind: 'application',
        nativeRefs: { hostKind: 'openclaw' }, principleId: 'T-01',
        activationRef: { activationId: 'act-1', sourceSnapshotDigest: 'sha256:b000000000000000000000000000000000000000000000000000000000000000' },
        payload: { proofMethod: 'runtime_verified', action: 'shadow_evaluated', enforcementBoundary: 'x' },
      }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('action_invalid');
  });
});

describe('episode / effect / outcome relations (SPEC §13.3)', () => {
  it('rejects an episode associated only by session identity', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{
        observationKey: 'k', sourceLocator: 'l', kind: 'behavior_episode',
        nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-1' },
        payload: { status: 'closed', actionSummary: 'write_file attempted' },
      }],
    }));
    expect(result).toEqual({ ok: false, reason: 'episode_requires_native_event_key' });
  });

  it('accepts an episode with a native tool-call key', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{
        observationKey: 'openclaw|episode|sess-1|tool-9',
        sourceLocator: 'l', kind: 'behavior_episode',
        nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-1', toolCallId: 'tool-9', toolName: 'write_file' },
        payload: { status: 'closed', actionSummary: 'write_file to test.txt' },
      }],
    }));
    expect(result.ok).toBe(true);
  });

  it('rejects an effect without an exact episode reference', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{
        observationKey: 'k', sourceLocator: 'l', kind: 'effect',
        nativeRefs: { hostKind: 'openclaw', toolCallId: 'tool-9' },
        principleId: 'T-01',
        contentRef: { principleId: 'T-01', payloadDigest: 'sha256:a000000000000000000000000000000000000000000000000000000000000000', resolution: 'resolved' },
        payload: { status: 'observed', observationSummary: 'tool blocked by rule' },
      }],
    }));
    expect(result).toEqual({ ok: false, reason: 'effect_requires_episode_principle_and_content_reference' });
  });

  it('rejects disputed/invalidated effects without a dispute reason', () => {
    const mkEffect = (status: 'disputed' | 'invalidated'): InterventionObservationInput => ({
      observationKey: 'k', sourceLocator: 'l', kind: 'effect',
      nativeRefs: { hostKind: 'openclaw', toolCallId: 't' },
      principleId: 'T-01', episodeKey: 'ep-1',
      contentRef: { principleId: 'T-01', payloadDigest: 'sha256:a000000000000000000000000000000000000000000000000000000000000000', resolution: 'resolved' },
      payload: { status, observationSummary: 's' },
    });
    expect(normalizeInterventionEvidenceBatch(validBatch({ observations: [mkEffect('disputed')] })))
      .toEqual({ ok: false, reason: 'effect_disputed_or_invalidated_requires_dispute_reason' });
    expect(normalizeInterventionEvidenceBatch(validBatch({ observations: [mkEffect('invalidated')] })))
      .toEqual({ ok: false, reason: 'effect_disputed_or_invalidated_requires_dispute_reason' });
  });

  it('rejects an outcome without an episode reference', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{
        observationKey: 'k', sourceLocator: 'l', kind: 'outcome',
        nativeRefs: { hostKind: 'openclaw' },
        payload: { outcomeSource: 'owner_feedback', observationSummary: 's', actorId: 'owner-1' },
      }],
    }));
    expect(result).toEqual({ ok: false, reason: 'outcome_requires_episode_reference' });
  });

  it('rejects owner_feedback without a server-resolved actor', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{
        observationKey: 'k', sourceLocator: 'l', kind: 'outcome',
        nativeRefs: { hostKind: 'openclaw' }, episodeKey: 'ep-1',
        payload: { outcomeSource: 'owner_feedback', observationSummary: 's' },
      }],
    }));
    expect(result).toEqual({ ok: false, reason: 'owner_feedback_requires_resolved_actor' });
  });
});

describe('untrusted-input hardening (rc-1..rc-5)', () => {
  it('rejects non-object batches', () => {
    expect(normalizeInterventionEvidenceBatch(null)).toEqual({ ok: false, reason: 'batch_is_not_an_object' });
    expect(normalizeInterventionEvidenceBatch('x')).toEqual({ ok: false, reason: 'batch_is_not_an_object' });
  });

  it('rejects unknown top-level fields — no score or ranking can be smuggled in', () => {
    const result = normalizeInterventionEvidenceBatch({
      ...validBatch(),
      effectivenessScore: 0.9,
    });
    expect(result).toEqual({ ok: false, reason: 'batch_unknown_field:effectivenessScore' });
  });

  it('rejects unknown observation fields', () => {
    // Deliberately malformed fixture passed as unknown — the ingress boundary
    // receives untrusted data, not typed input (rc-1).
    const batch = {
      ...validBatch(),
      observations: [{ ...baseObservation(), successRate: 1 }],
    };
    expect(normalizeInterventionEvidenceBatch(batch)).toEqual({ ok: false, reason: 'observation_unknown_field:successRate' });
  });

  it('rejects unknown payload fields per kind', () => {
    const batch = {
      ...validBatch(),
      observations: [{
        ...baseObservation(),
        payload: { targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted', score: 1 },
      }],
    };
    expect(normalizeInterventionEvidenceBatch(batch)).toEqual({ ok: false, reason: 'observation_payload_delivery_unknown_field:score' });
  });

  it('rejects duplicate observation keys within one batch', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({ observations: [baseObservation(), baseObservation()] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('batch_duplicate_observation_key');
  });

  it('rejects oversized batches', () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ ...baseObservation(), observationKey: `k-${i}` }));
    const result = normalizeInterventionEvidenceBatch(validBatch({ observations: many }));
    expect(result).toEqual({ ok: false, reason: 'batch_observations_too_large:65>64' });
  });

  it('rejects non-ISO timestamps', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({ recordedAt: '2026-10-07 08:00:00' }));
    expect(result).toEqual({ ok: false, reason: 'batch_recordedAt_missing_or_not_iso_utc' });
    const impossibleDate = normalizeInterventionEvidenceBatch(validBatch({ recordedAt: '2026-99-99T08:00:00Z' }));
    expect(impossibleDate).toEqual({ ok: false, reason: 'batch_recordedAt_missing_or_not_iso_utc' });
  });

  it('rejects over-long free text at the documented bounds', () => {
    const long = 'x'.repeat(401);
    const result = normalizeInterventionEvidenceBatch(validBatch({
      observations: [{
        observationKey: 'k', sourceLocator: 'l', kind: 'behavior_episode',
        nativeRefs: { hostKind: 'openclaw', toolCallId: 't' },
        payload: { status: 'closed', actionSummary: long },
      }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('actionSummary_too_long');
  });

  it('rejects corrections that lack a reason or a reference', () => {
    const withRefOnly = { ...baseObservation(), correctionOf: 'sha256:old', correctionReason: undefined };
    expect(normalizeInterventionEvidenceBatch(validBatch({ observations: [withRefOnly] })))
      .toEqual({ ok: false, reason: 'correction_requires_both_reference_and_reason' });
    const withReasonOnly = { ...baseObservation(), correctionOf: undefined, correctionReason: 're-observed' };
    expect(normalizeInterventionEvidenceBatch(validBatch({ observations: [withReasonOnly] })))
      .toEqual({ ok: false, reason: 'correction_requires_both_reference_and_reason' });
  });
});

describe('capability declarations (SPEC §13.6)', () => {
  it('accepts a supported capability with a proof note', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      capabilityDeclarations: [{
        hostKind: 'openclaw',
        capability: 'application_runtime_verified',
        status: 'supported',
        adapterVersion: 'openclaw-plugin@2.2.2',
        channel: 'code_tool_hook',
        maxConfirmation: 'runtime_loaded',
        note: 'RuleHost live evaluation + gate block return',
      }],
    }));
    expect(result.ok).toBe(true);
  });

  it('rejects supported without a proof reference', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      capabilityDeclarations: [{
        hostKind: 'codex', capability: 'agent_context_delivery', status: 'supported',
        adapterVersion: 'codex-adapter@2.2.2', channel: 'pd-hook',
      }],
    }));
    expect(result).toEqual({ ok: false, reason: 'capability_supported_requires_proof_note' });
  });

  it('accepts honest unknown and unsupported states', () => {
    const result = normalizeInterventionEvidenceBatch(validBatch({
      capabilityDeclarations: [
        { hostKind: 'codex', capability: 'agent_context_delivery', status: 'unknown', adapterVersion: 'v', channel: 'pd-hook' },
        { hostKind: 'codex', capability: 'application_self_report', status: 'unsupported', adapterVersion: 'v', channel: 'pd-hook' },
      ],
    }));
    expect(result.ok).toBe(true);
  });

  it('rejects a capability outside the closed vocabulary (rc-2, no as-cast past validation)', () => {
    // Simulates an untrusted producer payload (rc-1): the type would forbid
    // the forged value, but the RUNTIME must reject it regardless.
    const forged = {
      ...validBatch(),
      capabilityDeclarations: [{
        hostKind: 'openclaw',
        capability: 'effectiveness_score',
        status: 'supported',
        adapterVersion: 'openclaw-plugin@2.2.2',
        channel: 'code_tool_hook',
        note: 'a forged capability must never reach the ledger',
      }],
    } as unknown as InterventionEvidenceBatchInput;
    const result = normalizeInterventionEvidenceBatch(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('capability_invalid');
  });
});
