import { describe, it, expect } from 'vitest';

function detectCodeBlocks(text: string): Array<{ type: 'code'; language: string; code: string } | { type: 'text'; content: string }> {
  const parts: Array<{ type: 'code'; language: string; code: string } | { type: 'text'; content: string }> = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'code', language: match[1] || '', code: match[2].trimEnd() });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return parts;
}

describe('MarkdownRenderer utilities', () => {
  describe('detectCodeBlocks', () => {
    it('should handle plain text without code blocks', () => {
      const result = detectCodeBlocks('Hello world');
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text');
    });

    it('should detect a code block with language', () => {
      const result = detectCodeBlocks('Before\n```typescript\nconst x = 1;\n```\nAfter');
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('text');
      expect(result[1].type).toBe('code');
      if (result[1].type === 'code') {
        expect(result[1].language).toBe('typescript');
        expect(result[1].code).toBe('const x = 1;');
      }
      expect(result[2].type).toBe('text');
    });

    it('should detect a code block without language', () => {
      const result = detectCodeBlocks('```\nplain code\n```');
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('code');
      if (result[0].type === 'code') {
        expect(result[0].language).toBe('');
        expect(result[0].code).toBe('plain code');
      }
    });

    it('should handle multiple code blocks', () => {
      const result = detectCodeBlocks('```js\na\n```\ntext\n```py\nb\n```');
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('code');
      expect(result[1].type).toBe('text');
      expect(result[2].type).toBe('code');
    });

    it('should handle empty input', () => {
      const result = detectCodeBlocks('');
      expect(result).toHaveLength(0);
    });

    it('should handle code block at start', () => {
      const result = detectCodeBlocks('```ts\ncode\n```\ntrailing text');
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('code');
      expect(result[1].type).toBe('text');
    });

    it('should handle code block at end', () => {
      const result = detectCodeBlocks('leading text\n```ts\ncode\n```');
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('text');
      expect(result[1].type).toBe('code');
    });
  });
});
