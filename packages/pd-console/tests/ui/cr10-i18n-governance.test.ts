/**
 * CR10: i18n governance tests
 *
 * Validates:
 * 1. en/zh-CN key parity
 * 2. zh-CN has no Owner/Agent/Prompt/Console mixed terms
 * 3. en has no Chinese characters
 * 4. Banned words scan (including login slogan)
 * 5. No confirm-first default examples
 * 6. No raw key leakage (all keys have string values)
 */

import { describe, it, expect } from 'vitest';
import en from '../../src/ui/i18n/en.json';
import zhCN from '../../src/ui/i18n/zh-CN.json';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively collect all dot-path keys from a nested object */
function collectKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || obj === undefined || typeof obj !== 'object' || Array.isArray(obj)) {
    return [];
  }
  const keys: string[] = [];
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(...collectKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

/** Recursively collect all string values from a nested object */
function collectStringValues(obj: unknown): string[] {
  if (obj === null || obj === undefined || typeof obj !== 'object' || Array.isArray(obj)) {
    return [];
  }
  const values: string[] = [];
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      values.push(value);
    } else if (typeof value === 'object' && value !== null) {
      values.push(...collectStringValues(value));
    }
  }
  return values;
}

/** Check if a string contains CJK characters */
function containsChinese(str: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(str);
}

// ── Banned words ──────────────────────────────────────────────────────────────

const BANNED_WORDS_EN = [
  'Burn pain',
  'Evolve',
  'Auto-evolve',
  'One-click evolve',
  'Automatically optimize',
  'Auto-optimize',
];

const BANNED_WORDS_ZH = [
  '燃烧痛苦',
  '驱动进化',
  '自动优化',
  '一键进化',
  '燃烧',
  '驱动进化',
];

// ── Mixed terms: zh-CN should not contain bare English terms ──────────────────

const ZH_BANNED_MIXED_TERMS = [
  // Owner → 拥有者
  { term: 'Owner', replacement: '拥有者', allowInProduct: true },
  // Agent → 智能体
  { term: 'Agent', replacement: '智能体', allowInProduct: true },
  // Prompt → 提示词
  { term: 'Prompt', replacement: '提示词', allowInProduct: true },
  // Console → 控制台 (when used as generic noun, not product name)
  { term: 'Console', replacement: '控制台', allowInProduct: true },
];

// Product names / technical terms that are allowed to remain in English in zh-CN
const ALLOWED_EN_TERMS_IN_ZH = [
  'PD',
  'RuleHost',
  'OpenClaw',
  'Console API',
  'Bearer Token',
  'Bearer',
  'API',
  'CR5',
  'Code Tool Hook',
  'post-MVP',
  'GitHub',
  'Markdown',
  'ID',
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('i18n key parity', () => {
  const enKeys = collectKeys(en).sort();
  const zhKeys = collectKeys(zhCN).sort();

  it('en and zh-CN have the same number of keys', () => {
    expect(enKeys.length).toBe(zhKeys.length);
  });

  it('every en key exists in zh-CN', () => {
    const zhKeySet = new Set(zhKeys);
    const missing = enKeys.filter(k => !zhKeySet.has(k));
    expect(missing, `Keys in en but missing from zh-CN: ${missing.join(', ')}`).toEqual([]);
  });

  it('every zh-CN key exists in en', () => {
    const enKeySet = new Set(enKeys);
    const missing = zhKeys.filter(k => !enKeySet.has(k));
    expect(missing, `Keys in zh-CN but missing from en: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('zh-CN no Owner/Agent/Prompt/Console mixed terms', () => {
  const zhValues = collectStringValues(zhCN);

  it('no bare "Owner" in zh-CN strings (should be 拥有者)', () => {
    const violations: string[] = [];
    for (const val of zhValues) {
      // Check if "Owner" appears as a standalone word (not part of allowed product term)
      if (/\bOwner\b/.test(val)) {
        // Check if it's part of an allowed term
        const isAllowed = ALLOWED_EN_TERMS_IN_ZH.some(allowed => val.includes(allowed) && allowed.includes('Owner'));
        if (!isAllowed) {
          violations.push(val);
        }
      }
    }
    expect(violations, `Found bare "Owner" in zh-CN: ${violations.join('; ')}`).toEqual([]);
  });

  it('no bare "Agent" in zh-CN strings (should be 智能体)', () => {
    const violations: string[] = [];
    for (const val of zhValues) {
      if (/\bAgent\b/.test(val)) {
        const isAllowed = ALLOWED_EN_TERMS_IN_ZH.some(allowed => val.includes(allowed) && allowed.includes('Agent'));
        if (!isAllowed) {
          violations.push(val);
        }
      }
    }
    expect(violations, `Found bare "Agent" in zh-CN: ${violations.join('; ')}`).toEqual([]);
  });

  it('no bare "Prompt" in zh-CN strings (should be 提示词)', () => {
    const violations: string[] = [];
    for (const val of zhValues) {
      if (/\bPrompt\b/.test(val)) {
        const isAllowed = ALLOWED_EN_TERMS_IN_ZH.some(allowed => val.includes(allowed) && allowed.includes('Prompt'));
        if (!isAllowed) {
          violations.push(val);
        }
      }
    }
    expect(violations, `Found bare "Prompt" in zh-CN: ${violations.join('; ')}`).toEqual([]);
  });

  it('no bare "Console" in zh-CN strings (should be 控制台)', () => {
    const violations: string[] = [];
    for (const val of zhValues) {
      if (/\bConsole\b/.test(val)) {
        // Console API is allowed, bare Console is not
        const isPartOfAllowedTerm = ALLOWED_EN_TERMS_IN_ZH.some(
          allowed => allowed.includes('Console') && val.includes(allowed)
        );
        if (!isPartOfAllowedTerm) {
          violations.push(val);
        }
      }
    }
    expect(violations, `Found bare "Console" in zh-CN: ${violations.join('; ')}`).toEqual([]);
  });
});

describe('en has no Chinese characters', () => {
  const enValues = collectStringValues(en);

  // languageSwitcher.chinese = "中文" is intentional: the language picker
  // must display the native name of the target language.
  const ALLOWED_CJK_IN_EN = ['中文'];

  it('no CJK characters in English strings (except language switcher native names)', () => {
    const violations = enValues.filter(v => containsChinese(v) && !ALLOWED_CJK_IN_EN.includes(v));
    expect(violations, `Found Chinese characters in en.json: ${violations.join('; ')}`).toEqual([]);
  });
});

describe('banned words scan', () => {
  it('en.json has no banned words', () => {
    const enValues = collectStringValues(en);
    const violations: string[] = [];
    for (const word of BANNED_WORDS_EN) {
      for (const val of enValues) {
        if (val.includes(word)) {
          violations.push(`"${word}" found in: ${val}`);
        }
      }
    }
    expect(violations, `Banned words in en.json: ${violations.join('; ')}`).toEqual([]);
  });

  it('zh-CN.json has no banned words', () => {
    const zhValues = collectStringValues(zhCN);
    const violations: string[] = [];
    for (const word of BANNED_WORDS_ZH) {
      for (const val of zhValues) {
        if (val.includes(word)) {
          violations.push(`"${word}" found in: ${val}`);
        }
      }
    }
    expect(violations, `Banned words in zh-CN.json: ${violations.join('; ')}`).toEqual([]);
  });

  it('login slogan is governance-flavored (en)', () => {
    const slogan = (en as Record<string, unknown>).pages
      ? ((en as Record<string, unknown>).pages as Record<string, unknown>).login
        ? (((en as Record<string, unknown>).pages as Record<string, unknown>).login as Record<string, unknown>).slogan as string
        : ''
      : '';
    expect(slogan).toBeTruthy();
    // Must NOT contain banned words
    for (const word of BANNED_WORDS_EN) {
      expect(slogan, `Login slogan contains banned word "${word}"`).not.toContain(word);
    }
    // Must contain governance-related term
    const governanceTerms = ['govern', 'principle', 'correction'];
    const hasGovernance = governanceTerms.some(t => slogan.toLowerCase().includes(t));
    expect(hasGovernance, `Login slogan "${slogan}" should contain a governance term`).toBe(true);
  });

  it('login slogan is governance-flavored (zh-CN)', () => {
    const slogan = ((zhCN as Record<string, unknown>).pages as Record<string, unknown>).login
      ? (((zhCN as Record<string, unknown>).pages as Record<string, unknown>).login as Record<string, unknown>).slogan as string
      : '';
    expect(slogan).toBeTruthy();
    for (const word of BANNED_WORDS_ZH) {
      expect(slogan, `Login slogan contains banned word "${word}"`).not.toContain(word);
    }
    // Must contain governance-related term
    const governanceTerms = ['治理', '原则', '纠正', '沉淀'];
    const hasGovernance = governanceTerms.some(t => slogan.includes(t));
    expect(hasGovernance, `Login slogan "${slogan}" should contain a governance term`).toBe(true);
  });
});

describe('no confirm-first default examples', () => {
  const allEnValues = collectStringValues(en);
  const allZhValues = collectStringValues(zhCN);

  it('en.json has no confirm-first default examples', () => {
    const violations = allEnValues.filter(v =>
      /confirm.first/i.test(v) || /change before confirm/i.test(v)
    );
    expect(violations, `Found confirm-first examples in en.json: ${violations.join('; ')}`).toEqual([]);
  });

  it('zh-CN.json has no confirm-first default examples', () => {
    const violations = allZhValues.filter(v =>
      v.includes('变更前确认需求') || v.includes('confirm-first')
    );
    expect(violations, `Found confirm-first examples in zh-CN.json: ${violations.join('; ')}`).toEqual([]);
  });
});

describe('no raw key leakage', () => {
  it('every leaf value in en.json is a string', () => {
    const enKeys = collectKeys(en);
    expect(enKeys.length).toBeGreaterThan(0);
    // collectKeys only returns keys that have non-object leaf values
    // so if we got here, all values are primitives
    // But let's verify they're all strings
    function checkStringLeaves(obj: unknown): string[] {
      if (obj === null || obj === undefined || typeof obj !== 'object' || Array.isArray(obj)) {
        return [];
      }
      const nonString: string[] = [];
      for (const key of Object.keys(obj as Record<string, unknown>)) {
        const value = (obj as Record<string, unknown>)[key];
        if (typeof value === 'string') {
          // ok
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          nonString.push(...checkStringLeaves(value));
        } else {
          nonString.push(key);
        }
      }
      return nonString;
    }
    const nonString = checkStringLeaves(en);
    expect(nonString, `Non-string leaf values in en.json: ${nonString.join(', ')}`).toEqual([]);
  });

  it('every leaf value in zh-CN.json is a string', () => {
    function checkStringLeaves(obj: unknown): string[] {
      if (obj === null || obj === undefined || typeof obj !== 'object' || Array.isArray(obj)) {
        return [];
      }
      const nonString: string[] = [];
      for (const key of Object.keys(obj as Record<string, unknown>)) {
        const value = (obj as Record<string, unknown>)[key];
        if (typeof value === 'string') {
          // ok
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          nonString.push(...checkStringLeaves(value));
        } else {
          nonString.push(key);
        }
      }
      return nonString;
    }
    const nonString = checkStringLeaves(zhCN);
    expect(nonString, `Non-string leaf values in zh-CN.json: ${nonString.join(', ')}`).toEqual([]);
  });
});
