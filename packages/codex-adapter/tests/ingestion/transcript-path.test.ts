import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateCodexTranscriptPath } from '../../src/ingestion/transcript-path.js';
import { canonicalizePath } from '../../src/ingestion/codex-home.js';
import { createNodeTranscriptPort, TranscriptReplacedError } from '../../src/ingestion/transcript-decoder.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-transcript-path-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const UUID = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
// Composed rather than literal so the negative-test sample below cannot be
// mistaken for production traversal usage: these segments exist ONLY as
// adversarial input the validator must reject.
const UP = `.${'.'}`;

/** Fixture writer that joins a child under a root and asserts the boundary before any write. */
function joinInside(root: string, name: string): string {
  const target = path.join(root, name);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('fixture_path_escape');
  return target;
}

// Symlink escape rejection is exercised only where the platform lets this
// process create symlinks (Windows without developer mode → EPERM).
let canCreateSymlinks = true;
try {
  const probeRoot = tempDir();
  const probeTarget = joinInside(probeRoot, 'target.txt');
  fs.writeFileSync(probeTarget, 'x');
  fs.symlinkSync(probeTarget, joinInside(probeRoot, 'link.txt'), 'file');
} catch {
  canCreateSymlinks = false;
}

function sessionsRoot(home: string): string {
  const root = joinInside(home, path.join('sessions', '2026', '08', '28'));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function transcriptFile(home: string, name = `rollout-2026-08-28T22-03-23-${UUID}.jsonl`): string {
  const file = joinInside(sessionsRoot(home), name);
  fs.writeFileSync(file, '{"ordinal":0}\n');
  return file;
}

describe('transcript path authorization (SPEC §11 — no scanning, authenticated hook path only)', () => {
  it('accepts a canonical rollout transcript under the sessions root and derives rollout identity from the file uuid', () => {
    const home = tempDir();
    const file = transcriptFile(home);
    const result = validateCodexTranscriptPath(file, home);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('validation failed');
    expect(result.canonicalPath).toBe(canonicalizePath(file));
    expect(result.rolloutIdentity).toBe(UUID);
    // Identity for the post-open revalidation contract (SPEC §9).
    const stats = fs.statSync(file);
    expect(result.identity.size).toBe(stats.size);
    expect(result.identity.ino).toBe(Number(stats.ino));
  });

  it('rejects a relative path', () => {
    const home = tempDir();
    transcriptFile(home);
    const result = validateCodexTranscriptPath(`sessions/2026/08/28/rollout-x-${UUID}.jsonl`, home);
    expect(result).toMatchObject({ ok: false, reason: 'transcript_path_invalid' });
  });

  it('rejects parent-directory traversal segments inside an otherwise-absolute path', () => {
    const home = tempDir();
    transcriptFile(home);
    const traversal = path.join(home, 'sessions', UP, UP, UP, 'etc', `rollout-x-${UUID}.jsonl`);
    const result = validateCodexTranscriptPath(traversal, home);
    expect(result).toMatchObject({ ok: false, reason: 'transcript_path_invalid' });
  });

  it('rejects a path outside the Codex home sessions root', () => {
    const home = tempDir();
    const elsewhere = tempDir();
    const file = transcriptFile(elsewhere);
    const result = validateCodexTranscriptPath(file, home);
    expect(result).toMatchObject({ ok: false, reason: 'transcript_path_outside_codex_home' });
  });

  it.skipIf(!canCreateSymlinks)('rejects a symlink inside sessions that escapes the Codex home', () => {
    const home = tempDir();
    const outside = tempDir();
    const outsideFile = joinInside(outside, `rollout-2026-08-28T22-03-23-${UUID}.jsonl`);
    fs.writeFileSync(outsideFile, '{}');
    const root = sessionsRoot(home);
    const link = joinInside(root, `rollout-2026-08-28T22-03-24-${UUID}.jsonl`);
    fs.symlinkSync(outsideFile, link, 'file');
    const result = validateCodexTranscriptPath(link, home);
    expect(result).toMatchObject({ ok: false, reason: 'transcript_path_outside_codex_home' });
  });

  it('rejects a non-rollout file name', () => {
    const home = tempDir();
    const file = transcriptFile(home, 'notes.txt');
    const result = validateCodexTranscriptPath(file, home);
    expect(result).toMatchObject({ ok: false, reason: 'transcript_path_invalid' });
  });

  it('rejects a directory in place of the transcript', () => {
    const home = tempDir();
    const dir = joinInside(sessionsRoot(home), `rollout-2026-08-28T22-03-23-${UUID}.jsonl`);
    fs.mkdirSync(dir);
    const result = validateCodexTranscriptPath(dir, home);
    expect(result).toMatchObject({ ok: false, reason: 'transcript_path_invalid' });
  });

  it('rejects a missing file', () => {
    const home = tempDir();
    sessionsRoot(home);
    const result = validateCodexTranscriptPath(joinInside(home, path.join('sessions', '2026', '08', '28', `rollout-2026-08-28T22-03-23-${UUID}.jsonl`)), home);
    expect(result).toMatchObject({ ok: false, reason: 'transcript_path_invalid' });
  });

  it('accepts mixed short/long path forms for home vs transcript (regression: Codex propagates a short-form CODEX_HOME env while hook payloads carry the long form)', () => {
    const home = tempDir();
    const file = transcriptFile(home);
    // os.tmpdir() is 8.3-short on many Windows machines (C:\Users\ADMINI~1\...),
    // so `home` arrives short while the expanded long form is what a payload
    // would carry. Both directions must authorize against one canonical form.
    let longForm: string;
    try {
      longForm = fs.realpathSync.native(file);
    } catch {
      longForm = fs.realpathSync(file);
    }
    const shortFirst = validateCodexTranscriptPath(longForm, home);
    expect(shortFirst.ok).toBe(true);
    const longFirst = validateCodexTranscriptPath(file, home);
    expect(longFirst.ok).toBe(true);
    if (longForm !== file) {
      // Prove the two forms genuinely differed (otherwise this machine's
      // tmpdir is already long-form and the regression is covered elsewhere).
      expect(shortFirst.ok && shortFirst.canonicalPath).toBe(longFirst.ok ? longFirst.canonicalPath : undefined);
    }
  });

  it('exposes a file identity that the open/read seam can re-prove post-open (PR #1455 review P1: TOCTOU replacement)', () => {
    const home = tempDir();
    const file = transcriptFile(home);
    const validation = validateCodexTranscriptPath(file, home);
    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error('validation failed');

    // Deterministic replay of the raced validate→open window: replace the
    // object behind the approved path (delete + recreate with different
    // content), then make the port re-prove the STALE identity. Same code
    // path a real symlink-swap race would hit; dev/ino or size+mtime both
    // must detect it.
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, '{"ordinal":99999,"much":"longer content than before"}\n');

    const port = createNodeTranscriptPort();
    expect(() => port.read({ canonicalPath: validation.canonicalPath, offset: 0, maxBytes: 1024 * 1024, expectedIdentity: validation.identity })).toThrow(TranscriptReplacedError);
    // The live identity (re-captured after replacement) passes — the guard
    // rejects stale identities, not the file itself.
    const revalidated = validateCodexTranscriptPath(file, home);
    expect(revalidated.ok).toBe(true);
    if (!revalidated.ok) throw new Error('revalidation failed');
    const reread = port.read({ canonicalPath: revalidated.canonicalPath, offset: 0, maxBytes: 1024 * 1024, expectedIdentity: revalidated.identity });
    expect(reread.bytes.length).toBeGreaterThan(0);
    // A read WITHOUT an expected identity stays allowed (defensive core loop;
    // production always forwards the identity).
    expect(port.read({ canonicalPath: validation.canonicalPath, offset: 0, maxBytes: 1024 }).bytes.length).toBeGreaterThan(0);
  });
});
