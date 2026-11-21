/**
 * Owner projection over manifest path aliases (P1-6).
 *
 * `parseWorkspaceList` dedupes workspaces[] only lexically; a symlink and
 * its target (or two Windows case spellings) can BOTH be listed and an
 * `backgroundExecutions` record may be keyed under EITHER alias. Discovery
 * groups them by realpath identity into ONE entry and must query owner
 * records for EVERY alias:
 *   - no record anywhere  → default_legacy;
 *   - a record under any single alias → that record (never silently lost);
 *   - identical records under several aliases → merged (one fact);
 *   - disagreeing records → explicit `conflicting` verdict, never a
 *     silently-picked winner.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  type BackgroundExecutionRecord,
  type HostClaimOptions,
  type HostClaimReaders,
  type HostWorkspaceClaim,
  type InstallManifest,
} from '@principles/install-layout';
import { discoverWorkspaces } from '../../../src/services/service-host/workspace-discovery.js';
import { projectWorkspaceOwnerAliases } from '../../../src/services/service-host/owner-projection.js';

const PLATFORM = process.platform;

function claimOptionsWith(readers: Partial<HostClaimReaders>, platform: string = PLATFORM): HostClaimOptions {
  return {
    homeDir: '/fakehome',
    platform,
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

function probesAllPresent() {
  return { statDir: () => 'dir' as const, realpath: (t: string) => path.resolve(t) };
}

function record(overrides: Partial<BackgroundExecutionRecord> = {}): BackgroundExecutionRecord {
  return {
    state: 'service_host_owned',
    effectiveOwner: 'service_host',
    generation: 3,
    operationId: null,
    previousOwner: null,
    targetOwner: null,
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

function manifestWithAliases(aliases: string[], records: Record<string, BackgroundExecutionRecord>): InstallManifest {
  return {
    layoutVersion: 1,
    mode: 'canonical',
    hosts: ['openclaw'],
    workspaces: aliases,
    backgroundExecutions: records,
  };
}

function entryOf(result: { workspaces: { canonicalDir: string }[] }, dir: string) {
  return result.workspaces.find((w) => path.resolve(w.canonicalDir) === path.resolve(dir));
}

/** Two manifest spellings, ONE real directory (lexical + its realpath target). */
const ALIAS = path.resolve('/ws/alias-form');
const REAL = path.resolve('/ws/real-dir');

function aliasRealpath(target: string): string {
  const resolved = path.resolve(target);
  return resolved === ALIAS ? REAL : resolved;
}

function aliasProbes() {
  return { statDir: () => 'dir' as const, realpath: aliasRealpath };
}

describe('owner records survive realpath aliasing', () => {
  it('A: a record keyed under the SECOND alias is found (the regression: first-alias lookup dropped it)', () => {
    // Manifest lists the lexical alias first; the record lives under the
    // realpath form — the realpath-deduped group previously kept only the
    // first manifestForm and projected default_legacy.
    const manifest = manifestWithAliases([ALIAS, REAL], {
      [path.resolve(REAL)]: record(),
    });
    const result = discoverWorkspaces({
      manifest,
      claims: [],
      claimOptions: claimOptionsWith({ realpath: aliasRealpath }),
      probes: aliasProbes(),
    });
    expect(result.discoveredTotal).toBe(1);
    const entry = entryOf(result, REAL);
    expect(entry?.owner.source).toBe('record');
    expect(entry?.owner.state).toBe('service_host_owned');
    expect(entry?.owner.effectiveOwner).toBe('service_host');
    expect(entry?.owner.generation).toBe(3);
    expect(entry?.verdict).not.toBe('conflicting');
  });

  it('B: a record keyed under the FIRST alias is found', () => {
    const manifest = manifestWithAliases([ALIAS, REAL], {
      [path.resolve(ALIAS)]: record({ generation: 7 }),
    });
    const result = discoverWorkspaces({
      manifest,
      claims: [],
      claimOptions: claimOptionsWith({ realpath: aliasRealpath }),
      probes: aliasProbes(),
    });
    const entry = entryOf(result, REAL);
    expect(entry?.owner.source).toBe('record');
    expect(entry?.owner.generation).toBe(7);
  });

  it('C: identical records under both aliases merge into one projection', () => {
    const shared = record();
    const manifest = manifestWithAliases([ALIAS, REAL], {
      [path.resolve(ALIAS)]: shared,
      [path.resolve(REAL)]: { ...shared },
    });
    const result = discoverWorkspaces({
      manifest,
      claims: [],
      claimOptions: claimOptionsWith({ realpath: aliasRealpath }),
      probes: aliasProbes(),
    });
    const entry = entryOf(result, REAL);
    expect(entry?.owner.source).toBe('record');
    expect(entry?.owner.state).toBe('service_host_owned');
    expect(entry?.verdict).not.toBe('conflicting');
  });

  it('D: disagreeing generations → explicit conflicting verdict, never a silent pick', () => {
    const manifest = manifestWithAliases([ALIAS, REAL], {
      [path.resolve(ALIAS)]: record({ generation: 3 }),
      [path.resolve(REAL)]: record({ generation: 9 }),
    });
    const result = discoverWorkspaces({
      manifest,
      claims: [],
      claimOptions: claimOptionsWith({ realpath: aliasRealpath }),
      probes: aliasProbes(),
    });
    const entry = entryOf(result, REAL);
    expect(entry?.verdict).toBe('conflicting');
    expect(entry?.owner.source).toBe('conflicting');
    expect(entry?.reason).toContain('workspace_owner_alias_conflict');
    expect(entry?.reason).toContain('generation');
  });

  it('E: disagreeing effectiveOwner → conflicting (legacy vs service_host)', () => {
    const manifest = manifestWithAliases([ALIAS, REAL], {
      [path.resolve(ALIAS)]: record(),
      [path.resolve(REAL)]: record({ effectiveOwner: 'legacy', state: 'legacy_owned' }),
    });
    const result = discoverWorkspaces({
      manifest,
      claims: [],
      claimOptions: claimOptionsWith({ realpath: aliasRealpath }),
      probes: aliasProbes(),
    });
    expect(entryOf(result, REAL)?.verdict).toBe('conflicting');
  });

  it('F: two aliases that resolve to DIFFERENT real dirs stay separate (no cross-merge)', () => {
    const other = path.resolve('/ws/other-real');
    const manifest = manifestWithAliases([ALIAS, other], {
      [path.resolve(other)]: record(),
    });
    const result = discoverWorkspaces({
      manifest,
      claims: [],
      claimOptions: claimOptionsWith({ realpath: aliasRealpath }),
      probes: aliasProbes(),
    });
    expect(result.discoveredTotal).toBe(2);
    expect(entryOf(result, REAL)?.owner.source).toBe('default_legacy');
    expect(entryOf(result, REAL)?.owner.state).toBe('legacy_owned');
    expect(entryOf(result, other)?.owner.source).toBe('record');
  });

  it('G: win32 case-spellings of one dir keep the record (junction/case alias)', () => {
    // path.win32.resolve produces the key form the manifest parser writes;
    // the record sits under the second spelling.
    const upper = 'C:\\Ws\\Team';
    const lower = 'c:\\ws\\team';
    const api = path.win32;
    const manifest: InstallManifest = {
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['openclaw'],
      workspaces: [upper, lower],
      backgroundExecutions: { [api.resolve(lower)]: record() },
    };
    const result = discoverWorkspaces({
      manifest,
      claims: [],
      claimOptions: claimOptionsWith(
        { realpath: (t: string) => api.resolve(t) },
        'win32',
      ),
      probes: {
        statDir: () => 'dir',
        realpath: (t: string) => api.resolve(t),
      },
    });
    expect(result.discoveredTotal).toBe(1);
    const entry = result.workspaces[0];
    expect(entry?.owner.source).toBe('record');
    expect(entry?.owner.state).toBe('service_host_owned');
    expect(entry?.verdict).not.toBe('conflicting');
  });
});

describe('projectWorkspaceOwnerAliases — direct unit semantics', () => {
  it('no record on any alias → default_legacy', () => {
    const manifest = manifestWithAliases([ALIAS, REAL], {});
    const owner = projectWorkspaceOwnerAliases(manifest, [ALIAS, REAL], PLATFORM);
    expect(owner.source).toBe('default_legacy');
    expect(owner.state).toBe('legacy_owned');
    expect(owner.effectiveOwner).toBe('legacy');
  });

  it('conflicting projection names the differing fields (generation / effectiveOwner)', () => {
    const manifest = manifestWithAliases([ALIAS, REAL], {
      [path.resolve(ALIAS)]: record({ generation: 1, effectiveOwner: 'legacy', state: 'legacy_owned' }),
      [path.resolve(REAL)]: record({ generation: 2 }),
    });
    const owner = projectWorkspaceOwnerAliases(manifest, [ALIAS, REAL], PLATFORM);
    expect(owner.source).toBe('conflicting');
    expect(owner.conflictDetail).toContain('generation');
    expect(owner.conflictDetail).toContain('effectiveOwner');
    expect(owner.conflictDetail).toContain('state');
  });

  it('a claim-only (no manifest aliases) entry keeps the conservative single-dir lookup', () => {
    const ws = path.resolve('/ws/claim-only');
    const manifest = manifestWithAliases([], {});
    const owner = projectWorkspaceOwnerAliases(manifest, [ws], PLATFORM);
    expect(owner.source).toBe('default_legacy');
  });
});
