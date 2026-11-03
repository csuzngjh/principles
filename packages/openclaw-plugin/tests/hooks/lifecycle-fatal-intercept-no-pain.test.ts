/**
 * Pain Phase 0 — Fatal Intercept no longer creates host Pain.
 *
 * SPEC PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3 §6.3:
 * - the intercept_extraction pain_detected emission (painType tool_failure,
 *   score 100) that bypassed Evidence Triage / TriggerController was removed;
 * - the host safety interception itself is untouched (it lives in the host);
 * - the failure fact must remain observable in the pre-compaction memory note.
 *
 * Runs against a real temp workspace + real session jsonl file (ERR-025).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../src/hooks/pain.js', () => ({
  emitPainDetectedEvent: vi.fn(),
}));

import { extractPainFromSessionFile } from '../../src/hooks/lifecycle.js';
import { emitPainDetectedEvent } from '../../src/hooks/pain.js';
import { PD_DIRS } from '../../src/core/paths.js';

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fatal-intercept-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Pain Phase 0: Fatal Intercept produces no Pain but keeps its failure record', () => {
  it('hard-abort snapshot → operational note written, pain_detected NOT emitted', async () => {
    const workspaceDir = makeWorkspace();
    const sessionFile = path.join(workspaceDir, 'session.jsonl');
    const jsonl = [
      JSON.stringify({ role: 'assistant', content: 'I will modify the file directly' }),
      JSON.stringify({
        role: 'assistant',
        content: 'attempting the forbidden action',
        openclawAbort: { aborted: true, origin: 'rpc', runId: 'run-fatal-1' },
      }),
    ].join('\n');
    fs.writeFileSync(sessionFile, jsonl, 'utf8');

    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await extractPainFromSessionFile(sessionFile, {
      workspaceDir,
      sessionId: 'sess-fatal',
      logger,
    } as never);

    // 1. No Pain: the retired emit path must never fire.
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();

    // 2. Operational record preserved: the daily memory note still records
    //    the intercept observably (timestamps + verbatim signal content).
    const [dateStr] = new Date().toISOString().split('T');
    const dailyLog = path.join(workspaceDir, PD_DIRS.MEMORY, `${dateStr}.md`);
    expect(fs.existsSync(dailyLog)).toBe(true);
    const content = fs.readFileSync(dailyLog, 'utf8');
    expect(content).toContain('## [');
    expect(content).toContain('[FATAL INTERCEPT]');
    expect(content).toContain('attempting the forbidden action');
    // 3. Operational classification: the old Pain-titled sections are gone.
    expect(content).toContain('Session Operational Signals (Pre-Compaction)');
    expect(content).toContain('Operational Signals extracted from session transcript');
    expect(content).toContain('not Pain admission evidence');
    expect(content).not.toContain('Consolidated Pain');
    expect(content).not.toContain('Pain Signals');
    // 4. The review text no longer claims the signal entered the pain chain.
    expect(content).not.toContain('emitted into the Runtime V2 pain chain');
    expect(content).not.toContain('intercept_extraction');

    // 5. Safety interception fact unchanged: the extractor still logs the
    //    hard-abort snapshot detection (host-side protection unaffected).
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Detected hard-abort snapshot (runId: run-fatal-1)'),
    );
  });

  it('non-fatal sessions write nothing and emit nothing', async () => {
    const workspaceDir = makeWorkspace();
    const sessionFile = path.join(workspaceDir, 'session.jsonl');
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ role: 'assistant', content: 'all good here' }) + '\n',
      'utf8',
    );

    await extractPainFromSessionFile(sessionFile, {
      workspaceDir,
      sessionId: 'sess-ok',
    } as never);

    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
    const [dateStr] = new Date().toISOString().split('T');
    expect(fs.existsSync(path.join(workspaceDir, PD_DIRS.MEMORY, `${dateStr}.md`))).toBe(false);
  });

  it('keeps EVERY fatal intercept even when 6+ later ordinary signals would push it out of the recent-5 cap', async () => {
    const workspaceDir = makeWorkspace();
    const sessionFile = path.join(workspaceDir, 'session.jsonl');
    // Transcript order: one hard abort FIRST, then six oversized-truncation
    // ordinary signals. The plain slice(-5) cap would drop the intercept —
    // with the pain emission retired these notes are its only durable record.
    const lines = [
      JSON.stringify({ role: 'assistant', content: 'attempting the forbidden action', openclawAbort: { aborted: true, origin: 'rpc', runId: 'run-fatal-cap' } }),
      ...Array.from({ length: 6 }, (_, i) => JSON.stringify({
        role: 'assistant',
        content: `reading oversized file number ${i}`,
        __openclaw: { truncated: true, reason: 'oversized' },
      })),
    ].join('\n');
    fs.writeFileSync(sessionFile, lines, 'utf8');

    await extractPainFromSessionFile(sessionFile, {
      workspaceDir,
      sessionId: 'sess-cap',
    } as never);

    expect(emitPainDetectedEvent).not.toHaveBeenCalled();

    const [dateStr] = new Date().toISOString().split('T');
    const dailyLog = path.join(workspaceDir, PD_DIRS.MEMORY, `${dateStr}.md`);
    const content = fs.readFileSync(dailyLog, 'utf8');

    // 1. The fatal intercept survives the cap (full retention for hard aborts).
    expect(content).toContain('[FATAL INTERCEPT]');
    expect(content).toContain('attempting the forbidden action');
    // 2. Ordinary signals keep the recent-5 cap: 6 driven → the 5 most
    //    recent appear (files 1..5), the oldest ordinary one is capped out.
    const ordinaryKept = Array.from({ length: 6 }, (_, i) => content.includes(`oversized file number ${i}`));
    expect(ordinaryKept.filter(Boolean)).toHaveLength(5);
    expect(content.includes('oversized file number 0')).toBe(false);
    // 3. Still zero Pain (retirement contract unchanged by the cap fix).
    expect(content).toContain('Session Operational Signals');
  });
});
