import { describe, it, expect, vi } from 'vitest';
import { parseThinkingOsMd, generateDetectionPatterns } from '../../src/core/thinking-os-parser.js';

describe('parseThinkingOsMd', () => {
  it('parses a single directive correctly', () => {
    const content = `
<directive id="T-01" name="MAP_BEFORE_TERRITORY">
  <trigger>Always understand the problem before acting</trigger>
  <must>Map the territory first</must>
  <forbidden>Acting without understanding</forbidden>
</directive>
`;

    const directives = parseThinkingOsMd(content);

    expect(directives).toHaveLength(1);
    expect(directives[0].id).toBe('T-01');
    expect(directives[0].name).toBe('MAP_BEFORE_TERRITORY');
    expect(directives[0].trigger).toBe('Always understand the problem before acting');
    expect(directives[0].must).toBe('Map the territory first');
    expect(directives[0].forbidden).toBe('Acting without understanding');
  });

  it('parses multiple directives', () => {
    const content = `
<directive id="T-01" name="FIRST">
  <trigger>First trigger</trigger>
  <must>First must</must>
  <forbidden>First forbidden</forbidden>
</directive>
<directive id="T-02" name="SECOND">
  <trigger>Second trigger</trigger>
  <must>Second must</must>
  <forbidden>Second forbidden</forbidden>
</directive>
`;

    const directives = parseThinkingOsMd(content);

    expect(directives).toHaveLength(2);
    expect(directives[0].id).toBe('T-01');
    expect(directives[1].id).toBe('T-02');
  });

  it('handles missing optional tags', () => {
    const content = `
<directive id="T-01" name="MINIMAL">
  <trigger>Only trigger</trigger>
</directive>
`;

    const directives = parseThinkingOsMd(content);

    expect(directives).toHaveLength(1);
    expect(directives[0].id).toBe('T-01');
    expect(directives[0].name).toBe('MINIMAL');
    expect(directives[0].trigger).toBe('Only trigger');
    expect(directives[0].must).toBe('');
    expect(directives[0].forbidden).toBe('');
  });

  it('handles missing name attribute', () => {
    const content = `
<directive id="T-01">
  <trigger>Trigger</trigger>
</directive>
`;

    const directives = parseThinkingOsMd(content);

    expect(directives).toHaveLength(1);
    expect(directives[0].id).toBe('T-01');
    expect(directives[0].name).toBe('');
  });

  it('skips directives without id attribute', () => {
    const content = `
<directive name="NO_ID">
  <trigger>Trigger</trigger>
</directive>
<directive id="T-01" name="VALID">
  <trigger>Valid</trigger>
</directive>
`;

    const directives = parseThinkingOsMd(content);

    expect(directives).toHaveLength(1);
    expect(directives[0].id).toBe('T-01');
  });

  it('returns empty array for content with no directives', () => {
    const content = `
# Thinking OS
Some regular markdown content
No XML tags here
`;

    const directives = parseThinkingOsMd(content);

    expect(directives).toEqual([]);
  });

  it('returns empty array for empty content', () => {
    const directives = parseThinkingOsMd('');
    expect(directives).toEqual([]);
  });

  it('trims whitespace from tag content', () => {
    const content = `
<directive id="T-01" name="TRIMMED">
  <trigger>
    Multi-line
    trigger
    text
  </trigger>
  <must>  Must with leading/trailing spaces  </must>
</directive>
`;

    const directives = parseThinkingOsMd(content);

    expect(directives[0].trigger).toBe('Multi-line trigger text');
    expect(directives[0].must).toBe('Must with leading/trailing spaces');
  });

  it('handles case-insensitive tag names', () => {
    const content = `
<directive id="T-01" name="CASE_TEST">
  <TRIGGER>Uppercase trigger</TRIGGER>
  <Must>Mixed case must</Must>
  <FORBIDDEN>All caps forbidden</FORBIDDEN>
</directive>
`;

    const directives = parseThinkingOsMd(content);

    expect(directives[0].trigger).toBe('Uppercase trigger');
    expect(directives[0].must).toBe('Mixed case must');
    expect(directives[0].forbidden).toBe('All caps forbidden');
  });

  it('handles directives with extra attributes', () => {
    const content = `
<directive id="T-01" name="EXTRA_ATTRS" version="1.0" deprecated="false">
  <trigger>Test</trigger>
</directive>
`;

    const directives = parseThinkingOsMd(content);

    expect(directives).toHaveLength(1);
    expect(directives[0].id).toBe('T-01');
    expect(directives[0].name).toBe('EXTRA_ATTRS');
  });
});

describe('generateDetectionPatterns', () => {
  it('extracts Chinese phrases from trigger', () => {
    const patterns = generateDetectionPatterns('你需要先理解问题再采取行动');
    
    expect(patterns).toHaveLength(2);
    expect(patterns[0].source).toBe('你需要先理解问题');
    expect(patterns[1].source).toBe('再采取行动');
  });

  it('extracts English words from trigger', () => {
    const patterns = generateDetectionPatterns('Always understand the problem before acting');
    
    expect(patterns).toHaveLength(2);
    expect(patterns[0].source).toBe('Always understand the problem');
    expect(patterns[1].source).toBe('before acting');
  });

  it('extracts mixed Chinese and English', () => {
    const patterns = generateDetectionPatterns('理解 understand the problem 问题');
    
    expect(patterns).toHaveLength(1);
    expect(patterns[0].source).toBe('understand the problem');
  });

  it('returns empty array for empty trigger', () => {
    const patterns = generateDetectionPatterns('');
    expect(patterns).toEqual([]);
  });

  it('returns empty array for whitespace-only trigger', () => {
    const patterns = generateDetectionPatterns('   ');
    expect(patterns).toEqual([]);
  });

  it('filters out short English words (less than 3 chars)', () => {
    const patterns = generateDetectionPatterns('do it now');
    
    expect(patterns).toEqual([/now/i]);
  });

  it('filters out short Chinese phrases (less than 3 chars)', () => {
    const patterns = generateDetectionPatterns('你好');
    
    expect(patterns).toEqual([]);
  });

  it('creates case-insensitive regexes', () => {
    const patterns = generateDetectionPatterns('Understand');
    
    expect(patterns[0].test('understand')).toBe(true);
    expect(patterns[0].test('UNDERSTAND')).toBe(true);
    expect(patterns[0].test('Understand')).toBe(true);
  });

  it('escapes special regex characters', () => {
    const patterns = generateDetectionPatterns('test pattern');
    
    expect(patterns).toHaveLength(1);
    expect(patterns[0].source).toBe('test pattern');
  });

  it('extracts multi-word English phrases', () => {
    const patterns = generateDetectionPatterns('always understand the problem');
    
    expect(patterns).toContainEqual(expect.objectContaining({ source: 'always understand the problem' }));
  });
});