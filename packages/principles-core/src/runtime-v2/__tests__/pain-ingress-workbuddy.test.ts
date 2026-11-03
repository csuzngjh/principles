/**
 * SPEC v0.3 §5 contract gap: PainIngress had no WorkBuddy correlation variant.
 * These tests pin the additive type and its semantics.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluatePainIngress,
  parsePainIngressReport,
} from '../pain-ingress.js';
import { parsePainIngressV1Payload } from '../pain-ingress-payload.js';
import type { IngressEvidenceEntry, PainIngressReport } from '../pain-ingress.js';

const SESSION = 'wb-session-1';
const ENTRIES: [IngressEvidenceEntry, ...IngressEvidenceEntry[]] = [
  { kind: 'behavior_trace', sourceRef: 'pain_event:wb-1', note: '这是错的' },
];

function workbuddyReport(overrides: Partial<PainIngressReport> = {}): PainIngressReport {
  return {
    identity: { kind: 'host_observation', observationId: 'wb-observation-1' },
    painType: 'user_frustration',
    source: 'user_correction',
    reason: 'User correction detected',
    score: 70,
    origin: { kind: 'automatic_hook', source: 'workbuddy:user_prompt_submit' },
    correlation: { status: 'bound', hostKind: 'workbuddy', sessionId: SESSION, logicalObservationKey: '["workbuddy","wb-session-1","gen-1"]|user' },
    evidence: { status: 'available', entries: ENTRIES },
    ...overrides,
  };
}

describe('PainIngress WorkBuddy correlation (SPEC v0.3 §5)', () => {
  it('bound WorkBuddy automatic correction submits with its own host identity', () => {
    const decision = evaluatePainIngress(workbuddyReport());
    expect(decision.action).toBe('submit');
    if (decision.action !== 'submit') return;
    expect(decision.legacy.hostKind).toBe('workbuddy');
    expect(decision.legacy.sessionId).toBe(SESSION);
    expect(decision.legacy.provenance).toBe('automatic_hook');
    expect(decision.painIngress.correlation).toMatchObject({ status: 'bound', hostKind: 'workbuddy', sessionId: SESSION });
  });

  it('parsing a WorkBuddy report preserves the correlation variant', () => {
    const parsed = parsePainIngressReport(workbuddyReport());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.correlation).toMatchObject({ status: 'bound', hostKind: 'workbuddy', sessionId: SESSION });
  });

  it('sentinel WorkBuddy sessions are rejected like every other host', () => {
    const parsed = parsePainIngressReport(workbuddyReport({
      correlation: { status: 'bound', hostKind: 'workbuddy', sessionId: 'unknown' },
    }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasonCode).toBe('session_sentinel_invalid');
  });

  it('unbound automatic WorkBuddy signals stay observation-only', () => {
    const decision = evaluatePainIngress(workbuddyReport({
      correlation: { status: 'unbound', reason: 'missing_host_session' },
    }));
    expect(decision.action).toBe('observation_only');
  });

  it('the persisted v1 payload validates the WorkBuddy correlation', () => {
    const parsed = parsePainIngressV1Payload({
      version: 'v1',
      origin: { kind: 'automatic_hook', source: 'workbuddy:user_prompt_submit' },
      correlation: { status: 'bound', hostKind: 'workbuddy', sessionId: SESSION },
      evidenceClass: { status: 'available', entryCount: 1 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload.correlation).toMatchObject({ status: 'bound', hostKind: 'workbuddy', sessionId: SESSION });
  });
});
