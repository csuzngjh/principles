/**
 * PRI-642 Scope A — typed trajectory evidence acquisition API.
 *
 * SPEC §7.2: Scope A adds a typed acquisition API that returns the
 * discriminated available/unavailable result. The legacy array API
 * (`buildTrajectoryEvidence`) remains a compatibility wrapper for automatic
 * emitters and MUST keep its exact sentinel shapes (covered separately in
 * trajectory-evidence.test.ts).
 *
 * These tests are negative-first: they fail before the typed API exists and
 * must pass after, with no placeholder evidence ever counted as available.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { acquireTrajectoryEvidence } from '../../src/hooks/trajectory-evidence.js';
import type { WorkspaceContext } from '../../src/core/workspace-context.js';
import type { TrajectoryDatabase } from '../../src/core/trajectory.js';

vi.mock('../../src/hooks/message-sanitize.js', () => ({
  sanitizeAssistantText: vi.fn((text: string) => text),
}));

describe('acquireTrajectoryEvidence — typed acquisition API (PRI-642 Scope A)', () => {
  let mockTrajectory: Partial<TrajectoryDatabase>;
  let mockWctx: Partial<WorkspaceContext>;

  beforeEach(() => {
    mockTrajectory = {
      listUserTurnsForSession: vi.fn(),
      listAssistantTurns: vi.fn(),
      listToolCallsForSession: vi.fn(),
    };
    mockWctx = {
      trajectory: mockTrajectory as TrajectoryDatabase,
      workspaceDir: '/test/workspace',
    };
  });

  it('returns available with real entries when the session has turns', () => {
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([
      { createdAt: '2026-09-01T10:00:00Z', correctionDetected: true, rawExcerpt: 'Owner correction' },
    ] as any);
    vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([
      { createdAt: '2026-09-01T10:01:00Z', sanitizedText: 'assistant text' },
    ] as any);
    vi.mocked(mockTrajectory.listToolCallsForSession!).mockReturnValue([]);

    const result = acquireTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.entries.length).toBeGreaterThan(0);
    // Every entry must be a real trace reference — no sentinel placeholders.
    for (const entry of result.entries) {
      expect(entry.sourceRef).not.toBe('owner_reported:cli');
      expect(entry.sourceRef).not.toBe('trajectory:empty');
      expect(entry.sourceRef).not.toBe('owner_message:unavailable');
    }
  });

  it('returns unavailable/session_not_found for the "unknown" sentinel session', () => {
    const result = acquireTrajectoryEvidence(mockWctx as WorkspaceContext, 'unknown');
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('session_not_found');
  });

  it('returns unavailable/session_not_found when sessionId is empty', () => {
    const result = acquireTrajectoryEvidence(mockWctx as WorkspaceContext, '');
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('session_not_found');
  });

  it('returns unavailable/trajectory_unavailable when the trajectory DB is absent', () => {
    mockWctx.trajectory = undefined;
    const result = acquireTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('trajectory_unavailable');
  });

  it('returns unavailable/empty_trajectory when the session exists but has no usable evidence', () => {
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([]);
    vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);
    vi.mocked(mockTrajectory.listToolCallsForSession!).mockReturnValue([]);

    const result = acquireTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('empty_trajectory');
  });

  it('returns unavailable/evidence_read_failed when every trajectory read throws', () => {
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockImplementation(() => {
      throw new Error('DB locked');
    });
    vi.mocked(mockTrajectory.listAssistantTurns!).mockImplementation(() => {
      throw new Error('DB locked');
    });
    vi.mocked(mockTrajectory.listToolCallsForSession!).mockImplementation(() => {
      throw new Error('DB locked');
    });

    const result = acquireTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('evidence_read_failed');
  });

  it('distinguishes unreadable trajectory from empty trajectory (SPEC 12.1 / exec-prompt item 5)', () => {
    const unreadable = acquireTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockImplementation(() => {
      throw new Error('corrupt');
    });
    vi.mocked(mockTrajectory.listAssistantTurns!).mockImplementation(() => {
      throw new Error('corrupt');
    });
    vi.mocked(mockTrajectory.listToolCallsForSession!).mockImplementation(() => {
      throw new Error('corrupt');
    });
    const failed = acquireTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    // Reset for the empty case
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([]);
    vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);
    vi.mocked(mockTrajectory.listToolCallsForSession!).mockReturnValue([]);
    const empty = acquireTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    expect(failed.status).toBe('unavailable');
    expect(empty.status).toBe('unavailable');
    if (failed.status !== 'unavailable' || empty.status !== 'unavailable') return;
    expect(failed.reasonCode).not.toBe(empty.reasonCode);
    expect(failed.reasonCode).toBe('evidence_read_failed');
    expect(empty.reasonCode).toBe('empty_trajectory');
    expect(unreadable.status).toBe('unavailable');
  });

  it('treats a partial read failure with real entries as available (partial evidence beats none)', () => {
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([
      { createdAt: '2026-09-01T10:00:00Z', correctionDetected: true, rawExcerpt: 'real correction' },
    ] as any);
    vi.mocked(mockTrajectory.listAssistantTurns!).mockImplementation(() => {
      throw new Error('partial failure');
    });
    vi.mocked(mockTrajectory.listToolCallsForSession!).mockReturnValue([]);

    const result = acquireTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.entries.some(e => e.sourceRef.startsWith('owner_message:'))).toBe(true);
  });

  it('queries the trajectory for exactly the requested session (rc-6 lineage consistency)', () => {
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([]);
    vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);

    acquireTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-target');

    expect(mockTrajectory.listUserTurnsForSession).toHaveBeenCalledWith('session-target');
    expect(mockTrajectory.listAssistantTurns).toHaveBeenCalledWith('session-target');
  });
});
