import { describe, it, expect } from 'vitest';
import { extractMessageContent } from '../message-extraction.js';

describe('message-extraction', () => {
  describe('extractMessageContent', () => {
    it('returns string as-is', () => {
      expect(extractMessageContent('hello world')).toBe('hello world');
    });

    it('returns empty string for null', () => {
      expect(extractMessageContent(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(extractMessageContent(undefined)).toBe('');
    });

    it('returns empty string for non-object primitives', () => {
      expect(extractMessageContent(123)).toBe('');
      expect(extractMessageContent(true)).toBe('');
      expect(extractMessageContent(Symbol('test'))).toBe('');
    });

    it('extracts string content from object', () => {
      expect(extractMessageContent({ content: 'hello' })).toBe('hello');
    });

    it('returns empty string when content is missing', () => {
      expect(extractMessageContent({})).toBe('');
    });

    it('returns empty string when content is not string', () => {
      expect(extractMessageContent({ content: 123 })).toBe('');
      expect(extractMessageContent({ content: null })).toBe('');
      expect(extractMessageContent({ content: {} })).toBe('');
    });

    it('extracts text from array content with text parts', () => {
      const message = {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ],
      };
      expect(extractMessageContent(message)).toBe('hello\nworld');
    });

    it('filters non-text parts from array content', () => {
      const message = {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', url: 'http://example.com' },
          { type: 'text', text: 'world' },
        ],
      };
      expect(extractMessageContent(message)).toBe('hello\nworld');
    });

    it('handles empty text in array parts', () => {
      const message = {
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'hello' },
        ],
      };
      expect(extractMessageContent(message)).toBe('hello');
    });

    it('handles missing text property in text parts', () => {
      const message = {
        content: [
          { type: 'text' },
          { type: 'text', text: 'hello' },
        ],
      };
      expect(extractMessageContent(message)).toBe('hello');
    });

    it('trims result from array content', () => {
      const message = {
        content: [
          { type: 'text', text: '  hello  ' },
          { type: 'text', text: '  world  ' },
        ],
      };
      expect(extractMessageContent(message)).toBe('hello  \n  world');
    });

    it('returns empty string for empty array content', () => {
      expect(extractMessageContent({ content: [] })).toBe('');
    });

    it('returns empty string for array with no text parts', () => {
      const message = {
        content: [
          { type: 'image', url: 'http://example.com' },
          { type: 'file', name: 'test.txt' },
        ],
      };
      expect(extractMessageContent(message)).toBe('');
    });
  });
});