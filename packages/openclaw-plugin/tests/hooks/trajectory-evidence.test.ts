/**
 * Trajectory Evidence Builder Tests — PRI-326
 *
 * Tests the pure data extraction function buildTrajectoryEvidence
 * which reads from trajectory DB, sanitizes, and returns evidence entries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTrajectoryEvidence } from '../../src/hooks/trajectory-evidence.js';
import type { WorkspaceContext } from '../../src/core/workspace-context.js';
import type { TrajectoryDatabase } from '../../src/core/trajectory.js';

// Mock sanitizeAssistantText to avoid testing message-sanitize here
vi.mock('../../src/hooks/message-sanitize.js', () => ({
  sanitizeAssistantText: vi.fn((text: string) => text),
}));

describe('buildTrajectoryEvidence', () => {
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

  it('returns unavailable evidence when trajectory is not available', () => {
    mockWctx.trajectory = undefined;
    const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'unknown');
    expect(result).toHaveLength(1);
    expect(result[0].sourceRef).toBe('owner_message:unavailable');
    expect(result[0].note).toContain('no_trajectory_db');
  });

  it('returns unavailable evidence when sessionId is unknown', () => {
    const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'unknown');
    expect(result).toHaveLength(1);
    expect(result[0].sourceRef).toBe('owner_message:unavailable');
    expect(result[0].note).toContain('unknown_session');
  });

  it('returns last correction owner message as evidence', () => {
    const mockUserTurn = {
      createdAt: '2024-01-15T10:00:00Z',
      correctionDetected: true,
      rawExcerpt: 'Please fix this bug',
    };
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([mockUserTurn as any]);
    vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);

    const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    expect(result).toHaveLength(1);
    expect(result[0].sourceRef).toContain('owner_message:');
    expect(result[0].note).toBe('Please fix this bug');
  });

  it('handles trajectory listUserTurnsForSession throwing an error gracefully', () => {
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockImplementation(() => {
      throw new Error('Database error');
    });
    vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);

    const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    expect(result).toHaveLength(1);
    expect(result[0].sourceRef).toBe('owner_message:unavailable');
    expect(result[0].note).toContain('trajectory_user_turns_unavailable');
    expect(result[0].note).toContain('Database error');
  });

  it('returns recent assistant turns as evidence', () => {
    const mockUserTurn = {
      createdAt: '2024-01-15T10:00:00Z',
      correctionDetected: false,
      rawExcerpt: '',
    };
    const mockAssistantTurns = [
      { createdAt: '2024-01-15T09:58:00Z', sanitizedText: 'Turn 1' },
      { createdAt: '2024-01-15T09:59:00Z', sanitizedText: 'Turn 2' },
      { createdAt: '2024-01-15T10:00:00Z', sanitizedText: 'Turn 3' },
    ];
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([mockUserTurn as any]);
    vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue(mockAssistantTurns as any);

    const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    // Should have the last 3 assistant turns (MAX is 3 from core constants)
    expect(result.length).toBeGreaterThan(0);
    expect(result.some(e => e.note === 'Turn 3')).toBe(true);
  });

  it('handles trajectory listAssistantTurns throwing an error gracefully', () => {
    const mockUserTurn = {
      createdAt: '2024-01-15T10:00:00Z',
      correctionDetected: true,
      rawExcerpt: 'Last correction',
    };
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([mockUserTurn as any]);
    vi.mocked(mockTrajectory.listAssistantTurns!).mockImplementation(() => {
      throw new Error('Trajectory DB error');
    });

    const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    // Should have owner message plus error entry
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].sourceRef).toContain('owner_message:');
  });

  it('returns empty trajectory notice when no user corrections or assistant turns', () => {
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([]);
    vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);

    const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    expect(result).toHaveLength(1);
    expect(result[0].sourceRef).toBe('trajectory:empty');
    expect(result[0].note).toContain('trajectory_available_but_empty');
  });

  it('respects MAX_EVIDENCE_ENTRIES limit', () => {
    // Create many user turns with corrections
    const manyUserTurns = Array.from({ length: 10 }, (_, i) => ({
      createdAt: `2024-01-15T${String(i).padStart(2, '0')}:00:00Z`,
      correctionDetected: true,
      rawExcerpt: `Correction ${i}`,
    }));
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue(manyUserTurns as any);
    vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);

    const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    // MAX_EVIDENCE_ENTRIES from core is 5, so should be capped
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('uses last correction turn (most recent) when multiple corrections exist', () => {
    const olderCorrection = {
      createdAt: '2024-01-15T09:00:00Z',
      correctionDetected: true,
      rawExcerpt: 'Older correction',
    };
    const newerCorrection = {
      createdAt: '2024-01-15T10:00:00Z',
      correctionDetected: true,
      rawExcerpt: 'Newer correction',
    };
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([olderCorrection, newerCorrection] as any);
    vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);

    const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    // Should use the newer correction (last in reverse order)
    expect(result[0].note).toBe('Newer correction');
  });

  it('sanitizes owner message text', () => {
    const mockUserTurn = {
      createdAt: '2024-01-15T10:00:00Z',
      correctionDetected: true,
      rawExcerpt: 'Text with [EMOTIONAL_DAMAGE_DETECTED:mild] internal tags',
    };
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([mockUserTurn] as any);
    vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);

    const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    // The mock sanitizeAssistantText returns text as-is
    expect(result[0].note).toContain('Text with [EMOTIONAL_DAMAGE_DETECTED:mild] internal tags');
  });

  it('truncates long notes to MAX_EVIDENCE_NOTE_CHARS', () => {
    const longText = 'A'.repeat(10000);
    const mockUserTurn = {
      createdAt: '2024-01-15T10:00:00Z',
      correctionDetected: true,
      rawExcerpt: longText,
    };
    vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([mockUserTurn] as any);
    vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);

    const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

    // Note should be truncated to MAX_EVIDENCE_NOTE_CHARS (1000 from core)
    expect(result[0].note.length).toBeLessThanOrEqual(1000);
  });

  // ── PRI-358: Failed tool_calls evidence ────────────────────────────────────

  describe('PRI-358: failed tool_calls evidence', () => {
    it('extracts failed tool_calls as evidence entries', () => {
      vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([]);
      vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);
      vi.mocked(mockTrajectory.listToolCallsForSession!).mockReturnValue([
        { id: 1, toolName: 'bash', outcome: 'failure', errorType: 'non_zero_exit', exitCode: 1, errorMessage: 'Command failed', filePath: null, durationMs: 500, gfiBefore: null, gfiAfter: null, createdAt: '2024-01-15T10:00:00Z' },
        { id: 2, toolName: 'write_file', outcome: 'success', errorType: null, exitCode: 0, errorMessage: null, filePath: null, durationMs: 100, gfiBefore: null, gfiAfter: null, createdAt: '2024-01-15T10:01:00Z' },
        { id: 3, toolName: 'bash', outcome: 'failure', errorType: 'timeout', exitCode: 124, errorMessage: 'Timed out', filePath: null, durationMs: 30000, gfiBefore: null, gfiAfter: null, createdAt: '2024-01-15T10:02:00Z' },
      ]);

      const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

      const failureEntries = result.filter(e => e.sourceRef.startsWith('tool_call_failure:'));
      expect(failureEntries.length).toBe(2);
      expect(failureEntries[0].note).toContain('bash');
      expect(failureEntries[0].note).toContain('non_zero_exit');
      expect(failureEntries[1].note).toContain('timeout');
    });

    it('does not add tool_call_failure entries when no failures exist', () => {
      vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([]);
      vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);
      vi.mocked(mockTrajectory.listToolCallsForSession!).mockReturnValue([
        { id: 1, toolName: 'bash', outcome: 'success', errorType: null, exitCode: 0, errorMessage: null, filePath: null, durationMs: 100, gfiBefore: null, gfiAfter: null, createdAt: '2024-01-15T10:00:00Z' },
      ]);

      const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

      const failureEntries = result.filter(e => e.sourceRef.startsWith('tool_call_failure:'));
      expect(failureEntries.length).toBe(0);
    });

    it('limits failed tool_calls to 3 entries', () => {
      vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([]);
      vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);
      vi.mocked(mockTrajectory.listToolCallsForSession!).mockReturnValue([
        { id: 1, toolName: 'bash', outcome: 'failure', errorType: 'err1', exitCode: 1, errorMessage: null, filePath: null, durationMs: 100, gfiBefore: null, gfiAfter: null, createdAt: '2024-01-15T10:00:00Z' },
        { id: 2, toolName: 'bash', outcome: 'failure', errorType: 'err2', exitCode: 2, errorMessage: null, filePath: null, durationMs: 100, gfiBefore: null, gfiAfter: null, createdAt: '2024-01-15T10:01:00Z' },
        { id: 3, toolName: 'bash', outcome: 'failure', errorType: 'err3', exitCode: 3, errorMessage: null, filePath: null, durationMs: 100, gfiBefore: null, gfiAfter: null, createdAt: '2024-01-15T10:02:00Z' },
        { id: 4, toolName: 'bash', outcome: 'failure', errorType: 'err4', exitCode: 4, errorMessage: null, filePath: null, durationMs: 100, gfiBefore: null, gfiAfter: null, createdAt: '2024-01-15T10:03:00Z' },
      ]);

      const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

      const failureEntries = result.filter(e => e.sourceRef.startsWith('tool_call_failure:'));
      expect(failureEntries.length).toBe(3);
    });

    it('handles listToolCallsForSession throwing gracefully', () => {
      vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([]);
      vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);
      vi.mocked(mockTrajectory.listToolCallsForSession!).mockImplementation(() => {
        throw new Error('DB read error');
      });

      const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

      const unavailableEntry = result.find(e => e.sourceRef === 'tool_call_failure:unavailable');
      expect(unavailableEntry).toBeDefined();
      expect(unavailableEntry!.note).toContain('trajectory_tool_calls_unavailable');
    });

    it('does not add unavailable entry when other evidence exists and tool_calls throws', () => {
      const mockUserTurn = {
        createdAt: '2024-01-15T10:00:00Z',
        correctionDetected: true,
        rawExcerpt: 'Owner correction',
      };
      vi.mocked(mockTrajectory.listUserTurnsForSession!).mockReturnValue([mockUserTurn] as any);
      vi.mocked(mockTrajectory.listAssistantTurns!).mockReturnValue([]);
      vi.mocked(mockTrajectory.listToolCallsForSession!).mockImplementation(() => {
        throw new Error('DB read error');
      });

      const result = buildTrajectoryEvidence(mockWctx as WorkspaceContext, 'session-123');

      // Should have owner message but NOT a tool_call_failure:unavailable entry
      // because we already have evidence
      expect(result.some(e => e.sourceRef.startsWith('owner_message:'))).toBe(true);
      expect(result.some(e => e.sourceRef === 'tool_call_failure:unavailable')).toBe(false);
    });
  });
});