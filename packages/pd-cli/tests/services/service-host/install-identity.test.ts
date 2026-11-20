/**
 * Install identity + environment isolation (task Stage 4, TD §5.2).
 *
 * The coordinator must NEVER resolve an experiment install: the inherited
 * PD_EXPERIMENT_ROOT is stripped before identity resolution and the fact is
 * recorded (rc-9), not silent. The shared home precedence (HOME first, then
 * os.homedir()) stays the single identity authority.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveCoordinatorInstallIdentity,
  stripExperimentRoot,
} from '../../../src/services/service-host/install-identity.js';

const REAL_HOME = mkdtempSync(path.join(os.tmpdir(), 'pd-sh-identity-'));

describe('stripExperimentRoot', () => {
  it('passes an env without the variable through untouched (copy, not the same object)', () => {
    const env = { HOME: '/tmp/h', PATH: '/bin' };
    const result = stripExperimentRoot(env);
    expect(result.view).toEqual({ inheritedExperimentRoot: false, experimentRootStripped: false });
    expect(result.env).toEqual(env);
    expect(result.env).not.toBe(env);
  });

  it('strips the variable and records the fact with a bounded echo', () => {
    const env = { HOME: '/tmp/h', PD_EXPERIMENT_ROOT: 'D:/pd-labs/pri-872' };
    const result = stripExperimentRoot(env);
    expect(result.view).toEqual({
      inheritedExperimentRoot: true,
      experimentRootStripped: true,
      inheritedExperimentRootValue: 'D:/pd-labs/pri-872',
    });
    expect(result.env.PD_EXPERIMENT_ROOT).toBeUndefined();
    expect(result.env.HOME).toBe('/tmp/h');
  });

  it('bounds a very long inherited value (rc-8)', () => {
    const result = stripExperimentRoot({ PD_EXPERIMENT_ROOT: 'x'.repeat(500) });
    expect(result.view.inheritedExperimentRootValue).toBeDefined();
    expect((result.view.inheritedExperimentRootValue ?? '').length).toBeLessThanOrEqual(121);
  });
});

describe('resolveCoordinatorInstallIdentity', () => {
  it('resolves a production identity from HOME precedence and derives the manifest paths', () => {
    const result = resolveCoordinatorInstallIdentity({ HOME: REAL_HOME });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.mode).toBe('production');
    expect(result.identity.homeDir).toBe(path.resolve(REAL_HOME));
    expect(result.identity.pdHome).toBe(path.join(path.resolve(REAL_HOME), '.pd'));
    expect(result.identity.manifestPath.endsWith('install.json')).toBe(true);
    expect(result.identity.activeRecordPath.endsWith('active.json')).toBe(true);
    expect(result.identity.environment.experimentRootStripped).toBe(false);
  });

  it('resolves the PRODUCTION identity even when PD_EXPERIMENT_ROOT is inherited, and records the strip', () => {
    const result = resolveCoordinatorInstallIdentity({
      HOME: REAL_HOME,
      PD_EXPERIMENT_ROOT: 'D:/pd-labs/pri-872',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The identity is the production home derived from HOME — never the experiment root.
    expect(result.identity.homeDir).toBe(path.resolve(REAL_HOME));
    expect(result.identity.pdHome).toBe(path.join(path.resolve(REAL_HOME), '.pd'));
    expect(result.identity.environment).toEqual({
      inheritedExperimentRoot: true,
      experimentRootStripped: true,
      inheritedExperimentRootValue: 'D:/pd-labs/pri-872',
    });
  });

  it('reports homeSource HOME vs os.homedir() honestly', () => {
    const withHome = resolveCoordinatorInstallIdentity({ HOME: REAL_HOME });
    const withoutHome = resolveCoordinatorInstallIdentity({});
    expect(withHome.ok && withHome.identity.homeSource).toBe('HOME');
    expect(withoutHome.ok && withoutHome.identity.homeSource).toBe('os.homedir()');
  });

  it('surfaces a production-resolution refusal as a structured failure', () => {
    const result = resolveCoordinatorInstallIdentity({
      HOME: REAL_HOME,
      OPENCLAW_STATE_DIR: 'relative/path',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('install_identity_refused:');
    expect(result.reason).toContain('openclaw_state_dir_not_absolute');
    expect(result.nextAction.length).toBeGreaterThan(0);
  });
});
