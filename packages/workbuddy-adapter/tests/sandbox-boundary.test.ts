/**
 * assertInsideSandbox boundary regression table (2026-11-24 remediation,
 * P2): the sandbox guard must judge REAL paths — a symlink/junction/reparse
 * point sitting on an existing ancestor must not fake containment, and a
 * same-prefix sibling must not pass the way a string `startsWith` check
 * would. Anything it cannot prove safe fails closed.
 *
 * IMPORTANT: "outside" dirs are created WITHOUT trackTempDir — registering
 * them as sandbox roots would defeat the escape check (and did, in the first
 * draft of this file).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertInsideSandbox, cleanupTempDirs, trackTempDir } from './helpers/workbench.js';

const untrackedDirs: string[] = [];

function sandboxRoot(): string {
  return trackTempDir(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-sandbox-'))));
}

/** A directory that is NOT a registered sandbox root — the escape target. */
function outsideDir(prefix = 'pd-wb-outside-'): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  untrackedDirs.push(dir);
  return dir;
}

afterAll(() => {
  cleanupTempDirs();
  for (const dir of untrackedDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('assertInsideSandbox', () => {
  it('accepts a normal subdirectory of the sandbox', () => {
    const root = sandboxRoot();
    fs.mkdirSync(path.join(root, 'deep', 'dir'), { recursive: true });
    expect(() => assertInsideSandbox(path.join(root, 'deep', 'dir', 'file.db'))).not.toThrow();
    expect(() => assertInsideSandbox(root)).not.toThrow();
  });

  it('accepts a not-yet-created path under the sandbox', () => {
    const root = sandboxRoot();
    expect(() => assertInsideSandbox(path.join(root, 'future', 'file'))).not.toThrow();
  });

  it('rejects ../ traversal past the root', () => {
    const root = sandboxRoot();
    expect(() => assertInsideSandbox(path.join(root, 'sub', '..', '..', 'escape'))).toThrow(/outside the test sandbox/);
  });

  it('rejects a same-prefix sibling directory (startsWith false positive)', () => {
    const parent = outsideDir('pd-wb-pair-');
    const root = trackTempDir(path.join(parent, 'sandbox'));
    const sibling = path.join(parent, 'sandbox-evil');
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);
    expect(() => assertInsideSandbox(path.join(sibling, 'config.yaml'))).toThrow(/outside the test sandbox/);
  });

  it('rejects a symlink inside the sandbox that points outside', () => {
    const root = sandboxRoot();
    const outside = outsideDir();
    fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => assertInsideSandbox(path.join(root, 'link', 'config.yaml'))).toThrow(/outside the test sandbox/);
  });

  it('rejects a junction inside the sandbox that points outside', () => {
    const root = sandboxRoot();
    const outside = outsideDir();
    fs.symlinkSync(outside, path.join(root, 'junction'), 'junction');
    expect(() => assertInsideSandbox(path.join(root, 'junction', 'config.yaml'))).toThrow(/outside the test sandbox/);
  });

  it('rejects a dangling link (target never created) instead of trusting it', () => {
    const root = sandboxRoot();
    const outside = path.join(outsideDir(), 'never-created');
    fs.symlinkSync(outside, path.join(root, 'dangling'), 'junction');
    expect(() => assertInsideSandbox(path.join(root, 'dangling', 'config.yaml'))).toThrow(/Refusing to seed/);
  });

  it('rejects a Windows-style cross-drive path', () => {
    sandboxRoot();
    expect(() => assertInsideSandbox('D:\\other-drive\\config.yaml')).toThrow(/Refusing to seed/);
  });

  it('rejects a UNC-style external path', () => {
    sandboxRoot();
    expect(() => assertInsideSandbox('\\\\fileserver\\share\\config.yaml')).toThrow(/Refusing to seed/);
  });

  it('rejects a path whose deepest existing ancestor is an outside link', () => {
    const parent = outsideDir('pd-wb-nest-');
    const outside = outsideDir();
    fs.symlinkSync(outside, path.join(parent, 'entry'), 'dir');
    const root = sandboxRoot();
    expect(() => assertInsideSandbox(path.join(root, 'ok'))).not.toThrow();
    expect(() => assertInsideSandbox(path.join(parent, 'entry', 'config.yaml'))).toThrow(/outside the test sandbox/);
  });
});
