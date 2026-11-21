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

  it('F4: a config-named credential passes through even when the name does NOT match the generic pattern', () => {
    const { env } = buildWorkerEnvironment({
      identity: identity(),
      hostKind: 'workbuddy',
      inheritedEnv: { TEAM_LLM_AUTH: 'fixture-inert-value' },
      credentialEnvAllowlist: ['TEAM_LLM_AUTH'],
      platform: 'linux',
    });
    // resolveProviderApiKey reads THIS exact name (apiKeyEnv) — without the
    // config-derived allowlist the child would lose a working credential.
    expect(env.TEAM_LLM_AUTH).toBe('fixture-inert-value');
  });

  it('F4: the config allowlist can never re-admit a pointer variable', () => {
    const id = identity();
    const { env } = buildWorkerEnvironment({
      identity: id,
      hostKind: 'codex',
      inheritedEnv: { CODEX_HOME: '/evil/codex' },
      credentialEnvAllowlist: ['CODEX_HOME', 'TEAM_LLM_AUTH'],
      platform: 'linux',
    });
    // Pointer rejection outranks the config allowlist.
    expect(env.CODEX_HOME).toBe(id.hostRoots.codexHome);
    expect(env.CODEX_HOME).not.toBe('/evil/codex');
  });

  it('R1: a config-declared Node launch variable can never be re-admitted as a credential', () => {
    const { env, report } = buildWorkerEnvironment({
      identity: identity(),
      hostKind: 'codex',
      inheritedEnv: {
        NODE_OPTIONS: '--require /tmp/evil.js',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        NODE_EXTRA_CA_CERTS: '/evil/ca.pem',
        NODE_PATH: '/evil/modules',
        LD_PRELOAD: '/evil.so',
      },
      credentialEnvAllowlist: ['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_PATH', 'LD_PRELOAD'],
      platform: 'linux',
    });
    // The workspace config can name its own credentials, but it can never use
    // that channel to inject runtime-launch settings into the Worker child.
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(report.passedThrough).not.toContain('NODE_OPTIONS');
    expect(report.passedThrough).not.toContain('LD_PRELOAD');
  });

  it('R1: the launch-control denial is case-insensitive on win32 too', () => {
    const { env } = buildWorkerEnvironment({
      identity: identity(),
      hostKind: 'workbuddy',
      inheritedEnv: { node_options: '--require C:\\evil.js', Node_Path: 'D:\\evil' },
      credentialEnvAllowlist: ['node_options', 'Node_Path'],
      platform: 'win32',
    });
    expect(env.node_options).toBeUndefined();
    expect(env.Node_Path).toBeUndefined();
  });

  it('F4: malformed config allowlist names are ignored', () => {
    const longName = 'A'.repeat(80);
    const { env } = buildWorkerEnvironment({
      identity: identity(),
      hostKind: 'codex',
      inheritedEnv: { 'BAD NAME': 'x', '../evil': 'y', [longName]: 'z' },
      credentialEnvAllowlist: ['BAD NAME', '../evil', longName, ''],
      platform: 'linux',
    });
    expect(env['BAD NAME']).toBeUndefined();
    expect(env['../evil']).toBeUndefined();
    expect(env[longName]).toBeUndefined();
  });

  it('F13: the invocation id is pinned into the child env and reported by name only', () => {
    const { env, report } = buildWorkerEnvironment({
      identity: identity(),
      hostKind: 'codex',
      inheritedEnv: { PD_INVOCATION_ID: 'inherited-forgery' },
      invocationId: 'inv-fixture-42',
      platform: 'linux',
    });
    expect(env.PD_INVOCATION_ID).toBe('inv-fixture-42');
    expect(report.invocationId).toBe('inv-fixture-42');
    // The report carries the id (run metadata), never env VALUES.
    expect(JSON.stringify(report)).not.toContain('fixture-inert-value');
  });
});
