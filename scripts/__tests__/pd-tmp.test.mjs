import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveTmpRoot,
  createTaskDir,
  sweep,
  driveRootAudit,
  sanitizeLabel,
} from '../dev/pd-tmp.mjs';

function makeBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tmp-test-'));
}

function ageDir(dir, days) {
  const t = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  fs.utimesSync(dir, t, t);
}

test('resolveTmpRoot derives one shared root for both layouts, override wins', () => {
  const primary = path.join(path.parse(process.cwd()).root, 'work', 'principles');
  expect(resolveTmpRoot({}, primary)).toBe(path.join(path.dirname(primary), '.pd-tmp', 'principles'));

  const worktree = path.join(path.parse(process.cwd()).root, 'work', '_worktrees', 'principles', 'PRI-1-slug');
  expect(resolveTmpRoot({}, worktree)).toBe(path.join(path.dirname(path.dirname(path.dirname(worktree))), '.pd-tmp', 'principles'));

  const override = path.join(path.parse(process.cwd()).root, 'custom-tmp');
  expect(resolveTmpRoot({ PD_TMP_ROOT: override }, primary)).toBe(override);
});

test('sanitizeLabel makes filesystem-safe names and never returns empty', () => {
  expect(sanitizeLabel('review/2367:x')).toBe('review-2367-x');
  expect(sanitizeLabel('   ')).toBe('task');
  expect(sanitizeLabel(undefined)).toBe('task');
});

test('createTaskDir isolates by date and label under the managed root', () => {
  const root = makeBase();
  try {
    const dir = createTaskDir({ root, label: 'review-2367' });
    expect(fs.existsSync(dir)).toBe(true);
    expect(path.relative(root, dir).split(path.sep)).toHaveLength(2); // <date>/<task>
    expect(path.basename(dir)).toMatch(/^task-review-2367-\d{6}-[0-9a-f]{6}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweep removes only entries past the TTL and never follows symlinks', () => {
  const root = makeBase();
  const outside = makeBase();
  try {
    const old = path.join(root, '20260101');
    const fresh = path.join(root, '20261106');
    const stray = path.join(root, 'notes.txt');
    fs.mkdirSync(old);
    fs.mkdirSync(fresh);
    fs.writeFileSync(stray, 'x');
    ageDir(old, 400);

    const link = path.join(root, '20250101');
    let linkMade = false;
    try {
      fs.symlinkSync(outside, link, 'junction');
      linkMade = true;
      ageDir(link, 400);
    } catch {
      // symlink privilege unavailable — the guard is still exercised by the
      // lstat branch, this test just cannot create the fixture
    }

    const r = sweep({ root, log: false });
    expect(r.removed).toEqual(['20260101']);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(stray)).toBe(true);
    if (linkMade) {
      expect(fs.existsSync(link)).toBe(true);
      expect(fs.existsSync(outside)).toBe(true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('sweep refuses the filesystem root and tolerates an absent root', () => {
  const fsRoot = path.parse(process.cwd()).root;
  expect(sweep({ root: fsRoot, log: false }).refused).toBe('filesystem-root');

  const parent = makeBase();
  try {
    const missing = path.join(parent, 'never-created');
    const r = sweep({ root: missing, log: false });
    expect(r.removed).toEqual([]);
    expect(r.error).toBeUndefined(); // ENOENT is legitimately "nothing to sweep"
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('driveRootAudit reports only the ad-hoc residue prefix and is read-only', () => {
  const root = makeBase();
  try {
    fs.mkdirSync(path.join(root, 'pd-review-2367'));
    fs.mkdirSync(path.join(root, 'keep-me'));
    fs.writeFileSync(path.join(root, 'pd-probe-recon.json'), '{}');

    const r = driveRootAudit({ driveRoot: root });
    expect(r.residue.map((x) => x.name).sort()).toEqual(['pd-probe-recon.json', 'pd-review-2367']);
    expect(fs.existsSync(path.join(root, 'pd-review-2367'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'pd-probe-recon.json'))).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
