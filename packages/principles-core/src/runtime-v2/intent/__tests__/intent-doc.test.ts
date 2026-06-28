import { describe, it, expect } from 'vitest';
import { INTENT_MAX_BYTES, INTENT_DOC_TEMPLATE, parseIntentDocSections, computeIntentContentHash, validateIntentDocSections, type IntentDocWarning, type IntentDocSections, INTENT_DOC_TEMPLATE_ZH, INTENT_DOC_TEMPLATE_EN, getIntentFilename, createIntentTemplate } from '../intent-doc.js';

const VALID = `# INTENT.md

## 1. Why

This project validates pain from repeatedly correcting Agents.

## 2. Desired Outcome

A new user understands PD within five minutes.

## 3. Non-negotiables

- Do not make PD a heavy Agent platform.
- Do not increase Owner attention burden.

## 4. Stop / Escalation

If a change expands PD into orchestration, stop and ask Owner.

## 5. Current Strategic Focus

Validate the smallest loop: Pain to Principle to Delta.
`;

describe('parseIntentDocSections', () => {
  it('parses all 5 sections', () => {
    const s = parseIntentDocSections(VALID);
    expect(s.why).toContain('correcting Agents');
    expect(s.desiredOutcome).toContain('five minutes');
    expect(s.nonNegotiables).toContain('heavy Agent');
    expect(s.stopEscalation).toContain('stop and ask');
    expect(s.currentStrategicFocus).toContain('smallest loop');
  });
  it('returns undefined for missing sections', () => {
    const s = parseIntentDocSections(`## 1. Why\n\nJust why.\n`);
    expect(s.why).toBe('Just why.');
    expect(s.desiredOutcome).toBeUndefined();
  });
  it('handles empty string', () => { expect(() => parseIntentDocSections('')).not.toThrow(); });
  it('handles no headers', () => { expect(() => parseIntentDocSections('plain text')).not.toThrow(); });
  it('parses template', () => {
    const s = parseIntentDocSections(INTENT_DOC_TEMPLATE);
    expect(s.why).toBeDefined();
    expect(s.desiredOutcome).toBeDefined();
  });
});

describe('computeIntentContentHash', () => {
  it('returns sha256: prefix', () => { expect(computeIntentContentHash('x').startsWith('sha256:')).toBe(true); });
  it('has 64 hex chars', () => { expect(computeIntentContentHash('x').slice(7)).toMatch(/^[0-9a-f]{64}$/); });
  it('is deterministic', () => { expect(computeIntentContentHash('a')).toBe(computeIntentContentHash('a')); });
  it('differs for different inputs', () => { expect(computeIntentContentHash('a')).not.toBe(computeIntentContentHash('b')); });
});

describe('validateIntentDocSections', () => {
  it('5 missing warnings for empty', () => {
    const w = validateIntentDocSections({});
    expect(w.length).toBe(5);
    expect(w.every((x: IntentDocWarning) => x.code === 'missing_section')).toBe(true);
  });
  it('no warnings for valid', () => {
    const s = parseIntentDocSections(VALID);
    expect(validateIntentDocSections(s)).toEqual([]);
  });
  it('empty_section for blank content', () => {
    const raw = `## 1. Why\n\n\n## 2. Desired Outcome\n\nValid outcome here.\n## 3. Non-negotiables\n\nValid NN.\n## 4. Stop / Escalation\n\nValid stop.\n## 5. Current Strategic Focus\n\nValid focus.\n`;
    const w = validateIntentDocSections(parseIntentDocSections(raw));
    expect(w.some((x: IntentDocWarning) => x.code === 'empty_section' && x.section === 'why')).toBe(true);
  });
  it('too_vague for short content', () => {
    const raw = `## 1. Why\n\nshort\n## 2. Desired Outcome\n\nValid outcome here.\n## 3. Non-negotiables\n\nValid NN.\n## 4. Stop / Escalation\n\nValid stop.\n## 5. Current Strategic Focus\n\nValid focus.\n`;
    const w = validateIntentDocSections(parseIntentDocSections(raw));
    expect(w.some((x: IntentDocWarning) => x.code === 'too_vague' && x.section === 'why')).toBe(true);
  });
  it('parse_failed for non-string section value (CodeRabbit coverage nitpick)', () => {
    // validateIntentDocSections is exported and can receive a directly-constructed
    // sections object where a key holds a non-string value. parseIntentDocSections
    // always returns string|undefined, so this branch is only reachable via direct
    // calls — covering it locks the defensive contract.
    const malformed = { why: 123 as unknown as string } as IntentDocSections;
    const w = validateIntentDocSections(malformed);
    expect(w.some((x: IntentDocWarning) => x.code === 'parse_failed' && x.section === 'why')).toBe(true);
  });
});

describe('constants', () => {
  it('INTENT_MAX_BYTES is 32768', () => { expect(INTENT_MAX_BYTES).toBe(32768); });
  it('template has 5 headers', () => {
    expect(INTENT_DOC_TEMPLATE).toContain('## 1. Why');
    expect(INTENT_DOC_TEMPLATE).toContain('## 5. Current Strategic Focus');
  });
});

describe('Intent bilingual templates', () => {
  it('getIntentFilename returns lang-suffixed filename', () => {
    expect(getIntentFilename('zh-CN')).toBe('INTENT.zh-CN.md');
    expect(getIntentFilename('en')).toBe('INTENT.en.md');
  });

  it('INTENT_DOC_TEMPLATE_ZH contains Chinese guidance prompts', () => {
    expect(INTENT_DOC_TEMPLATE_ZH).toContain('这个项目');
    expect(INTENT_DOC_TEMPLATE_ZH).toContain('## 1. Why');
  });

  it('INTENT_DOC_TEMPLATE_EN contains enhanced prompts', () => {
    expect(INTENT_DOC_TEMPLATE_EN).toContain('Why does this project matter?');
    expect(INTENT_DOC_TEMPLATE_EN).toContain('## 1. Why');
  });

  it('createIntentTemplate returns correct template per lang', () => {
    expect(createIntentTemplate('zh-CN')).toBe(INTENT_DOC_TEMPLATE_ZH);
    expect(createIntentTemplate('en')).toBe(INTENT_DOC_TEMPLATE_EN);
  });

  it('both templates parse to 5 sections with same keys', () => {
    const zhSections = parseIntentDocSections(INTENT_DOC_TEMPLATE_ZH);
    const enSections = parseIntentDocSections(INTENT_DOC_TEMPLATE_EN);
    const zhKeys = Object.keys(zhSections).sort();
    const enKeys = Object.keys(enSections).sort();
    expect(zhKeys).toEqual(['currentStrategicFocus', 'desiredOutcome', 'nonNegotiables', 'stopEscalation', 'why']);
    expect(enKeys).toEqual(zhKeys);
  });
});