import { describe, it, expect, beforeEach } from 'vitest';
import { OpenClawPainAdapter } from '../../../src/adapters/coding/openclaw-pain-adapter.js';
import { validatePainSignal } from '../../../src/pain-signal.js';

describe('OpenClawPainAdapter', () => {
  let adapter: OpenClawPainAdapter;

  beforeEach(() => {
    adapter = new OpenClawPainAdapter();
  });

  describe('capture()', () => {
    it('returns null for non-failure tool event (no error)', () => {
      const event = { toolName: 'write', result: 'success' };
      const result = adapter.capture(event);
      expect(result).toBeNull();
    });

    it('returns null for non-failure tool event (error is empty string)', () => {
      const event = { toolName: 'read', error: '' };
      const result = adapter.capture(event);
      expect(result).toBeNull();
    });

    it('returns valid PainSignal for tool failure with ENOENT', () => {
      const event = {
        toolName: 'write',
        error: 'ENOENT: no such file or directory',
        params: { file_path: '/tmp/test.ts' },
      };
      const result = adapter.capture(event);
      expect(result).not.toBeNull();
      expect(result!.source).toBe('tool_failure');
      expect(result!.domain).toBe('coding');
      expect(result!.score).toBe(80);
      expect(result!.severity).toBe('high');
    });

    it('returns PainSignal score 95 for permission denied error', () => {
      const event = { toolName: 'write', error: 'EACCES: permission denied' };
      const result = adapter.capture(event);
      expect(result!.score).toBe(95);
      expect(result!.severity).toBe('critical');
    });

    it('returns PainSignal score 60 for timeout error', () => {
      const event = { toolName: 'bash', error: 'ETIMEDOUT: connection timed out' };
      const result = adapter.capture(event);
      expect(result!.score).toBe(60);
      expect(result!.severity).toBe('medium');
    });

    it('returns null for malformed event (missing toolName)', () => {
      const event = { error: 'some error' } as any;
      const result = adapter.capture(event);
      expect(result).toBeNull();
    });

    it('output passes validatePainSignal()', () => {
      const event = { toolName: 'edit', error: 'EINVAL: invalid argument' };
      const result = adapter.capture(event);
      expect(result).not.toBeNull();
      const validation = validatePainSignal(result);
      expect(validation.valid).toBe(true);
    });

    it('sets domain to coding', () => {
      const event = { toolName: 'write', error: 'ENOENT' };
      const result = adapter.capture(event);
      expect(result!.domain).toBe('coding');
    });

    it('derives severity from score correctly', () => {
      const event = { toolName: 'write', error: 'ENOENT' };
      const result = adapter.capture(event);
      // score 80 -> high severity (70-89)
      expect(result!.severity).toBe('high');
    });

    it('defaults sessionId to unknown when not provided', () => {
      const event = { toolName: 'write', error: 'error' };
      const result = adapter.capture(event);
      expect(result!.sessionId).toBe('unknown');
    });

    it('defaults agentId to unknown when not provided', () => {
      const event = { toolName: 'write', error: 'error' };
      const result = adapter.capture(event);
      expect(result!.agentId).toBe('unknown');
    });

    it('uses provided sessionId and agentId when available', () => {
      const event = {
        toolName: 'write',
        error: 'error',
        sessionId: 'sess-456',
        agentId: 'builder',
      };
      const result = adapter.capture(event);
      expect(result!.sessionId).toBe('sess-456');
      expect(result!.agentId).toBe('builder');
    });

    it('includes toolName in context', () => {
      const event = { toolName: 'edit', error: 'error' };
      const result = adapter.capture(event);
      expect(result!.context.toolName).toBe('edit');
    });
  });
});
