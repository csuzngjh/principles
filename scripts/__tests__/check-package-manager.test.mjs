import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../dev/check-package-manager.mjs', import.meta.url)
);

/**
 * Run the guard as a real preinstall would, with one installer identity.
 *
 * Windows environment names are case-insensitive, but `process.env` keeps the
 * casing it was handed. When a parent process exports `NPM_CONFIG_USER_AGENT`
 * (Trae/IDE shells do), `{ ...process.env, npm_config_user_agent }` produces
 * BOTH spellings, and the child's case-insensitive lookup resolves to the
 * uppercase one — so the simulated installer identity never reached the guard
 * and every rejection case saw a real npm UA and exited 0. Linux is
 * case-sensitive, which is why this only failed locally on Windows.
 * Drop every case variant before installing the one identity under test.
 */
function withInstallerIdentity(userAgent) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_config_user_agent') delete env[key];
  }
  if (userAgent !== undefined) env.npm_config_user_agent = userAgent;
  return env;
}

function run(userAgent) {
  return spawnSync(process.execPath, [script], {
    env: withInstallerIdentity(userAgent),
    encoding: 'utf-8',
  });
}

describe('check-package-manager', () => {
  it('accepts npm installs', () => {
    const result = run('npm/10.9.7 node/v22.22.2 win32 x64 workspaces/false');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it.each([
    'pnpm/12.16.1 npm/? node/v22.22.2 win32 x64',
    'yarn/1.22.22 npm/? node/v22.22.2 win32 x64',
    'bun/1.2.0 npm/? node/v22.22.2 win32 x64',
  ])('rejects non-npm installer: %s', (userAgent) => {
    const result = run(userAgent);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rejected');
    expect(result.stderr).toContain('npm install');
  });

  it('fails closed when the installer hides its identity', () => {
    const result = run(undefined);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no npm_config_user_agent');
  });
});
