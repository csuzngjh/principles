import { describe, it, expect } from 'vitest';
import { escapeXml } from '../xml-escape.js';

describe('escapeXml', () => {
  it('escapes ampersand', () => {
    expect(escapeXml('A&B')).toBe('A&amp;B');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a<b')).toBe('a&lt;b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a>b')).toBe('a&gt;b');
  });

  it('escapes double quote', () => {
    expect(escapeXml('a"b')).toBe('a&quot;b');
  });

  it('escapes single quote', () => {
    expect(escapeXml("a'b")).toBe('a&apos;b');
  });

  it('escapes all special characters in mixed content', () => {
    expect(escapeXml('<tag attr="x">A&B\'C</tag>')).toBe(
      '&lt;tag attr=&quot;x&quot;&gt;A&amp;B&apos;C&lt;/tag&gt;',
    );
  });

  it('returns empty string unchanged', () => {
    expect(escapeXml('')).toBe('');
  });

  it('returns string without special characters unchanged', () => {
    expect(escapeXml('plain text 123')).toBe('plain text 123');
  });

  it('escapes repeated special characters', () => {
    expect(escapeXml('&&&')).toBe('&amp;&amp;&amp;');
  });

  it('escapes ampersand first to avoid double-escaping', () => {
    // If & were not escaped first, &lt; would become &amp;lt;
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('handles principle-id-like input', () => {
    expect(escapeXml('P<001>')).toBe('P&lt;001&gt;');
  });

  it('handles principle-text-like input', () => {
    expect(escapeXml('Use "typeof" & avoid <as>')).toBe(
      'Use &quot;typeof&quot; &amp; avoid &lt;as&gt;',
    );
  });
});
