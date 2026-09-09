/**
 * PRI-711 — codex-adapter runtime resolution links.
 *
 * Real-fs tests over ensureCodexAdapterResolution(): the installer step that
 * materializes the adapter's `file:../<component>` dependency links under
 * <home>/.pd/runtime. pd-cli's eager import graph statically resolves the
 * adapter (health-codex), so a bare adapter — exactly what installers before
 * PRI-711 laid down, because the release payload never shipped adapter
 * node_modules — crashed every pd command at startup with
 * ERR_MODULE_NOT_FOUND.
 *
 * The resolution assertions go through a real createRequire probe from the
 * adapter dir, the same lookup shape the ESM loader performs for the
 * adapter's bare imports (realpath parent chain), not through inspecting
 * link metadata alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureCodexAdapterResolution } from '../src/installer.js';

let fixtureRoot: string;

function runtimeDir(): string {
  return path.join(fixtureRoot, '.pd', 'runtime');
}

function adapterDir(): string {
  return path.join(runtimeDir(), 'codex-adapter');
}

function writeComponent(dirName: string, npmName: string): string {
  // Fixture inputs are literal component names; assert the boundary anyway so
  // the path stays inside the fixture root (same shape the production code
  // applies to untrusted layout refs).
  if (path.basename(dirName) !== dirName) throw new Error(`fixture component name must be a simple segment: ${dirName}`);
  const dir = path.join(runtimeDir(), dirName);
  if (!dir.startsWith(runtimeDir() + path.sep)) throw new Error('fixture component escaped the runtime dir');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: npmName, version: '0.0.0-test', main: './dist/entry.js' }),
  );
  fs.writeFileSync(path.join(dir, 'dist', 'entry.js'), 'export const marker = true;\n');
  return dir;
}

function writeAdapterManifest(dependencies: Record<string, string>): void {
  fs.mkdirSync(path.join(adapterDir(), 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(adapterDir(), 'package.json'),
    JSON.stringify({
      name: '@principles/codex-adapter',
      version: '0.0.0-test',
      type: 'module',
      main: './dist/index.js',
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    }),
  );
  fs.writeFileSync(path.join(adapterDir(), 'dist', 'index.js'), 'export const marker = true;\n');
}

function resolveFromAdapter(specifier: string): string {
  // A CJS probe file inside the adapter dir: resolution starts at the adapter
  // and walks the realpath parent chain — the same lookup the ESM loader
  // performs for the adapter's bare imports.
  return createRequire(path.join(adapterDir(), 'probe.cjs')).resolve(specifier);
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-adapter-resolution-'));
  vi.stubEnv('HOME', fixtureRoot);
  vi.stubEnv('USERPROFILE', fixtureRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('ensureCodexAdapterResolution', () => {
  it('materializes links for declared file:../ deps and the adapter can then resolve them', () => {
    const coreDir = writeComponent('core', '@principles/core');
    const hostRuntimeDir = writeComponent('host-runtime', '@principles/host-runtime');
    writeAdapterManifest({
      '@principles/core': 'file:../core',
      '@principles/host-runtime': 'file:../host-runtime',
    });

    ensureCodexAdapterResolution();

    expect(fs.realpathSync(path.join(adapterDir(), 'node_modules', '@principles', 'core'))).toBe(
      fs.realpathSync(coreDir),
    );
    expect(fs.realpathSync(path.join(adapterDir(), 'node_modules', '@principles', 'host-runtime'))).toBe(
      fs.realpathSync(hostRuntimeDir),
    );
    // The actual contract: bare imports from the adapter resolve.
    expect(resolveFromAdapter('@principles/host-runtime')).toContain(path.join('host-runtime', 'dist', 'entry.js'));
    expect(resolveFromAdapter('@principles/core')).toContain(path.join('core', 'dist', 'entry.js'));
  });

  it('is idempotent — a second run keeps correct links and still resolves', () => {
    writeComponent('core', '@principles/core');
    writeComponent('host-runtime', '@principles/host-runtime');
    writeAdapterManifest({ '@principles/host-runtime': 'file:../host-runtime' });

    ensureCodexAdapterResolution();
    ensureCodexAdapterResolution();

    expect(resolveFromAdapter('@principles/host-runtime')).toContain('entry.js');
  });

  it('reconciles a wrong-target link to the runtime sibling', () => {
    const hostRuntimeDir = writeComponent('host-runtime', '@principles/host-runtime');
    writeAdapterManifest({ '@principles/host-runtime': 'file:../host-runtime' });
    const wrongDir = path.join(fixtureRoot, 'unrelated');
    fs.mkdirSync(wrongDir, { recursive: true });
    const linkPath = path.join(adapterDir(), 'node_modules', '@principles', 'host-runtime');
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(wrongDir, linkPath, 'junction');

    ensureCodexAdapterResolution();

    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(hostRuntimeDir));
  });

  it('replaces a stale physical copy in the dependency slot', () => {
    const coreDir = writeComponent('core', '@principles/core');
    writeAdapterManifest({ '@principles/core': 'file:../core' });
    const slot = path.join(adapterDir(), 'node_modules', '@principles', 'core');
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(path.join(slot, 'stale.js'), 'export const stale = true;\n');

    ensureCodexAdapterResolution();

    expect(fs.realpathSync(slot)).toBe(fs.realpathSync(coreDir));
    expect(fs.existsSync(path.join(slot, 'stale.js'))).toBe(false);
  });

  it('fails loud when a declared sibling component is missing', () => {
    writeComponent('core', '@principles/core');
    writeAdapterManifest({ '@principles/host-runtime': 'file:../host-runtime' });

    expect(() => ensureCodexAdapterResolution()).toThrow(/sibling runtime component is missing/);
  });

  it('refuses traversal-shaped file refs (rc-1: manifest is untrusted input)', () => {
    writeComponent('core', '@principles/core');
    writeAdapterManifest({ 'evil/pkg': 'file:../../outside' });

    expect(() => ensureCodexAdapterResolution()).toThrow(/unsupported file dependency ref/);
  });
});
