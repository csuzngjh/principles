/**
 * Owner projection (SPEC §8.4) — read-only, parser-faithful, no inference.
 * The manifest parser already fail-closes illegal state/owner combinations,
 * so the projection's job is: exact canonical key lookup + legacy default.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import type { BackgroundExecutionRecord, InstallManifest } from '@principles/install-layout';
import { projectWorkspaceOwner } from '../../../src/services/service-host/owner-projection.js';

function record(partial: Partial<BackgroundExecutionRecord>): BackgroundExecutionRecord {
  return {
    state: 'legacy_owned',
    effectiveOwner: 'legacy',
    generation: 0,
    operationId: null,
    previousOwner: null,
    targetOwner: null,
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...partial,
  };
}

describe('projectWorkspaceOwner', () => {
  const ws = path.resolve('/ws/one');

  it('a workspace with no record is the §8.4 legacy default (generation 0)', () => {
    const manifest: InstallManifest = { layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'], workspaces: [ws] };
    const owner = projectWorkspaceOwner(manifest, ws, process.platform);
    expect(owner).toEqual({
      source: 'default_legacy',
      state: 'legacy_owned',
      effectiveOwner: 'legacy',
      generation: 0,
      operationId: null,
      previousOwner: null,
      targetOwner: null,
      updatedAt: null,
    });
  });

  it('projects each persisted state verbatim, per workspace key', () => {
    const states: BackgroundExecutionRecord['state'][] = [
      'legacy_owned',
      'handover_preparing',
      'service_host_owned',
      'rollback_pending',
    ];
    for (const state of states) {
      const rec =
        state === 'legacy_owned'
          ? record({})
          : state === 'handover_preparing'
            ? record({ state, effectiveOwner: 'legacy', generation: 2, operationId: 'op-1', previousOwner: 'legacy', targetOwner: 'service_host', updatedAt: '2026-11-20T01:00:00.000Z' })
            : state === 'rollback_pending'
              ? record({ state, effectiveOwner: 'service_host', generation: 4, operationId: 'op-2', previousOwner: 'service_host', targetOwner: 'legacy', updatedAt: '2026-11-20T02:00:00.000Z' })
              : record({ state, effectiveOwner: 'service_host', generation: 3, operationId: null, previousOwner: null, targetOwner: null, updatedAt: '2026-11-20T03:00:00.000Z' });
      const manifest: InstallManifest = {
        layoutVersion: 1,
        mode: 'canonical',
        hosts: ['openclaw'],
        workspaces: [ws],
        backgroundExecutions: { [path.resolve(ws)]: rec },
      };
      const owner = projectWorkspaceOwner(manifest, ws, process.platform);
      expect(owner.source).toBe('record');
      expect(owner.state).toBe(state);
      expect(owner.effectiveOwner).toBe(rec.effectiveOwner);
      expect(owner.generation).toBe(rec.generation);
      expect(owner.operationId).toBe(rec.operationId);
    }
  });

  it('records for OTHER workspaces never leak across the per-workspace boundary', () => {
    const other = path.resolve('/ws/two');
    const manifest: InstallManifest = {
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['openclaw'],
      workspaces: [ws, other],
      backgroundExecutions: {
        [path.resolve(other)]: record({ state: 'handover_preparing', effectiveOwner: 'legacy', generation: 7, operationId: 'op-x', previousOwner: 'legacy', targetOwner: 'service_host', updatedAt: 'x' }),
      },
    };
    // Workspace ONE stays the legacy default even though TWO is mid-handover.
    expect(projectWorkspaceOwner(manifest, ws, process.platform).state).toBe('legacy_owned');
    expect(projectWorkspaceOwner(manifest, other, process.platform).state).toBe('handover_preparing');
    expect(projectWorkspaceOwner(manifest, other, process.platform).generation).toBe(7);
  });

  it('lookup uses the SAME canonical rule as the manifest parser (api.resolve per platform)', () => {
    const dir = process.platform === 'win32' ? 'C:\\ws\\MixedCase' : '/ws/mixedcase';
    const manifest: InstallManifest = {
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['openclaw'],
      workspaces: [dir],
      backgroundExecutions: { [path.resolve(dir)]: record({ state: 'rollback_pending', effectiveOwner: 'service_host', generation: 5, operationId: 'op-r', previousOwner: 'service_host', targetOwner: 'legacy', updatedAt: 'y' }) },
    };
    expect(projectWorkspaceOwner(manifest, dir, process.platform).state).toBe('rollback_pending');
  });
});
