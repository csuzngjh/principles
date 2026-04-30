import { describe, test, expect } from 'vitest';
import { extractAgentIdFromSessionKey } from '../../src/utils/session-key';

describe('extractAgentIdFromSessionKey', () => {
  test('returns undefined for undefined input', () => {
    expect(extractAgentIdFromSessionKey(undefined)).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(extractAgentIdFromSessionKey('')).toBeUndefined();
  });

  test('returns agentId from 3-part key (agent:{id}:{type}:{uuid})', () => {
    expect(extractAgentIdFromSessionKey('agent:main:session:abc-123')).toBe('main');
  });

  test('returns agentId from 2-part key (agent:{id}:{uuid})', () => {
    expect(extractAgentIdFromSessionKey('agent:worker-1:def-456')).toBe('worker-1');
  });

  test('returns undefined for non-matching format', () => {
    expect(extractAgentIdFromSessionKey('user:main:session:abc')).toBeUndefined();
    expect(extractAgentIdFromSessionKey('session:abc-123')).toBeUndefined();
    expect(extractAgentIdFromSessionKey('random-string')).toBeUndefined();
  });

  test('trims whitespace from agentId', () => {
    expect(extractAgentIdFromSessionKey('agent: main :session:abc')).toBe('main');
  });

  test('returns undefined when agentId is whitespace-only', () => {
    expect(extractAgentIdFromSessionKey('agent:  :session:abc')).toBeUndefined();
  });

  test('handles agentId with special characters', () => {
    expect(extractAgentIdFromSessionKey('agent:my-agent_v2:session:abc')).toBe('my-agent_v2');
  });
});
