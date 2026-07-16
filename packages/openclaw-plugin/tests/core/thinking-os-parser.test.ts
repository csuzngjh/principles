import { describe, it, expect } from 'vitest';
import {
  parseThinkingOsMd,
  generateDetectionPatterns,
  type ThinkingOsDirective,
} from '../../src/core/thinking-os-parser.js';

describe('parseThinkingOsMd', () => {
  it('returns empty array for empty input', () => {
    expect(parseThinkingOsMd('')).toEqual([]);
  });

  it('returns empty array for content with no directives', () => {
    expect(parseThinkingOsMd('# Some Markdown\nNo directives here.')).toEqual([]);
  });

  it('parses a single directive with all fields', () => {
    const content = `
<directive id="T-01" name="MAP_BEFORE_TERRITORY">
  <trigger>When starting a new coding task</trigger>
  <must>Create a map before diving into code</must>
  <forbidden>Jump straight into implementation without planning</forbidden>
</directive>
`;
    const result = parseThinkingOsMd(content);
    expect(result).toHaveLength(1);
    const directive = result[0] as ThinkingOsDirective;
    expect(directive.id).toBe('T-01');
    expect(directive.name).toBe('MAP_BEFORE_TERRITORY');
    expect(directive.trigger).toBe('When starting a new coding task');
    expect(directive.must).toBe('Create a map before diving into code');
    expect(directive.forbidden).toBe('Jump straight into implementation without planning');
  });

  it('parses multiple directives', () => {
    const content = `
<directive id="T-01" name="FIRST">
  <trigger>Trigger 1</trigger>
  <must>Must 1</must>
  <forbidden>Forbidden 1</forbidden>
</directive>
<directive id="T-02" name="SECOND">
  <trigger>Trigger 2</trigger>
  <must>Must 2</must>
  <forbidden>Forbidden 2</forbidden>
</directive>
`;
    const result = parseThinkingOsMd(content);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('T-01');
    expect(result[1]?.id).toBe('T-02');
  });

  it('handles missing name attribute gracefully', () => {
    const content = `
<directive id="T-01">
  <trigger>Trigger text</trigger>
  <must>Must text</must>
  <forbidden>Forbidden text</forbidden>
</directive>
`;
    const result = parseThinkingOsMd(content);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('T-01');
    expect(result[0]?.name).toBe('');
  });

  it('skips directives without id attribute', () => {
    const content = `
<directive name="NO_ID">
  <trigger>Trigger</trigger>
  <must>Must</must>
  <forbidden>Forbidden</forbidden>
</directive>
`;
    const result = parseThinkingOsMd(content);
    expect(result).toEqual([]);
  });

  it('handles missing trigger tag', () => {
    const content = `
<directive id="T-01" name="TEST">
  <must>Must text</must>
  <forbidden>Forbidden text</forbidden>
</directive>
`;
    const result = parseThinkingOsMd(content);
    expect(result).toHaveLength(1);
    expect(result[0]?.trigger).toBe('');
    expect(result[0]?.must).toBe('Must text');
  });

  it('handles missing must tag', () => {
    const content = `
<directive id="T-01" name="TEST">
  <trigger>Trigger text</trigger>
  <forbidden>Forbidden text</forbidden>
</directive>
`;
    const result = parseThinkingOsMd(content);
    expect(result).toHaveLength(1);
    expect(result[0]?.must).toBe('');
  });

  it('handles missing forbidden tag', () => {
    const content = `
<directive id="T-01" name="TEST">
  <trigger>Trigger text</trigger>
  <must>Must text</must>
</directive>
`;
    const result = parseThinkingOsMd(content);
    expect(result).toHaveLength(1);
    expect(result[0]?.forbidden).toBe('');
  });

  it('normalizes whitespace in tag content', () => {
    const content = `
<directive id="T-01" name="TEST">
  <trigger>
    Multi-line
    trigger
    text
  </trigger>
  <must>   Must with   spaces   </must>
  <forbidden>
    Forbidden
    with
    tabs  and  spaces
  </forbidden>
</directive>
`;
    const result = parseThinkingOsMd(content);
    expect(result).toHaveLength(1);
    expect(result[0]?.trigger).toBe('Multi-line trigger text');
    expect(result[0]?.must).toBe('Must with spaces');
    expect(result[0]?.forbidden).toBe('Forbidden with tabs and spaces');
  });

  it('handles case-insensitive tag names', () => {
    const content = `
<DIRECTIVE id="T-01" name="TEST">
  <TRIGGER>Trigger</TRIGGER>
  <MUST>Must</MUST>
  <FORBIDDEN>Forbidden</FORBIDDEN>
</DIRECTIVE>
`;
    const result = parseThinkingOsMd(content);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('T-01');
    expect(result[0]?.trigger).toBe('Trigger');
    expect(result[0]?.must).toBe('Must');
    expect(result[0]?.forbidden).toBe('Forbidden');
  });

  it('handles case-insensitive attribute names', () => {
    const content = `
<directive ID="T-01" NAME="TestDirective">
  <trigger>Trigger</trigger>
  <must>Must</must>
  <forbidden>Forbidden</forbidden>
</directive>
`;
    const result = parseThinkingOsMd(content);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('T-01');
  });

  it('handles surrounding markdown content', () => {
    const content = `
# Thinking OS

This document defines thinking models.

## Directives

<directive id="T-01" name="FIRST">
  <trigger>Trigger 1</trigger>
  <must>Must 1</must>
  <forbidden>Forbidden 1</forbidden>
</directive>

Some text in between.

<directive id="T-02" name="SECOND">
  <trigger>Trigger 2</trigger>
  <must>Must 2</must>
  <forbidden>Forbidden 2</forbidden>
</directive>

## End

Footer text.
`;
    const result = parseThinkingOsMd(content);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('T-01');
    expect(result[1]?.id).toBe('T-02');
  });

  it('preserves order of directives as they appear', () => {
    const content = `
<directive id="B" name="B_NAME"><trigger>t</trigger><must>m</must><forbidden>f</forbidden></directive>
<directive id="A" name="A_NAME"><trigger>t</trigger><must>m</must><forbidden>f</forbidden></directive>
<directive id="C" name="C_NAME"><trigger>t</trigger><must>m</must><forbidden>f</forbidden></directive>
`;
    const result = parseThinkingOsMd(content);
    expect(result).toHaveLength(3);
    expect(result.map(d => d.id)).toEqual(['B', 'A', 'C']);
  });

  it('handles directives with empty body tags', () => {
    const content = `
<directive id="T-01" name="TEST">
  <trigger></trigger>
  <must></must>
  <forbidden></forbidden>
</directive>
`;
    const result = parseThinkingOsMd(content);
    expect(result).toHaveLength(1);
    expect(result[0]?.trigger).toBe('');
    expect(result[0]?.must).toBe('');
    expect(result[0]?.forbidden).toBe('');
  });

  it('handles directives with special characters in content', () => {
    const content = `
<directive id="T-01" name="TEST">
  <trigger>When user says "this is broken"</trigger>
  <must>Use <pre> tags for code</must>
  <forbidden>Ignore user's frustration & don't empathize</forbidden>
</directive>
`;
    const result = parseThinkingOsMd(content);
    expect(result).toHaveLength(1);
    expect(result[0]?.trigger).toContain('this is broken');
    expect(result[0]?.forbidden).toContain("user's frustration");
  });

  it('handles null/undefined like empty string via type coercion', () => {
    expect(parseThinkingOsMd('')).toEqual([]);
    expect(parseThinkingOsMd(null as unknown as string)).toEqual([]);
    expect(parseThinkingOsMd(undefined as unknown as string)).toEqual([]);
  });
});

describe('generateDetectionPatterns', () => {
  it('returns empty array for empty string', () => {
    expect(generateDetectionPatterns('')).toEqual([]);
  });

  it('extracts Chinese phrases from trigger text', () => {
    const patterns = generateDetectionPatterns('当用户感到困惑时应该停下来');
    expect(patterns.map(p => p.source)).toEqual(['当用户感到困惑时', '应该停下来']);
    for (const p of patterns) {
      expect(p).toBeInstanceOf(RegExp);
      expect(p.flags).toContain('i');
    }
  });

  it('extracts English words from trigger text', () => {
    const patterns = generateDetectionPatterns('When user is confused stop and clarify');
    expect(patterns.length).toBeGreaterThan(0);
    const patternSources = patterns.map(p => p.source);
    expect(patternSources.some(s => /user/.test(s))).toBe(true);
    expect(patternSources.some(s => /confused/.test(s))).toBe(true);
  });

  it('generates case-insensitive regex patterns', () => {
    const patterns = generateDetectionPatterns('Confused User');
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) {
      expect(p.flags).toContain('i');
    }
  });

  it('matches expected text with generated patterns', () => {
    const patterns = generateDetectionPatterns('user is confused');
    const hasMatch = patterns.some(p => p.test('The user seems confused about this issue'));
    expect(hasMatch).toBe(true);
  });

  it('handles mixed Chinese and English text', () => {
    const patterns = generateDetectionPatterns('用户 confused 应该停下来');
    expect(patterns.length).toBeGreaterThan(1);
    const hasChinese = patterns.some(p => /[\u4e00-\u9fa5]/.test(p.source));
    const hasEnglish = patterns.some(p => /[a-zA-Z]/.test(p.source));
    expect(hasChinese).toBe(true);
    expect(hasEnglish).toBe(true);
  });

  it('treats regex punctuation as phrase separators', () => {
    const patterns = generateDetectionPatterns('error occurred with file.test.ts');
    expect(patterns.map(p => p.source)).toEqual(['error occurred with file', 'test']);
  });

  it('filters out very short English phrases (< 3 chars)', () => {
    const patterns = generateDetectionPatterns('a b c hi go');
    const patternSources = patterns.map(p => p.source);
    const shortPatterns = patternSources.filter(s => s.replace(/\\/g, '').length < 3);
    expect(shortPatterns.length).toBe(0);
  });

  it('handles text with only short words', () => {
    const patterns = generateDetectionPatterns('a b c d');
    expect(patterns).toEqual([]);
  });

  it('handles text with numbers and symbols', () => {
    const patterns = generateDetectionPatterns('test123 error code 404 not found');
    expect(patterns.length).toBeGreaterThan(0);
  });
});
