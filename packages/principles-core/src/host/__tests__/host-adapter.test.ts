/**
 * Host adapter type guard tests (ADR-0020 §2.2)
 *
 * Verifies the pure type guards correctly discriminate valid/invalid inputs.
 * These tests live in principles-core because the type guards are pure logic
 * (no I/O). The actual CodexHooksHostAdapter implementation has its own
 * tests in packages/codex-adapter/.
 */
import { describe, it, expect } from 'vitest';
import {
  HOST_EVENT_KINDS,
  isHostEventKind,
  isHostDecision,
  isHostEventContext,
  isHostEvent,
  isHostEventResult,
} from '../index.js';
import type { HostEvent, HostEventContext, HostEventResult } from '../index.js';

describe('HostAdapter type guards (ADR-0020)', () => {
  describe('isHostEventKind', () => {
    it('accepts all canonical kinds', () => {
      for (const kind of HOST_EVENT_KINDS) {
        expect(isHostEventKind(kind)).toBe(true);
      }
    });

    it.each([[''], ['unknown'], ['BeforeToolCall'], ['pre_tool_use'], [42], [null], [undefined]])(
      'rejects non-canonical value %p',
      (value) => {
        expect(isHostEventKind(value)).toBe(false);
      },
    );
  });

  describe('isHostDecision', () => {
    it.each(['allow', 'deny', 'modify', 'observe'])('accepts %p', (value) => {
      expect(isHostDecision(value)).toBe(true);
    });

    it.each(['', 'block', 'ask', 1, null, undefined])('rejects %p', (value) => {
      expect(isHostDecision(value)).toBe(false);
    });
  });

  describe('isHostEventContext', () => {
    const valid: HostEventContext = {
      workspaceDir: '/ws',
      sessionId: 'sess-1',
    };

    it('accepts minimal valid context', () => {
      expect(isHostEventContext(valid)).toBe(true);
    });

    it('accepts context with optional fields', () => {
      expect(isHostEventContext({ ...valid, turnId: 'turn-1', toolName: 'Bash' })).toBe(true);
    });

    it.each([
      [null],
      [undefined],
      [[]],
      ['string'],
      [{ workspaceDir: '/ws' }], // missing sessionId
      [{ sessionId: 'sess-1' }], // missing workspaceDir
      [{ workspaceDir: 1, sessionId: 'sess-1' }], // wrong type
    ])('rejects %p', (value) => {
      expect(isHostEventContext(value)).toBe(false);
    });
  });

  describe('isHostEvent', () => {
    const ctx: HostEventContext = { workspaceDir: '/ws', sessionId: 'sess-1' };
    const valid: HostEvent = {
      kind: 'before_tool_call',
      context: ctx,
      rawPayload: { foo: 'bar' },
      source: 'codex:pre_tool_use',
    };

    it('accepts a valid event', () => {
      expect(isHostEvent(valid)).toBe(true);
    });

    it.each([
      [null],
      [undefined],
      [[]],
      [{ kind: 'unknown', context: ctx, rawPayload: null, source: 'x' }],
      [{ kind: 'before_tool_call', context: null, rawPayload: null, source: 'x' }],
      [{ kind: 'before_tool_call', context: ctx, source: 'x' }], // missing rawPayload
      [{ kind: 'before_tool_call', context: ctx, rawPayload: null }], // missing source
    ])('rejects %p', (value) => {
      expect(isHostEvent(value)).toBe(false);
    });
  });

  describe('isHostEventResult', () => {
    const valid: HostEventResult = {
      decision: 'allow',
      source: 'codex:pre_tool_use',
    };

    it('accepts a valid result', () => {
      expect(isHostEventResult(valid)).toBe(true);
    });

    it.each([
      [null],
      [undefined],
      [[]],
      [{ decision: 'block', source: 'x' }],
      [{ decision: 'allow' }], // missing source
      [{ source: 'x' }], // missing decision
    ])('rejects %p', (value) => {
      expect(isHostEventResult(value)).toBe(false);
    });

    it('accepts valid warnings and metadata', () => {
      expect(isHostEventResult({ decision: 'allow', source: 'x', warnings: ['w1'], metadata: { k: 1 } })).toBe(true);
    });

    it.each([
      [{ decision: 'allow', source: 'x', warnings: 'not-array' }],
      [{ decision: 'allow', source: 'x', warnings: [123] }],
      [{ decision: 'allow', source: 'x', metadata: 'not-object' }],
      [{ decision: 'allow', source: 'x', metadata: null }],
      [{ decision: 'allow', source: 'x', metadata: [] }],
    ])('rejects malformed optional fields %p', (value) => {
      expect(isHostEventResult(value)).toBe(false);
    });
  });
});
