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
    fs.writeFileSync(path.join(inputDir, component, 'package.json'), JSON.stringify({ name: component }));
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
  it('creates a self-contained platform asset and a manifest verified by the production verifier', () => {
    const { inputDir, outputDir } = createFixture();
    const script = path.resolve(__dirname, '..', 'scripts', 'build-release-asset.mjs');

    execFileSync(process.execPath, [script, '--input', inputDir, '--output', outputDir, '--platform', 'win32', '--arch', 'x64', '--node-abi', '127'], {
      stdio: 'pipe',
    });

    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(outputDir, '_release', 'manifest.json'), 'utf-8'));
    verifyReleaseAssetManifest(outputDir, parseReleaseAssetManifest(manifest));
    expect(fs.existsSync(path.join(outputDir, 'plugin', 'node_modules', 'runtime-dependency', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, '_release', 'asset.json'))).toBe(true);
  });
});
