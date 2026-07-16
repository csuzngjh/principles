import { describe, expect, it } from 'vitest';
import { isExpectedSubagentError } from '../../../src/service/subagent-workflow/subagent-error-utils.js';

describe('isExpectedSubagentError', () => {
  describe('gateway request availability', () => {
    it('detects plugin runtime subagent methods error', () => {
      expect(isExpectedSubagentError('Plugin runtime subagent methods are only available during a gateway request')).toBe(true);
    });
  });

  describe('boot session', () => {
    it('detects cannot start workflow for boot session', () => {
      expect(isExpectedSubagentError('cannot start workflow for boot session')).toBe(true);
    });
  });

  describe('subagent runtime unavailable', () => {
    it('detects subagent runtime unavailable', () => {
      expect(isExpectedSubagentError('subagent runtime unavailable')).toBe(true);
    });

    it('detects subagent is not available', () => {
      expect(isExpectedSubagentError('subagent is not available')).toBe(true);
    });

    it('detects NocturnalWorkflowManager with subagent runtime unavailable', () => {
      expect(isExpectedSubagentError('NocturnalWorkflowManager: subagent runtime unavailable')).toBe(true);
    });
  });

  describe('gateway not running', () => {
    it('detects gateway is not running', () => {
      expect(isExpectedSubagentError('gateway is not running')).toBe(true);
    });
  });

  describe('process isolation', () => {
    it('detects process isolation in cron jobs', () => {
      expect(isExpectedSubagentError('process isolation prevents subagent access in cron context')).toBe(true);
    });
  });

  describe('connection issues', () => {
    it('detects connection refused', () => {
      expect(isExpectedSubagentError('subagent connection refused')).toBe(true);
    });

    it('detects connection reset', () => {
      expect(isExpectedSubagentError('subagent connection reset')).toBe(true);
    });

    it('detects lowercase econnrefused in connection context', () => {
      expect(isExpectedSubagentError('subagent connection econnrefused')).toBe(true);
    });

    it('detects lowercase connection refused', () => {
      expect(isExpectedSubagentError('subagent connection refused')).toBe(true);
    });

    it('detects connection issues in daemon mode', () => {
      expect(isExpectedSubagentError('subagent connection reset by peer in daemon mode')).toBe(true);
    });
  });

  describe('false positives', () => {
    it('returns false for unrelated errors', () => {
      expect(isExpectedSubagentError('database connection failed')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isExpectedSubagentError('')).toBe(false);
    });

    it('returns false for null', () => {
      expect(isExpectedSubagentError(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isExpectedSubagentError(undefined)).toBe(false);
    });

    it('returns false for numbers', () => {
      expect(isExpectedSubagentError(123)).toBe(false);
    });

    it('returns false for objects', () => {
      expect(isExpectedSubagentError({ message: 'some error' })).toBe(false);
    });

    it('returns false for subagent-related but different errors', () => {
      expect(isExpectedSubagentError('subagent process crashed unexpectedly')).toBe(false);
      expect(isExpectedSubagentError('subagent authentication failed')).toBe(false);
      expect(isExpectedSubagentError('subagent timeout exceeded')).toBe(false);
    });

    it('returns false for connection issues not involving subagent', () => {
      expect(isExpectedSubagentError('database connection refused')).toBe(false);
      expect(isExpectedSubagentError('API connection reset')).toBe(false);
    });
  });

  describe('error objects', () => {
    it('handles Error objects', () => {
      expect(isExpectedSubagentError(new Error('subagent runtime unavailable'))).toBe(true);
      expect(isExpectedSubagentError(new Error('database error'))).toBe(false);
    });

    it('handles error-like objects with toString method', () => {
      const customError = { message: 'subagent is not available', toString: () => 'subagent is not available' };
      expect(isExpectedSubagentError(customError)).toBe(true);
    });
  });
});