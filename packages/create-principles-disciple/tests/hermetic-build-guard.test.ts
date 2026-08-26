import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * Source-tree immutability guards (hermetic build contract).
 *
 * The self-contained bundler materializes FULL dependency trees; that must be
 * impossible to point at the repository source package, by omission AND by
 * explicit request. In-place stamping refuses the source package root the
 * same way. These guards exist so no future change can quietly reintroduce
 * the 720k-file workspace pollution observed on the dev machine.
 */

const INSTALLER_DIR = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);

const BUNDLE_SCRIPT = path.join(INSTALLER_DIR, 'scripts', 'bundle-plugin.mjs');
const ASSET_SCRIPT = path.join(INSTALLER_DIR, 'scripts', 'build-release-asset.mjs');

async function expectScriptRefusal(script: string, args: readonly string[], messagePattern: RegExp): Promise<void> {
  const failure = await execFileAsync(process.execPath, [script, ...args], {
    cwd: INSTALLER_DIR,
    timeout: 60_000,
  }).then(() => undefined, (error: unknown) => error);
  expect(failure).toBeDefined();
  if (typeof error === 'undefined') return;
  const stderr = typeof (failure as { stderr?: unknown }).stderr === 'string'
    ? String((failure as { stderr: string }).stderr)
    : '';
  expect(stderr).toMatch(messagePattern);
}

describe('hermetic build guards (source tree immutability)', () => {
  it('refuses self-contained materialization without an explicit output root', async () => {
    await expectScriptRefusal(BUNDLE_SCRIPT, ['--self-contained'], /requires an explicit --output-root/);
  });

  it('refuses self-contained materialization targeting the source package', async () => {
    await expectScriptRefusal(BUNDLE_SCRIPT, ['--self-contained', '--output-root', INSTALLER_DIR], /Refusing to materialize/);
    await expectScriptRefusal(
      BUNDLE_SCRIPT,
      ['--self-contained', '--output-root', path.join(INSTALLER_DIR, 'nested')],
      /Refusing to materialize/,
    );
  });

  it('refuses in-place stamping on the source package root', async () => {
    await expectScriptRefusal(
      ASSET_SCRIPT,
      ['--input', INSTALLER_DIR, '--output', INSTALLER_DIR, '--in-place', 'true', '--platform', 'win32', '--arch', 'x64', '--node-abi', '127'],
      /Refusing to stamp/,
    );
  });

  it('left no source-tree pollution from these refusal attempts', () => {
    for (const pollution of ['_release', 'plugin/node_modules', 'core/node_modules']) {
      expect(fs.existsSync(path.join(INSTALLER_DIR, pollution)), pollution).toBe(false);
    }
  });
});
