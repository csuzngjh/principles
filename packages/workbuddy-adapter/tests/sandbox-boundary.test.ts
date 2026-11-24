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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  activationArtifact,
  assertInsideSandbox,
  cleanupTempDirs,
  makeGovernance,
  makeTrajectory,
  trackTempDir,
} from './helpers/workbench.js';
import type { ArtifactInput } from './helpers/workbench.js';

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

  it('rejects a junction nested inside a real sandbox directory', () => {
    const root = sandboxRoot();
    const outside = outsideDir();
    fs.mkdirSync(path.join(root, 'deep'));
    fs.symlinkSync(outside, path.join(root, 'deep', 'link'), 'junction');
    expect(() => assertInsideSandbox(path.join(root, 'deep', 'link', 'evil.db'))).toThrow(/outside the test sandbox/);
  });
});

/**
 * UNC / device-namespace refusal must be a pure-string verdict: under Windows
 * a stat of `\\host\share` can reach an SMB server (integrated-auth leak)
 * BEFORE any boundary judgment exists. These spies prove zero filesystem API
 * calls happen on the reject path — the check never gets near the network.
 */
describe('assertInsideSandbox UNC/device-path safety', () => {
  const REMOTE_OR_DEVICE = [
    '\\\\fileserver\\share\\config.yaml',
    '//fileserver/share/config.yaml',
    '\\\\?\\C:\\evil\\config.yaml',
    '\\\\?\\UNC\\fileserver\\share\\config.yaml',
    '\\\\.\\PhysicalDrive0',
  ];

  it('rejects UNC and device-namespace paths with ZERO filesystem access', () => {
    const spies = [
      vi.spyOn(fs, 'realpathSync'),
      vi.spyOn(fs.realpathSync, 'native'),
      vi.spyOn(fs, 'lstatSync'),
      vi.spyOn(fs, 'statSync'),
      vi.spyOn(fs, 'existsSync'),
      vi.spyOn(fs, 'accessSync'),
      vi.spyOn(fs, 'readdirSync'),
      vi.spyOn(fs, 'openSync'),
      vi.spyOn(fs, 'mkdirSync'),
      vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs, 'readlinkSync'),
    ];
    try {
      for (const candidate of REMOTE_OR_DEVICE) {
        expect(() => assertInsideSandbox(candidate)).toThrow(/UNC\/network|device-namespace/);
      }
      for (const spy of spies) {
        expect(spy, `${spy.getMockName()} must not be called for a refused remote/device path`).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('refuses to register a UNC path as a sandbox root', () => {
    expect(() => trackTempDir('\\\\fileserver\\share')).toThrow(/UNC\/network/);
  });
});

/**
 * Real malicious-path regression (2026-11-24 remediation): every scenario
 * plants a junction/symlink escape on an ACTUAL write target and proves the
 * helper refuses it — with an unregistered outside dir holding a decoy whose
 * SHA-256 (and the whole tree) must be byte-identical afterwards.
 */
describe('sandbox write-target escapes', () => {
  const ARTIFACT: ArtifactInput = {
    id: 'artifact-escape-probe',
    kind: 'principle',
    principleId: 'pr-escape-probe',
    content: { probe: true },
    channel: 'prompt',
    action: 'prompt_activate',
    target: 'project://escape-probe',
  };

  function sha256Of(file: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }

  /** Recursive rel-path → sha256 (files) / link target (links) / dir marker. */
  function snapshotTree(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        const rel = path.relative(dir, p);
        if (entry.isSymbolicLink()) out.set(rel, `link->${fs.readlinkSync(p)}`);
        else if (entry.isDirectory()) walk(p);
        else out.set(rel, sha256Of(p));
      }
    };
    walk(dir);
    return out;
  }

  function sandboxHome(): string {
    return trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-home-')));
  }

  /** The governance dir makeGovernance(home) resolves to. */
  function governanceDir(home: string): string {
    return path.join(home, '.workbuddy', 'pd-workspace');
  }

  function seedDecoyDb(file: string): void {
    const db = new Database(file);
    db.exec(`CREATE TABLE keepme (v TEXT); INSERT INTO keepme VALUES ('owner-data');`);
    db.close();
  }

  it('refuses makeGovernance when <governance>/.pd is a junction to an outside dir', () => {
    const home = sandboxHome();
    const outside = outsideDir();
    fs.writeFileSync(path.join(outside, 'config.yaml'), 'decoy: owner-data\n');
    const before = snapshotTree(outside);
    const governance = governanceDir(home);
    fs.mkdirSync(governance, { recursive: true });
    fs.symlinkSync(outside, path.join(governance, '.pd'), 'junction');
    expect(() => makeGovernance(home)).toThrow(/Refusing to seed/);
    expect(snapshotTree(outside)).toEqual(before);
  });

  it('refuses makeGovernance when <governance>/.pd is a junction to a non-existent outside target', () => {
    const home = sandboxHome();
    const outside = outsideDir();
    const before = snapshotTree(outside);
    const governance = governanceDir(home);
    fs.mkdirSync(governance, { recursive: true });
    fs.symlinkSync(path.join(outside, 'never-created'), path.join(governance, '.pd'), 'junction');
    expect(() => makeGovernance(home)).toThrow(/Refusing to seed/);
    expect(snapshotTree(outside)).toEqual(before);
  });

  it('refuses makeGovernance when <governance>/.pd/config.yaml is itself a link to an outside file', (ctx) => {
    const home = sandboxHome();
    const outside = outsideDir();
    const decoy = path.join(outside, 'real-config.yaml');
    fs.writeFileSync(decoy, 'decoy: real config\n');
    const governance = governanceDir(home);
    fs.mkdirSync(path.join(governance, '.pd'), { recursive: true });
    try {
      // File symlink; on hosts without link privilege this scenario is still
      // covered by the .pd junction case above.
      fs.symlinkSync(decoy, path.join(governance, '.pd', 'config.yaml'), 'file');
    } catch {
      return ctx.skip();
    }
    const before = snapshotTree(outside);
    expect(() => makeGovernance(home)).toThrow(/Refusing to seed/);
    expect(snapshotTree(outside)).toEqual(before);
  });

  it('refuses makeTrajectory when <governance>/.state is a junction to an outside dir', () => {
    const root = sandboxRoot();
    const governance = path.join(root, 'governance');
    fs.mkdirSync(governance);
    const outside = outsideDir();
    seedDecoyDb(path.join(outside, 'trajectory.db'));
    const before = snapshotTree(outside);
    fs.symlinkSync(outside, path.join(governance, '.state'), 'junction');
    expect(() => makeTrajectory(governance)).toThrow(/Refusing to seed/);
    expect(snapshotTree(outside)).toEqual(before);
  });

  it('refuses activationArtifact when <governance>/.pd/state.db resolves outside through a link', async () => {
    const root = sandboxRoot();
    const governance = path.join(root, 'governance');
    fs.mkdirSync(path.join(governance, '.pd'), { recursive: true });
    const outside = outsideDir();
    seedDecoyDb(path.join(outside, 'state.db'));
    const before = snapshotTree(outside);
    // state.db as a directory junction: the guard must resolve through it and
    // refuse BEFORE SqliteConnection's Database() could create/write the file.
    fs.symlinkSync(outside, path.join(governance, '.pd', 'state.db'), 'junction');
    await expect(activationArtifact(governance, ARTIFACT)).rejects.toThrow(/Refusing to seed/);
    expect(snapshotTree(outside)).toEqual(before);
  });

  it('refuses activationArtifact when <governance>/.pd is a junction to an outside dir holding a decoy db', async () => {
    const root = sandboxRoot();
    const governance = path.join(root, 'governance');
    fs.mkdirSync(governance);
    const outside = outsideDir();
    seedDecoyDb(path.join(outside, 'state.db'));
    const before = snapshotTree(outside);
    fs.symlinkSync(outside, path.join(governance, '.pd'), 'junction');
    await expect(activationArtifact(governance, ARTIFACT)).rejects.toThrow(/Refusing to seed/);
    expect(snapshotTree(outside)).toEqual(before);
  });

  it('still performs the normal sandboxed writes (nested dirs, config + trajectory db)', () => {
    const home = sandboxHome();
    const governance = makeGovernance(home);
    const configPath = path.join(governance, '.pd', 'config.yaml');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(() => assertInsideSandbox(configPath)).not.toThrow();
    makeTrajectory(governance);
    expect(fs.existsSync(path.join(governance, '.state', 'trajectory.db'))).toBe(true);
    const outside = outsideDir();
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
