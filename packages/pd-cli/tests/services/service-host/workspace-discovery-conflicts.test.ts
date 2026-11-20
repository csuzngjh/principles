/**
 * Workspace discovery — multi-host attribution and foreign containment
 * (SPEC §9.1.5; PRI-1247 misbinding shape), plus owner projection wiring
 * through discovery.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  type HostClaimOptions,
  type HostClaimReaders,
  type HostWorkspaceClaim,
  type InstallManifest,
} from '@principles/install-layout';
import { discoverWorkspaces } from '../../../src/services/service-host/workspace-discovery.js';

const PLATFORM = process.platform;

function manifestOf(workspaces: string[]): InstallManifest {
  return { layoutVersion: 1, mode: 'canonical', hosts: ['openclaw', 'codex'], ...(workspaces.length > 0 ? { workspaces } : {}) };
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

function entryOf(result: { workspaces: { canonicalDir: string }[] }, dir: string) {
  return result.workspaces.find((w) => path.resolve(w.canonicalDir) === path.resolve(dir));
}

function probesAllPresent() {
  return { statDir: () => 'dir' as const, realpath: (t: string) => path.resolve(t) };
}

describe('multi-host attribution (§9.1.5: multi-host same workspace is allowed)', () => {
  it('two payload bindings on the SAME directory → shared attribution, authorized, not a conflict', () => {
    const ws = path.resolve('/ws/shared');
    const result = discoverWorkspaces({
      manifest: manifestOf([ws]),
      claims: [claim('codex', ws, 'payload_binding'), claim('openclaw', ws, 'payload_binding')],
      claimOptions: claimOptionsWith({}),
      probes: probesAllPresent(),
    });
    expect(result.discoveredTotal).toBe(1);
    const entry = entryOf(result, ws);
    expect(entry?.verdict).toBe('authorized');
    expect(entry?.hosts).toEqual(['codex', 'openclaw']);
    expect(entry?.sources).toHaveLength(3); // manifest + 2 claims
  });

  it('claim-level attribution survives when the manifest lists nothing (claim-only workspace)', () => {
    const ws = path.resolve('/ws/claim-only');
    const result = discoverWorkspaces({
      manifest: manifestOf([]),
      claims: [claim('codex', ws, 'payload_binding')],
      claimOptions: claimOptionsWith({}),
      probes: probesAllPresent(),
    });
    expect(result.discoveredTotal).toBe(1);
    const entry = entryOf(result, ws);
    expect(entry?.verdict).toBe('authorized');
    expect(entry?.hosts).toEqual(['codex']);
    expect(entry?.owner.state).toBe('legacy_owned');
    expect(entry?.owner.source).toBe('default_legacy');
  });
});

describe('foreign containment (PRI-1247 misbinding → conflicting, fail-closed)', () => {
  it('a workspace INSIDE another host default tree is conflicting', () => {
    const openclawDefault = path.resolve('/fakehome/clawd');
    const nested = path.resolve('/fakehome/clawd/nested-ws');
    const result = discoverWorkspaces({
      manifest: manifestOf([nested]),
      claims: [claim('openclaw', openclawDefault, 'default')],
      claimOptions: claimOptionsWith({}),
      probes: probesAllPresent(),
    });
    expect(entryOf(result, nested)?.verdict).toBe('conflicting');
    expect(entryOf(result, nested)?.reason).toContain('workspace_containment_conflict');
    expect(entryOf(result, openclawDefault)?.verdict).toBe('authorized');
    expect(result.counts.conflicting).toBe(1);
  });

  it('conflicting outranks a would-be authorized verdict (fail-closed precedence)', () => {
    const openclawDefault = path.resolve('/fakehome/clawd');
    const nested = path.resolve('/fakehome/clawd/nested-ws');
    const result = discoverWorkspaces({
      manifest: manifestOf([nested]),
      claims: [
        claim('codex', nested, 'payload_binding'), // codex declares the nested dir directly
        claim('openclaw', openclawDefault, 'default'),
      ],
      claimOptions: claimOptionsWith({}),
      probes: probesAllPresent(),
    });
    expect(entryOf(result, nested)?.verdict).toBe('conflicting');
    // Only same-identity claims become host attribution; the openclaw default
    // tree is containment evidence (in the reason), not attribution.
    expect(entryOf(result, nested)?.hosts).toEqual(['codex']);
  });

  it('worktree-realpath containment: a binding whose identity reaches into a foreign tree is caught', () => {
    // The nested dir's REAL identity differs from its lexical form (a junction
    // reaching into ~/clawd). The foreign check resolves identity through the
    // SAME injected readers, so the alias must be caught there.
    const lexical = path.resolve('/ws/alias');
    const openclawDefault = path.resolve('/fakehome/clawd');
    const realInside = path.resolve('/fakehome/clawd/nested');
    const result = discoverWorkspaces({
      manifest: manifestOf([lexical]),
      claims: [claim('openclaw', openclawDefault, 'default')],
      claimOptions: claimOptionsWith({
        realpath: (t: string) => (path.resolve(t) === lexical ? realInside : path.resolve(t)),
      }),
      probes: { statDir: () => 'dir', realpath: (t: string) => (path.resolve(t) === lexical ? realInside : path.resolve(t)) },
    });
    // The entry identity is the REALPATH form (the alias resolves into the
    // foreign tree), so look the entry up by that form.
    expect(entryOf(result, realInside)?.verdict).toBe('conflicting');
  });
});

describe('same-host nesting is NOT foreign ownership (P1-5)', () => {
  it('OpenClaw parent + OpenClaw child (binding inside its own default tree) → no conflict', () => {
    const openclawDefault = path.resolve('/fakehome/clawd');
    const nested = path.resolve('/fakehome/clawd/team');
    const result = discoverWorkspaces({
      manifest: manifestOf([]),
      claims: [
        claim('openclaw', openclawDefault, 'default'),
        claim('openclaw', nested, 'payload_binding'),
      ],
      claimOptions: claimOptionsWith({}),
      probes: probesAllPresent(),
    });
    const entry = entryOf(result, nested);
    // Registered by a payload binding and .pd present → authorized,
    // NEVER conflicting: both claims belong to openclaw itself.
    expect(entry?.verdict).toBe('authorized');
    expect(entry?.reason).toBeUndefined();
    expect(entry?.hosts).toEqual(['openclaw']);
    expect(result.counts.conflicting).toBe(0);
  });

  it('Codex parent + OpenClaw child (binding inside codex tree) → real foreign conflict', () => {
    const codexDefault = path.resolve('/fakehome/.codex/pd-workspace');
    const nested = path.resolve('/fakehome/.codex/pd-workspace/team');
    const result = discoverWorkspaces({
      manifest: manifestOf([]),
      claims: [
        claim('codex', codexDefault, 'default'),
        claim('openclaw', nested, 'payload_binding'),
      ],
      claimOptions: claimOptionsWith({}),
      probes: probesAllPresent(),
    });
    const entry = entryOf(result, nested);
    expect(entry?.verdict).toBe('conflicting');
    expect(entry?.reason).toContain('workspace_containment_conflict');
    expect(entry?.reason).toContain('codex');
    // Same-identity openclaw attribution survives; codex stays a violation, not attribution.
    expect(entry?.hosts).toEqual(['openclaw']);
  });

  it('OpenClaw parent + Codex child → real foreign conflict (symmetric)', () => {
    const openclawDefault = path.resolve('/fakehome/clawd');
    const nested = path.resolve('/fakehome/clawd/team');
    const result = discoverWorkspaces({
      manifest: manifestOf([]),
      claims: [
        claim('openclaw', openclawDefault, 'default'),
        claim('codex', nested, 'payload_binding'),
      ],
      claimOptions: claimOptionsWith({}),
      probes: probesAllPresent(),
    });
    expect(entryOf(result, nested)?.verdict).toBe('conflicting');
    expect(entryOf(result, nested)?.reason).toContain('openclaw');
  });

  it('a symlink alias of a same-host claimed dir resolves to the right host attribution', () => {
    const lexical = path.resolve('/ws/alias');
    const real = path.resolve('/fakehome/clawd/team');
    const realpathMap = (t: string) => (path.resolve(t) === lexical ? real : path.resolve(t));
    const result = discoverWorkspaces({
      manifest: manifestOf([lexical]),
      claims: [claim('openclaw', real, 'payload_binding'), claim('openclaw', path.resolve('/fakehome/clawd'), 'default')],
      claimOptions: claimOptionsWith({ realpath: realpathMap }),
      probes: { statDir: () => 'dir', realpath: realpathMap },
    });
    // One real dir: the alias joins the openclaw-claimed group, hosts correct.
    expect(result.discoveredTotal).toBeGreaterThanOrEqual(1);
    const entry = entryOf(result, real);
    expect(entry?.verdict).not.toBe('conflicting');
    expect(entry?.hosts).toEqual(['openclaw']);
  });

  it('a manifest-only workspace keeps the conservative all-hosts foreign scan', () => {
    const openclawDefault = path.resolve('/fakehome/clawd');
    const orphan = path.resolve('/fakehome/clawd/orphan');
    const result = discoverWorkspaces({
      manifest: manifestOf([orphan]),
      claims: [claim('openclaw', openclawDefault, 'default')],
      claimOptions: claimOptionsWith({}),
      probes: probesAllPresent(),
    });
    expect(entryOf(result, orphan)?.verdict).toBe('conflicting');
    expect(entryOf(result, orphan)?.reason).toContain('workspace_containment_conflict');
  });
});

describe('owner projection through discovery', () => {
  it('a record keyed to the manifest form projects onto the deduped entry; absent records default to legacy', () => {
    const ws = path.resolve('/ws/owned');
    const manifest: InstallManifest = {
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['openclaw'],
      workspaces: [ws],
      backgroundExecutions: {
        [path.resolve(ws)]: {
          state: 'service_host_owned',
          effectiveOwner: 'service_host',
          generation: 3,
          operationId: null,
          previousOwner: null,
          targetOwner: null,
          updatedAt: '2026-11-20T00:00:00.000Z',
        },
      },
    };
    const result = discoverWorkspaces({
      manifest,
      claims: [],
      claimOptions: claimOptionsWith({}),
      probes: probesAllPresent(),
    });
    const entry = entryOf(result, ws);
    expect(entry?.owner.state).toBe('service_host_owned');
    expect(entry?.owner.generation).toBe(3);
    expect(entry?.owner.source).toBe('record');
  });
});
