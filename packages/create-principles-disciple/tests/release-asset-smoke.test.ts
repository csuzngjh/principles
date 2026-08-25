import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extract as extractTar } from 'tar';

const INSTALLER_DIR = path.resolve(__dirname, '..');
const COMPONENT_NAMES = ['plugin', 'console', 'core', 'pd-cli', 'host-runtime', 'install-layout'];
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-release-smoke-'));
// CI builds the publication twice, byte-compares the archives, then points
// this smoke at the second build via PD_RELEASE_SMOKE_PUBLICATION. Every
// assertion below (digest, safe extract, no-symlink, no-npm install) still
// runs against the provided publication — only the internal build is skipped.
// The env-provided directory is a read-only input: child processes spawned by
// this file only ever receive mkdtemp-derived paths, never env values.
const providedPublication = process.env.PD_RELEASE_SMOKE_PUBLICATION;
if (providedPublication !== undefined) {
  if (!path.isAbsolute(providedPublication) || path.basename(providedPublication).startsWith('-')) {
    throw new Error(`PD_RELEASE_SMOKE_PUBLICATION must be an absolute directory path: ${providedPublication}`);
  }
  if (!fs.existsSync(path.join(providedPublication, 'asset.tar'))
    || !fs.existsSync(path.join(providedPublication, 'asset.tar.sha256'))) {
    throw new Error(`PD_RELEASE_SMOKE_PUBLICATION does not contain asset.tar and asset.tar.sha256: ${providedPublication}`);
  }
}
const buildPublicationInternally = providedPublication === undefined;
const internalPublicationDir = path.join(root, 'asset');
const publicationDir = buildPublicationInternally ? internalPublicationDir : providedPublication;
const assetDir = path.join(root, 'extracted');
const homeDir = path.join(root, 'home');
const workspaceDir = path.join(root, 'workspace');
const binDir = path.join(root, 'bin');
const npmMarker = path.join(root, 'npm-invoked');

function validateEntryBelowRoot(entry: string, rootDirectory: string): string {
  const resolved = path.resolve(entry);
  if (!resolved.startsWith(rootDirectory + path.sep) || !fs.existsSync(resolved)) {
    throw new Error(`Required entry is missing or outside ${rootDirectory}: ${resolved}`);
  }
  return resolved;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyDetachedDigest(archivePath: string, digestPath: string): Promise<void> {
  const expected = fs.readFileSync(digestPath, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(expected) || await sha256File(archivePath) !== expected) {
    throw new Error('Release archive digest mismatch');
  }
}

beforeAll(async () => {
  if (buildPublicationInternally) {
    const before = COMPONENT_NAMES.filter(name => fs.existsSync(path.join(INSTALLER_DIR, name, 'node_modules')));
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const builderEntry = validateEntryBelowRoot(
      path.join(INSTALLER_DIR, 'scripts', 'build-self-contained-release.mjs'),
      INSTALLER_DIR,
    );
    await execFileAsync(process.execPath, [builderEntry, '--output', internalPublicationDir], {
      cwd: INSTALLER_DIR,
      env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' },
      timeout: 600_000,
    });
    expect(COMPONENT_NAMES.filter(name => fs.existsSync(path.join(INSTALLER_DIR, name, 'node_modules')))).toEqual(before);
  }
  const archivePath = path.join(publicationDir, 'asset.tar');
  await verifyDetachedDigest(archivePath, path.join(publicationDir, 'asset.tar.sha256'));
  fs.mkdirSync(assetDir);
  extractTar({
    cwd: assetDir,
    file: archivePath,
    preservePaths: false,
    strict: true,
    sync: true,
    onentry: (entry) => {
      expect(path.isAbsolute(entry.path)).toBe(false);
      expect(entry.path.split('/')).not.toContain('..');
      expect(['SymbolicLink', 'Link']).not.toContain(entry.type);
    },
  });
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

afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }), 300_000);

describe('production self-contained release asset', () => {
  it('rejects a truncated published archive before extraction', async () => {
    const tamperedArchive = path.join(root, 'tampered.tar');
    fs.copyFileSync(path.join(publicationDir, 'asset.tar'), tamperedArchive);
    fs.appendFileSync(tamperedArchive, 'tampered');

    await expect(verifyDetachedDigest(tamperedArchive, path.join(publicationDir, 'asset.tar.sha256'))).rejects.toThrow(/digest mismatch/i);
  });

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

  it('installs from pipeline output without invoking npm', async () => {
    const installerEntry = validateEntryBelowRoot(path.join(INSTALLER_DIR, 'dist', 'installer.js'), INSTALLER_DIR);
    const installerModule = pathToFileURL(installerEntry).href;
    const resultMarker = '__PD_INSTALL_RESULT__';
    const runner = `import { install } from ${JSON.stringify(installerModule)};\nconst result=await install({language:'en',mode:'force',workspaceDir:process.argv[1],channels:['prompt','defer_archive','code_tool_hook'],overwriteConfig:false,host:'openclaw',stopGateway:false},process.argv[2],{quiet:true,nonInteractive:true});\nprocess.stdout.write(${JSON.stringify(resultMarker)}+JSON.stringify(result));`;
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', runner, workspaceDir, assetDir],
      {
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, PD_SKIP_NPM_UPGRADE: '1', PD_SKIP_GLOBAL_SHIM: '1' },
        timeout: 600_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
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
