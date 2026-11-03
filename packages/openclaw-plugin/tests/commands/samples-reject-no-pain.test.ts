/**
 * Pain Phase 0 — Correction Sample Reject no longer produces host Pain.
 *
 * SPEC PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3 §6.4:
 * - reject → emitPainDetectedEvent (direct diagnosis trigger) removed;
 * - reject → correction_rejected pain_events row removed (both the plugin
 *   TrajectoryDatabase writer and the core store mirror);
 * - approve/reject + reason + review status remain the learning record.
 *
 * This drives the REAL production path: real temp workspace, real
 * TrajectoryDatabase (sample mining + review), real DB assertions (ERR-025).
 * Only the pain emitter is mocked (it is the assertion target).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

vi.mock('../../src/hooks/pain.js', () => ({
  emitPainDetectedEvent: vi.fn(),
}));

import { handleSamplesCommand } from '../../src/commands/samples.js';
import { emitPainDetectedEvent } from '../../src/hooks/pain.js';
import { TrajectoryDatabase, TrajectoryRegistry } from '../../src/core/trajectory.js';
import { listCorrectionSamples } from '@principles/core/trajectory-store';

const tempDirs: string[] = [];
const prevPdWorkspaceDir = process.env.PD_WORKSPACE_DIR;

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-samples-reject-'));
  tempDirs.push(dir);
  // Pin the PD explicit workspace source so command-side resolution cannot
  // divert to a real host workspace on a dev machine (~/.openclaw config).
  process.env.PD_WORKSPACE_DIR = dir;
  return dir;
}

function mineOneSample(workspaceDir: string, sessionId: string): string {
  let sampleId = '';
  TrajectoryRegistry.use(workspaceDir, (db: TrajectoryDatabase) => {
    const assistantTurnId = db.recordAssistantTurn({
      sessionId,
      runId: 'run-reject-cmd',
      provider: 'test-provider',
      model: 'test-model',
      rawText: 'assistant output that needs correction',
      sanitizedText: 'assistant output that needs correction',
      usageJson: {},
      empathySignalJson: {},
    });
    db.recordUserTurn({
      sessionId,
      turnIndex: 1,
      rawText: 'this is wrong, fix it',
      correctionDetected: true,
      correctionCue: 'this is wrong',
      referencesAssistantTurnId: assistantTurnId,
    });
    db.recordToolCall({ sessionId, toolName: 'edit_file', outcome: 'success' });
  });
  const [sample] = listCorrectionSamples(workspaceDir);
  if (!sample) throw new Error('test setup failed: no correction sample mined');
  sampleId = sample.sampleId;
  return sampleId;
}

afterEach(() => {
  // Close registry-held DB handles before removing the temp dirs (EPERM on
  // Windows otherwise — the open better-sqlite3 file cannot be unlinked).
  for (const dir of tempDirs) {
    try {
      TrajectoryRegistry.dispose(dir);
    } catch {
      // already closed — cleanup continues regardless
    }
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (prevPdWorkspaceDir === undefined) delete process.env.PD_WORKSPACE_DIR;
  else process.env.PD_WORKSPACE_DIR = prevPdWorkspaceDir;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Pain Phase 0: /pd-samples review reject creates no Pain (production path)', () => {
  it('reject → review saved with reason, zero pain writes, zero diagnosis trigger', () => {
    const workspaceDir = makeWorkspace();
    const sessionId = 'sess-reject-cmd';
    const sampleId = mineOneSample(workspaceDir, sessionId);

    const result = handleSamplesCommand({
      args: `review reject ${sampleId} bad fix`,
      sessionId,
      sessionKey: sessionId,
      config: { workspaceDir, language: 'en' },
    } as never);

    // 1. Owner-facing outcome unchanged: the review itself succeeds.
    expect(result.text).toContain('rejected');

    // 2. No Diagnostician trigger: the direct emit was removed.
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();

    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      // 3. No pain_events row from any former writer (plugin or core mirror)
      //    — also proves no double write.
      const pain = db
        .prepare("SELECT COUNT(*) AS n FROM pain_events WHERE source = 'correction_rejected'")
        .get() as { n: number };
      expect(pain.n).toBe(0);

      // 4. Learning record intact: status + audit row with the reason.
      const sample = db
        .prepare('SELECT review_status FROM correction_samples WHERE sample_id = ?')
        .get(sampleId) as { review_status: string };
      expect(sample.review_status).toBe('rejected');
      const reviews = db
        .prepare('SELECT review_status, note FROM sample_reviews WHERE sample_id = ?')
        .all(sampleId) as Array<{ review_status: string; note: string | null }>;
      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.review_status).toBe('rejected');
      expect(reviews[0]?.note).toBe('bad fix');
    } finally {
      db.close();
    }
  });

  it('approve keeps working and also never emits pain', () => {
    const workspaceDir = makeWorkspace();
    const sessionId = 'sess-approve-cmd';
    const sampleId = mineOneSample(workspaceDir, sessionId);

    const result = handleSamplesCommand({
      args: `review approve ${sampleId} good fix`,
      sessionId,
      sessionKey: sessionId,
      config: { workspaceDir, language: 'en' },
    } as never);

    expect(result.text).toContain('approved');
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });
});
