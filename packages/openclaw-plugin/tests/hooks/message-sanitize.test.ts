import { describe, it, expect } from 'vitest';
import { handleBeforeMessageWrite, sanitizeAssistantText } from '../../src/hooks/message-sanitize';

describe('message-sanitize hook', () => {
  it('removes empathy control tags from assistant text', () => {
    const text = '抱歉 [EMOTIONAL_DAMAGE_DETECTED:moderate]\n<empathy signal="damage" severity="moderate"/>\n继续处理';
    expect(sanitizeAssistantText(text)).toBe('抱歉\n\n继续处理');
  });

  it('returns modified message for assistant role', () => {
    const result = handleBeforeMessageWrite({
      message: {
        role: 'assistant',
        content: 'hello [EMOTIONAL_DAMAGE_DETECTED] world'
      }
    } as any);

    expect(result).toEqual({
      message: {
        role: 'assistant',
        content: 'hello  world'
      }
    });
  });

  it('ignores non-assistant messages', () => {
    const result = handleBeforeMessageWrite({
      message: {
        role: 'user',
        content: '[EMOTIONAL_DAMAGE_DETECTED]'
      }
    } as any);

    expect(result).toBeUndefined();
  });
});
