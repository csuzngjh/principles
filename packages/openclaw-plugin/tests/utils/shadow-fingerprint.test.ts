/**
 * Tests for Shadow Observation Fingerprint Utilities.
 *
 * Coverage gaps targeted:
 *  - isLocalProfile() membership + negative cases
 *  - computeRuntimeShadowTaskFingerprint() determinism / length / stability
 *  - PD_LOCAL_PROFILES public set contract (read-only surface)
 */

import { describe, it, expect } from 'vitest';
import {
  isLocalProfile,
  computeRuntimeShadowTaskFingerprint,
  PD_LOCAL_PROFILES,
} from '../../src/utils/shadow-fingerprint.js';
import type { PluginHookSubagentSpawningEvent } from '../../src/openclaw-sdk.js';

function buildEvent(overrides: Partial<PluginHookSubagentSpawningEvent> = {}): PluginHookSubagentSpawningEvent {
  return {
    type: 'subagent_spawning',
    id: 'evt-1',
    createdAt: 0,
    session: { id: 's', capabilities: [] },
    childSessionKey: 'child-session-001',
    agentId: 'my-agent',
    label: 'review-diff',
    mode: 'auto',
    threadRequested: false,
    requester: { channel: 'main', threadId: 't-0' },
    ...overrides,
  } as PluginHookSubagentSpawningEvent;
}

describe('isLocalProfile', () => {
  it('returns true for both canonical PD local profiles', () => {
    expect(isLocalProfile('local-reader')).toBe(true);
    expect(isLocalProfile('local-editor')).toBe(true);
  });

  it('returns false for arbitrary user profiles', () => {
    expect(isLocalProfile('')).toBe(false);
    expect(isLocalProfile('user-agent')).toBe(false);
    expect(isLocalProfile('LOCAL-READER')).toBe(false);
    expect(isLocalProfile('local-reader-2')).toBe(false);
  });
});

describe('PD_LOCAL_PROFILES public surface', () => {
  it('exposes exactly the two canonical PD local profiles', () => {
    expect(PD_LOCAL_PROFILES.has('local-reader')).toBe(true);
    expect(PD_LOCAL_PROFILES.has('local-editor')).toBe(true);
    expect(PD_LOCAL_PROFILES.size).toBe(2);
  });
});

describe('computeRuntimeShadowTaskFingerprint', () => {
  it('returns a 16-char hexadecimal string', () => {
    const fp = computeRuntimeShadowTaskFingerprint(buildEvent());
    expect(typeof fp).toBe('string');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic — same input produces same fingerprint', () => {
    const e = buildEvent();
    expect(computeRuntimeShadowTaskFingerprint(e)).toBe(computeRuntimeShadowTaskFingerprint(e));
  });

  it('distinguishes different childSessionKey / agentId / label / mode', () => {
    const base = computeRuntimeShadowTaskFingerprint(buildEvent());
    const differentChild = computeRuntimeShadowTaskFingerprint(buildEvent({ childSessionKey: 'child-session-999' }));
    const differentAgent = computeRuntimeShadowTaskFingerprint(buildEvent({ agentId: 'other-agent' }));
    const differentLabel = computeRuntimeShadowTaskFingerprint(buildEvent({ label: 'different' }));
    const differentMode = computeRuntimeShadowTaskFingerprint(buildEvent({ mode: 'interactive' }));

    expect(differentChild).not.toBe(base);
    expect(differentAgent).not.toBe(base);
    expect(differentLabel).not.toBe(base);
    expect(differentMode).not.toBe(base);
  });

  it('treats missing label as empty string (deterministic)', () => {
    const withUndefined = buildEvent();
    (withUndefined as unknown as { label?: string }).label = undefined;
    const withEmpty = buildEvent({ label: '' });
    expect(computeRuntimeShadowTaskFingerprint(withUndefined)).toBe(computeRuntimeShadowTaskFingerprint(withEmpty));
  });

  it('uses requester.channel and requester.threadId for fingerprinting', () => {
    const a = computeRuntimeShadowTaskFingerprint(buildEvent({ requester: { channel: 'A', threadId: '1' } as never }));
    const b = computeRuntimeShadowTaskFingerprint(buildEvent({ requester: { channel: 'B', threadId: '1' } as never }));
    const c = computeRuntimeShadowTaskFingerprint(buildEvent({ requester: { channel: 'A', threadId: '2' } as never }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('gracefully handles requester with no channel/threadId', () => {
    const fp = computeRuntimeShadowTaskFingerprint(buildEvent({ requester: {} as never }));
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces stable fingerprints across independent invocations', () => {
    const e = buildEvent({
      childSessionKey: 'sub-42',
      agentId: 'reviewer',
      label: 'diff-review',
      mode: 'auto',
      threadRequested: true,
      requester: { channel: 'pr', threadId: 'thread-123' } as never,
    });
    const fs = new Set<string>();
    for (let i = 0; i < 5; i++) {
      fs.add(computeRuntimeShadowTaskFingerprint(e));
    }
    expect(fs.size).toBe(1);
  });
});
