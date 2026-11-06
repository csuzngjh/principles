import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  bindAdaptivePluginVersionForTest,
  buildAdaptiveConfigIdentitySnapshot,
  buildUnavailableAdaptiveConfigIdentity,
  computeEffectiveHookSetFingerprint,
  deriveAdaptiveEvidenceCoverage,
  forgetAdaptiveConfigIdentity,
  getRememberedAdaptiveConfigIdentity,
  readExecutingPluginVersion,
  rememberAdaptiveConfigIdentity,
  resetAdaptiveConfigIdentityStateForTest,
  setManifestReadProbeForTest,
  type AdaptiveHookRegistration,
} from '../../src/core/adaptive-config-identity.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  resetAdaptiveConfigIdentityStateForTest();
});

function artifactFixture(version: string, name = 'principles-disciple'): {
  root: string;
  executingFileUrl: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'pd-adaptive-identity-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version }));
  const executingFile = join(root, 'dist', 'bundle.js');
  writeFileSync(executingFile, '// fixture\n');
  return { root, executingFileUrl: pathToFileURL(executingFile).href };
}

function oversizedArtifactFixture(paddingBytes: number): { root: string; executingFileUrl: string } {
  const root = mkdtempSync(join(tmpdir(), 'pd-adaptive-identity-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'principles-disciple',
      version: '1.0.0',
      padding: 'x'.repeat(paddingBytes),
    }),
  );
  const executingFile = join(root, 'dist', 'bundle.js');
  writeFileSync(executingFile, '// fixture\n');
  return { root, executingFileUrl: pathToFileURL(executingFile).href };
}

function hooks(overrides: Partial<AdaptiveHookRegistration> = {}, count = 2): AdaptiveHookRegistration[] {
  const base: AdaptiveHookRegistration[] = [
    { surfaceId: 'hook:before_prompt_build', event: 'before_prompt_build', enabled: true },
    { surfaceId: 'hook:after_tool_call', event: 'after_tool_call', enabled: true },
    { surfaceId: 'hook:llm_output', event: 'llm_output', enabled: false },
  ].slice(0, count);
  return base.map(hook => ({ ...hook, ...overrides }));
}

describe('readExecutingPluginVersion', () => {
  it('reads the manifest that owns the loaded module', () => {
    const fixture = artifactFixture('2.6.2');
    bindAdaptivePluginVersionForTest(fixture.executingFileUrl);
    expect(readExecutingPluginVersion()).toEqual({ version: '2.6.2' });
  });

  it('cross-checks the host-declared plugin root and refuses a conflict', () => {
    const executing = artifactFixture('2.6.2');
    bindAdaptivePluginVersionForTest(executing.executingFileUrl);
    const conflictingRoot = artifactFixture('2.5.0').root;
    expect(readExecutingPluginVersion({ pluginRootDir: conflictingRoot }))
      .toEqual({ version: 'unknown', reason: 'plugin_version_manifest_conflict' });
  });

  it('degrades to unknown on missing or unreadable manifests without throwing', () => {
    bindAdaptivePluginVersionForTest('not-a-file-url');
    expect(readExecutingPluginVersion()).toEqual({ version: 'unknown', reason: 'executing_url_invalid' });

    const missing = artifactFixture('0.0.0');
    rmSync(join(missing.root, 'package.json'));
    bindAdaptivePluginVersionForTest(missing.executingFileUrl);
    expect(readExecutingPluginVersion().version).toBe('unknown');
  });

  it('keeps the loaded version when the on-disk manifest changes after load', () => {
    const fixture = artifactFixture('1.0.0');
    // Simulates module evaluation: the version is bound once here.
    bindAdaptivePluginVersionForTest(fixture.executingFileUrl);
    expect(readExecutingPluginVersion()).toEqual({ version: '1.0.0' });

    // The process keeps running the same loaded code; only the disk changes.
    writeFileSync(
      join(fixture.root, 'package.json'),
      JSON.stringify({ name: 'principles-disciple', version: '2.0.0' }),
    );

    expect(readExecutingPluginVersion()).toEqual({ version: '1.0.0' });
    const snapshot = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'shared',
      hookRegistrations: hooks(),
    });
    expect(snapshot.pluginVersion).toBe('1.0.0');
    expect(snapshot.configIdentityCoverage.confirmed).toContain('pluginVersion');
  });

  it('downgrades to unknown when the installed root disagrees with the loaded version', () => {
    const executing = artifactFixture('1.0.0');
    bindAdaptivePluginVersionForTest(executing.executingFileUrl);
    // In-place upgrade replaced the installed manifest, but the old code runs.
    const upgradedRoot = artifactFixture('2.0.0').root;
    expect(readExecutingPluginVersion({ pluginRootDir: upgradedRoot }))
      .toEqual({ version: 'unknown', reason: 'plugin_version_manifest_conflict' });
  });

  it('reads at most MAX_MANIFEST_BYTES + 1 bytes before rejecting an oversized manifest', () => {
    const fixture = oversizedArtifactFixture(128 * 1024);
    let observedBytes = 0;
    setManifestReadProbeForTest(bytesRead => {
      observedBytes = bytesRead;
    });

    bindAdaptivePluginVersionForTest(fixture.executingFileUrl);
    expect(readExecutingPluginVersion().version).toBe('unknown');
    expect(observedBytes).toBeLessThanOrEqual(65537);
  });
});

describe('effective hook set fingerprint', () => {
  it('is order-insensitive and changes with the confirmed effective set', () => {
    const forward = computeEffectiveHookSetFingerprint(hooks());
    const reversed = computeEffectiveHookSetFingerprint([...hooks()].reverse());
    expect(reversed.fingerprint).toBe(forward.fingerprint);
    expect(forward.state).toBe('partial');
    expect(forward.reason).toBe('host_dispatch_not_observable');

    const changed = computeEffectiveHookSetFingerprint(hooks({ enabled: false }, 1));
    expect(changed.fingerprint).not.toBe(forward.fingerprint);
  });

  it('does not fabricate a fingerprint when nothing was registered', () => {
    expect(computeEffectiveHookSetFingerprint([])).toEqual({
      fingerprint: 'unknown',
      state: 'unknown',
      reason: 'no_registered_hooks',
    });
  });
});

describe('adaptive config identity snapshot', () => {
  it('keeps hostVersion unknown because no trusted runtime interface exists', () => {
    bindAdaptivePluginVersionForTest(artifactFixture('2.6.2').executingFileUrl);
    const snapshot = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'shared',
      hookRegistrations: hooks(),
    });
    expect(snapshot.hostVersion).toBe('unknown');
    expect(snapshot.configIdentityCoverage.notes).toContain('hostVersion:no_runtime_interface');
    expect(snapshot.evidenceCoverage).toBe('partial');
  });

  it('changes identity when the loaded plugin version or runtime mode changes', () => {
    bindAdaptivePluginVersionForTest(artifactFixture('1.0.0').executingFileUrl);
    const versionA = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'shared',
      hookRegistrations: hooks(),
    });

    // A different process loaded a different artifact.
    bindAdaptivePluginVersionForTest(artifactFixture('1.0.1').executingFileUrl);
    const versionB = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'shared',
      hookRegistrations: hooks(),
    });
    expect(versionA.pluginVersion).toBe('1.0.0');
    expect(versionB.pluginVersion).toBe('1.0.1');
    expect(versionB.pluginVersion).not.toBe(versionA.pluginVersion);

    const modeB = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'plugin_local',
      hookRegistrations: hooks(),
    });
    expect(modeB.runtimeMode).toBe('plugin_local');
    expect(modeB.runtimeMode).not.toBe(versionA.runtimeMode);
  });

  it('reports identity unavailable when no source can be confirmed', () => {
    const unavailable = buildUnavailableAdaptiveConfigIdentity('shared', 'identity_collection_failed');
    expect(unavailable.host).toBe('unknown');
    expect(unavailable.hostVersion).toBe('unknown');
    expect(unavailable.pluginVersion).toBe('unknown');
    expect(unavailable.effectiveHookSetFingerprint).toBe('unknown');
    expect(unavailable.evidenceCoverage).toBe('unknown');
    expect(unavailable.effectiveHookSetFingerprint).not.toMatch(/sha256:/);
  });

  it('derives complete, partial and all-unknown coverage', () => {
    expect(deriveAdaptiveEvidenceCoverage({ confirmed: 5, partial: 0, missing: 0 })).toBe('complete');
    expect(deriveAdaptiveEvidenceCoverage({ confirmed: 3, partial: 1, missing: 1 })).toBe('partial');
    expect(deriveAdaptiveEvidenceCoverage({ confirmed: 0, partial: 0, missing: 5 })).toBe('unknown');
  });

  it('freezes the snapshot so later configuration changes cannot rewrite it', () => {
    bindAdaptivePluginVersionForTest(artifactFixture('2.6.2').executingFileUrl);
    const registrations = hooks();
    const snapshot = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'shared',
      hookRegistrations: registrations,
    });
    const before = snapshot.effectiveHookSetFingerprint;

    registrations[0]!.enabled = false;
    expect(snapshot.effectiveHookSetFingerprint).toBe(before);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as { hostVersion: string }).hostVersion = '9.9.9';
    }).toThrow(TypeError);
  });

  it('keeps the opening snapshot for an in-flight invocation', () => {
    bindAdaptivePluginVersionForTest(artifactFixture('1.0.0').executingFileUrl);
    const opening = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'shared',
      hookRegistrations: hooks(),
    });
    rememberAdaptiveConfigIdentity('inv-1', opening);

    bindAdaptivePluginVersionForTest(artifactFixture('1.0.1').executingFileUrl);
    const nextInvocation = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'plugin_local',
      hookRegistrations: hooks({ enabled: false }, 1),
    });

    expect(getRememberedAdaptiveConfigIdentity('inv-1')).toBe(opening);
    forgetAdaptiveConfigIdentity('inv-1');
    expect(getRememberedAdaptiveConfigIdentity('inv-1')).toBeUndefined();

    rememberAdaptiveConfigIdentity('inv-2', nextInvocation);
    expect(getRememberedAdaptiveConfigIdentity('inv-2')?.runtimeMode).toBe('plugin_local');
    expect(getRememberedAdaptiveConfigIdentity('inv-2')?.pluginVersion).toBe('1.0.1');
  });

  it('emits only whitelisted identity fields', () => {
    bindAdaptivePluginVersionForTest(artifactFixture('2.6.2').executingFileUrl);
    const snapshot = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'shared',
      hookRegistrations: hooks(),
    });
    expect(Object.keys(snapshot).sort()).toEqual([
      'configIdentityCoverage',
      'effectiveHookSetFingerprint',
      'evidenceCoverage',
      'host',
      'hostVersion',
      'pluginVersion',
      'runtimeMode',
    ]);
    const serialized = JSON.stringify(snapshot).toLowerCase();
    for (const forbidden of ['authorization', 'api_key', 'apikey', 'cookie', 'prompt', 'secret', 'token', 'workspace']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
