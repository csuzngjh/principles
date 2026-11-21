/**
 * Workspace discovery — source merging, dedupe and verdict escalation
 * (SPEC §9.1 / Phase 1 admission boundary).
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import type { HostClaimOptions, HostClaimReaders, HostWorkspaceClaim, InstallManifest } from '@principles/install-layout';
import { discoverWorkspaces } from '../../../src/services/service-host/workspace-discovery.js';

const PLATFORM = process.platform;

function manifestOf(workspaces: string[]): InstallManifest {
  return { layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'], ...(workspaces.length > 0 ? { workspaces } : {}) };
}

function claimOptionsWith(readers: Partial<HostClaimReaders>): HostClaimOptions {
  return {
    homeDir: '/fakehome',
    platform: PLATFORM,
    readers: {
      readJson: () => undefined,
      listDir: () => undefined,
      realpath: (target: string) => target,
      ...readers,
    },
  };
}

function claim(host: HostWorkspaceClaim['host'], dir: string, via: HostWorkspaceClaim['via']): HostWorkspaceClaim {
  return { host, workspaceDir: path.resolve(dir), via, source: `test:${host}` };
}

function entryOf(result: { workspaces: { canonicalDir: string }[] }, dir: string): { canonicalDir: string; verdict: string; reason?: string; hosts: readonly string[] } | undefined {
  return result.workspaces.find((w) => path.resolve(w.canonicalDir) === path.resolve(dir));
}

/** Probes where every probed path is a directory except the listed missing ones. */
function probesFor(missing: string[] = [], nonDirectories: string[] = []) {
  const missingSet = new Set(missing.map((d) => path.resolve(d)));
  const otherSet = new Set(nonDirectories.map((d) => path.resolve(d)));
  return {
    statDir: (dir: string) => {
      const key = path.resolve(dir);
      if (missingSet.has(key)) return 'missing' as const;
      if (otherSet.has(key)) return 'other' as const;
      return 'dir' as const;
    },
    realpath: (target: string) => path.resolve(target),
  };
}

describe('source merging and dedupe', () => {
  it('merges a manifest workspace with its claims into ONE deduped entry', () => {
    const ws = path.resolve('/ws/a');
    const result = discoverWorkspaces({
      manifest: manifestOf([ws]),
      claims: [claim('openclaw', ws, 'payload_binding')],
      claimOptions: claimOptionsWith({}),
      probes: probesFor(),
    });
    expect(result.discoveredTotal).toBe(1);
    expect(result.workspaces[0]?.sources).toHaveLength(2);
    expect(result.workspaces[0]?.hosts).toEqual(['openclaw']);
    expect(result.workspaces[0]?.canonicalDir).toBe(ws);
  });

  it('dedupes two lexical forms that the OS resolves to one real directory', () => {
    const wsA = path.resolve('/ws/A');
    const wsB = PLATFORM === 'win32' ? wsA.toLowerCase() : path.resolve('/ws/B');
    // The fake realpath mimics the OS: one real directory behind both forms.
    const real = PLATFORM === 'win32' ? wsA.toLowerCase() : wsA;
    const result = discoverWorkspaces({
      manifest: manifestOf([wsA, wsB]),
      claims: [],
      claimOptions: claimOptionsWith({}),
      probes: { statDir: () => 'dir', realpath: (t) => (path.resolve(t) === wsB || path.resolve(t) === wsA ? real : path.resolve(t)) },
    });
    expect(result.discoveredTotal).toBe(1);
    expect(result.workspaces[0]?.sources).toHaveLength(2);
    expect(result.workspaces[0]?.canonicalDir).toBe(real);
  });

  it('dedupes a junction alias onto its realpath identity (§9.1.6)', () => {
    const lexical = path.resolve('/ws/alias');
    const real = path.resolve('/ws/real-dir');
    const result = discoverWorkspaces({
      manifest: manifestOf([lexical, real]),
      claims: [],
      claimOptions: claimOptionsWith({}),
      probes: { statDir: () => 'dir', realpath: (t) => (path.resolve(t) === lexical ? real : path.resolve(t)) },
    });
    expect(result.discoveredTotal).toBe(1);
    expect(result.workspaces).toHaveLength(1);
    // The realpath form is the entry identity; both manifest listings are evidence.
    expect(result.workspaces[0]?.canonicalDir).toBe(real);
    expect(result.workspaces[0]?.sources).toHaveLength(2);
  });

  it('keeps different directories as separate entries, validated independently', () => {
    const present = path.resolve('/ws/present');
    const missing = path.resolve('/ws/missing');
    const result = discoverWorkspaces({
      manifest: manifestOf([present, missing]),
      claims: [],
      claimOptions: claimOptionsWith({}),
      probes: probesFor([missing]),
    });
    expect(result.discoveredTotal).toBe(2);
    expect(entryOf(result, present)?.verdict).toBe('authorized');
    expect(entryOf(result, missing)?.verdict).toBe('unavailable');
    expect(result.counts.authorized).toBe(1);
    expect(result.counts.unavailable).toBe(1);
  });
});

describe('verdict escalation (registered facts vs potential locations)', () => {
  it('missing dir: manifest-listed → unavailable, default-tree claim only → discovered', () => {
    const registered = path.resolve('/ws/registered-missing');
    const defaultTree = path.resolve('/fakehome/.codex/pd-workspace');
    const result = discoverWorkspaces({
      manifest: manifestOf([registered]),
      claims: [claim('codex', defaultTree, 'default')],
      claimOptions: claimOptionsWith({}),
      probes: probesFor([registered, defaultTree]),
    });
    expect(entryOf(result, registered)?.verdict).toBe('unavailable');
    expect(entryOf(result, registered)?.reason).toBe('workspace_directory_missing');
    expect(entryOf(result, defaultTree)?.verdict).toBe('discovered');
    expect(entryOf(result, defaultTree)?.reason).toBe('default_location_not_created_yet');
  });

  it('dir present without .pd: registered → degraded, default-only → discovered', () => {
    const registered = path.resolve('/ws/registered-nopd');
    const defaultTree = path.resolve('/fakehome/.codex/pd-workspace');
    const result = discoverWorkspaces({
      manifest: manifestOf([registered]),
      claims: [claim('codex', defaultTree, 'default')],
      claimOptions: claimOptionsWith({}),
      // Both dirs exist; every <dir>/.pd probe misses (realpath form: dir + /.pd).
      probes: probesFor([`${registered}${path.sep}.pd`, `${defaultTree}${path.sep}.pd`]),
    });
    expect(entryOf(result, registered)?.verdict).toBe('degraded');
    expect(entryOf(result, registered)?.reason).toBe('workspace_state_dir_missing');
    expect(entryOf(result, defaultTree)?.verdict).toBe('discovered');
    expect(entryOf(result, defaultTree)?.reason).toBe('pd_state_dir_not_initialized');
  });

  it('non-directory path with a registered fact → unavailable (never a replacement-dir inference)', () => {
    const notADir = path.resolve('/ws/file-not-dir');
    const result = discoverWorkspaces({
      manifest: manifestOf([notADir]),
      claims: [],
      claimOptions: claimOptionsWith({}),
      probes: probesFor([], [notADir]),
    });
    expect(entryOf(result, notADir)?.verdict).toBe('unavailable');
    expect(entryOf(result, notADir)?.reason).toBe('workspace_path_not_a_directory');
  });

  it('an out-of-tree custom workspace (no claims) is authorized — manifest source alone suffices', () => {
    const ws = path.resolve('/ws/custom');
    const result = discoverWorkspaces({
      manifest: manifestOf([ws]),
      claims: [],
      claimOptions: claimOptionsWith({}),
      probes: probesFor(),
    });
    expect(entryOf(result, ws)?.verdict).toBe('authorized');
    expect(entryOf(result, ws)?.hosts).toEqual([]);
  });
});
