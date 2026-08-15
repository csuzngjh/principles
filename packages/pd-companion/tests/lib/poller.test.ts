import { describe, it, expect } from 'vitest';
import {
  diffPendingApprovals,
  parseApprovalsResponse,
  parseUpdateCheckResponse,
  shouldNotifyUpdate,
} from '../../src/lib/poller.js';

describe('parseApprovalsResponse (rc-1: validate /api response)', () => {
  const validBody = {
    success: true,
    data: {
      items: [{ approvalId: 'ap-1' }, { approvalId: 'ap-2' }, { noId: true }, 'garbage'],
      stats: { pending: 2, approved: 5 },
    },
  };

  it('extracts approvalIds element-wise and pending count', () => {
    const snapshot = parseApprovalsResponse(validBody);
    expect(snapshot).toBeDefined();
    expect(snapshot?.approvalIds).toEqual(['ap-1', 'ap-2']);
    expect(snapshot?.pendingCount).toBe(2);
  });

  it('falls back to items length when stats is missing', () => {
    const snapshot = parseApprovalsResponse({ success: true, data: { items: [{ approvalId: 'x' }] } });
    expect(snapshot?.pendingCount).toBe(1);
  });

  it('returns undefined for malformed bodies (no silent "no approvals")', () => {
    expect(parseApprovalsResponse({ success: false })).toBeUndefined();
    expect(parseApprovalsResponse({ success: true, data: null })).toBeUndefined();
    expect(parseApprovalsResponse({ success: true, data: { items: 'not-array' } })).toBeUndefined();
    expect(parseApprovalsResponse('string')).toBeUndefined();
  });
});

describe('diffPendingApprovals', () => {
  it('first snapshot is a silent baseline — no notifications (locked decision)', () => {
    const diff = diffPendingApprovals({ hasBaseline: false, knownIds: new Set([]), snapshotIds: ['a', 'b'] });
    expect(diff.notifyIds).toEqual([]);
    expect(diff.baselineIds).toEqual(['a', 'b']);
  });

  it('notifies only ids not already known', () => {
    const diff = diffPendingApprovals({ hasBaseline: true, knownIds: new Set(['a', 'b']), snapshotIds: ['b', 'c'] });
    expect(diff.notifyIds).toEqual(['c']);
    expect(diff.baselineIds).toBeUndefined();
  });

  it('nothing new → empty notify list', () => {
    const diff = diffPendingApprovals({ hasBaseline: true, knownIds: new Set(['a']), snapshotIds: ['a'] });
    expect(diff.notifyIds).toEqual([]);
  });
});

describe('parseUpdateCheckResponse', () => {
  it('accepts {data:{hasUpdate,latestVersion}} envelope', () => {
    const info = parseUpdateCheckResponse({ success: true, data: { hasUpdate: true, latestVersion: '2.0.0', currentVersion: '1.0.0' } });
    expect(info).toEqual({ hasUpdate: true, latestVersion: '2.0.0' });
  });

  it('returns undefined when hasUpdate is not boolean or latestVersion is not string', () => {
    expect(parseUpdateCheckResponse({ data: { hasUpdate: 'yes' } })).toBeUndefined();
    expect(parseUpdateCheckResponse({ data: { hasUpdate: true, latestVersion: 2 } })).toBeUndefined();
    expect(parseUpdateCheckResponse('nope')).toBeUndefined();
  });
});

describe('shouldNotifyUpdate (once per version)', () => {
  it('notifies first time a version is available', () => {
    expect(shouldNotifyUpdate([], { hasUpdate: true, latestVersion: '2.0.0' })).toBe(true);
  });

  it('does not re-notify the same version (anti-noise, locked decision #4)', () => {
    expect(shouldNotifyUpdate(['2.0.0'], { hasUpdate: true, latestVersion: '2.0.0' })).toBe(false);
  });

  it('does not notify when no update or version unknown', () => {
    expect(shouldNotifyUpdate([], { hasUpdate: false, latestVersion: '9.9.9' })).toBe(false);
    expect(shouldNotifyUpdate([], { hasUpdate: true })).toBe(false);
  });
});
