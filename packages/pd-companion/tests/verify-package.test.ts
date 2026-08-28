import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as asar from '@electron/asar';
import {
  MAIN_ENTRY,
  RUNTIME_DEPENDENCY,
  locatePackagedAppAsar,
  verifyPackagedApp,
} from '../scripts/verify-package.mjs';

/**
 * The packaged-artifact contract: app.asar must contain the Electron main
 * entry AND the runtime dependency's executable JS, and the packaged main
 * entry must be able to resolve + load that dependency. These tests build
 * miniature real asar archives with @electron/asar (the same library
 * electron-builder uses) so every failure mode — missing dependency, empty
 * executable JS, missing main entry, missing archive — fails loud without a
 * full electron-builder run.
 */

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-verify-pkg-'));

afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }), 60_000);

/**
 * Build a minimal packaged-app tree and pack it into a real app.asar.
 * Fixture names are contained under the mkdtemp root before any filesystem
 * use (resolve + explicit boundary check; no traversal fragments accepted).
 */
async function buildAppAsar(
  fixtureName: string,
  {
    includeDependency = true,
    includeMain = true,
    dependencyJs = 'export function getInstallLayoutPaths(h) { return { runtimeDir: h }; }\n',
  }: { includeDependency?: boolean; includeMain?: boolean; dependencyJs?: string } = {},
): Promise<string> {
  const appDir = path.resolve(root, fixtureName);
  if (appDir === root || !appDir.startsWith(root + path.sep)) {
    throw new Error(`fixture name escapes the test root: ${fixtureName}`);
  }
  fs.mkdirSync(path.join(appDir, 'dist', 'main'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: '@principles/pd-companion', version: '0.0.0-test', main: MAIN_ENTRY }));
  if (includeMain) {
    fs.writeFileSync(path.join(appDir, 'dist', 'main', 'main.js'), '// compiled main\n');
  }
  if (includeDependency) {
    fs.mkdirSync(path.join(appDir, 'node_modules', '@principles', 'install-layout', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'node_modules', '@principles', 'install-layout', 'package.json'), JSON.stringify({ name: RUNTIME_DEPENDENCY, version: '0.0.0-test', type: 'module', main: './dist/index.js' }));
    fs.writeFileSync(path.join(appDir, 'node_modules', '@principles', 'install-layout', 'dist', 'index.js'), dependencyJs);
  }
  const archive = path.join(root, `${fixtureName}.asar`);
  await asar.createPackage(appDir, archive);
  return archive;
}

describe('packaged app verification', () => {
  it('accepts an app.asar that bundles the runtime dependency', async () => {
    const result = await verifyPackagedApp(await buildAppAsar('healthy'));
    expect(result.resolvedDependency).toContain('install-layout');
  });

  it('rejects an app.asar whose runtime dependency is missing', async () => {
    const archive = await buildAppAsar('no-dep', { includeDependency: false });
    await expect(verifyPackagedApp(archive)).rejects.toThrow(RUNTIME_DEPENDENCY);
  });

  it('rejects an app.asar whose dependency entry is empty (no executable JS)', async () => {
    const archive = await buildAppAsar('empty-dep', { dependencyJs: '' });
    await expect(verifyPackagedApp(archive)).rejects.toThrow(/empty/i);
  });

  it('rejects an app.asar missing the Electron main entry', async () => {
    const broken = await buildAppAsar('no-main', { includeDependency: false, includeMain: false });
    await expect(verifyPackagedApp(broken)).rejects.toThrow(/main/i);
  });

  it('rejects a missing archive with a next-action message', async () => {
    await expect(verifyPackagedApp(path.join(root, 'does-not-exist.asar'))).rejects.toThrow(/app\.asar not found[\s\S]*npm run dist/);
  });

  it('locatePackagedAppAsar finds win-unpacked/resources/app.asar', () => {
    const resources = path.join(root, 'release-locate', 'win-unpacked', 'resources');
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, 'app.asar'), 'stub');
    expect(locatePackagedAppAsar(path.join(root, 'release-locate'))).toBe(path.join(resources, 'app.asar'));
    expect(() => locatePackagedAppAsar(path.join(root, 'release-missing'))).toThrow(/npm run dist/);
  });
});
