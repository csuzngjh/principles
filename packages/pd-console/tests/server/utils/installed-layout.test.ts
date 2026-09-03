/**
 * installed-layout util — single authority for the installed PD plugin
 * location and version (read by the update page and health diagnostics).
 *
 * Regression context (PRI-649): HealthCheckModel previously resolved the PD
 * version via a fixed five-level relative path that only matched the dev
 * tree; in the installed legacy layout it returned 'unknown' forever.
 *
 * Layout resolution depends on BOTH os.homedir() (canonical ~/.pd/runtime,
 * per install-layout getInstallLayoutPaths) and OPENCLAW_HOME (legacy
 * extension dir). Both are pinned to isolated temp dirs per test so a dev
 * machine that itself carries a real canonical or legacy install cannot leak
 * into the fixtures.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// os.homedir() drives canonical path resolution; mock the module so
// `import * as os` in the test file and in installed-layout.ts resolves to
// the same controllable namespace.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const realHomedir = actual.homedir.bind(actual);
  return { ...actual, homedir: vi.fn(() => realHomedir()) };
});

import {
  readInstalledPdVersion,
  readCurrentVersion,
  resolveExtensionsDir,
  resolvePluginDir,
  resolveUpdateLayout,
} from '../../../src/server/utils/installed-layout.js';

describe('installed-layout', () => {
  let tmpDir: string;
  let savedOpenclawHome: string | undefined;
  let homedirDefaultImpl: (() => string) | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-installed-layout-test-'));
    savedOpenclawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = tmpDir;

    // Pin homedir to the empty fixture home: no ~/.pd/install.json and no
    // ~/.pd/runtime there, so canonical resolution stays inert unless a test
    // creates its own canonical fixture (see canonical cases below).
    const homedirMock = vi.mocked(os.homedir);
    homedirDefaultImpl = homedirMock.getMockImplementation();
    homedirMock.mockImplementation(() => tmpDir);
  });

  afterEach(() => {
    const homedirMock = vi.mocked(os.homedir);
    if (homedirDefaultImpl) homedirMock.mockImplementation(homedirDefaultImpl);
    else homedirMock.mockReset();
    if (savedOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = savedOpenclawHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function installLegacyPlugin(version: string): string {
    const pluginDir = path.join(tmpDir, 'extensions', 'principles-disciple');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'principles-disciple', version }),
    );
    return pluginDir;
  }

  /** Create a canonical fixture home: manifest + runtime/plugin/package.json. */
  function installCanonicalHome(version: string): string {
    const canonicalHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-canonical-'));
    const runtimeDir = path.join(canonicalHome, '.pd', 'runtime');
    const pluginDir = path.join(runtimeDir, 'plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(canonicalHome, '.pd', 'install.json'),
      JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'] }),
    );
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'principles-disciple', version }),
    );
    return canonicalHome;
  }

  it('resolves the legacy extension dir under OPENCLAW_HOME', () => {
    expect(resolveExtensionsDir()).toBe(path.join(tmpDir, 'extensions'));
  });

  it('readInstalledPdVersion reads the installed plugin package.json version', () => {
    installLegacyPlugin('1.227.0');
    expect(resolvePluginDir('')).toBe(path.join(tmpDir, 'extensions', 'principles-disciple'));
    expect(readInstalledPdVersion()).toBe('1.227.0');
  });

  it('readInstalledPdVersion returns undefined when no plugin is installed', () => {
    expect(readInstalledPdVersion()).toBeUndefined();
  });

  it('readCurrentVersion returns undefined for malformed package.json instead of throwing (rc-3)', () => {
    const pluginDir = installLegacyPlugin('1.0.0');
    fs.writeFileSync(path.join(pluginDir, 'package.json'), '{ not json');
    expect(readCurrentVersion(pluginDir)).toBeUndefined();
  });

  it('readCurrentVersion returns undefined when the version field is not a string (rc-1)', () => {
    const pluginDir = installLegacyPlugin('1.0.0');
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'principles-disciple', version: 42 }),
    );
    expect(readCurrentVersion(pluginDir)).toBeUndefined();
  });

  // ── Canonical layout ─────────────────────────────────────────────────────

  it('resolves canonical runtime layout when install.json manifest + runtime dir exist', () => {
    const canonicalHome = installCanonicalHome('9.9.9');
    const pluginDir = path.join(canonicalHome, '.pd', 'runtime', 'plugin');

    const homedirMock = vi.mocked(os.homedir);
    homedirMock.mockImplementation(() => canonicalHome);
    try {
      const layout = resolveUpdateLayout();
      expect(layout).toBeDefined();
      expect(layout?.pluginDir).toBe(pluginDir);
      expect(resolvePluginDir('')).toBe(pluginDir);
      expect(readInstalledPdVersion()).toBe('9.9.9');
    } finally {
      homedirMock.mockImplementation(() => tmpDir);
      fs.rmSync(canonicalHome, { recursive: true, force: true });
    }
  });

  it('canonical layout wins when both canonical and legacy layouts exist (install-layout precedence)', () => {
    // Legacy fixture (under OPENCLAW_HOME)
    installLegacyPlugin('1.0.0');

    // Canonical fixture (under mocked homedir)
    const canonicalHome = installCanonicalHome('9.9.9');
    const pluginDir = path.join(canonicalHome, '.pd', 'runtime', 'plugin');

    const homedirMock = vi.mocked(os.homedir);
    homedirMock.mockImplementation(() => canonicalHome);
    try {
      // Both layouts exist; canonical should win.
      expect(resolvePluginDir('')).toBe(pluginDir);
      expect(readInstalledPdVersion()).toBe('9.9.9');
    } finally {
      homedirMock.mockImplementation(() => tmpDir);
      fs.rmSync(canonicalHome, { recursive: true, force: true });
    }
  });
});
