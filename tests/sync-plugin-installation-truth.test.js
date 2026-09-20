import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

const legacyInstallers = [
  {
    script: join(repoRoot, 'scripts', 'install.mjs'),
    refusalArgs: [[], ['--force'], ['-f'], ['--skip-build'], ['--skip-deps'], ['--skip-console'], ['--skip-plugin'], ['--lang', 'zh'], ['--unknown-flag']],
  },
  {
    script: join(repoRoot, 'packages', 'openclaw-plugin', 'scripts', 'sync-plugin.mjs'),
    refusalArgs: [[], ['--force'], ['-f'], ['--dev'], ['-d'], ['--skip-build'], ['--skip-deps'], ['--no-restart'], ['--bump'], ['--unknown-flag']],
  },
];

// PRI-868: the legacy dev install chain is deactivated. The contract is a hard
// refusal with ZERO side effects — the guard must fire before any dependency
// install, build, file copy, config write, or gateway/schtasks call, and no
// flag bypasses it.
describe('legacy dev installers are deactivated (PRI-868)', () => {
  function spawnInstaller(script, argv, fakeHome) {
    return spawnSync(process.execPath, [script, ...argv], {
      cwd: repoRoot,
      timeout: 30000,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });
  }

  for (const { script, refusalArgs } of legacyInstallers) {
    for (const argv of refusalArgs) {
      it(`refuses ${argv.join(' ') || '(no args)'} with exit 1 and zero writes: ${script}`, () => {
        const fakeHome = mkdtempSync(join(tmpdir(), 'pri868-home-'));
        writeFileSync(join(fakeHome, 'sentinel.txt'), 'do-not-touch');

        const result = spawnInstaller(script, argv, fakeHome);

        expect(result.status).toBe(1);
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        expect(output).toContain('已停用');
        expect(output).toContain('create-principles-disciple');

        // Zero side effects: the redirected home must still hold ONLY the sentinel.
        expect(readdirSync(fakeHome)).toEqual(['sentinel.txt']);
      });
    }

    it(`prints the deactivation notice and exits 0 on --help: ${script}`, () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'pri868-help-'));

      const result = spawnInstaller(script, ['--help'], fakeHome);

      expect(result.status).toBe(0);
      expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain('已停用');
      expect(readdirSync(fakeHome)).toEqual([]);
    });
  }
});
