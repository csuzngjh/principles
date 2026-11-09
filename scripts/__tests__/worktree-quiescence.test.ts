// PRI-1143 Owner review P1-1: deletion of a quarantined worktree requires a
// positive proof that no process still holds anything inside it. These cases
// exercise the real mechanisms on real filesystem state:
//   linux  -> /proc scan (this process's own descriptors are part of the scan)
//   win32  -> rename probe (any open handle in the subtree blocks the rename)
// and the fail-closed answer on platforms with no inspection mechanism.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proveQuarantineQuiescent } from '../dev/lib/quiescence.mjs';
import { makeTempDir, removeFixture } from './dev-worktree-test-utils';

const supported = process.platform === 'linux' || process.platform === 'win32';

let root: string;
let quarantineParent: string;
let quarantinePath: string;

beforeEach(() => {
  root = makeTempDir('pd-quiescence-');
  quarantineParent = path.join(root, '.pd-worktree-cleanup-test');
  quarantinePath = path.join(quarantineParent, 'worktree');
  fs.mkdirSync(path.join(quarantinePath, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(quarantinePath, 'sub', 'deep', 'notes.txt'), 'data\n', 'utf-8');
});

afterEach(() => {
  removeFixture(root);
});

describe.skipIf(!supported)('proveQuarantineQuiescent on a supported platform', () => {
  it('proves an idle tree quiescent', () => {
    const result = proveQuarantineQuiescent({ quarantinePath, quarantineParent });
    expect(result.proven, result.reason).toBe(true);
    expect(result.mechanism).toBe(process.platform === 'linux' ? 'linux-procfs' : 'win32-rename-probe');
  });

  it('refuses while a file deep inside the tree is held open, and proves it once closed', () => {
    const held = path.join(quarantinePath, 'sub', 'deep', 'notes.txt');
    const fd = fs.openSync(held, 'r+');
    try {
      const result = proveQuarantineQuiescent({ quarantinePath, quarantineParent });
      expect(result.proven).toBe(false);
      if (process.platform === 'linux') {
        // This very process is found holding the descriptor.
        expect(result.holders?.some((h) => h.pid === process.pid && h.kind === 'fd')).toBe(true);
      } else {
        expect(result.reason).toContain('handle');
      }
    } finally {
      fs.closeSync(fd);
    }
    expect(proveQuarantineQuiescent({ quarantinePath, quarantineParent }).proven).toBe(true);
  });

  it('refuses while a directory handle is open inside the tree', () => {
    const handle = fs.opendirSync(path.join(quarantinePath, 'sub'));
    try {
      expect(proveQuarantineQuiescent({ quarantinePath, quarantineParent }).proven).toBe(false);
    } finally {
      handle.closeSync();
    }
  });

  it('refuses while a process working directory is inside the tree', (ctx) => {
    const previous = process.cwd();
    try {
      process.chdir(path.join(quarantinePath, 'sub', 'deep'));
    } catch {
      ctx.skip(); // worker threads cannot chdir; the forks pool can
    }
    try {
      const result = proveQuarantineQuiescent({ quarantinePath, quarantineParent });
      expect(result.proven).toBe(false);
      if (process.platform === 'linux') {
        expect(result.holders?.some((h) => h.pid === process.pid && h.kind === 'cwd')).toBe(true);
      }
    } finally {
      process.chdir(previous);
    }
  });

  it.skipIf(process.platform !== 'win32')('the Windows rename probe leaves the tree exactly where it was', () => {
    const before = fs.lstatSync(quarantineParent, { bigint: true });
    const result = proveQuarantineQuiescent({ quarantinePath, quarantineParent });
    expect(result.proven).toBe(true);
    const after = fs.lstatSync(quarantineParent, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(fs.existsSync(quarantineParent + '.quiescence-probe')).toBe(false);
    expect(fs.readFileSync(path.join(quarantinePath, 'sub', 'deep', 'notes.txt'), 'utf-8')).toBe('data\n');
  });
});

describe('proveQuarantineQuiescent without an inspection mechanism', () => {
  it('never proves quiescence, so the caller must refuse (fail-closed)', () => {
    const result = proveQuarantineQuiescent({ quarantinePath, quarantineParent, platform: 'darwin' });
    expect(result.proven).toBe(false);
    expect(result.mechanism).toBe('unsupported');
    expect(result.reason).toContain('darwin');
    // And it touched nothing.
    expect(fs.readFileSync(path.join(quarantinePath, 'sub', 'deep', 'notes.txt'), 'utf-8')).toBe('data\n');
  });
});
