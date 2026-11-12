/**
 * PR #2563 review round 2 regression pins.
 *
 * The ingestion section is a READ-ONLY observability layer sitting on the
 * `pd health` startup path. Two facts are pinned here through the real public
 * entry point `assessIngestionHealth` (never a reimplementation):
 *
 *  1. A throwing lower-level store reader must NOT take down the whole health
 *     report — each host degrades into a structured row with reason+nextAction.
 *  2. Codex obeys the SAME privacy ordering as WorkBuddy: without a granted
 *     consent the health surface must never locate/walk host transcript files.
 *
 * Only the single dependency under test is mocked; every other reader stays
 * the production one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockListCheckpoints,
  mockLocateCodexTranscript,
} = vi.hoisted(() => ({
  mockListCheckpoints: vi.fn(),
  mockLocateCodexTranscript: vi.fn(),
}));

vi.mock('@principles/host-runtime', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, listGovernanceCheckpoints: mockListCheckpoints };
});

vi.mock('@principles/codex-adapter', () => ({
  locateCodexTranscriptByRolloutIdentity: mockLocateCodexTranscript,
}));

import { assessIngestionHealth, formatIngestionHealthLines } from '../../src/commands/health-ingestion.js';

const WORKSPACE = 'D:/synthetic-ingestion-workspace';
const HOME = 'D:/synthetic-ingestion-home';

beforeEach(() => {
  mockListCheckpoints.mockReset();
  mockLocateCodexTranscript.mockReset();
});

describe('ingestion section failure isolation (PR #2563 review round 2)', () => {
  it('never lets a throwing store reader escape into the main health report', async () => {
    mockListCheckpoints.mockImplementation(() => {
      throw new Error('SQLITE_CORRUPT: simulated store failure');
    });
    mockLocateCodexTranscript.mockReturnValue({ ok: true, sizeBytes: 2500 });

    const section = await assessIngestionHealth({ workspaceDir: WORKSPACE, home: HOME });

    // Both hosts degrade INDEPENDENTLY — one failed host does not erase the other.
    for (const host of ['codex', 'workbuddy'] as const) {
      const row = section[host];
      expect(row.status).toBe('monitored');
      expect(row.hostFlag.state).toBe('UNKNOWN');
      expect(row.consent.state).toBe('unreadable');
      expect('reason' in row.checkpoints).toBe(true);
      expect('reason' in row.liveOnly).toBe(true);
      if ('reason' in row.checkpoints) {
        expect(row.checkpoints.reason).toContain('ingestion_assessment_failed');
        expect(row.checkpoints.reason).toContain('SQLITE_CORRUPT');
        expect(row.checkpoints.nextAction.length).toBeGreaterThan(0);
      }
    }
    // The honest third-host row survives untouched.
    expect(section.openclaw.status).toBe('not_wired');
    // The text report still renders, with the diagnostic + nextAction (cli-6).
    const text = formatIngestionHealthLines(section).join('\n');
    expect(text).toContain('ingestion_assessment_failed');
    expect(text).toContain('nextAction');
  });

  it('still returns a normal summary when the same reader recovers', async () => {
    mockListCheckpoints.mockReturnValue({ ok: true, checkpoints: [] });
    mockLocateCodexTranscript.mockReturnValue({ ok: true, sizeBytes: 2500 });

    const section = await assessIngestionHealth({ workspaceDir: WORKSPACE, home: HOME });
    expect(section.codex.checkpoints).toMatchObject({ total: 0 });
    expect(section.workbuddy.checkpoints).toMatchObject({ total: 0 });
  });

  it('does NOT locate Codex transcripts without a granted consent (privacy ordering)', async () => {
    // One real checkpoint row, and a locator that WOULD report 2500B if called.
    mockListCheckpoints.mockReturnValue({
      ok: true,
      checkpoints: [{
        hostKind: 'codex',
        rolloutIdentity: 'aaaaaaaa-0000-4000-8000-0000000000f1',
        byteOffset: 1000,
        lastOrdinal: 1,
        cliVersion: null,
        rootSessionId: 'aaaaaaaa-0000-4000-8000-0000000000f1',
        incompleteTail: false,
        lastDegradationReason: null,
        lastDegradationOrdinal: null,
        updatedAt: '2026-11-12T00:00:00.000Z',
      }],
    });
    mockLocateCodexTranscript.mockReturnValue({ ok: true, sizeBytes: 2500 });

    // No consent record for a synthetic workspace → not_present / flag_on_without_grant.
    const section = await assessIngestionHealth({ workspaceDir: WORKSPACE, home: HOME });
    expect(mockLocateCodexTranscript).not.toHaveBeenCalled();
    const checkpoints = section.codex.checkpoints;
    if ('reason' in checkpoints) throw new Error(`unexpected degraded checkpoints: ${checkpoints.reason}`);
    expect(checkpoints.lagBytes).toBeNull();
    expect(checkpoints.lagUndetectable).toBe(true);
  });
});
