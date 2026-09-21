import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import tempLifecycleGlobalSetup, {
  createRunDir,
  sanitizeLabel,
  sweepStale,
  sweepE2eWorkspace,
  resolveTempRoot,
} from '../test/temp-lifecycle.mjs';

function makeBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'temp-lifecycle-test-'));
}

function ageDir(dir, days) {
  const t = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  fs.utimesSync(dir, t, t);
}

test('createRunDir creates an isolated, filesystem-safe run directory', () => {
  const base = makeBase();
  try {
    const dir = createRunDir({ base, label: '@principles/core' });
    expect(fs.existsSync(dir)).toBe(true);
    expect(path.dirname(dir)).toBe(base);
    expect(path.basename(dir)).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(path.basename(dir)).toContain('core');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('sanitizeLabel neutralizes separators and empties', () => {
  expect(sanitizeLabel('a/b\\c:d')).toBe('a-b-c-d');
  expect(sanitizeLabel(undefined)).toBe('run');
  expect(sanitizeLabel('///')).toBe('run');
});

test('sweepStale removes only stale directories and keeps fresh ones', () => {
  const base = makeBase();
  try {
    const oldDir = path.join(base, 'vitest-old-01');
    const freshDir = path.join(base, 'vitest-fresh-01');
    const strayFile = path.join(base, 'note.txt');
    fs.mkdirSync(oldDir);
    fs.mkdirSync(freshDir);
    fs.writeFileSync(strayFile, 'x');
    ageDir(oldDir, 8);

    const r = sweepStale({ base });
    expect(r.removed).toEqual(['vitest-old-01']);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(freshDir)).toBe(true);
    expect(fs.existsSync(strayFile)).toBe(true); // files are never swept by this tool
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('sweepStale refuses the system temp root and tolerates a missing base', () => {
  const refused = sweepStale({ base: os.tmpdir() });
  expect(refused.removed).toEqual([]);
  expect(refused.refused).toBe('system-temp-root');

  const missing = sweepStale({ base: path.join(makeBase(), 'not-created') });
  expect(missing.removed).toEqual([]);
  expect(missing.error).toBeUndefined(); // ENOENT is legitimately "nothing to sweep"

  const notADir = path.join(makeBase(), 'a-file');
  fs.writeFileSync(notADir, 'x');
  const blocked = sweepStale({ base: notADir });
  expect(blocked.removed).toEqual([]);
  expect(blocked.error).toBe('ENOTDIR'); // rc-9: other errors stay observable, not "nothing to sweep"
});

test('sweepStale never traverses symlinks/junctions', () => {
  const base = makeBase();
  try {
    const target = makeBase();
    const link = path.join(base, 'vitest-linked-01');
    try {
      fs.symlinkSync(target, link, 'junction');
    } catch {
      return; // symlink privilege unavailable on this machine — skip
    }
    ageDir(link, 8);
    const r = sweepStale({ base });
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(target)).toBe(true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('sweepE2eWorkspace matches timestamped residue only, never fixtures', () => {
  const repoRoot = makeBase();
  const ws = path.join(repoRoot, 'tests', 'e2e-workspace');
  fs.mkdirSync(ws, { recursive: true });
  try {
    const names = [
      'e2e-1780049707469-b07bb3b5',
      'acceptance-l3e-1786418574',
      'verify-fix-1786423073',
      'trap-03-missing-dep',
    ];
    for (const n of names) fs.mkdirSync(path.join(ws, n));
    ageDir(path.join(ws, 'e2e-1780049707469-b07bb3b5'), 8);
    ageDir(path.join(ws, 'acceptance-l3e-1786418574'), 8);
    ageDir(path.join(ws, 'verify-fix-1786423073'), 1); // fresh → kept
    ageDir(path.join(ws, 'trap-03-missing-dep'), 30); // fixture → never matched

    const r = sweepE2eWorkspace({ repoRoot });
    expect(r.removed.sort()).toEqual(['acceptance-l3e-1786418574', 'e2e-1780049707469-b07bb3b5']);
    expect(fs.existsSync(path.join(ws, 'verify-fix-1786423073'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'trap-03-missing-dep'))).toBe(true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('globalSetup redirects TMPDIR/TEMP/TMP, teardown removes run dir and restores env', async () => {
  const saved = {
    root: process.env.PD_TEST_TEMP_ROOT,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  const base = makeBase();
  // os.tmpdir() on Windows DERIVES from TMP/TEMP, so it must be captured
  // before setup overwrites the env — comparing against it afterwards is a
  // tautology, not an assertion.
  const systemTmp = path.resolve(os.tmpdir());
  try {
    process.env.PD_TEST_TEMP_ROOT = base;
    const teardown = await tempLifecycleGlobalSetup({ name: 'unit-test' });
    expect(typeof teardown).toBe('function');
    const baseResolved = path.resolve(base);
    for (const key of ['TMPDIR', 'TEMP', 'TMP']) {
      expect(path.resolve(process.env[key])).not.toBe(systemTmp);
      expect(path.resolve(process.env[key]).startsWith(baseResolved)).toBe(true);
      expect(process.env[key]).toContain('vitest-unit-test');
    }
    // mkdtemp through the redirected os.tmpdir() lands inside our run dir
    const runDir = fs.realpathSync(process.env.TEMP);
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-probe-'));
    expect(probe.startsWith(runDir)).toBe(true);

    teardown();
    expect(fs.existsSync(runDir)).toBe(false);
    expect(process.env.TEMP).toBe(saved.TEMP);
    expect(process.env.TMPDIR).toBe(saved.TMPDIR);
  } finally {
    for (const [k, v] of Object.entries({
      PD_TEST_TEMP_ROOT: saved.root,
      TMPDIR: saved.TMPDIR,
      TEMP: saved.TEMP,
      TMP: saved.TMP,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('PD_TEST_TEMP_ROOT=system disables redirection entirely', async () => {
  const savedRoot = process.env.PD_TEST_TEMP_ROOT;
  const savedTemp = process.env.TEMP;
  try {
    process.env.PD_TEST_TEMP_ROOT = 'system';
    const teardown = await tempLifecycleGlobalSetup({ name: 'unit-test' });
    expect(teardown).toBeUndefined();
    expect(process.env.TEMP).toBe(savedTemp);
    expect(resolveTempRoot()).toBeNull();
  } finally {
    if (savedRoot === undefined) delete process.env.PD_TEST_TEMP_ROOT;
    else process.env.PD_TEST_TEMP_ROOT = savedRoot;
  }
});
