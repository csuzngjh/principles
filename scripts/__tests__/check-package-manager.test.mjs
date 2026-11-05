import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../dev/check-package-manager.mjs', import.meta.url)
);

/** Run the guard as a real preinstall would, with one installer identity. */
function run(userAgent) {
  const env = { ...process.env };
  if (userAgent === undefined) delete env.npm_config_user_agent;
  else env.npm_config_user_agent = userAgent;
  return spawnSync(process.execPath, [script], { env, encoding: 'utf-8' });
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
