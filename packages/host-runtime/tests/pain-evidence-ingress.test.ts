/**
 * PRI-642 Scope B — Pain Evidence Ingress valid-combination matrix contract.
 *
 * One test per row of SPEC §8.2, plus the rc-6 mixed-lineage and the
 * Codex-incomplete-lineage rows. These are contract tests for the shared
 * ingress in @principles/host-runtime: they define the normative decision
 * for every origin × correlation × evidence combination BEFORE any LLM,
 * task, or candidate mutation.
 *
 * Naming follows SPEC §8.1; the semantic shape is normative.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluatePainIngress,
  parsePainIngressReport,
} from '../src/pain-evidence-ingress.js';
import type { PainIngressReport } from '../src/pain-evidence-ingress.js';

const OPENCLAW_SESSION = 'sess-openclaw-1';
const EVIDENCE_ENTRIES = [
  { kind: 'behavior_trace' as const, sourceRef: 'owner_message:2026-09-01T10:00:00Z', note: 'Please fix the subtitle size' },
  { kind: 'behavior_trace' as const, sourceRef: 'tool_call_failure:2026-09-01T10:01:00Z', note: 'Tool write_file failed' },
];

function baseReport(overrides: Partial<PainIngressReport> = {}): PainIngressReport {
  return {
    identity: { kind: 'manual_pain_id', painId: 'manual_123_abc' },
    painType: 'user_frustration',
    source: 'manual',
    reason: 'agent keeps over-engineering',
    score: 80,
    origin: { kind: 'owner_manual', channel: 'openclaw_command' },
    correlation: { status: 'bound', hostKind: 'openclaw', sessionId: OPENCLAW_SESSION },
    evidence: { status: 'available', entries: EVIDENCE_ENTRIES },
    ...overrides,
  };
}

describe('Pain Evidence Ingress — SPEC §8.2 valid-combination matrix', () => {
  it('row 1: owner manual / OpenClaw command + matching bound + available → submit (host-context-bound with evidence)', () => {
    const decision = evaluatePainIngress(baseReport());
    expect(decision.action).toBe('submit');
    if (decision.action !== 'submit') return;
    expect(decision.legacy.provenance).toBe('host_context_bound');
    expect(decision.legacy.hostKind).toBe('openclaw');
    expect(decision.legacy.sessionId).toBe(OPENCLAW_SESSION);
    expect(decision.legacy.evidence).toEqual(EVIDENCE_ENTRIES);
    expect(decision.painIngress.version).toBe('v1');
  });

  it('row 2: owner manual / OpenClaw command + bound + unavailable → explicit degrade with legacy, no false context-bound success', () => {
    const decision = evaluatePainIngress(baseReport({
      evidence: { status: 'unavailable', reason: 'empty_trajectory' },
    }));
    expect(decision.action).toBe('degrade');
    if (decision.action !== 'degrade') return;
    expect(decision.reasonCode).toBe('empty_trajectory');
    expect(decision.warning).toBeTruthy();
    expect(decision.nextAction).toBeTruthy();
    // The bound submit is still allowed, but with honest EMPTY evidence.
    expect(decision.legacy).toBeDefined();
    expect(decision.legacy!.evidence).toEqual([]);
    expect(decision.legacy!.sessionId).toBe(OPENCLAW_SESSION);
  });

  it('row 3: owner manual / CLI explicit session + matching bound + available → submit', () => {
    const decision = evaluatePainIngress(baseReport({
      origin: { kind: 'owner_manual', channel: 'cli_explicit_session' },
    }));
    expect(decision.action).toBe('submit');
    if (decision.action !== 'submit') return;
    expect(decision.legacy.provenance).toBe('host_context_bound');
    expect(decision.legacy.hostKind).toBe('openclaw');
    expect(decision.legacy.evidence).toEqual(EVIDENCE_ENTRIES);
  });

  it('row 4: owner manual / CLI explicit session + matching bound + unavailable → degrade carries the evidence reason; never a silent downgrade', () => {
    const decision = evaluatePainIngress(baseReport({
      origin: { kind: 'owner_manual', channel: 'cli_explicit_session' },
      evidence: { status: 'unavailable', reason: 'evidence_read_failed' },
    }));
    expect(decision.action).toBe('degrade');
    if (decision.action !== 'degrade') return;
    expect(decision.reasonCode).toBe('evidence_read_failed');
  });

  it('row 5: owner manual / CLI explicit session + unbound → refuse (invalid combination)', () => {
    const decision = evaluatePainIngress(baseReport({
      origin: { kind: 'owner_manual', channel: 'cli_explicit_session' },
      correlation: { status: 'unbound', reason: 'missing_host_session' },
    }));
    expect(decision.action).toBe('refuse');
    if (decision.action !== 'refuse') return;
    expect(decision.reasonCode).toBe('origin_correlation_mismatch');
  });

  it('row 6: owner manual / external CLI unbound + unbound + unavailable → manual exception submit with disclosure, no fabricated evidence', () => {
    const decision = evaluatePainIngress(baseReport({
      origin: { kind: 'owner_manual', channel: 'external_cli_unbound' },
      correlation: { status: 'unbound', reason: 'external_cli' },
      evidence: { status: 'unavailable', reason: 'trajectory_unavailable' },
    }));
    expect(decision.action).toBe('submit');
    if (decision.action !== 'submit') return;
    expect(decision.legacy.provenance).toBe('owner_reported_no_host_trace');
    // The Owner reason is report context, never trajectory evidence.
    expect(decision.legacy.evidence).toEqual([]);
    expect(decision.legacy.sessionId).toBeUndefined();
    expect(decision.warnings.join(' ')).toMatch(/context_unbound|--session/);
  });

  it('row 7: owner manual / external CLI unbound + any host-bound correlation → refuse (invalid origin/correlation combination)', () => {
    const decision = evaluatePainIngress(baseReport({
      origin: { kind: 'owner_manual', channel: 'external_cli_unbound' },
      correlation: { status: 'bound', hostKind: 'openclaw', sessionId: OPENCLAW_SESSION },
    }));
    expect(decision.action).toBe('refuse');
    if (decision.action !== 'refuse') return;
    expect(decision.reasonCode).toBe('origin_correlation_mismatch');
  });

  it('row 8: automatic OpenClaw hook + matching bound + available → submit as automatic_hook with correlation retained', () => {
    const decision = evaluatePainIngress(baseReport({
      identity: { kind: 'host_observation', observationId: 'obs-tool-1' },
      painType: 'tool_failure',
      source: 'after_tool_call',
      origin: { kind: 'automatic_hook', source: 'after_tool_call' },
    }));
    expect(decision.action).toBe('submit');
    if (decision.action !== 'submit') return;
    expect(decision.legacy.provenance).toBe('automatic_hook');
    expect(decision.legacy.hostKind).toBe('openclaw');
    expect(decision.painIngress.correlation).toMatchObject({ status: 'bound', hostKind: 'openclaw' });
  });

  it('row 9: automatic OpenClaw hook + matching bound + unavailable → observation-only, no LLM', () => {
    const decision = evaluatePainIngress(baseReport({
      identity: { kind: 'host_observation', observationId: 'obs-tool-2' },
      painType: 'tool_failure',
      source: 'after_tool_call',
      origin: { kind: 'automatic_hook', source: 'after_tool_call' },
      evidence: { status: 'unavailable', reason: 'empty_trajectory' },
    }));
    expect(decision.action).toBe('observation_only');
    if (decision.action !== 'observation_only') return;
    expect(decision.reasonCode).toBe('empty_trajectory');
    expect(decision.note).toBeTruthy();
  });

  it('row 10: automatic OpenClaw hook + unbound → observation-only, no LLM', () => {
    const decision = evaluatePainIngress(baseReport({
      identity: { kind: 'host_observation', observationId: 'obs-tool-3' },
      painType: 'tool_failure',
      source: 'after_tool_call',
      origin: { kind: 'automatic_hook', source: 'after_tool_call' },
      correlation: { status: 'unbound', reason: 'missing_host_session' },
    }));
    expect(decision.action).toBe('observation_only');
    if (decision.action !== 'observation_only') return;
    expect(decision.reasonCode).toBe('missing_host_session');
  });

  it('row 11: automatic Codex hook + complete Codex bound + available → submit preserving full Codex lineage', () => {
    const decision = evaluatePainIngress(baseReport({
      identity: { kind: 'host_observation', observationId: 'codex-obs-1' },
      painType: 'user_frustration',
      source: 'codex:post_tool_use',
      origin: { kind: 'automatic_hook', source: 'codex:post_tool_use' },
      correlation: {
        status: 'bound',
        hostKind: 'codex',
        rootSessionId: 'root-sess-1',
        rolloutIdentity: 'rollout-1',
        logicalObservationKey: 'codex|rollout-1|turn-7|user',
        hostTurnId: 'turn-7',
      },
    }));
    expect(decision.action).toBe('submit');
    if (decision.action !== 'submit') return;
    expect(decision.legacy.hostKind).toBe('codex');
    // Codex lineage SHALL NOT be flattened to a session id (SPEC §8.1).
    expect(decision.painIngress.correlation).toMatchObject({
      status: 'bound',
      hostKind: 'codex',
      rootSessionId: 'root-sess-1',
      rolloutIdentity: 'rollout-1',
      logicalObservationKey: 'codex|rollout-1|turn-7|user',
      hostTurnId: 'turn-7',
    });
    // SPEC §8.3: automatic hooks derive `automatic_hook` (the existing Codex
    // peer path still writes host_context_bound until the B4 parity gate
    // decides whether it migrates — both are non-owner-explicit for the
    // admission gate, so semantics are preserved).
    expect(decision.legacy.provenance).toBe('automatic_hook');
  });

  it('row 12: automatic Codex hook + incomplete lineage → refuse/degrade before persistence or LLM', () => {
    // Incompleteness arrives through untrusted input — the parse-level guard
    // rejects it before the typed evaluation (rc-1/rc-3).
    const parsed = parsePainIngressReport({
      identity: { kind: 'host_observation', observationId: 'codex-obs-2' },
      painType: 'user_frustration',
      source: 'codex:post_tool_use',
      reason: 'correction',
      origin: { kind: 'automatic_hook', source: 'codex:post_tool_use' },
      correlation: {
        status: 'bound',
        hostKind: 'codex',
        rootSessionId: 'root-sess-1',
        rolloutIdentity: 'rollout-1',
        logicalObservationKey: 'codex|rollout-1|turn-8|user',
        // hostTurnId missing → incomplete Codex lineage
      },
      evidence: { status: 'available', entries: EVIDENCE_ENTRIES },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasonCode).toBe('codex_lineage_incomplete');
  });

  it('mixed-event lineage (rc-6): identifiers from different events → refuse lineage_mismatch', () => {
    const decision = evaluatePainIngress(baseReport({
      identity: { kind: 'host_observation', observationId: 'codex-obs-3' },
      painType: 'user_frustration',
      source: 'codex:post_tool_use',
      origin: { kind: 'automatic_hook', source: 'codex:post_tool_use' },
      correlation: {
        status: 'bound',
        hostKind: 'codex',
        rootSessionId: 'root-sess-1',
        // rollout A in the correlation …
        rolloutIdentity: 'rollout-A',
        // … but the logical key embeds rollout B — identifiers disagree.
        logicalObservationKey: 'codex|rollout-B|turn-9|user',
        hostTurnId: 'turn-9',
      },
    }));
    expect(decision.action).toBe('refuse');
    if (decision.action !== 'refuse') return;
    expect(decision.reasonCode).toBe('lineage_mismatch');
  });
});

describe('parsePainIngressReport — runtime validation of untrusted input', () => {
  it('accepts a well-formed report and round-trips it', () => {
    const parsed = parsePainIngressReport(baseReport());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.correlation).toMatchObject({ status: 'bound', sessionId: OPENCLAW_SESSION });
  });

  it('rejects malformed JSON input with a structured reason', () => {
    const parsed = parsePainIngressReport('not-an-object');
    expect(parsed.ok).toBe(false);
  });

  it('rejects an unknown origin kind (rc-1/rc-3: fail loud, no silent skip)', () => {
    const parsed = parsePainIngressReport({
      ...baseReport(),
      origin: { kind: 'mystery_origin' },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasonCode).toBe('origin_invalid');
  });

  it('rejects evidence entries with unknown kind (rc-4: element-level validation)', () => {
    const parsed = parsePainIngressReport({
      ...baseReport(),
      evidence: {
        status: 'available',
        entries: [{ kind: 'dream', sourceRef: 'x', note: 'y' }],
      },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasonCode).toBe('evidence_invalid');
  });

  it('rejects a present-but-invalid score instead of silently dropping it (rc-3/rc-9)', () => {
    const parsed = parsePainIngressReport({ ...baseReport(), score: 250 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasonCode).toBe('score_invalid');
  });

  it('rejects an openclaw bound correlation with a sentinel session (rc: no sentinel as real session)', () => {
    const parsed = parsePainIngressReport({
      ...baseReport(),
      correlation: { status: 'bound', hostKind: 'openclaw', sessionId: 'cli' },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasonCode).toBe('session_sentinel_invalid');
  });
});
