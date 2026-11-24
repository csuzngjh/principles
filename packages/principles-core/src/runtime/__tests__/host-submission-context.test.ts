/**
 * PRI-1274 (B1) — HostSubmissionContext unit contract.
 *
 * Pure-normalizer coverage: per-host field mapping, optional-turn semantics,
 * sentinel rejection, malformed-metadata fail-closed, and the model-claim
 * conflict rule. Corresponds to SPEC-PD-FEEDBACK-RESILIENCE-001 TD §1.3
 * "主路径" and the T3 negative matrix.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveHostSubmissionContext,
  hostSessionClaimConflictsWithContext,
  PD_HOST_CONTEXT_META_KEY,
  HOST_SUBMISSION_CONTEXT_SOURCE,
} from '../host-submission-context.js';

describe('resolveHostSubmissionContext — Codex native fields', () => {
  it('binds from threadId with optional turn metadata (T1 shape)', () => {
    const resolved = resolveHostSubmissionContext('codex', {
      threadId: 'rollout-1',
      'x-codex-turn-metadata': { turn_id: 'turn-9' },
    });
    expect(resolved.status).toBe('present');
    if (resolved.status !== 'present') return;
    expect(resolved.context.sessionId).toBe('rollout-1');
    expect(resolved.context.submissionTurnId).toBe('turn-9');
    expect(resolved.context.source).toBe(HOST_SUBMISSION_CONTEXT_SOURCE);
  });

  it('turn id is optional — its absence never negates the session (the B1 fix)', () => {
    const resolved = resolveHostSubmissionContext('codex', { threadId: 'rollout-1' });
    expect(resolved.status).toBe('present');
    if (resolved.status !== 'present') return;
    expect(resolved.context.sessionId).toBe('rollout-1');
    expect(resolved.context.submissionTurnId).toBeUndefined();
  });

  it('falls back to sessionId when threadId is absent', () => {
    const resolved = resolveHostSubmissionContext('codex', { sessionId: 'sess-2' });
    expect(resolved.status).toBe('present');
    if (resolved.status !== 'present') return;
    expect(resolved.context.sessionId).toBe('sess-2');
  });

  it('threadId wins over sessionId when both exist', () => {
    const resolved = resolveHostSubmissionContext('codex', { threadId: 'thread-a', sessionId: 'sess-b' });
    expect(resolved.status).toBe('present');
    if (resolved.status !== 'present') return;
    expect(resolved.context.sessionId).toBe('thread-a');
  });

  it('sentinel sessions are invalid, never bound (T3)', () => {
    expect(resolveHostSubmissionContext('codex', { threadId: 'cli' }).status).toBe('invalid');
    expect(resolveHostSubmissionContext('codex', { threadId: 'unknown' }).status).toBe('invalid');
  });

  it('turn metadata present but malformed fails closed', () => {
    const resolved = resolveHostSubmissionContext('codex', {
      threadId: 'rollout-1',
      'x-codex-turn-metadata': 'not-an-object',
    });
    expect(resolved).toEqual({ status: 'invalid', reasonCode: 'codex_turn_metadata_invalid' });
    const badTurn = resolveHostSubmissionContext('codex', {
      threadId: 'rollout-1',
      'x-codex-turn-metadata': { turn_id: 42 },
    });
    expect(badTurn.status).toBe('invalid');
  });

  it('identity keys present but unusable values are invalid (not "missing")', () => {
    const resolved = resolveHostSubmissionContext('codex', { sessionId: 123 });
    expect(resolved).toEqual({ status: 'invalid', reasonCode: 'codex_session_id_invalid' });
  });

  it('P2: a sentinel threadId never silently falls back to sessionId (T4)', () => {
    const resolved = resolveHostSubmissionContext('codex', { threadId: 'cli', sessionId: 'sess-valid' });
    expect(resolved).toEqual({ status: 'invalid', reasonCode: 'codex_thread_id_invalid' });
    // Same for a present-but-empty / oversized threadId — a half-broken
    // identity is invalid, not a session-only one.
    expect(resolveHostSubmissionContext('codex', { threadId: '  ', sessionId: 'sess-valid' }).status).toBe('invalid');
    expect(resolveHostSubmissionContext('codex', { threadId: 'x'.repeat(201), sessionId: 'sess-valid' }).status).toBe('invalid');
  });

  it('a malformed sessionId without a threadId is invalid with its own code', () => {
    expect(resolveHostSubmissionContext('codex', { sessionId: 'unknown' })).toEqual({
      status: 'invalid',
      reasonCode: 'codex_session_id_invalid',
    });
  });

  it('meta with only unrelated keys (progress tokens) is missing', () => {
    expect(resolveHostSubmissionContext('codex', { progressToken: 'tok-1' }).status).toBe('missing');
    expect(resolveHostSubmissionContext('codex', undefined).status).toBe('missing');
  });

  it('windowId/itemId are never mapped to a turn', () => {
    const resolved = resolveHostSubmissionContext('codex', { threadId: 't-1', windowId: 'w', itemId: 'i' });
    expect(resolved.status).toBe('present');
    if (resolved.status !== 'present') return;
    expect(resolved.context.submissionTurnId).toBeUndefined();
    expect(resolved.context.toolCallId).toBeUndefined();
  });
});

describe('resolveHostSubmissionContext — namespaced pd.host-context.v1', () => {
  it('binds sessionId with optional turn/call ids', () => {
    const resolved = resolveHostSubmissionContext('openclaw', {
      [PD_HOST_CONTEXT_META_KEY]: { sessionId: 'oc-sess-1', submissionTurnId: 'turn-3', toolCallId: 'call-7' },
    });
    expect(resolved.status).toBe('present');
    if (resolved.status !== 'present') return;
    expect(resolved.context.sessionId).toBe('oc-sess-1');
    expect(resolved.context.submissionTurnId).toBe('turn-3');
    expect(resolved.context.toolCallId).toBe('call-7');
  });

  it('works for workbuddy too (the unified consumer contract)', () => {
    const resolved = resolveHostSubmissionContext('workbuddy', {
      [PD_HOST_CONTEXT_META_KEY]: { sessionId: 'wb-sess-1' },
    });
    expect(resolved.status).toBe('present');
    if (resolved.status !== 'present') return;
    expect(resolved.context.sessionId).toBe('wb-sess-1');
  });

  it('missing sessionId fails closed', () => {
    const resolved = resolveHostSubmissionContext('openclaw', { [PD_HOST_CONTEXT_META_KEY]: {} });
    expect(resolved).toEqual({ status: 'invalid', reasonCode: 'host_context_v1_missing_session' });
  });

  it('unknown extra fields are rejected (strict contract)', () => {
    const resolved = resolveHostSubmissionContext('openclaw', {
      [PD_HOST_CONTEXT_META_KEY]: { sessionId: 's', sessionKey: 'not-a-session-id' },
    });
    expect(resolved).toEqual({ status: 'invalid', reasonCode: 'host_context_v1_unknown_field' });
  });

  it('present-but-malformed optional ids fail closed (rc-3)', () => {
    expect(resolveHostSubmissionContext('openclaw', {
      [PD_HOST_CONTEXT_META_KEY]: { sessionId: 's', submissionTurnId: ' ' },
    })).toEqual({ status: 'invalid', reasonCode: 'host_context_v1_turn_invalid' });
    expect(resolveHostSubmissionContext('openclaw', {
      [PD_HOST_CONTEXT_META_KEY]: { sessionId: 's', toolCallId: 7 },
    })).toEqual({ status: 'invalid', reasonCode: 'host_context_v1_tool_call_invalid' });
  });

  it('sentinel sessionId is invalid', () => {
    const resolved = resolveHostSubmissionContext('openclaw', {
      [PD_HOST_CONTEXT_META_KEY]: { sessionId: 'cli' },
    });
    expect(resolved.status).toBe('invalid');
  });

  it('non-object context value is invalid', () => {
    const resolved = resolveHostSubmissionContext('openclaw', { [PD_HOST_CONTEXT_META_KEY]: 'nope' });
    expect(resolved).toEqual({ status: 'invalid', reasonCode: 'host_context_v1_invalid_shape' });
  });

  it('codex ignores the namespaced key (foreign producer is not a Codex identity source)', () => {
    expect(resolveHostSubmissionContext('codex', {
      [PD_HOST_CONTEXT_META_KEY]: { sessionId: 'forged' },
    }).status).toBe('missing');
  });
});

describe('hostSessionClaimConflictsWithContext — fail-closed conflict rule (T3)', () => {
  const context = { sessionId: 'trusted-1', source: HOST_SUBMISSION_CONTEXT_SOURCE } as const;

  it('no claim → no conflict', () => {
    expect(hostSessionClaimConflictsWithContext(undefined, context)).toBe(false);
  });

  it('claim agreeing with the trusted session → no conflict', () => {
    expect(hostSessionClaimConflictsWithContext({ threadId: 'trusted-1' }, context)).toBe(false);
    expect(hostSessionClaimConflictsWithContext({ sessionId: 'trusted-1' }, context)).toBe(false);
  });

  it('a model-forged disagreeing claim conflicts (fail closed)', () => {
    expect(hostSessionClaimConflictsWithContext({ threadId: 'forged-thread' }, context)).toBe(true);
    expect(hostSessionClaimConflictsWithContext({ sessionId: 'forged-session' }, context)).toBe(true);
  });

  it('P2: a MIXED claim with one agreeing and one foreign value still conflicts (T4)', () => {
    // One matching value must never launder a second, foreign one.
    expect(hostSessionClaimConflictsWithContext({ threadId: 'foreign-1', sessionId: 'trusted-1' }, context)).toBe(true);
    expect(hostSessionClaimConflictsWithContext({ threadId: 'trusted-1', sessionId: 'foreign-1' }, context)).toBe(true);
    // Fully-agreeing mixed claims stay clean.
    expect(hostSessionClaimConflictsWithContext({ threadId: 'trusted-1', sessionId: 'trusted-1' }, context)).toBe(false);
  });

  it('sentinel-only or empty claims do not conflict (they are simply unusable)', () => {
    expect(hostSessionClaimConflictsWithContext({ threadId: 'cli' }, context)).toBe(false);
    expect(hostSessionClaimConflictsWithContext({ sessionId: '  ' }, context)).toBe(false);
  });
});

describe('resolveHostSubmissionContext — WorkBuddy native engine baggage (PRI-1275)', () => {
  // Probe evidence (2026-11-24, installed CodeBuddy Code 2.165.0): the real
  // engine sends `_meta.baggage = "codebuddy.session_id=<uuid>,…"` alongside
  // modelId/traceparent/progressToken; the value equals the hook payload's
  // session_id. conversation_request_id is NOT mapped (unproven turn
  // equivalence, SPEC field rules).

  it('baggage session identity alone binds the session (real-engine shape)', () => {
    const meta = {
      modelId: 'wb-probe-mock',
      traceparent: '00-9e20b85b83d30b39ab39f7951ac95e0a-ff9a59749cfc6662-01',
      baggage: 'codebuddy.session_id=01a20d41-fc4f-71ec-ab89-7d83a970215a,codebuddy.conversation_request_id=01a20d41fbb377cfa975b1b725b6238e',
      progressToken: 2,
    };
    const resolution = resolveHostSubmissionContext('workbuddy', meta);
    expect(resolution.status).toBe('present');
    if (resolution.status === 'present') {
      expect(resolution.context.sessionId).toBe('01a20d41-fc4f-71ec-ab89-7d83a970215a');
      expect(resolution.context.submissionTurnId).toBeUndefined();
      expect(resolution.context.toolCallId).toBeUndefined();
      expect(resolution.context.source).toBe('mcp_request_meta');
    }
  });

  it('unrelated _meta without any recognized field stays missing (progress tokens etc.)', () => {
    expect(resolveHostSubmissionContext('workbuddy', { progressToken: 2, modelId: 'm' }).status).toBe('missing');
    // Baggage present but WITHOUT a session entry is not an identity attempt.
    expect(resolveHostSubmissionContext('workbuddy', { baggage: 'codebuddy.other=x' }).status).toBe('missing');
    expect(resolveHostSubmissionContext('workbuddy', { baggage: '' }).status).toBe('missing');
    expect(resolveHostSubmissionContext('workbuddy', undefined).status).toBe('missing');
  });

  it('present-but-malformed identity fails closed, never silently degrades', () => {
    expect(resolveHostSubmissionContext('workbuddy', { baggage: { fake: true } })).toEqual({
      status: 'invalid', reasonCode: 'workbuddy_baggage_session_invalid',
    });
    // Sentinel spellings are rejected (same rule as every host id).
    expect(resolveHostSubmissionContext('workbuddy', { baggage: 'codebuddy.session_id=cli' }).status).toBe('invalid');
    // Oversized session value.
    expect(resolveHostSubmissionContext('workbuddy', { baggage: `codebuddy.session_id=${'x'.repeat(201)}` })).toEqual({
      status: 'invalid', reasonCode: 'workbuddy_baggage_session_invalid',
    });
  });

  it('baggage entry properties after a semicolon are stripped, not treated as id bytes', () => {
    const resolution = resolveHostSubmissionContext('workbuddy', { baggage: 'codebuddy.session_id=sess-1;tracestate=acme' });
    expect(resolution.status).toBe('present');
    if (resolution.status === 'present') expect(resolution.context.sessionId).toBe('sess-1');
  });

  it('namespaced producer contract still binds when it agrees with the engine baggage', () => {
    const resolution = resolveHostSubmissionContext('workbuddy', {
      'pd.host-context.v1': { sessionId: 'sess-ns', toolCallId: 'call-1' },
      baggage: 'codebuddy.session_id=sess-ns',
    });
    expect(resolution.status).toBe('present');
    if (resolution.status === 'present') {
      expect(resolution.context.sessionId).toBe('sess-ns');
      expect(resolution.context.toolCallId).toBe('call-1');
    }
  });

  it('namespaced vs baggage disagreement fails closed (half-broken identity)', () => {
    expect(resolveHostSubmissionContext('workbuddy', {
      'pd.host-context.v1': { sessionId: 'sess-ns' },
      baggage: 'codebuddy.session_id=sess-other',
    })).toEqual({ status: 'invalid', reasonCode: 'workbuddy_context_conflict' });
  });

  it('MULTIPLE baggage session entries with disagreeing values fail closed (CR-1)', () => {
    // A later same-key entry is a competing identity, never an ignorable
    // duplicate: `session-a,codebuddy.session_id=session-b` is a conflict.
    expect(resolveHostSubmissionContext('workbuddy', {
      baggage: 'codebuddy.session_id=session-a,codebuddy.session_id=session-b',
    })).toEqual({ status: 'invalid', reasonCode: 'workbuddy_baggage_session_conflict' });
    // A later INVALID entry fails closed even when the first looked fine.
    expect(resolveHostSubmissionContext('workbuddy', {
      baggage: 'codebuddy.session_id=session-a,codebuddy.session_id=cli',
    })).toEqual({ status: 'invalid', reasonCode: 'workbuddy_baggage_session_invalid' });
    // Repeated IDENTICAL entries are one identity, not a conflict.
    expect(resolveHostSubmissionContext('workbuddy', {
      baggage: 'codebuddy.session_id=sess-1,codebuddy.session_id=sess-1',
    })).toEqual({ status: 'present', context: { sessionId: 'sess-1', source: 'mcp_request_meta' } });
    // The conflict rule also guards the namespaced comparison path.
    expect(resolveHostSubmissionContext('workbuddy', {
      'pd.host-context.v1': { sessionId: 'sess-ns' },
      baggage: 'codebuddy.session_id=sess-ns,codebuddy.session_id=sess-other',
    })).toEqual({ status: 'invalid', reasonCode: 'workbuddy_baggage_session_conflict' });
  });

  it('baggage identity is a WorkBuddy field — Codex and OpenClaw never consume it', () => {
    expect(resolveHostSubmissionContext('codex', { baggage: 'codebuddy.session_id=sess-1' }).status).toBe('missing');
    expect(resolveHostSubmissionContext('openclaw', { baggage: 'codebuddy.session_id=sess-1' }).status).toBe('missing');
  });
});
