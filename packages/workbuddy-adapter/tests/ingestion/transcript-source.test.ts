/**
 * WorkBuddy transcript-source adapter tests (PRI-1171 P2; tech design §5.1,
 * §5.4, §5.5): locate priority + authorization, and the decodeWindow
 * assembly (guard-free, compaction tombstone NEVER passed, checkpoint-seeded
 * ordinals, 50MB single-session alert).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, makeHome } from '../helpers/workbench.js';
import {
  WORKBUDDY_SINGLE_SESSION_ALERT_BYTES,
  createWorkbuddyTranscriptSource,
} from '../../src/ingestion/transcript-source.js';
import type { GovernanceCheckpointRecord } from '@principles/host-runtime';

afterAll(cleanupTempDirs);

const NOW = new Date('2026-11-11T00:00:00.000Z');
const SESSION_FILE = '22222222-3333-4444-8555-666666666666.jsonl';
const SESSION_ID = SESSION_FILE.replace('.jsonl', '');

/** Containment-checked join for test writes (mirrors the production locator discipline). */
function underHome(home: string, ...segments: string[]): string {
  const target = path.join(home, ...segments);
  if (target !== home && !target.startsWith(home + path.sep)) throw new Error('test path escaped the temp home');
  return target;
}

function makeProjectsRoot(home: string): string {
  const root = underHome(home, '.workbuddy', 'projects');
  fs.mkdirSync(underHome(root, 'd-Code-principles'), { recursive: true });
  return root;
}

function writeSessionFile(home: string, body: string): string {
  const file = underHome(home, '.workbuddy', 'projects', 'd-Code-principles', SESSION_FILE);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function source() {
  return createWorkbuddyTranscriptSource({ now: NOW });
}

describe('locate (deterministic, never scans)', () => {
  it('uses a valid hook transcript_path first and captures pre-open identity', () => {
    const home = makeHome();
    makeProjectsRoot(home);
    const file = writeSessionFile(home, '{"type":"ai-title","aiTitle":"t"}\n');
    const located = source().locate({ sessionId: SESSION_ID, cwd: 'D:\\Other' }, { transcriptPath: file }, { home });
    expect(located).toMatchObject({ status: 'ok', sessionIdentity: SESSION_ID });
    if (located.status === 'ok') {
      // The locator's contract is the NATIVE canonical path (transcript-path.ts
      // canonicalizePath), not path.resolve: on Windows the OS temp root is
      // often the 8.3 short form (C:\Users\ADMINI~1\...) and path.resolve keeps
      // it, while realpathSync.native expands it to the long form. Asserting
      // path.resolve here only passed because the vitest temp harness redirects
      // TMPDIR to a short-name-free directory.
      expect(located.filePath).toBe(fs.realpathSync.native(file));
      expect(located.expectedIdentity.size).toBe(fs.statSync(file).size);
    }
  });

  it('rejects a hinted transcript that belongs to a DIFFERENT session (identity binding)', () => {
    const home = makeHome();
    makeProjectsRoot(home);
    const otherSessionFile = '33333333-4444-4555-8666-777777777777.jsonl';
    const otherFile = underHome(home, '.workbuddy', 'projects', 'd-Code-principles', otherSessionFile);
    fs.writeFileSync(otherFile, '{"type":"ai-title","aiTitle":"other"}\n', 'utf8');
    // Same root, contract-shaped name, real file — only the identity differs.
    const located = source().locate({ sessionId: SESSION_ID, cwd: 'd:\\Code\\principles' }, { transcriptPath: otherFile }, { home });
    expect(located).toMatchObject({ status: 'degraded', reason: 'transcript_session_mismatch' });
    if (located.status === 'degraded') expect(located.nextAction).toContain('33333333-4444-4555-8666-777777777777');
  });

  it('rejects a hinted transcript when the hook carries no session id (cannot bind)', () => {
    const home = makeHome();
    makeProjectsRoot(home);
    const file = writeSessionFile(home, '{"type":"ai-title","aiTitle":"t"}\n');
    const located = source().locate({ sessionId: '  ', cwd: 'd:\\Code\\principles' }, { transcriptPath: file }, { home });
    expect(located).toMatchObject({ status: 'degraded', reason: 'transcript_session_unverified' });
  });

  it('skips an empty transcript_path (InstructionsLoaded) and falls through', () => {
    const home = makeHome();
    makeProjectsRoot(home);
    writeSessionFile(home, '{"type":"ai-title","aiTitle":"t"}\n');
    const located = source().locate({ sessionId: SESSION_ID, cwd: 'd:\\Code\\principles' }, { transcriptPath: '' }, { home });
    expect(located).toMatchObject({ status: 'ok', sessionIdentity: SESSION_ID });
  });

  it('uses agent_transcript_path when transcript_path is absent (Stop channel)', () => {
    const home = makeHome();
    makeProjectsRoot(home);
    const file = writeSessionFile(home, '{"type":"ai-title","aiTitle":"t"}\n');
    const located = source().locate({ sessionId: SESSION_ID, cwd: 'd:\\Code\\principles' }, { agentTranscriptPath: file }, { home });
    expect(located).toMatchObject({ status: 'ok' });
  });

  it('derives <projects>/<encodeCwd(cwd)>/<sessionId>.jsonl when no hint exists', () => {
    const home = makeHome();
    makeProjectsRoot(home);
    writeSessionFile(home, '{"type":"ai-title","aiTitle":"t"}\n');
    // Uppercase drive must land in the same encoded directory as the lowercase record form.
    const located = source().locate({ sessionId: SESSION_ID, cwd: 'D:\\Code\\principles' }, {}, { home });
    expect(located).toMatchObject({ status: 'ok', sessionIdentity: SESSION_ID });
  });

  it('degrades neutrally when the derived session file does not exist yet', () => {
    const home = makeHome();
    makeProjectsRoot(home);
    const located = source().locate({ sessionId: SESSION_ID, cwd: 'd:\\Code\\principles' }, {}, { home });
    expect(located).toMatchObject({ status: 'degraded', reason: 'transcript_unavailable' });
  });

  it('degrades when neither a hint nor a derivable session exists', () => {
    const home = makeHome();
    makeProjectsRoot(home);
    const located = source().locate({ sessionId: 'not-a-session-id', cwd: '' }, {}, { home });
    expect(located).toMatchObject({ status: 'degraded', reason: 'transcript_unavailable' });
  });

  it('rejects raw traversal payloads (unnormalized .. segments)', () => {
    const home = makeHome();
    makeProjectsRoot(home);
    // Raw, deliberately UNnormalized payload — path.join would collapse the
    // traversal away; the rejection path must see the literal segment.
    const traversal = `${home}${path.sep}..${path.sep}escape.jsonl`;
    const located = source().locate({ sessionId: SESSION_ID }, { transcriptPath: traversal }, { home });
    expect(located).toMatchObject({ status: 'degraded', reason: 'transcript_path_invalid' });
  });

  it('rejects paths outside the projects root', () => {
    const home = makeHome();
    makeProjectsRoot(home);
    // Contract-shaped file name OUTSIDE the root — reaches the containment check.
    const otherHome = makeHome();
    const outside = path.join(otherHome, '88888888-9999-4888-8777-666666666666.jsonl');
    fs.writeFileSync(outside, '{}', 'utf8');
    const located = source().locate({ sessionId: SESSION_ID }, { transcriptPath: outside }, { home });
    expect(located).toMatchObject({ status: 'degraded', reason: 'transcript_path_outside_projects_root' });
  });

  it('rejects non-main-session (subagent) files — P3 scope', () => {
    const home = makeHome();
    const root = makeProjectsRoot(home);
    // Contract-shaped file name NESTED under subagents/ — depth, not name, decides.
    const agentFile = underHome(root, 'd-Code-principles', SESSION_ID, 'subagents', '88888888-9999-4888-8777-666666666666.jsonl');
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(agentFile, '{}', 'utf8');
    const located = source().locate({ sessionId: SESSION_ID }, { transcriptPath: agentFile }, { home });
    expect(located).toMatchObject({ status: 'degraded', reason: 'transcript_path_not_main_session' });
  });

  it('derives a POSIX-cwd transcript inside the projects root (review P2-11)', () => {
    const home = makeHome();
    const root = underHome(home, '.workbuddy', 'projects');
    const posixDir = underHome(root, '-home-user-proj');
    fs.mkdirSync(posixDir, { recursive: true });
    fs.writeFileSync(underHome(posixDir, SESSION_FILE), '{"type":"ai-title","aiTitle":"t"}\n', 'utf8');
    const located = source().locate({ sessionId: SESSION_ID, cwd: '/home/user/proj' }, {}, { home });
    expect(located).toMatchObject({ status: 'ok', sessionIdentity: SESSION_ID });
    if (located.status === 'ok') {
      // Compare native-to-native: the locator canonicalizes both the root and
      // the file, so path.resolve(root) would mismatch under an 8.3 temp path.
      expect(path.relative(fs.realpathSync.native(root), located.filePath).startsWith('..')).toBe(false);
    }
  });

  it('rejects a POSIX-style hint that does not resolve inside this host projects root (review P2-11)', () => {
    const home = makeHome();
    makeProjectsRoot(home);
    // Deliberately foreign POSIX path: it must never be read just because the
    // file name is contract-shaped.
    const located = source().locate(
      { sessionId: SESSION_ID, cwd: '/home/user/proj' },
      { transcriptPath: `/home/user/.workbuddy/projects/-home-user-proj/${SESSION_FILE}` },
      { home },
    );
    expect(located.status).toBe('degraded');
    if (located.status === 'degraded') {
      expect(['transcript_path_invalid', 'transcript_path_outside_projects_root']).toContain(located.reason);
    }
  });

  it('rejects file names outside the <sessionId>.jsonl contract', () => {
    const home = makeHome();
    const root = makeProjectsRoot(home);
    const odd = underHome(root, 'd-Code-principles', 'session-log.txt');
    fs.writeFileSync(odd, '{}', 'utf8');
    const located = source().locate({ sessionId: SESSION_ID }, { transcriptPath: odd }, { home });
    expect(located).toMatchObject({ status: 'degraded', reason: 'transcript_path_invalid' });
  });
});

describe('decodeWindow assembly', () => {
  const BODY = [
    JSON.stringify({ type: 'session-meta', id: 'b0000000-0000-4000-8000-000000000001', sessionId: SESSION_ID, timestamp: 1780000000000, meta: {} }),
    JSON.stringify({ id: 'b0000000-0000-4000-8000-000000000002', timestamp: 1780000001000, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }),
    JSON.stringify({ id: 'b0000000-0000-4000-8000-000000000003', timestamp: 1780000002000, type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summary' }], providerData: { compactType: 'pre-message-auto', isCompacted: true, isSummary: true } }),
    '',
  ].join('\n');

  /** Locate the deterministic session file, throwing with the degradation reason on refusal. */
  function locatedOk(home: string): Extract<ReturnType<ReturnType<typeof source>['locate']>, { status: 'ok' }> {
    makeProjectsRoot(home);
    writeSessionFile(home, BODY);
    const located = source().locate({ sessionId: SESSION_ID, cwd: 'd:\\Code\\principles' }, {}, { home });
    if (located.status !== 'ok') throw new Error(`locate degraded: ${located.reason}`);
    return located;
  }

  it('never passes a compaction tombstone even when markers are present (§5.4)', () => {
    const home = makeHome();
    const located = locatedOk(home);
    const bytes = fs.readFileSync(located.filePath);
    const delta = source().decodeWindow(located, { bytes, fileOffset: 0, byteBoundReached: false, fileSize: bytes.length }, null);
    expect(delta.compactionTimestamp).toBeNull();
    expect(delta.warnings).toContain('wb_compaction_marker:1');
    // The summary record is host-authored: observable as a warning, never as an
    // Owner turn (P2 review).
    expect(delta.warnings).toContain('wb_skipped:compaction_summary:1');
    expect(delta.observations.map((o) => o.kind)).toEqual(['assistant_turn']);
  });

  it('keeps no host guard and seeds ordinals from the checkpoint', () => {
    const home = makeHome();
    const located = locatedOk(home);
    const bytes = fs.readFileSync(located.filePath);
    const checkpoint: GovernanceCheckpointRecord = {
      hostKind: 'workbuddy',
      rolloutIdentity: SESSION_ID,
      byteOffset: 0,
      lastOrdinal: 7,
      cliVersion: null,
      rootSessionId: 'root-from-checkpoint',
      incompleteTail: false,
      lastDegradationReason: null,
      lastDegradationOrdinal: null,
      updatedAt: NOW.toISOString(),
    };
    const delta = source().decodeWindow(located, { bytes, fileOffset: 0, byteBoundReached: false, fileSize: bytes.length }, checkpoint);
    expect(delta.guard).toBeNull();
    // Every consumed record (including the skipped session-meta) takes one
    // synthesized ordinal: seeded at 8, three records → last 10.
    expect(delta.lastOrdinal).toBe(10);
    expect(delta.rollout.rootSessionId).toBe('root-from-checkpoint');
    expect(delta.rollbackTurns).toEqual([]);
  });

  it('falls back to the session identity as rootSessionId without a checkpoint', () => {
    const home = makeHome();
    const located = locatedOk(home);
    const bytes = fs.readFileSync(located.filePath);
    const delta = source().decodeWindow(located, { bytes, fileOffset: 0, byteBoundReached: false, fileSize: bytes.length }, null);
    expect(delta.rollout.rootSessionId).toBe(SESSION_ID);
  });

  it('reports the 50MB single-session alert without stopping ingestion (§5.5)', () => {
    const home = makeHome();
    const located = locatedOk(home);
    const bytes = fs.readFileSync(located.filePath);
    const oversized = WORKBUDDY_SINGLE_SESSION_ALERT_BYTES + 1;
    const delta = source().decodeWindow(located, { bytes, fileOffset: 0, byteBoundReached: false, fileSize: oversized }, null);
    expect(delta.stop).toEqual({ kind: 'eof' });
    expect(delta.fileSize).toBe(oversized);
    expect(delta.warnings).toContain(`wb_transcript_oversized:${oversized}`);
  });
});
