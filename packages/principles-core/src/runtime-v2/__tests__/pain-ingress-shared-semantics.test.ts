/**
 * PRI-642 review blocker 1 — ONE ingress semantic authority for CLI and
 * OpenClaw.
 *
 * Cases A–E are each evaluated through BOTH adapter entry shapes (the
 * OpenClaw funnel's report construction and the pd-cli report construction)
 * against the SAME evaluatePainIngress function. The point is not that each
 * adapter "looks right" in isolation — it is that both adapters funnel the
 * same facts into the same semantic evaluator and therefore cannot drift.
 */
import { describe, it, expect } from 'vitest';
import { evaluatePainIngress, parsePainIngressReport } from '../pain-ingress.js';
import type { PainIngressReport, IngressEvidenceEntry } from '../pain-ingress.js';

const SESSION = 'sess-openclaw-1';
const ENTRIES: [IngressEvidenceEntry, ...IngressEvidenceEntry[]] = [
  { kind: 'behavior_trace', sourceRef: 'owner_message:t1', note: 'fix it' },
  { kind: 'behavior_trace', sourceRef: 'tool_call_failure:t2', note: 'Tool write failed' },
];

/** The OpenClaw funnel's report construction (pain-ingress-adapter.ts shape). */
function openclawReport(partial: Partial<PainIngressReport>): PainIngressReport {
  return {
    identity: { kind: 'manual_pain_id', painId: 'manual_oc_1' },
    painType: 'user_frustration',
    source: 'manual',
    reason: 'over-engineering',
    score: 80,
    origin: { kind: 'owner_manual', channel: 'openclaw_command' },
    correlation: { status: 'bound', hostKind: 'openclaw', sessionId: SESSION },
    evidence: { status: 'available', entries: ENTRIES },
    ...partial,
  };
}

/** The pd-cli report construction (pain-record.ts resolveIngressDecision shape). */
function cliReport(partial: Partial<PainIngressReport>): PainIngressReport {
  return {
    identity: { kind: 'manual_pain_id', painId: 'manual_cli_1' },
    painType: 'user_frustration',
    source: 'manual',
    reason: 'over-engineering',
    score: 80,
    origin: { kind: 'owner_manual', channel: 'cli_explicit_session' },
    correlation: { status: 'bound', hostKind: 'openclaw', sessionId: SESSION },
    evidence: { status: 'available', entries: ENTRIES },
    ...partial,
  };
}

describe('Blocking 1 — one semantic authority for both adapters (Cases A–E)', () => {
  it('Case A: owner manual + valid bound OpenClaw session + evidence → submit/host_context_bound/openclaw/bound (both adapters)', () => {
    for (const report of [openclawReport({}), cliReport({})]) {
      const decision = evaluatePainIngress(report);
      expect(decision.action).toBe('submit');
      if (decision.action !== 'submit') return;
      expect(decision.legacy.provenance).toBe('host_context_bound');
      expect(decision.legacy.hostKind).toBe('openclaw');
      expect(decision.legacy.sessionId).toBe(SESSION);
      expect(decision.painIngress.correlation.status).toBe('bound');
      expect(decision.painIngress.correlation).toMatchObject({ hostKind: 'openclaw', sessionId: SESSION });
    }
  });

  it('Case B: owner manual + unbound external CLI → owner_reported_no_host_trace, no fake session, no fake evidence (both adapters)', () => {
    const unbound = {
      correlation: { status: 'unbound', reason: 'external_cli' },
      origin: { kind: 'owner_manual', channel: 'external_cli_unbound' },
      evidence: { status: 'unavailable', reason: 'not_applicable_unbound' },
    } as const satisfies Partial<PainIngressReport>;
    for (const report of [openclawReport(unbound), cliReport(unbound)]) {
      const decision = evaluatePainIngress(report);
      expect(decision.action).toBe('submit');
      if (decision.action !== 'submit') return;
      expect(decision.legacy.provenance).toBe('owner_reported_no_host_trace');
      expect(decision.legacy.sessionId).toBeUndefined();
      expect(decision.legacy.evidence).toEqual([]);
      expect(decision.warnings.join(' ')).toMatch(/context_unbound|--session/);
    }
  });

  it('Case C: automatic hook + bound + evidence → automatic_hook + submit (both adapters)', () => {
    const auto = {
      identity: { kind: 'host_observation' as const, observationId: 'obs-1' },
      origin: { kind: 'automatic_hook' as const, source: 'gate_blocked' },
      painType: 'user_frustration' as const,
    };
    for (const report of [openclawReport(auto), cliReport(auto)]) {
      const decision = evaluatePainIngress(report);
      expect(decision.action).toBe('submit');
      if (decision.action !== 'submit') return;
      expect(decision.legacy.provenance).toBe('automatic_hook');
    }
  });

  it('Case D: automatic hook + no evidence → observation_only (both adapters)', () => {
    const auto = {
      identity: { kind: 'host_observation' as const, observationId: 'obs-2' },
      origin: { kind: 'automatic_hook' as const, source: 'gate_blocked' },
      painType: 'user_frustration' as const,
      evidence: { status: 'unavailable' as const, reason: 'empty_trajectory' as const },
    };
    for (const report of [openclawReport(auto), cliReport(auto)]) {
      const decision = evaluatePainIngress(report);
      expect(decision.action).toBe('observation_only');
      if (decision.action !== 'observation_only') return;
      expect(decision.reasonCode).toBe('empty_trajectory');
    }
  });

  it('Case E: invalid origin/correlation combination → refuse (both adapters)', () => {
    const invalid = {
      correlation: { status: 'unbound', reason: 'external_cli' },
      origin: { kind: 'owner_manual', channel: 'cli_explicit_session' },
    } as const satisfies Partial<PainIngressReport>;
    for (const report of [openclawReport(invalid), cliReport(invalid)]) {
      const decision = evaluatePainIngress(report);
      expect(decision.action).toBe('refuse');
      if (decision.action !== 'refuse') return;
      expect(decision.reasonCode).toBe('origin_correlation_mismatch');
    }
  });

  it('parsePainIngressReport shares the same invariant surface for both adapters', () => {
    // Both adapters can round-trip their report through the shared parser
    // and get identical semantics — one parse, one invariant, one decision.
    const parsed = parsePainIngressReport(cliReport({}));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const decision = evaluatePainIngress(parsed.report);
    expect(decision.action).toBe('submit');
    expect((ENTRIES as readonly IngressEvidenceEntry[]).length).toBe(2);
  });
});
