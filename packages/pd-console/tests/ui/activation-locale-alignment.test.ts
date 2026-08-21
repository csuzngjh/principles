import { describe, expect, it } from 'vitest';
import en from '../../src/ui/i18n/en.json';
import zhCN from '../../src/ui/i18n/zh-CN.json';

describe('Activation i18n key alignment', () => {
  it('has identical checks keys in en and zh-CN', () => {
    const enChecks = Object.keys(en.pages.activation.checks).sort();
    const zhChecks = Object.keys(zhCN.pages.activation.checks).sort();
    expect(zhChecks).toEqual(enChecks);
  });

  it('has identical checkStatus keys in en and zh-CN', () => {
    const enStatus = Object.keys(en.pages.activation.checkStatus).sort();
    const zhStatus = Object.keys(zhCN.pages.activation.checkStatus).sort();
    expect(zhStatus).toEqual(enStatus);
  });

  it('has identical reasonCodes keys in en and zh-CN', () => {
    const enReasonCodes = Object.keys(en.pages.activation.reasonCodes).sort();
    const zhReasonCodes = Object.keys(zhCN.pages.activation.reasonCodes).sort();
    expect(zhReasonCodes).toEqual(enReasonCodes);
  });

  it('has non-empty translations for all activation keys', () => {
    for (const [, value] of Object.entries(en.pages.activation.checks)) {
      expect(typeof value).toBe('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
    for (const [, value] of Object.entries(zhCN.pages.activation.checks)) {
      expect(typeof value).toBe('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
    for (const [, value] of Object.entries(en.pages.activation.reasonCodes)) {
      expect(typeof value).toBe('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
    for (const [, value] of Object.entries(zhCN.pages.activation.reasonCodes)) {
      expect(typeof value).toBe('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
  });
});
