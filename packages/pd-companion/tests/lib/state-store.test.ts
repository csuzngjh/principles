import { describe, it, expect } from 'vitest';
import {
  defaultCompanionState,
  markApprovalsNotified,
  markUpdateNotified,
  parseCompanionState,
  NOTIFIED_IDS_CAP,
} from '../../src/lib/state-store.js';

describe('parseCompanionState (rc-1/rc-4: validate untrusted file content)', () => {
  it('returns defaults for non-object input', () => {
    const s = parseCompanionState('nope');
    expect(s).toEqual(defaultCompanionState());
    expect(parseCompanionState(null)).toEqual(defaultCompanionState());
  });

  it('keeps valid string arrays and drops non-string elements', () => {
    const s = parseCompanionState({
      notifiedApprovalIds: ['a', 42, 'b', null],
      notifiedUpdateVersions: ['1.0.0', true],
      firstRunNoticeShown: true,
      workspaceOverride: 'D:\\ws',
    });
    expect(s.notifiedApprovalIds).toEqual(['a', 'b']);
    expect(s.notifiedUpdateVersions).toEqual(['1.0.0']);
    expect(s.firstRunNoticeShown).toBe(true);
    expect(s.workspaceOverride).toBe('D:\\ws');
  });

  it('drops workspaceOverride when empty or non-string', () => {
    expect(parseCompanionState({ workspaceOverride: '' }).workspaceOverride).toBeUndefined();
    expect(parseCompanionState({ workspaceOverride: 5 }).workspaceOverride).toBeUndefined();
  });

  it('preserves only a non-empty encrypted Console token payload for the Companion to decrypt', () => {
    expect(parseCompanionState({ encryptedConsoleToken: 'base64-ciphertext' }).encryptedConsoleToken)
      .toBe('base64-ciphertext');
    expect(parseCompanionState({ encryptedConsoleToken: '' }).encryptedConsoleToken).toBeUndefined();
    expect(parseCompanionState({ encryptedConsoleToken: 42 }).encryptedConsoleToken).toBeUndefined();
  });

  it('enforces the FIFO cap on load', () => {
    const many = Array.from({ length: NOTIFIED_IDS_CAP + 100 }, (_, i) => `id-${i}`);
    const s = parseCompanionState({ notifiedApprovalIds: many });
    expect(s.notifiedApprovalIds.length).toBe(NOTIFIED_IDS_CAP);
    expect(s.notifiedApprovalIds[0]).toBe(`id-100`);
    expect(s.notifiedApprovalIds[NOTIFIED_IDS_CAP - 1]).toBe(`id-${NOTIFIED_IDS_CAP + 99}`);
  });
});

describe('markApprovalsNotified', () => {
  it('dedupes ids already recorded and appends new ones', () => {
    let s = defaultCompanionState();
    s = markApprovalsNotified(s, ['a', 'b']);
    s = markApprovalsNotified(s, ['b', 'c']);
    expect(s.notifiedApprovalIds).toEqual(['a', 'b', 'c']);
  });

  it('caps at NOTIFIED_IDS_CAP keeping the newest (FIFO eviction)', () => {
    let s = defaultCompanionState();
    const first = Array.from({ length: NOTIFIED_IDS_CAP }, (_, i) => `old-${i}`);
    s = markApprovalsNotified(s, first);
    s = markApprovalsNotified(s, ['new-1']);
    expect(s.notifiedApprovalIds.length).toBe(NOTIFIED_IDS_CAP);
    expect(s.notifiedApprovalIds).not.toContain('old-0');
    expect(s.notifiedApprovalIds).toContain('new-1');
  });

  it('returns same state for empty input', () => {
    const s = defaultCompanionState();
    expect(markApprovalsNotified(s, [])).toBe(s);
  });
});

describe('markUpdateNotified', () => {
  it('is idempotent per version', () => {
    let s = defaultCompanionState();
    s = markUpdateNotified(s, '1.2.0');
    const again = markUpdateNotified(s, '1.2.0');
    expect(again).toBe(s);
    expect(s.notifiedUpdateVersions).toEqual(['1.2.0']);
  });
});
