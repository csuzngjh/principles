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
  for (const component of ['plugin', 'console', 'core', 'pd-cli', 'host-runtime', 'install-layout']) {
    fs.mkdirSync(path.join(inputDir, component, 'node_modules', 'runtime-dependency'), { recursive: true });
    fs.writeFileSync(path.join(inputDir, component, 'package.json'), JSON.stringify({
      name: component,
      dependencies: { 'runtime-dependency': '1.0.0' },
    }));
    fs.writeFileSync(path.join(inputDir, component, 'node_modules', 'runtime-dependency', 'index.js'), 'module.exports = true;');
  }
  return { inputDir, outputDir };
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
