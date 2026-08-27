import { describe, expect, it } from 'vitest';
import { decideHostCoordination, type HostObservation } from '../src/update/rollback-policy.js';
import { evaluateDataCompatibility } from '../src/update/data-compatibility.js';
import { buildReleaseMetadata, type ReleaseMetadata } from '../src/update/release-metadata.js';

const expiresFar = '2030-01-01T00:00:00Z';

function release(productVersion: string, readsBackTo: string): ReleaseMetadata {
  return buildReleaseMetadata({
    productVersion,
    sourceCommit: '1234567890abcdef1234567890abcdef12345678',
    minBootstrapVersion: '1.0.0',
    publicationSequence: 10,
    expiresAt: expiresFar,
    assets: [{
      platform: 'win32', arch: 'x64', nodeAbi: '147',
      archiveSha256: 'a'.repeat(64), archiveSizeBytes: 1024,
    }],
    dataSchemaForwardReadableFrom: readsBackTo,
  });
}

function host(hostId: string, wasRunning: boolean, outcome: HostObservation['outcome']): HostObservation {
  return { hostId, wasRunningBeforeActivation: wasRunning, outcome };
}

describe('host coordination and rollback policy (SPEC 9 / 18-5)', () => {
  it('confirms when every previously running host passes the handshake', () => {
    const decision = decideHostCoordination({
      observations: [
        host('openclaw-gateway', true, { kind: 'passed' }),
        host('pd-console', true, { kind: 'passed' }),
        host('companion', false, { kind: 'not_restarted' }),
      ],
      autoRollbackAlreadyUsed: false,
    });
    expect(decision.action).toBe('confirm');
  });

  it('ignores hosts that were already stopped before activation', () => {
    const decision = decideHostCoordination({
      observations: [host('companion', false, { kind: 'failed', failureClass: 'deterministic_start_failure', detail: 'crash' })],
      autoRollbackAlreadyUsed: false,
    });
    expect(decision.action).toBe('confirm');
  });

  it('rolls back ALL affected hosts once when any running host fails deterministically (no split brain)', () => {
    const decision = decideHostCoordination({
      observations: [
        host('openclaw-gateway', true, { kind: 'passed' }),
        host('pd-console', true, { kind: 'failed', failureClass: 'handshake_mismatch', detail: 'wrong release' }),
      ],
      autoRollbackAlreadyUsed: false,
    });
    expect(decision.action).toBe('auto_rollback');
    if (decision.action === 'auto_rollback') {
      expect(decision.hosts).toEqual(['pd-console']);
      expect(decision.reason).toMatch(/split brain/i);
    }
  });

  it('does NOT roll back for network or external-service failures', () => {
    for (const failureClass of ['network_unavailable', 'external_service_unavailable'] as const) {
      const decision = decideHostCoordination({
        observations: [host('openclaw-gateway', true, { kind: 'failed', failureClass, detail: 'timeout' })],
        autoRollbackAlreadyUsed: false,
      });
      expect(decision.action, failureClass).toBe('retry_handshake');
      if (decision.action === 'retry_handshake') {
        expect(decision.reason).toMatch(/do not qualify/i);
      }
    }
  });

  it('opens the circuit breaker on a second deterministic failure after one automatic rollback', () => {
    const decision = decideHostCoordination({
      observations: [host('pd-console', true, { kind: 'failed', failureClass: 'deterministic_start_failure', detail: 'crash again' })],
      autoRollbackAlreadyUsed: true,
    });
    expect(decision.action).toBe('circuit_breaker_open');
    if (decision.action === 'circuit_breaker_open') {
      expect(decision.nextAction).toMatch(/last confirmed release remains active/i);
    }
  });

  it('holds for still-restarting hosts instead of deciding prematurely', () => {
    const decision = decideHostCoordination({
      observations: [host('openclaw-gateway', true, { kind: 'not_restarted' })],
      autoRollbackAlreadyUsed: false,
    });
    expect(decision.action).toBe('retry_handshake');
  });
});

describe('data compatibility window (SPEC 10 / 18-6)', () => {
  it('allows an ordinary update whose data stays readable by the previous release', () => {
    const decision = evaluateDataCompatibility({
      candidate: release('1.223.0', '1.220.0'),
      previous: release('1.222.0', '1.219.0'),
    });
    expect(decision).toMatchObject({ eligible: true, mode: 'expand_migrate_contract', oldestReadableRelease: '1.220.0' });
  });

  it('allows the first installation without a previous release', () => {
    const decision = evaluateDataCompatibility({ candidate: release('1.223.0', '1.220.0'), previous: null });
    expect(decision.eligible).toBe(true);
  });

  it('refuses ordinary update when the previous release falls outside the readable window', () => {
    const decision = evaluateDataCompatibility({
      candidate: release('2.0.0', '2.0.0'),
      previous: release('1.222.0', '1.219.0'),
    });
    expect(decision).toMatchObject({ eligible: false, reason: 'destructive_migration_requires_maintenance' });
    if (!decision.eligible) {
      expect(decision.message).toMatch(/strand code rollback/i);
      expect(decision.nextAction).toMatch(/maintenance/i);
    }
  });
});
