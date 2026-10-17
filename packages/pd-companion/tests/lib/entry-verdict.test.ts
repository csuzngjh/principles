import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { entryFileVerdict } from '../../src/lib/entry-verdict.js';

/**
 * PRI-1012: the update chain flips the version marker before it lays
 * pd-cli/dist/index.js, so a missing entry is a transient state of a healthy
 * install. These tests drive the real filesystem — the classification is the
 * fix, and a string scan of main.ts could not prove it.
 */

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-entry-verdict-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('entryFileVerdict — transient vs permanent (PRI-1012)', () => {
  it('accepts an existing regular file', () => {
    const file = path.join(root, 'index.js');
    fs.writeFileSync(file, 'export {}', 'utf8');
    expect(entryFileVerdict(file)).toEqual({ ok: true });
  });

  it('a not-yet-laid entry is transient, with the errno in the detail', () => {
    const missing = path.join(root, 'not-here-yet.js');
    const verdict = entryFileVerdict(missing);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.transient).toBe(true);
    expect(verdict.detail).toContain('ENOENT');
    expect(verdict.detail).toContain(missing);
  });

  it('a directory standing in for the entry is transient too', () => {
    const dir = path.join(root, 'dist');
    fs.mkdirSync(dir, { recursive: true });
    const verdict = entryFileVerdict(dir);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.transient).toBe(true);
    expect(verdict.detail).toContain('not a regular file');
  });

  it('a relative path is never worth waiting on', () => {
    const verdict = entryFileVerdict('pd-cli/dist/index.js');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.transient).toBe(false);
    expect(verdict.detail).toContain('not an absolute path');
  });

  it('a control character in the candidate is rejected as unsafe, not transient', () => {
    const verdict = entryFileVerdict(path.join(root, 'evil\n.js'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.transient).toBe(false);
    expect(verdict.detail).toContain('control characters');
  });

  it('the same path flips from transient-missing to ok once the update chain lays it', () => {
    const staged = path.join(root, 'runtime', 'pd-cli', 'dist', 'index.js');
    const before = entryFileVerdict(staged);
    expect(before.ok).toBe(false);
    if (before.ok) throw new Error('unreachable');
    expect(before.transient).toBe(true);

    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, 'export {}', 'utf8');
    expect(entryFileVerdict(staged)).toEqual({ ok: true });
  });
});
