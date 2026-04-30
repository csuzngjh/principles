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

  test('returns undefined for whitespace-only agentId', () => {
    // String.trim() removes ASCII whitespace (\\t, \\n, \\r, space) AND fullwidth space \\u3000 from edges
    expect(extractAgentIdFromSessionKey('agent:\t:session:abc')).toBeUndefined(); // tab → empty after trim
    expect(extractAgentIdFromSessionKey('agent:\r:session:abc')).toBeUndefined(); // CR → empty after trim
    expect(extractAgentIdFromSessionKey('agent:\u3000:session:abc')).toBeUndefined(); // fullwidth space trimmed → empty
  });

  test('handles mixed whitespace within agentId parts', () => {
    // Tab is internal (not at trim edge), so 'a\tb'.trim() → 'a\tb' (tab preserved in middle)
    expect(extractAgentIdFromSessionKey('agent:a\tb:session:abc')).toBe('a\tb');
    // CR\\n is internal, not at edge, so 'a\r\nb'.trim() → 'a\r\nb'
    expect(extractAgentIdFromSessionKey('agent:a\r\nb:session:abc')).toBe('a\r\nb');
  });
});
