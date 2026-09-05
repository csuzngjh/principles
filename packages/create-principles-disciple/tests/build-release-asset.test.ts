import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReleaseAssetManifest, verifyReleaseAssetManifest } from '../src/update/release-asset-manifest.js';

const temporaryDirectories: string[] = [];

function createFixture(): { inputDir: string; outputDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-release-build-'));
  temporaryDirectories.push(root);
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  // PRI-672: release-manager joined the shipped component set — the fixture
  // mirrors REQUIRED_COMPONENTS in build-release-asset.mjs.
  for (const component of ['plugin', 'console', 'core', 'pd-cli', 'host-runtime', 'install-layout', 'release-manager']) {
    fs.mkdirSync(path.join(inputDir, component, 'node_modules', 'runtime-dependency'), { recursive: true });
    fs.writeFileSync(path.join(inputDir, component, 'package.json'), JSON.stringify({
      name: component,
      dependencies: { 'runtime-dependency': '1.0.0' },
    }));
    fs.writeFileSync(path.join(inputDir, component, 'node_modules', 'runtime-dependency', 'index.js'), 'module.exports = true;');
  }
  return { inputDir, outputDir };
}

function buildArchive(inputDir: string, outputDir: string, archivePath: string, digestPath: string): void {
  const script = path.resolve(__dirname, '..', 'scripts', 'build-release-asset.mjs');
  execFileSync(process.execPath, [script, '--input', inputDir, '--output', outputDir, '--archive', archivePath, '--digest-output', digestPath, '--platform', 'win32', '--arch', 'x64', '--node-abi', '127'], {
    env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' },
    stdio: 'pipe',
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('build-release-asset', () => {
  it('refuses to replace an existing immutable release output before building', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-release-existing-'));
    temporaryDirectories.push(root);
    const outputDir = path.join(root, 'published');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, 'sentinel.txt'), 'keep');
    const script = path.resolve(__dirname, '..', 'scripts', 'build-self-contained-release.mjs');

    expect(() => execFileSync(process.execPath, [script, '--output', outputDir], {
      stdio: 'pipe',
    })).toThrow();
    expect(fs.readFileSync(path.join(outputDir, 'sentinel.txt'), 'utf8')).toBe('keep');

    const { inputDir } = createFixture();
    const assetScript = path.resolve(__dirname, '..', 'scripts', 'build-release-asset.mjs');
    expect(() => execFileSync(process.execPath, [assetScript, '--input', inputDir, '--output', outputDir, '--platform', 'win32', '--arch', 'x64', '--node-abi', '127'], {
      stdio: 'pipe',
    })).toThrow();
    expect(fs.readFileSync(path.join(outputDir, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('refuses to label a local native build as another platform before staging', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-release-target-'));
    temporaryDirectories.push(root);
    const outputDir = path.join(root, 'asset');
    const script = path.resolve(__dirname, '..', 'scripts', 'build-self-contained-release.mjs');
    const mismatchedPlatform = process.platform === 'win32' ? 'linux' : 'win32';

    expect(() => execFileSync(process.execPath, [script, '--output', outputDir, '--platform', mismatchedPlatform], {
      stdio: 'pipe',
    })).toThrow();
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('creates a self-contained platform asset and a manifest verified by the production verifier', () => {
    const { inputDir, outputDir } = createFixture();
    const inputBin = path.join(inputDir, 'plugin', 'node_modules', '.bin');
    fs.mkdirSync(inputBin, { recursive: true });
    fs.writeFileSync(path.join(inputBin, 'runtime-tool'), 'build-only shim');
    const script = path.resolve(__dirname, '..', 'scripts', 'build-release-asset.mjs');

    execFileSync(process.execPath, [script, '--input', inputDir, '--output', outputDir, '--platform', 'win32', '--arch', 'x64', '--node-abi', '127'], {
      stdio: 'pipe',
    });

    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(outputDir, '_release', 'manifest.json'), 'utf-8'));
    verifyReleaseAssetManifest(outputDir, parseReleaseAssetManifest(manifest));
    expect(fs.existsSync(path.join(outputDir, 'plugin', 'node_modules', 'runtime-dependency', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'plugin', 'node_modules', '.bin'))).toBe(false);
    expect(fs.readFileSync(path.join(inputBin, 'runtime-tool'), 'utf8')).toBe('build-only shim');
    expect(fs.existsSync(path.join(outputDir, '_release', 'asset.json'))).toBe(true);
  });

  it('creates byte-identical immutable archives and detached digests from the same source', () => {
    const first = createFixture();
    const second = createFixture();
    const firstArchive = path.join(path.dirname(first.outputDir), 'first.tar');
    const secondArchive = path.join(path.dirname(second.outputDir), 'second.tar');
    const firstDigest = `${firstArchive}.sha256`;
    const secondDigest = `${secondArchive}.sha256`;

    buildArchive(first.inputDir, first.outputDir, firstArchive, firstDigest);
    buildArchive(second.inputDir, second.outputDir, secondArchive, secondDigest);

    expect(fs.readFileSync(firstArchive)).toEqual(fs.readFileSync(secondArchive));
    expect(fs.readFileSync(firstDigest, 'utf8')).toMatch(/^[a-f0-9]{64}\n$/);
    expect(fs.readFileSync(firstDigest, 'utf8')).toBe(fs.readFileSync(secondDigest, 'utf8'));
    expect(fs.existsSync(path.join(first.outputDir, '_release', path.basename(firstDigest)))).toBe(false);
  });

  it('changes archive bytes and digest when one source byte changes', () => {
    const first = createFixture();
    const second = createFixture();
    fs.writeFileSync(path.join(second.inputDir, 'core', 'node_modules', 'runtime-dependency', 'index.js'), 'module.exports = false;');
    const firstArchive = path.join(path.dirname(first.outputDir), 'first.tar');
    const secondArchive = path.join(path.dirname(second.outputDir), 'second.tar');

    buildArchive(first.inputDir, first.outputDir, firstArchive, `${firstArchive}.sha256`);
    buildArchive(second.inputDir, second.outputDir, secondArchive, `${secondArchive}.sha256`);

    expect(fs.readFileSync(firstArchive)).not.toEqual(fs.readFileSync(secondArchive));
    expect(fs.readFileSync(`${firstArchive}.sha256`, 'utf8')).not.toBe(fs.readFileSync(`${secondArchive}.sha256`, 'utf8'));
  });

  it('refuses missing or invalid SOURCE_DATE_EPOCH and existing archive outputs', () => {
    const { inputDir, outputDir } = createFixture();
    const script = path.resolve(__dirname, '..', 'scripts', 'build-release-asset.mjs');
    const archivePath = path.join(path.dirname(outputDir), 'asset.tar');
    const digestPath = `${archivePath}.sha256`;
    const args = [script, '--input', inputDir, '--output', outputDir, '--archive', archivePath, '--digest-output', digestPath, '--platform', 'win32', '--arch', 'x64', '--node-abi', '127'];

    expect(() => execFileSync(process.execPath, args, { env: { ...process.env, SOURCE_DATE_EPOCH: '' }, stdio: 'pipe' })).toThrow();
    expect(fs.existsSync(outputDir)).toBe(false);
    expect(() => execFileSync(process.execPath, args, { env: { ...process.env, SOURCE_DATE_EPOCH: 'not-an-epoch' }, stdio: 'pipe' })).toThrow();
    fs.writeFileSync(archivePath, 'immutable');
    expect(() => execFileSync(process.execPath, args, { env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' }, stdio: 'pipe' })).toThrow();
    expect(fs.readFileSync(archivePath, 'utf8')).toBe('immutable');
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('refuses self-referential archive and digest paths without mutating source', () => {
    const { inputDir, outputDir } = createFixture();
    const script = path.resolve(__dirname, '..', 'scripts', 'build-release-asset.mjs');
    const sourceSnapshot = fs.readFileSync(path.join(inputDir, 'plugin', 'package.json'), 'utf8');

    expect(() => execFileSync(process.execPath, [script, '--input', inputDir, '--output', outputDir, '--archive', path.join(outputDir, 'asset.tar'), '--digest-output', path.join(outputDir, 'asset.sha256'), '--platform', 'win32', '--arch', 'x64', '--node-abi', '127'], {
      env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' },
      stdio: 'pipe',
    })).toThrow();
    expect(fs.existsSync(outputDir)).toBe(false);
    expect(fs.readFileSync(path.join(inputDir, 'plugin', 'package.json'), 'utf8')).toBe(sourceSnapshot);
  });

  it('rejects an archive parent alias into the input and removes its owned output', () => {
    const { inputDir, outputDir } = createFixture();
    const alias = path.join(path.dirname(inputDir), 'input-alias');
    fs.symlinkSync(inputDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const script = path.resolve(__dirname, '..', 'scripts', 'build-release-asset.mjs');

    expect(() => execFileSync(process.execPath, [script, '--input', inputDir, '--output', outputDir, '--archive', path.join(alias, 'asset.tar'), '--digest-output', path.join(alias, 'asset.tar.sha256'), '--platform', 'win32', '--arch', 'x64', '--node-abi', '127'], {
      env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' },
      stdio: 'pipe',
    })).toThrow();
    expect(fs.existsSync(outputDir)).toBe(false);
    expect(fs.existsSync(path.join(inputDir, 'asset.tar'))).toBe(false);
  });

  it('removes a partially published archive when the detached digest cannot be created', async () => {
    const { inputDir, outputDir } = createFixture();
    const script = path.resolve(__dirname, '..', 'scripts', 'build-release-asset.mjs');
    const archivePath = path.join(path.dirname(outputDir), 'mid-failure.tar');
    const digestPath = `${archivePath}.sha256`;
    // A file occupying the digest's parent directory makes the digest open
    // fail after the archive fd is already held — the failure the cleanup
    // contract exists for.
    const digestParentBlocker = path.join(`${archivePath}.sha256-parent`, 'blocker');
    fs.mkdirSync(path.dirname(digestParentBlocker), { recursive: true });
    fs.writeFileSync(digestParentBlocker, 'not a directory');
    const blockedDigestPath = path.join(digestParentBlocker, 'digest.txt');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const validatedScript = path.resolve(script);

    await expect(execFileAsync(process.execPath, [validatedScript, '--input', inputDir, '--output', outputDir, '--archive', archivePath, '--digest-output', blockedDigestPath, '--platform', 'win32', '--arch', 'x64', '--node-abi', '127'], {
      env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' },
    })).rejects.toThrow();
    expect(fs.existsSync(archivePath)).toBe(false);
    expect(fs.existsSync(digestPath)).toBe(false);
    expect(fs.existsSync(blockedDigestPath)).toBe(false);
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('rejects release input missing a declared runtime dependency', () => {
    const { inputDir, outputDir } = createFixture();
    fs.rmSync(path.join(inputDir, 'pd-cli', 'node_modules', 'runtime-dependency'), { recursive: true });
    const script = path.resolve(__dirname, '..', 'scripts', 'build-release-asset.mjs');

    expect(() => execFileSync(process.execPath, [script, '--input', inputDir, '--output', outputDir, '--platform', 'win32', '--arch', 'x64', '--node-abi', '127'], {
      stdio: 'pipe',
    })).toThrow();
  });

  it.skipIf(process.platform === 'win32')('removes POSIX npm build-only .bin links while rejecting every other symlink', () => {
    const { inputDir, outputDir } = createFixture();
    const binDir = path.join(inputDir, 'plugin', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync('../runtime-dependency/index.js', path.join(binDir, 'runtime-tool'));
    const script = path.resolve(__dirname, '..', 'scripts', 'build-release-asset.mjs');

    execFileSync(process.execPath, [script, '--input', inputDir, '--output', outputDir, '--platform', 'linux', '--arch', 'x64', '--node-abi', '127'], {
      stdio: 'pipe',
    });
    expect(fs.existsSync(path.join(outputDir, 'plugin', 'node_modules', '.bin'))).toBe(false);
    expect(fs.existsSync(path.join(inputDir, 'plugin', 'node_modules', '.bin', 'runtime-tool'))).toBe(true);

    execFileSync(process.execPath, [script, '--input', inputDir, '--output', inputDir, '--in-place', 'true', '--platform', 'linux', '--arch', 'x64', '--node-abi', '127'], {
      stdio: 'pipe',
    });
    expect(fs.existsSync(path.join(inputDir, 'plugin', 'node_modules', '.bin'))).toBe(false);

    fs.symlinkSync('index.js', path.join(inputDir, 'core', 'node_modules', 'runtime-dependency', 'unsafe-link'));
    expect(() => execFileSync(process.execPath, [script, '--input', inputDir, '--output', inputDir, '--in-place', 'true', '--platform', 'linux', '--arch', 'x64', '--node-abi', '127'], {
      stdio: 'pipe',
    })).toThrow();
  });
});
