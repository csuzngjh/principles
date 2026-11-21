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
    expect(resolved).toEqual({ status: 'invalid', reasonCode: 'codex_host_metadata_missing_session' });
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

  it('sentinel-only or empty claims do not conflict (they are simply unusable)', () => {
    expect(hostSessionClaimConflictsWithContext({ threadId: 'cli' }, context)).toBe(false);
    expect(hostSessionClaimConflictsWithContext({ sessionId: '  ' }, context)).toBe(false);
  });
});
