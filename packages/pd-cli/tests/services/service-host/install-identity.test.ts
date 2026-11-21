/**
 * Install identity + environment isolation (P1-1, TD §5.2).
 *
 * The coordinator's production identity derives ONLY from the OS account
 * record (`os.userInfo().homedir`) — never from `HOME`, `USERPROFILE` or
 * `PD_EXPERIMENT_ROOT`, none of which can relocate pdHome. Host-root env
 * vars steer DISCOVERY roots (recorded), never the install identity.
 * An undeterminable trusted home is a structured refusal, never a guess.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveCoordinatorInstallIdentity,
  stripExperimentRoot,
} from '../../../src/services/service-host/install-identity.js';

const dirs: string[] = [];
function tempDir(prefix = 'pd-sh-identity-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TRUSTED_HOME = tempDir('pd-sh-identity-home-');
const OS_HOME = os.userInfo().homedir;

describe('stripExperimentRoot', () => {
  it('passes an env without the variable through untouched (copy, not the same object), recording ignored/host vars', () => {
    const env = { HOME: '/tmp/h', PATH: '/bin' };
    const result = stripExperimentRoot(env);
    expect(result.view).toEqual({
      inheritedExperimentRoot: false,
      experimentRootStripped: false,
      ignoredIdentityEnvVars: ['HOME'],
      inheritedHostRootEnvVars: [],
      ignoredHostRootEnvVars: [],
    });
    expect(result.env).toEqual(env);
    expect(result.env).not.toBe(env);
  });

  it('strips the variable and records the fact with a bounded echo', () => {
    const env = { HOME: '/tmp/h', USERPROFILE: 'C:\\Users\\other', PD_EXPERIMENT_ROOT: 'D:/pd-labs/pri-872' };
    const result = stripExperimentRoot(env);
    expect(result.view).toEqual({
      inheritedExperimentRoot: true,
      experimentRootStripped: true,
      inheritedExperimentRootValue: 'D:/pd-labs/pri-872',
      ignoredIdentityEnvVars: ['HOME', 'USERPROFILE'],
      inheritedHostRootEnvVars: [],
      ignoredHostRootEnvVars: [],
    });
    expect(result.env.PD_EXPERIMENT_ROOT).toBeUndefined();
    expect(result.env.HOME).toBe('/tmp/h');
  });

  it('records inherited host-root vars as discovery context (not identity)', () => {
    const result = stripExperimentRoot({
      OPENCLAW_STATE_DIR: '/srv/oc-state',
      OPENCLAW_HOME: '/srv/oc-home',
      CODEX_HOME: '/srv/codex',
      WORKBUDDY_CONFIG_DIR: '/srv/wb',
    });
    expect(result.view.inheritedHostRootEnvVars).toEqual([
      'OPENCLAW_STATE_DIR',
      'OPENCLAW_HOME',
      'CODEX_HOME',
      'WORKBUDDY_CONFIG_DIR',
    ]);
    expect(result.view.ignoredIdentityEnvVars).toEqual([]);
  });

  it('bounds a very long inherited value (rc-8)', () => {
    const result = stripExperimentRoot({ PD_EXPERIMENT_ROOT: 'x'.repeat(500) });
    expect(result.view.inheritedExperimentRootValue).toBeDefined();
    expect((result.view.inheritedExperimentRootValue ?? '').length).toBeLessThanOrEqual(121);
  });
});

describe('resolveCoordinatorInstallIdentity', () => {
  it('resolves a production identity from the trusted home and derives the manifest paths', () => {
    const result = resolveCoordinatorInstallIdentity({}, { trustedHomeDir: TRUSTED_HOME });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.mode).toBe('production');
    expect(result.identity.homeSource).toBe('injected');
    expect(result.identity.homeDir).toBe(path.resolve(TRUSTED_HOME));
    expect(result.identity.pdHome).toBe(path.join(path.resolve(TRUSTED_HOME), '.pd'));
    expect(result.identity.manifestPath.endsWith('install.json')).toBe(true);
    expect(result.identity.activeRecordPath.endsWith('active.json')).toBe(true);
    expect(result.identity.environment.experimentRootStripped).toBe(false);
  });

  it('HOME pointing at an experiment directory is IGNORED: identity stays the trusted home', () => {
    const experiment = tempDir('pd-sh-experiment-');
    const result = resolveCoordinatorInstallIdentity(
      { HOME: experiment },
      { trustedHomeDir: TRUSTED_HOME },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.homeDir).toBe(path.resolve(TRUSTED_HOME));
    expect(result.identity.pdHome).toBe(path.join(path.resolve(TRUSTED_HOME), '.pd'));
    expect(result.identity.pdHome).not.toContain(experiment);
    expect(result.identity.environment.ignoredIdentityEnvVars).toContain('HOME');
  });

  it('USERPROFILE pointing at another user directory is IGNORED for identity', () => {
    const otherUser = tempDir('pd-sh-other-user-');
    const result = resolveCoordinatorInstallIdentity(
      { USERPROFILE: otherUser },
      { trustedHomeDir: TRUSTED_HOME },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.homeDir).toBe(path.resolve(TRUSTED_HOME));
    expect(result.identity.pdHome).not.toContain(otherUser);
    expect(result.identity.environment.ignoredIdentityEnvVars).toContain('USERPROFILE');
  });

  it('PD_EXPERIMENT_ROOT pointing at a production-looking dir still cannot move the identity', () => {
    const fakeProd = tempDir('pd-sh-fakeprod-');
    const result = resolveCoordinatorInstallIdentity(
      { PD_EXPERIMENT_ROOT: fakeProd },
      { trustedHomeDir: TRUSTED_HOME },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.pdHome).toBe(path.join(path.resolve(TRUSTED_HOME), '.pd'));
    expect(result.identity.environment.experimentRootStripped).toBe(true);
  });

  it('multiple simultaneous pollution vectors cannot steer the identity', () => {
    const experiment = tempDir('pd-sh-multi-');
    const result = resolveCoordinatorInstallIdentity(
      {
        HOME: experiment,
        USERPROFILE: experiment,
        PD_EXPERIMENT_ROOT: experiment,
        OPENCLAW_STATE_DIR: path.join(experiment, 'oc'),
        CODEX_HOME: path.join(experiment, 'codex'),
        WORKBUDDY_CONFIG_DIR: path.join(experiment, 'wb'),
      },
      { trustedHomeDir: TRUSTED_HOME },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.pdHome).toBe(path.join(path.resolve(TRUSTED_HOME), '.pd'));
    expect(result.identity.environment.ignoredIdentityEnvVars).toEqual(['HOME', 'USERPROFILE']);
    expect(result.identity.environment.inheritedHostRootEnvVars).toEqual([
      'OPENCLAW_STATE_DIR',
      'CODEX_HOME',
      'WORKBUDDY_CONFIG_DIR',
    ]);
  });

  it('honors host-root overrides for DISCOVERY roots while pdHome stays the trusted home', () => {
    const oc = tempDir('pd-sh-oc-');
    const codex = tempDir('pd-sh-codex-');
    const wb = tempDir('pd-sh-wb-');
    const result = resolveCoordinatorInstallIdentity(
      { OPENCLAW_STATE_DIR: oc, CODEX_HOME: codex, WORKBUDDY_CONFIG_DIR: wb },
      { trustedHomeDir: TRUSTED_HOME },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.pdHome).toBe(path.join(path.resolve(TRUSTED_HOME), '.pd'));
    expect(result.identity.hostRoots.openclawHome).toBe(path.resolve(oc));
    expect(result.identity.hostRoots.codexHome).toBe(path.resolve(codex));
    expect(result.identity.hostRoots.workbuddyConfigDir).toBe(path.resolve(wb));
  });

  it('F1: canonicalHostRootsOnly resolves host roots from the trusted home and records the ignored overrides', () => {
    const fakeCodex = tempDir('pd-sh-evil-codex-');
    const fakeWb = tempDir('pd-sh-evil-wb-');
    const result = resolveCoordinatorInstallIdentity(
      { CODEX_HOME: fakeCodex, WORKBUDDY_CONFIG_DIR: fakeWb },
      { trustedHomeDir: TRUSTED_HOME, canonicalHostRootsOnly: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const home = path.resolve(TRUSTED_HOME);
    // The inherited overrides did NOT steer host roots.
    expect(result.identity.hostRoots.codexHome).toBe(path.join(home, '.codex'));
    expect(result.identity.hostRoots.workbuddyConfigDir).toBe(path.join(home, '.workbuddy'));
    expect(result.identity.hostRoots.codexHome).not.toBe(path.resolve(fakeCodex));
    expect(result.identity.hostRoots.workbuddyConfigDir).not.toBe(path.resolve(fakeWb));
    // …and the ignored inputs are recorded (rc-9), never silently dropped.
    expect(result.identity.environment.ignoredHostRootEnvVars).toEqual(['CODEX_HOME', 'WORKBUDDY_CONFIG_DIR']);
    expect(result.identity.environment.inheritedHostRootEnvVars).toEqual(['CODEX_HOME', 'WORKBUDDY_CONFIG_DIR']);
  });

  it('F1: canonicalHostRootsOnly keeps the default mode untouched (no ignoredHostRootEnvVars entry)', () => {
    const fakeCodex = tempDir('pd-sh-evil-codex2-');
    const result = resolveCoordinatorInstallIdentity(
      { CODEX_HOME: fakeCodex },
      { trustedHomeDir: TRUSTED_HOME },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Dry-run mode still honors the override for discovery (P1-2).
    expect(result.identity.hostRoots.codexHome).toBe(path.resolve(fakeCodex));
    expect(result.identity.environment.ignoredHostRootEnvVars).toEqual([]);
  });

  it('derives default host roots from the SAME trusted home', () => {
    const result = resolveCoordinatorInstallIdentity({}, { trustedHomeDir: TRUSTED_HOME });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const home = path.resolve(TRUSTED_HOME);
    expect(result.identity.hostRoots.openclawHome).toBe(path.join(home, '.openclaw'));
    expect(result.identity.hostRoots.codexHome).toBe(path.join(home, '.codex'));
    expect(result.identity.hostRoots.workbuddyConfigDir).toBe(path.join(home, '.workbuddy'));
  });

  it('with no trusted home pinned, the OS account record decides (env is powerless)', () => {
    const experiment = tempDir('pd-sh-os-');
    const result = resolveCoordinatorInstallIdentity({ HOME: experiment, USERPROFILE: experiment });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.homeSource).toBe('os.userInfo()');
    expect(result.identity.homeDir).toBe(path.resolve(OS_HOME));
    expect(result.identity.pdHome).toBe(path.join(path.resolve(OS_HOME), '.pd'));
    expect(result.identity.pdHome).not.toContain(experiment);
  });

  it('a non-absolute trusted home is refused, never downgraded to a guess', () => {
    const result = resolveCoordinatorInstallIdentity({}, { trustedHomeDir: 'relative/path' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('install_identity_refused:home_not_absolute');
    expect(result.nextAction.length).toBeGreaterThan(0);
  });

  it('an empty trusted home is refused (undeterminable identity → refuse, not guess)', () => {
    const result = resolveCoordinatorInstallIdentity({}, { trustedHomeDir: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('install_identity_refused:');
  });

  it('surfaces a production-resolution refusal as a structured failure', () => {
    const result = resolveCoordinatorInstallIdentity(
      { OPENCLAW_STATE_DIR: 'relative/path' },
      { trustedHomeDir: TRUSTED_HOME },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('install_identity_refused:');
    expect(result.reason).toContain('openclaw_state_dir_not_absolute');
    expect(result.nextAction.length).toBeGreaterThan(0);
  });
});
