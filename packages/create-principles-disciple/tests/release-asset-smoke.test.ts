import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const INSTALLER_DIR = path.resolve(__dirname, '..');
const COMPONENT_NAMES = ['plugin', 'console', 'core', 'pd-cli', 'host-runtime', 'install-layout'];
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-release-smoke-'));
const assetDir = path.join(root, 'asset');
const homeDir = path.join(root, 'home');
const workspaceDir = path.join(root, 'workspace');
const binDir = path.join(root, 'bin');
const npmMarker = path.join(root, 'npm-invoked');

beforeAll(() => {
  const before = COMPONENT_NAMES.filter(name => fs.existsSync(path.join(INSTALLER_DIR, name, 'node_modules')));
  execFileSync(process.execPath, [path.join(INSTALLER_DIR, 'scripts', 'build-self-contained-release.mjs'), '--output', assetDir], {
    cwd: INSTALLER_DIR,
    stdio: 'pipe',
    timeout: 600_000,
  });
  expect(COMPONENT_NAMES.filter(name => fs.existsSync(path.join(INSTALLER_DIR, name, 'node_modules')))).toEqual(before);
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const openclaw = path.join(binDir, process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
  fs.writeFileSync(openclaw, process.platform === 'win32' ? '@echo off\r\necho openclaw 1.0.0\r\n' : '#!/bin/sh\necho openclaw 1.0.0\n');
  const npm = path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  fs.writeFileSync(npm, process.platform === 'win32' ? `@echo off\r\n>"${npmMarker}" echo invoked\r\nexit /b 97\r\n` : `#!/bin/sh\nprintf invoked > "${npmMarker}"\nexit 97\n`);
  if (process.platform !== 'win32') {
    fs.chmodSync(openclaw, 0o755);
    fs.chmodSync(npm, 0o755);
  }
}, 600_000);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }), 300_000);

describe('production self-contained release asset', () => {
  it('preserves source component identity without consulting registry state', () => {
    const sourcePackage: unknown = JSON.parse(fs.readFileSync(path.resolve(INSTALLER_DIR, '..', 'openclaw-plugin', 'package.json'), 'utf8'));
    const assetPackage: unknown = JSON.parse(fs.readFileSync(path.join(assetDir, 'plugin', 'package.json'), 'utf8'));
    const sourceVersion = typeof sourcePackage === 'object' && sourcePackage !== null && Object.hasOwn(sourcePackage, 'version')
      ? Reflect.get(sourcePackage, 'version')
      : undefined;
    expect(typeof sourceVersion).toBe('string');
    expect(assetPackage).toMatchObject({ version: sourceVersion });
  });

  it('contains no symlinks after build-only npm links are removed', () => {
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        expect(fs.lstatSync(entryPath).isSymbolicLink(), entryPath).toBe(false);
        if (entry.isDirectory()) visit(entryPath);
      }
    };
    visit(assetDir);
  }, 30_000);

  it('installs from pipeline output without invoking npm', () => {
    const installerModule = pathToFileURL(path.join(INSTALLER_DIR, 'dist', 'installer.js')).href;
    const resultMarker = '__PD_INSTALL_RESULT__';
    const runner = `import { install } from ${JSON.stringify(installerModule)};\nconst result=await install({language:'en',mode:'force',workspaceDir:process.argv[1],channels:['prompt','defer_archive','code_tool_hook'],overwriteConfig:false,host:'openclaw',stopGateway:false},process.argv[2],{quiet:true,nonInteractive:true});\nprocess.stdout.write(${JSON.stringify(resultMarker)}+JSON.stringify(result));`;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', runner, workspaceDir, assetDir], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, PD_SKIP_NPM_UPGRADE: '1', PD_SKIP_GLOBAL_SHIM: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 600_000,
    }).toString();
    const markerIndex = stdout.lastIndexOf(resultMarker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const result: unknown = JSON.parse(stdout.slice(markerIndex + resultMarker.length));
    if (typeof result === 'object' && result !== null && Object.hasOwn(result, 'success') && Reflect.get(result, 'success') !== true) {
      throw new Error(`Self-contained asset install failed: ${JSON.stringify(result)}`);
    }
    expect(result).toMatchObject({ success: true, components: { plugin: 'verified', console: 'configured' }, verification: { storyA: 'passed' } });
    expect(fs.existsSync(npmMarker)).toBe(false);
  }, 600_000);
});
