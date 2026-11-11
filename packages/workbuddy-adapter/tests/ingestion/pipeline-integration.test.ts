/**
 * End-to-end seam integration (PRI-1171 P2): the shared host-runtime
 * pipeline driving the WorkBuddy source adapter against a real workspace
 * store — the production boundary for ticket ④ (hooks/worker wiring lands
 * in ticket ⑤).
 *
 * Proves at the real interface:
 *   - locate → bounded read → decode → ingest commits observations AND the
 *     durable workbuddy checkpoint (byte offset + synthesized ordinal);
 *   - replay converges (duplicate windows insert nothing);
 *   - an incomplete tail holds the checkpoint and later completes;
 *   - flag-off / consent-not-granted short-circuit with ZERO port calls
 *     (SPEC §10 hard privacy invariant, proven by a port spy);
 *   - a session larger than one bounded window progresses across repeated
 *     runs from the committed checkpoint (catch-up loop shape).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs, makeHome } from '../helpers/workbench.js';
import {
  runConversationIngestion,
  readGovernanceCheckpoint,
  type GovernanceCheckpointRecord,
  type TranscriptPort,
} from '@principles/host-runtime';
import { createWorkbuddyTranscriptSource } from '../../src/ingestion/transcript-source.js';

afterAll(cleanupTempDirs);

const NOW = new Date('2026-11-11T00:00:00.000Z');
const SESSION_FILE = '33333333-4444-4555-8666-777777777777.jsonl';
const SESSION_ID = SESSION_FILE.replace('.jsonl', '');

/** Containment-checked join for test writes (mirrors the production locator discipline). */
function underHome(home: string, ...segments: string[]): string {
  const target = path.join(home, ...segments);
  if (target !== home && !target.startsWith(home + path.sep)) throw new Error('test path escaped the temp home');
  return target;
}

function record(id: string, type: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ id, timestamp: 1780000000000, type, sessionId: SESSION_ID, cwd: 'd:\\Synth\\wb', ...extra })}\n`;
}

const BODY_HEAD = [
  record('cccccccc-0000-4000-8000-000000000001', 'session-meta', { meta: {} }),
  record('cccccccc-0000-4000-8000-000000000002', 'message', { role: 'user', content: [{ type: 'input_text', text: 'integration user turn' }] }),
  record('cccccccc-0000-4000-8000-000000000003', 'message', { role: 'assistant', content: [{ type: 'output_text', text: 'integration assistant turn' }], providerData: { messageId: 'msg-3', model: 'synth-model-9' } }),
  record('cccccccc-0000-4000-8000-000000000004', 'reasoning', { parentId: 'cccccccc-0000-4000-8000-000000000003', content: [{ type: 'reasoning_text', text: 'integration reasoning' }] }),
  record('cccccccc-0000-4000-8000-000000000005', 'function_call', { callId: 'chatcmpl-tool-901', name: 'Bash', arguments: '{"command":"synth"}' }),
  record('cccccccc-0000-4000-8000-000000000006', 'function_call_result', { name: 'Bash', callId: 'chatcmpl-tool-901', status: 'completed', output: { type: 'text', text: 'synth ok' } }),
].join('');

interface Fixture {
  home: string;
  workspaceDir: string;
  transcriptFile: string;
  writeBody(body: string): void;
}

function makeFixture(): Fixture {
  const home = makeHome();
  const projectDir = underHome(home, '.workbuddy', 'projects', 'd-Synth-wb');
  fs.mkdirSync(projectDir, { recursive: true });
  const transcriptFile = underHome(home, '.workbuddy', 'projects', 'd-Synth-wb', SESSION_FILE);
  const workspaceDir = fs.mkdtempSync(underHome(home, 'workspace-'));
  fs.mkdirSync(underHome(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(underHome(workspaceDir, '.state', 'trajectory.db'), '');
  return { home, workspaceDir, transcriptFile, writeBody: (body: string) => fs.writeFileSync(transcriptFile, body, 'utf8') };
}

function run(fixture: Fixture, overrides: Partial<Parameters<typeof runConversationIngestion>[0]> = {}) {
  return runConversationIngestion({
    workspaceDir: fixture.workspaceDir,
    source: createWorkbuddyTranscriptSource({ now: NOW }),
    session: { sessionId: SESSION_ID, cwd: 'd:\\Synth\\wb' },
    hints: {},
    env: { home: fixture.home },
    flags: { ingestionEnabled: true },
    consent: { decision: 'granted' },
    now: NOW,
    ...overrides,
  });
}

function checkpointOf(fixture: Fixture): GovernanceCheckpointRecord | null {
  const read = readGovernanceCheckpoint({ workspaceDir: fixture.workspaceDir, hostKind: 'workbuddy', rolloutIdentity: SESSION_ID });
  return read !== null && 'byteOffset' in read ? read : null;
}

describe('pipeline × WorkBuddy source (production boundary)', () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = makeFixture();
    fixture.writeBody(BODY_HEAD);
  });

  it('ingests the window and commits the workbuddy checkpoint', () => {
    const outcome = run(fixture);
    expect(outcome).toMatchObject({ status: 'ok', inserted: 4, lagBytes: 0 }); // paired result emits no second observation
    if (outcome.status !== 'ok') return;
    expect(outcome.sessionIdentity).toBe(SESSION_ID);
    expect(outcome.warnings).toEqual(['wb_skipped:session-meta:1']);
    const checkpoint = checkpointOf(fixture);
    expect(checkpoint).toMatchObject({ hostKind: 'workbuddy', rolloutIdentity: SESSION_ID, byteOffset: Buffer.byteLength(BODY_HEAD, 'utf8'), incompleteTail: false });
    expect(outcome.observations.map((o) => o.kind)).toEqual(['user_turn', 'assistant_turn', 'reasoning', 'tool_call']);
  });

  it('replays as a no-op — the committed checkpoint makes the second run a zero-byte window', () => {
    expect(run(fixture)).toMatchObject({ status: 'ok', inserted: 4 });
    const first = checkpointOf(fixture);
    // The byte checkpoint is already at EOF: nothing is read past it, nothing
    // is re-decoded, nothing re-inserted, and the water mark cannot move.
    expect(run(fixture)).toMatchObject({ status: 'ok', inserted: 0, duplicates: 0, lagBytes: 0 });
    expect(checkpointOf(fixture)).toEqual(first);
  });

  it('holds the checkpoint at an incomplete tail and consumes it once completed', () => {
    const tail = '{"id":"cccccccc-0000-4000-8000-000000000007","timestamp":1780000007000,"type":"mess';
    fixture.writeBody(BODY_HEAD + tail);
    const outcome = run(fixture);
    expect(outcome).toMatchObject({ status: 'ok', inserted: 4 });
    if (outcome.status !== 'ok') return;
    expect(outcome.warnings).toContain('transcript_incomplete_tail');
    expect(checkpointOf(fixture)).toMatchObject({ byteOffset: Buffer.byteLength(BODY_HEAD, 'utf8'), incompleteTail: true });
    // The host finishes flushing the record; the next run consumes it.
    fixture.writeBody(`${BODY_HEAD}${tail}age","role":"user","content":[{"type":"input_text","text":"flushed"}]}\n`);
    expect(run(fixture)).toMatchObject({ status: 'ok', inserted: 1 });
    expect(checkpointOf(fixture)).toMatchObject({ incompleteTail: false });
  });

  it('short-circuits with ZERO port calls when the flag is off (SPEC §10)', () => {
    let portCalls = 0;
    const spyPort: TranscriptPort = { read: () => { portCalls += 1; throw new Error('must not be reached'); } };
    const outcome = run(fixture, { flags: { ingestionEnabled: false }, port: spyPort });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'ingestion_disabled' });
    expect(portCalls).toBe(0);
    expect(checkpointOf(fixture)).toBeNull();
  });

  it('short-circuits with ZERO port calls when consent is not granted', () => {
    let portCalls = 0;
    const spyPort: TranscriptPort = { read: () => { portCalls += 1; throw new Error('must not be reached'); } };
    const outcome = run(fixture, { consent: { decision: 'not_present' }, port: spyPort });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'consent_not_granted:not_present' });
    expect(portCalls).toBe(0);
  });

  it('progresses a session larger than one bounded window across repeated runs', () => {
    const big = record('cccccccc-0000-4000-8000-000000000008', 'message', { role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(40) }] });
    fixture.writeBody(BODY_HEAD + big);
    const first = run(fixture, { maxBatchBytes: Buffer.byteLength(BODY_HEAD, 'utf8') - 10 });
    expect(first).toMatchObject({ status: 'ok' });
    if (first.status !== 'ok') return;
    expect(first.lagBytes).toBeGreaterThan(0);
    const second = run(fixture, { maxBatchBytes: Buffer.byteLength(BODY_HEAD, 'utf8') - 10 });
    expect(second).toMatchObject({ status: 'ok', inserted: 2, lagBytes: 0 }); // orphan result + the big record
  });
});
