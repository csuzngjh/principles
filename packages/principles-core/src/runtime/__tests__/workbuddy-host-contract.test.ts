/**
 * WorkBuddy host contract tests (SPEC workbuddy-host-adapter §5, OD-02/OD-05).
 *
 * WorkBuddy is the third PD host (ADR-0020). These tests freeze the shared
 * contract surface the workbuddy-adapter depends on BEFORE the adapter exists:
 * the raw evidence source kind, host attribution in native refs / capability
 * declarations, the quiet default-off feature flag, and — critically for
 * anti-forgery (ADR-0027 §2.3) — that WorkBuddy hook-event-log evidence is
 * subject to the same no-raw-source-content rule as the Codex hook log, and
 * that pre-existing openclaw/codex rows keep normalizing unchanged (old-row
 * read compatibility).
 */
import { describe, it, expect } from 'vitest';
import { normalizeInterventionEvidenceBatch } from '../intervention-evidence-normalizer.js';
import type { InterventionNormalization } from '../intervention-evidence-normalizer.js';
import {
  INTERVENTION_SOURCE_KINDS,
  DEFAULT_FEATURE_FLAGS,
  computeEffectiveFlags,
} from '../index.js';
import { QUIET_FLAG_LIFECYCLE } from '../feature-flags/feature-flag-lifecycle.js';
import { computeFeatureFlagsFromConfig, isFeatureEnabled } from '../config/pd-config-feature-flags.js';
import { computeEffectivePdConfig } from '../config/pd-config-effective.js';
import type {
  InterventionEvidenceBatchInput,
  InterventionObservationInput,
} from '../types/intervention-evidence-contract.js';

function baseObservation(): InterventionObservationInput {
  return {
    observationKey: 'workbuddy|delivery|prompt|sess-1|gen-1|act-1',
    sourceLocator: 'workbuddy-pd-hook-event-log:sess-1',
    kind: 'delivery',
    occurredAt: '2026-10-12T07:59:59Z',
    nativeRefs: { hostKind: 'workbuddy', sessionId: 'sess-1', turnId: 'gen-1' },
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

function workbuddyBatch(overrides: Partial<InterventionEvidenceBatchInput> = {}): InterventionEvidenceBatchInput {
  return {
    evidenceScopeId: 'ws-scope-1',
    sourceKind: 'workbuddy_pd_hook_event_log',
    adapterVersion: 'workbuddy-adapter@0.1.0',
    recordedAt: '2026-10-12T08:00:00Z',
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

describe('WorkBuddy host contract — intervention evidence', () => {
  it('registers workbuddy_pd_hook_event_log in the closed source-kind set', () => {
    expect(INTERVENTION_SOURCE_KINDS).toContain('workbuddy_pd_hook_event_log');
  });

  it('normalizes a valid WorkBuddy delivery batch with workbuddy native refs', () => {
    const record = firstRecord(normalizeInterventionEvidenceBatch(workbuddyBatch()));
    expect(record.sourceKind).toBe('workbuddy_pd_hook_event_log');
    expect(record.nativeRefs.hostKind).toBe('workbuddy');
    expect(record.nativeRefs.turnId).toBe('gen-1');
  });

  it('normalizes a WorkBuddy capability declaration', () => {
    const result = normalizeInterventionEvidenceBatch(workbuddyBatch({
      capabilityDeclarations: [
        { hostKind: 'workbuddy', capability: 'agent_context_delivery', status: 'supported', adapterVersion: 'workbuddy-adapter@0.1.0', channel: 'pd-hook', maxConfirmation: 'submitted', note: 'P04 probe: UserPromptSubmit additionalContext verified in model-visible context' },
        { hostKind: 'workbuddy', capability: 'enforcement_delivery', status: 'supported', adapterVersion: 'workbuddy-adapter@0.1.0', channel: 'code_tool_hook', maxConfirmation: 'runtime_loaded', note: 'P02 probe: PreToolUse deny verified to block tool execution' },
        { hostKind: 'workbuddy', capability: 'application_self_report', status: 'unsupported', adapterVersion: 'workbuddy-adapter@0.1.0', channel: 'pd-hook' },
      ],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected capability batch to normalize');
    expect(result.batch.capabilityDeclarations?.length).toBe(3);
  });

  it('applies the hook-evidence no-raw-source-content rule to the WorkBuddy hook log (ADR-0027 anti-forgery parity)', () => {
    const result = normalizeInterventionEvidenceBatch(workbuddyBatch({
      observations: [{
        ...baseObservation(),
        kind: 'application',
        payload: {
          proofMethod: 'agent_claimed',
          action: 'self_reported',
          claimText: 'private task text',
        },
      }] as unknown as InterventionObservationInput[],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toContain('forbids_source_content:claimText');
  });

  it('keeps normalizing pre-existing openclaw and codex rows unchanged (old-row compatibility)', () => {
    const openclaw = normalizeInterventionEvidenceBatch({
      evidenceScopeId: 'ws-scope-1',
      sourceKind: 'openclaw_plugin_event_log',
      adapterVersion: 'openclaw-plugin@2.2.2',
      recordedAt: '2026-10-12T08:00:00Z',
      observations: [{
        ...baseObservation(),
        observationKey: 'openclaw|delivery|prompt|sess-1|run-1|act-1',
        nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-1', runId: 'run-1' },
      }],
    });
    expect(openclaw.ok).toBe(true);

    const codex = normalizeInterventionEvidenceBatch({
      evidenceScopeId: 'ws-scope-1',
      sourceKind: 'codex_pd_hook_event_log',
      adapterVersion: 'codex-adapter@0.1.0',
      recordedAt: '2026-10-12T08:00:00Z',
      observations: [{
        ...baseObservation(),
        observationKey: 'codex|delivery|prompt|sess-1|turn-1|act-1',
        nativeRefs: { hostKind: 'codex', sessionId: 'sess-1', turnId: 'turn-1' },
      }],
    });
    expect(codex.ok).toBe(true);
  });

  it('still rejects the codex hook log content rule with the codex-prefixed reason', () => {
    const result = normalizeInterventionEvidenceBatch({
      evidenceScopeId: 'ws-scope-1',
      sourceKind: 'codex_pd_hook_event_log',
      adapterVersion: 'codex-adapter@0.1.0',
      recordedAt: '2026-10-12T08:00:00Z',
      observations: [{
        ...baseObservation(),
        kind: 'application',
        payload: {
          proofMethod: 'agent_claimed',
          action: 'self_reported',
          claimText: 'private task text',
        },
      }] as unknown as InterventionObservationInput[],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('codex_hook_evidence_forbids_source_content:claimText');
  });
});

describe('WorkBuddy host contract — feature flag (OD-03)', () => {
  it('registers host.workbuddy as quiet, default off in the flag SSoT', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find((entry) => entry.id === 'host.workbuddy');
    expect(flag).toBeDefined();
    expect(flag).toMatchObject({ category: 'quiet', enabled: false });
    expect(flag?.description).toContain('Default OFF');
  });

  it('has a complete KEEP_QUIET lifecycle census entry', () => {
    const entry = QUIET_FLAG_LIFECYCLE['host.workbuddy'];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error('census entry missing');
    expect(entry.decision).toBe('KEEP_QUIET');
    expect(entry.consumers.length).toBeGreaterThan(0);
    expect(entry.graduationCriteria.length).toBeGreaterThan(0);
    expect(entry.retirementCriteria.length).toBeGreaterThan(0);
  });

  it('stays off under pure defaults (sparse config never implicitly enables it)', () => {
    const effective = computeEffectivePdConfig(null);
    const flags = computeFeatureFlagsFromConfig(effective);
    expect(isFeatureEnabled(flags, 'host.workbuddy')).toBe(false);
  });

  it('turns on only via an explicit user override, independently of host.codex', () => {
    const configPath = '/workspace/.pd/config.yaml';
    const base = computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath);
    expect(base.flags['host.workbuddy']?.enabled).toBe(false);
    const enabled = computeEffectiveFlags({ 'host.workbuddy': { enabled: true } }, DEFAULT_FEATURE_FLAGS, configPath);
    expect(enabled.flags['host.workbuddy']?.enabled).toBe(true);
    expect(enabled.flags['host.codex']?.enabled).toBe(true);
  });
});
