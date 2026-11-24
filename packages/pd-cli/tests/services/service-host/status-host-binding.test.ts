/**
 * PRI-1278 Phase 5: a Service-Host-only install owns a workspace with NO host
 * binding. The status contract must say so explicitly instead of implying a
 * worker capability that does not exist.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toServiceHostStatusWorkspace } from '../../../src/services/service-host/scheduler/service-status.js';
import type { WorkspaceDiscoveryEntry } from '../../../src/services/service-host/workspace-discovery.js';

function entry(overrides: Partial<WorkspaceDiscoveryEntry> = {}): WorkspaceDiscoveryEntry {
  return {
    canonicalDir: path.resolve('/tmp/pd-ws'),
    verdict: 'authorized',
    hosts: [],
    sources: [{ source: 'manifest', path: path.resolve('/tmp/pd-ws') }],
    owner: { state: 'service_host_owned', effectiveOwner: 'service_host', source: 'record', generation: 1 },
    checks: { directory: 'present', stateDir: 'present', realpathResolved: true },
    ...overrides,
  };
}

describe('toServiceHostStatusWorkspace — host binding witness', () => {
  it('no claims → waiting_for_host_binding (never a fabricated adapter)', () => {
    expect(toServiceHostStatusWorkspace(entry())).toMatchObject({
      ownerState: 'service_host_owned',
      effectiveOwner: 'service_host',
      hosts: [],
      hostBindingState: 'waiting_for_host_binding',
    });
  });

  it('a validated claim → bound', () => {
    expect(toServiceHostStatusWorkspace(entry({ hosts: ['codex'] }))).toMatchObject({
      hosts: ['codex'],
      hostBindingState: 'bound',
    });
  });
});
