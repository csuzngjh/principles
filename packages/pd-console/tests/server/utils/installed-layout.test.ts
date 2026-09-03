/**
 * installed-layout util — single authority for the installed PD plugin
 * location and version (read by the update page and health diagnostics).
 *
 * Regression context (PRI-649): HealthCheckModel previously resolved the PD
 * version via a fixed five-level relative path that only matched the dev
 * tree; in the installed legacy layout it returned 'unknown' forever.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readInstalledPdVersion,
  readCurrentVersion,
  resolveExtensionsDir,
  resolvePluginDir,
} from '../../../src/server/utils/installed-layout.js';

describe('installed-layout', () => {
  let tmpDir: string;
  let savedOpenclawHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-installed-layout-test-'));
    savedOpenclawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = tmpDir;
  });

  afterEach(() => {
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
});
