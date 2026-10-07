/**
 * Intervention Evidence Contract invariants (PD v2 Phase 1, ADR-0027).
 *
 * These tests pin the structural guarantees the architecture depends on:
 * closed state vocabularies, the confirmation ladder ordering, and the
 * deterministic identity/canonicalization helpers that store-level
 * idempotency builds on. Behavioral validation lives in
 * intervention-evidence-normalizer.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  DELIVERED_CONFIRMATIONS,
  DELIVERY_CONFIRMATIONS,
  INTERVENTION_CAPABILITIES,
  INTERVENTION_RECORD_KINDS,
  INTERVENTION_SOURCE_KINDS,
  INTERVENTION_TEXT_BOUNDS,
} from '../types/intervention-evidence-contract.js';
import {
  canonicalJson,
  computeEvidenceId,
  computeRecordDigest,
  mintObservationKey,
} from '../intervention-evidence-normalizer.js';
import type { NormalizedInterventionRecord } from '../types/intervention-evidence-contract.js';

describe('intervention evidence contract vocabulary', () => {
  it('exposes exactly the five Phase 1 record kinds', () => {
    expect([...INTERVENTION_RECORD_KINDS]).toEqual([
      'delivery', 'application', 'behavior_episode', 'effect', 'outcome',
    ]);
  });

  it('keeps the delivery confirmation ladder ordered weakest → strongest', () => {
    expect([...DELIVERY_CONFIRMATIONS]).toEqual([
      'prepared', 'submitted', 'host_accepted', 'context_present', 'runtime_loaded',
    ]);
  });

  it('only confirmed boundaries may mark a delivery delivered', () => {
    // prepared/submitted are pre-confirmation states (ADR-0027 §2.4).
    expect(DELIVERED_CONFIRMATIONS).not.toContain('prepared');
    expect(DELIVERED_CONFIRMATIONS).not.toContain('submitted');
    expect(DELIVERED_CONFIRMATIONS).toContain('host_accepted');
    expect(DELIVERED_CONFIRMATIONS).toContain('runtime_loaded');
  });

  it('exposes a closed source-kind vocabulary covering both hosts plus owner input', () => {
    const kinds = new Set(INTERVENTION_SOURCE_KINDS);
    expect(kinds.has('openclaw_plugin_event_log')).toBe(true);
    expect(kinds.has('codex_pd_hook_event_log')).toBe(true);
    expect(kinds.has('owner_console_input')).toBe(true);
  });

  it('exposes capability axes for both application proof methods', () => {
    const capabilities = new Set(INTERVENTION_CAPABILITIES);
    expect(capabilities.has('application_self_report')).toBe(true);
    expect(capabilities.has('application_runtime_verified')).toBe(true);
  });

  it('bounds every free-text surface', () => {
    expect(INTERVENTION_TEXT_BOUNDS.observationKey).toBeGreaterThan(0);
    expect(INTERVENTION_TEXT_BOUNDS.summary).toBeLessThanOrEqual(400);
    expect(INTERVENTION_TEXT_BOUNDS.claimText).toBeLessThanOrEqual(200);
  });
});

describe('deterministic identity helpers', () => {
  it('mints stable observation keys, mapping absent parts to a placeholder', () => {
    expect(mintObservationKey(['openclaw', 'delivery', undefined, 'run-1', 'act-1']))
      .toBe('openclaw|delivery|-|run-1|act-1');
    expect(mintObservationKey(['a', '', 'b'])).toBe('a|-|b');
    expect(mintObservationKey(['a', '', 'b'])).toBe(mintObservationKey(['a', undefined, 'b']));
  });

  it('derives identical evidenceIds for identical natural identity', () => {
    const a = computeEvidenceId('openclaw_plugin_event_log', 'events_2026-10-07.jsonl', 'k1');
    const b = computeEvidenceId('openclaw_plugin_event_log', 'events_2026-10-07.jsonl', 'k1');
    expect(a).toBe(b);
    expect(a.startsWith('sha256:')).toBe(true);
  });

  it('derives different evidenceIds when any identity component differs', () => {
    const base = computeEvidenceId('openclaw_plugin_event_log', 'loc', 'k1');
    expect(computeEvidenceId('openclaw_trajectory', 'loc', 'k1')).not.toBe(base);
    expect(computeEvidenceId('openclaw_plugin_event_log', 'loc2', 'k1')).not.toBe(base);
    expect(computeEvidenceId('openclaw_plugin_event_log', 'loc', 'k2')).not.toBe(base);
  });

  it('canonicalizes objects with order-independent keys', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] }))
      .toBe(canonicalJson({ a: [2, { c: 'x', d: null }], b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('computes stable record digests across key insertion order', () => {
    const recordA: Omit<NormalizedInterventionRecord, 'recordDigest'> = {
      evidenceId: 'sha256:x', evidenceScopeId: 'scope', sourceKind: 'host_runtime_dispatch',
      observationKey: 'k', sourceLocator: 'loc', kind: 'application',
      recordedAt: '2026-10-07T00:00:00Z', nativeRefs: { hostKind: 'openclaw' },
      payload: { proofMethod: 'agent_claimed', action: 'self_reported', claimText: 'ok' },
      principleId: 'T-01',
    };
    const recordB = { ...recordA, nativeRefs: { hostKind: 'openclaw' as const }, payload: recordA.payload };
    expect(computeRecordDigest(recordA)).toBe(computeRecordDigest(recordB));
    const mutated = { ...recordA, payload: { ...recordA.payload, claimText: 'changed' } };
    expect(computeRecordDigest(mutated)).not.toBe(computeRecordDigest(recordA));
  });
});
