import { describe, expect, it, vi } from 'vitest';
import { enumLabel, UNKNOWN_ENUM_LABEL } from '../../src/ui/utils/enum-labels.js';

describe('enumLabel — SPEC-PD-UIUX-002 1A', () => {
  it('resolves the promotion-readiness values rendered on the activation page', () => {
    expect(enumLabel('approvalReadiness', 'ready')).toBe('可以推进');
    expect(enumLabel('approvalReadiness', 'evidence_insufficient')).toBe('证据不足');
    expect(enumLabel('approvalReadiness', 'blocked')).toBe('存在阻断项');
    expect(enumLabel('approvalReadiness', 'unavailable')).toBe('暂时无法判定');
  });

  it('never returns the raw enum value for an unknown mapping', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const label = enumLabel('evidenceState', 'some-new-machine-word');
    expect(label).toBe(UNKNOWN_ENUM_LABEL);
    expect(label).not.toBe('some-new-machine-word');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('prefers i18n when the key resolves', () => {
    const t = (key: string) => (key === 'common.enums.approvalReadiness.ready' ? '可以继续' : key);
    expect(enumLabel('approvalReadiness', 'ready', t)).toBe('可以继续');
  });

  it('falls back to the local map when i18n echoes the key', () => {
    const t = (key: string) => key;
    expect(enumLabel('approvalReadiness', 'blocked', t)).toBe('存在阻断项');
  });
});
