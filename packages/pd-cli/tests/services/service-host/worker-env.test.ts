/**
 * Worker-subprocess environment allowlist (task §7 pollution matrix, TD §5.2):
 * the child env is BUILT from an allowlist with identity pins — a polluted
 * parent env can never redirect the production Workspace, the PD home or
 * the host roots (AC-11). Pure function tests. Credential-shaped NAMES are
 * constructed at runtime (the allowlist matches a pattern, not a vendor
 * list) so no credential literal ever appears in this file.
 */
import { describe, expect, it } from 'vitest';
import { buildWorkerEnvironment } from '../../../src/services/service-host/worker-env.js';
import { resolveCoordinatorInstallIdentity } from '../../../src/services/service-host/install-identity.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\fixture-home' : '/tmp/fixture-home';
const FAKE_ROOT = process.platform === 'win32' ? 'D:\\evil\\experiment' : '/tmp/evil-experiment';

function identity() {
  const resolved = resolveCoordinatorInstallIdentity({}, { trustedHomeDir: HOME });
  if (!resolved.ok) throw new Error(`identity refused: ${resolved.reason}`);
  return resolved.identity;
}

describe('pointer variables are dropped even when inherited (task §7 matrix)', () => {
  it('PD_EXPERIMENT_ROOT / PD_WORKSPACE_DIR / OPENCLAW_* never reach the child', () => {
    const { env, report } = buildWorkerEnvironment({
      identity: identity(),
      hostKind: 'codex',
      inheritedEnv: {
        PD_EXPERIMENT_ROOT: FAKE_ROOT,
        PD_WORKSPACE_DIR: '/evil/other-workspace',
        OPENCLAW_STATE_DIR: '/evil/openclaw',
        OPENCLAW_HOME: '/evil/openclaw2',
        PD_COMPANION_WORKER_IPC: '1',
      },
      platform: 'linux',
    });
    expect(env.PD_EXPERIMENT_ROOT).toBeUndefined();
    expect(env.PD_WORKSPACE_DIR).toBeUndefined();
    expect(env.OPENCLAW_STATE_DIR).toBeUndefined();
    expect(env.OPENCLAW_HOME).toBeUndefined();
    expect(env.PD_COMPANION_WORKER_IPC).toBeUndefined();
    expect(report.stripped).toContain('PD_EXPERIMENT_ROOT');
    expect(report.stripped).toContain('PD_WORKSPACE_DIR');
    expect(report.stripped).toContain('OPENCLAW_STATE_DIR');
    expect(report.stripped).toContain('PD_COMPANION_WORKER_IPC');
  });

  it('a forged CODEX_HOME is replaced by the trusted canonical host root (codex child)', () => {
    const id = identity();
    const { env } = buildWorkerEnvironment({
      identity: id,
      hostKind: 'codex',
      inheritedEnv: { CODEX_HOME: '/evil/codex' },
      platform: 'linux',
    });
    expect(env.CODEX_HOME).toBe(id.hostRoots.codexHome);
    expect(env.CODEX_HOME).not.toBe('/evil/codex');
  });

  it('a forged WORKBUDDY_CONFIG_DIR is replaced by the trusted canonical host root (workbuddy child)', () => {
    const id = identity();
    const { env } = buildWorkerEnvironment({
      identity: id,
      hostKind: 'workbuddy',
      inheritedEnv: { WORKBUDDY_CONFIG_DIR: '/evil/workbuddy' },
      platform: 'linux',
    });
    expect(env.WORKBUDDY_CONFIG_DIR).toBe(id.hostRoots.workbuddyConfigDir);
    expect(env.WORKBUDDY_CONFIG_DIR).not.toBe('/evil/workbuddy');
  });

  it('HOME / USERPROFILE are pinned from the trusted identity, never inherited', () => {
    const id = identity();
    const { env } = buildWorkerEnvironment({
      identity: id,
      hostKind: 'codex',
      inheritedEnv: { HOME: '/evil/home', USERPROFILE: 'D:\\evil\\profile' },
      platform: 'linux',
    });
    expect(env.HOME).toBe(id.homeDir);
    expect(env.USERPROFILE).toBe(id.homeDir);
    expect(env.HOME).not.toBe('/evil/home');
  });

  it('PD_INVOCATION_SOURCE is pinned to service_host over any inherited value', () => {
    for (const inherited of ['companion', 'manual', 'console', 'installer']) {
      const { env } = buildWorkerEnvironment({
        identity: identity(),
        hostKind: 'workbuddy',
        inheritedEnv: { PD_INVOCATION_SOURCE: inherited },
        platform: 'linux',
      });
      expect(env.PD_INVOCATION_SOURCE).toBe('service_host');
    }
  });

  it('a workbuddy child does not receive CODEX_HOME and vice versa', () => {
    const id = identity();
    const wb = buildWorkerEnvironment({ identity: id, hostKind: 'workbuddy', inheritedEnv: {}, platform: 'linux' });
    const cx = buildWorkerEnvironment({ identity: id, hostKind: 'codex', inheritedEnv: {}, platform: 'linux' });
    expect(wb.env.CODEX_HOME).toBeUndefined();
    expect(cx.env.WORKBUDDY_CONFIG_DIR).toBeUndefined();
    expect(cx.env.CODEX_HOME).toBe(id.hostRoots.codexHome);
    expect(wb.env.WORKBUDDY_CONFIG_DIR).toBe(id.hostRoots.workbuddyConfigDir);
  });
});

describe('allowlist passthrough', () => {
  it('system basics and credential-pattern names pass through; unrelated variables do not', () => {
    const credFixture = (prefix: string, suffix: string): [string, string] => [`${prefix}_${suffix}`, 'fixture-inert-value'];
    const credentialNames = [
      credFixture('OPENAI', 'API_KEY'),
      credFixture('ANTHROPIC', 'API_KEY'),
      credFixture('AWS_SESSION', 'TOKEN'),
    ];
    const { env, report } = buildWorkerEnvironment({
      identity: identity(),
      hostKind: 'codex',
      inheritedEnv: {
        PATH: '/usr/bin',
        SYSTEMROOT: 'C:\\Windows',
        LANG: 'en_US.UTF-8',
        TZ: 'UTC',
        HTTPS_PROXY: 'http://proxy.local:8080',
        MY_RANDOM_NOTE: 'not-allowed',
        DOTENV_CONFIG_PATH: '/evil/dotenv',
        ...Object.fromEntries(credentialNames),
      },
      platform: 'linux',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.TZ).toBe('UTC');
    expect(env.HTTPS_PROXY).toBe('http://proxy.local:8080');
    for (const [name, value] of credentialNames) {
      expect(env[name]).toBe(value);
      expect(report.passedThrough).toContain(name);
    }
    expect(env.MY_RANDOM_NOTE).toBeUndefined();
    expect(env.DOTENV_CONFIG_PATH).toBeUndefined();
    // Report carries NAMES only — never values (security contract).
    expect(JSON.stringify(report)).not.toContain('fixture-inert-value');
  });

  it('win32 matching is case-insensitive for allowlisted names', () => {
    const { env } = buildWorkerEnvironment({
      identity: identity(),
      hostKind: 'codex',
      inheritedEnv: { Path: 'C:\\bin', systemroot: 'C:\\Windows', pd_experiment_root: 'D:\\evil' },
      platform: 'win32',
    });
    expect(env.Path).toBe('C:\\bin');
    expect(env.systemroot).toBe('C:\\Windows');
    // The pointer check is case-insensitive on win32 too.
    expect(env.pd_experiment_root).toBeUndefined();
  });
});
