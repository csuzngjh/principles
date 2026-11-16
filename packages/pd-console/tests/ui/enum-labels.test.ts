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

describe('enumLabel — Examiner categories (2026-11 F-28 rework)', () => {
  it('resolves every lane/gate/ladder value the Examiner surfaces render', () => {
    expect(enumLabel('examinerLane', 'ok')).toBe('正常');
    expect(enumLabel('examinerLane', 'degraded')).toBe('部分数据暂不可用');
    expect(enumLabel('examinerLane', 'available')).toBe('可用');
    expect(enumLabel('gateState', 'BLOCKED')).toBe('受阻');
    expect(enumLabel('gateState', 'NOT_READY')).toBe('未就绪');
    expect(enumLabel('gateState', 'NOT_STARTED')).toBe('未开始');
    expect(enumLabel('gateState', 'ACTIVE')).toBe('生效中');
    expect(enumLabel('proofLadder', 'submitted')).toBe('已提交');
    expect(enumLabel('proofLadder', 'host_accepted')).toBe('宿主已接收');
    expect(enumLabel('proofLadder', 'runtime_loaded')).toBe('运行时已加载');
    expect(enumLabel('proofLadder', 'agent_claimed')).toBe('AI 自称已遵守');
    expect(enumLabel('proofLadder', 'runtime_verified')).toBe('运行时已验证');
  });

  it('resolves activation/injection row statuses instead of leaking raw enums', () => {
    expect(enumLabel('activationStatus', 'active')).toBe('生效中');
    expect(enumLabel('activationStatus', 'deactivated')).toBe('已停用');
    expect(enumLabel('activationStatus', 'suspended_by_flag')).toBe('被功能开关暂停');
    expect(enumLabel('injectionStatus', 'model_dependent')).toBe('取决于模型');
    expect(enumLabel('injectionStatus', 'oversized')).toBe('超出预算上限');
    expect(enumLabel('injectionStatus', 'route_unconfirmed')).toBe('注入路径未确认');
    expect(enumLabel('experimentMode', 'isolated_principle')).toBe('单原则隔离');
  });

  it('never leaks an unknown injection status raw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(enumLabel('injectionStatus', 'brand-new-status')).toBe(UNKNOWN_ENUM_LABEL);
    warn.mockRestore();
  });
});
