/**
 * ERR-168 / PRI-1282 Phase 4: install.json whole-object writers must coexist
 * with the §8.4 ownership CAS single-writer.
 *
 * The regression walks the REAL load-modify-save caller paths
 * (`mergeIntoInstallJson`, `writeInstallConfig`) against a manifest that
 * carries an ownership record written by the real transition primitive, and
 * asserts the locked sub-section survives. It also proves mutual exclusion:
 * while a transition holds the CAS lock, a writer fails LOUD instead of
 * silently writing an unlocked stale copy.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mergeIntoInstallJson, resolvePdHomePaths, writeInstallConfig } from '../src/update/install-layout.js';
import {
  acquireBackgroundExecutionCasLock,
  parseInstallManifest,
  readWorkspaceBackgroundOwnership,
  transitionWorkspaceBackgroundExecution,
} from '@principles/install-layout';

/** Test-fixture root; every derived path is checked against it (containment). */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cas-coexist-'));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function inside(root: string, name: string): string {
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`fixture path escaped its root: ${target}`);
  }
  return target;
}

function pdHomeFor(name: string): string {
  const home = inside(tmpRoot, name);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function installJson(home: string): string {
  return inside(home, 'install.json');
}

function seedManifest(home: string): string {
  const file = installJson(home);
  fs.writeFileSync(file, JSON.stringify({
    layoutVersion: 1,
    mode: 'canonical',
    hosts: ['openclaw'],
    workspaces: [],
    channel: 'stable',
  }, null, 2) + '\n', 'utf8');
  return file;
}

const wsFor = (home: string): string => inside(home, 'ws-alpha');

describe('install.json writers coexist with the §8.4 ownership CAS (ERR-168)', () => {
  it('mergeIntoInstallJson preserves an ownership record written by the transition primitive', () => {
    const home = pdHomeFor('merge');
    const file = seedManifest(home);
    const ws = wsFor(home);
    const begun = transitionWorkspaceBackgroundExecution({
      manifestPath: file, workspaceDir: ws, kind: 'provision_fresh_install', operationId: 'op-coexist-1', registerWorkspace: true,
    });
    expect(begun).toMatchObject({ ok: true });

    // The REAL caller path: a field-level merge (e.g. active release bookkeeping).
    mergeIntoInstallJson(file, { releaseMetadataUrl: 'https://example.invalid/meta.json' });

    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(raw.releaseMetadataUrl).toBe('https://example.invalid/meta.json');
    expect(parseInstallManifest(raw).manifest).toBeDefined();
    expect(readWorkspaceBackgroundOwnership({ manifestPath: file, workspaceDir: ws }))
      .toMatchObject({ status: 'service_host_owned', generation: 1 });
  });

  it('writeInstallConfig preserves the locked sub-section through its read-modify-save', () => {
    const home = pdHomeFor('config');
    const file = seedManifest(home);
    const ws = wsFor(home);
    transitionWorkspaceBackgroundExecution({
      manifestPath: file, workspaceDir: ws, kind: 'provision_fresh_install', operationId: 'op-coexist-2', registerWorkspace: true,
    });
    const paths = resolvePdHomePaths(home);
    writeInstallConfig(paths, { channel: 'candidate', autoCheck: true });

    expect(readWorkspaceBackgroundOwnership({ manifestPath: installJson(home), workspaceDir: ws }))
      .toMatchObject({ status: 'service_host_owned', generation: 1 });
    const raw = JSON.parse(fs.readFileSync(installJson(home), 'utf8')) as Record<string, unknown>;
    expect(raw.channel).toBe('candidate');
  });

  it('a writer fails LOUD while a transition holds the CAS lock — never a silent unlocked write', () => {
    const home = pdHomeFor('busy');
    const file = seedManifest(home);
    const holder = acquireBackgroundExecutionCasLock({
      manifestPath: file,
      operation: 'provision_fresh_install',
      workspaceDir: wsFor(home),
    });
    expect(holder.ok).toBe(true);
    if (!holder.ok) return;
    // The writer's bounded busy-wait retry budget is far shorter than this
    // test holds the lock, so the REAL caller path must throw loud.
    expect(() => mergeIntoInstallJson(file, { marker: 'should-not-land' })).toThrow(/write lock/);
    // The file is untouched — no partial/unlocked write happened.
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(raw.marker).toBeUndefined();
    holder.handle.release();
    // After release the same caller path succeeds.
    mergeIntoInstallJson(file, { marker: 'landed' });
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>).marker).toBe('landed');
  });
});
