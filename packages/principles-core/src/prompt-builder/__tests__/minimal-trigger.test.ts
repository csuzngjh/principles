import { describe, it, expect } from 'vitest';
import { isMinimalTrigger } from '../minimal-trigger.js';

describe('minimal-trigger', () => {
  describe('isMinimalTrigger', () => {
    it('returns true for heartbeat trigger', () => {
      expect(isMinimalTrigger('heartbeat')).toBe(true);
    });

    it('returns true for cron trigger', () => {
      expect(isMinimalTrigger('cron')).toBe(true);
    });

    it('returns true for subagent sessionId', () => {
      expect(isMinimalTrigger('user', 'main:subagent:123')).toBe(true);
    });

    it('returns false for user trigger', () => {
      expect(isMinimalTrigger('user')).toBe(false);
    });

    it('returns false for api trigger', () => {
      expect(isMinimalTrigger('api')).toBe(false);
    });

    it('returns false for undefined trigger', () => {
      expect(isMinimalTrigger(undefined)).toBe(false);
    });

    it('returns false for other triggers', () => {
      expect(isMinimalTrigger('manual')).toBe(false);
      expect(isMinimalTrigger('workflow')).toBe(false);
      expect(isMinimalTrigger('test')).toBe(false);
    });

    it('returns false for non-subagent sessionId', () => {
      expect(isMinimalTrigger('user', 'main:agent:123')).toBe(false);
      expect(isMinimalTrigger('user', 'session-123')).toBe(false);
      expect(isMinimalTrigger('user', 'main')).toBe(false);
    });

    it('returns false when sessionId is undefined', () => {
      expect(isMinimalTrigger('user', undefined)).toBe(false);
    });

    it('returns false when sessionId is empty', () => {
      expect(isMinimalTrigger('user', '')).toBe(false);
    });

    it('handles case sensitivity correctly', () => {
      expect(isMinimalTrigger('HEARTBEAT')).toBe(false);
      expect(isMinimalTrigger('Cron')).toBe(false);
    });
  });
});