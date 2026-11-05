import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildAdaptiveConfigIdentitySnapshot,
  buildUnavailableAdaptiveConfigIdentity,
  computeEffectiveHookSetFingerprint,
  deriveAdaptiveEvidenceCoverage,
  forgetAdaptiveConfigIdentity,
  getRememberedAdaptiveConfigIdentity,
  readExecutingPluginVersion,
  rememberAdaptiveConfigIdentity,
  resetAdaptiveConfigIdentityStateForTest,
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

function hooks(overrides: Partial<AdaptiveHookRegistration> = {}, count = 2): AdaptiveHookRegistration[] {
  const base: AdaptiveHookRegistration[] = [
    { surfaceId: 'hook:before_prompt_build', event: 'before_prompt_build', enabled: true },
    { surfaceId: 'hook:after_tool_call', event: 'after_tool_call', enabled: true },
    { surfaceId: 'hook:llm_output', event: 'llm_output', enabled: false },
  ].slice(0, count);
  return base.map(hook => ({ ...hook, ...overrides }));
}

describe('readExecutingPluginVersion', () => {
  it('reads the manifest that owns the executing module', () => {
    const fixture = artifactFixture('2.6.2');
    expect(readExecutingPluginVersion({ executingFileUrl: fixture.executingFileUrl }))
      .toEqual({ version: '2.6.2' });
  });

  it('cross-checks the host-declared plugin root and refuses a conflict', () => {
    const executing = artifactFixture('2.6.2');
    const conflictingRoot = artifactFixture('2.5.0').root;
    expect(readExecutingPluginVersion({
      executingFileUrl: executing.executingFileUrl,
      pluginRootDir: conflictingRoot,
    })).toEqual({ version: 'unknown', reason: 'plugin_version_manifest_conflict' });
  });

  it('degrades to unknown on missing or unreadable manifests without throwing', () => {
    expect(readExecutingPluginVersion({ executingFileUrl: 'not-a-file-url' }))
      .toEqual({ version: 'unknown', reason: 'executing_url_invalid' });
    const missing = artifactFixture('0.0.0');
    rmSync(join(missing.root, 'package.json'));
    expect(readExecutingPluginVersion({ executingFileUrl: missing.executingFileUrl }).version).toBe('unknown');
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
    const fixture = artifactFixture('2.6.2');
    const snapshot = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'shared',
      executingFileUrl: fixture.executingFileUrl,
      hookRegistrations: hooks(),
    });
    expect(snapshot.hostVersion).toBe('unknown');
    expect(snapshot.configIdentityCoverage.notes).toContain('hostVersion:no_runtime_interface');
    expect(snapshot.evidenceCoverage).toBe('partial');
  });

  it('changes identity when plugin version or runtime mode changes', () => {
    const versionA = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'shared',
      executingFileUrl: artifactFixture('1.0.0').executingFileUrl,
      hookRegistrations: hooks(),
    });
    const versionB = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'shared',
      executingFileUrl: artifactFixture('1.0.1').executingFileUrl,
      hookRegistrations: hooks(),
    });
    expect(versionA.pluginVersion).toBe('1.0.0');
    expect(versionB.pluginVersion).toBe('1.0.1');
    expect(versionB.pluginVersion).not.toBe(versionA.pluginVersion);

    const modeB = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'plugin_local',
      executingFileUrl: artifactFixture('1.0.0').executingFileUrl,
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
    const registrations = hooks();
    const snapshot = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'shared',
      executingFileUrl: artifactFixture('2.6.2').executingFileUrl,
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
    const opening = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'shared',
      executingFileUrl: artifactFixture('1.0.0').executingFileUrl,
      hookRegistrations: hooks(),
    });
    rememberAdaptiveConfigIdentity('inv-1', opening);

    const nextInvocation = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'plugin_local',
      executingFileUrl: artifactFixture('1.0.1').executingFileUrl,
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
    const snapshot = buildAdaptiveConfigIdentitySnapshot({
      runtimeMode: 'shared',
      executingFileUrl: artifactFixture('2.6.2').executingFileUrl,
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
