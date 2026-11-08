/**
 * Parity pin: the installer's LOCAL plugin-state judgment
 * (readWorkbuddyPluginState) must produce IDENTICAL outputs to the shared
 * install-layout interpreter (interpretWorkbuddyPluginState) that pd-cli
 * health applies — the mirror discipline of the Codex legacy-registration
 * parser. The runtime import cannot exist (the packaged installer must keep
 * loading against the PUBLISHED install-layout), so this matrix IS the
 * single-semantic-definition guarantee.
 *
 * Fixture matrix covers every tri-state combination the two readers can
 * observe, including the unreadable shapes. Values live in one table so a
 * semantic change must consciously update BOTH sides.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { interpretWorkbuddyPluginState, WORKBUDDY_PLUGIN_KEY } from '@principles/install-layout';
import { readWorkbuddyPluginState, resolveWorkbuddyPaths } from '../src/installers/workbuddy-host-installer.js';

let home = '';
let configDir = '';
let previousConfigDir: string | undefined;

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'pd-wb-parity-'));
  configDir = mkdtempSync(path.join(os.tmpdir(), 'pd-wb-parity-cfg-'));
  previousConfigDir = process.env.WORKBUDDY_CONFIG_DIR;
  process.env.WORKBUDDY_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
  else process.env.WORKBUDDY_CONFIG_DIR = previousConfigDir;
  rmSync(home, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

interface MatrixRow {
  name: string;
  registry: () => void;
  settings: (dir: string) => void;
  expect: { registered: boolean; registryReadable: boolean; enabled: boolean | null };
}

const MATRIX: MatrixRow[] = [
  {
    name: 'registered + enabled',
    registry: () => writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { [WORKBUDDY_PLUGIN_KEY]: [{ scope: 'user' }] } }),
    settings: (dir) => writeJson(path.join(dir, 'settings.json'), { enabledPlugins: { [WORKBUDDY_PLUGIN_KEY]: true } }),
    expect: { registered: true, registryReadable: true, enabled: true },
  },
  {
    name: 'registered + disabled',
    registry: () => writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { [WORKBUDDY_PLUGIN_KEY]: [{ scope: 'user' }] } }),
    settings: (dir) => writeJson(path.join(dir, 'settings.json'), { enabledPlugins: { [WORKBUDDY_PLUGIN_KEY]: false } }),
    expect: { registered: true, registryReadable: true, enabled: false },
  },
  {
    name: 'registered + settings key absent → enablement unknown',
    registry: () => writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { [WORKBUDDY_PLUGIN_KEY]: [{ scope: 'user' }] } }),
    settings: (dir) => writeJson(path.join(dir, 'settings.json'), { enabledPlugins: {} }),
    expect: { registered: true, registryReadable: true, enabled: null },
  },
  {
    name: 'not registered (registry readable)',
    registry: () => writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: {} }),
    settings: (dir) => writeJson(path.join(dir, 'settings.json'), { enabledPlugins: { [WORKBUDDY_PLUGIN_KEY]: true } }),
    expect: { registered: false, registryReadable: true, enabled: true },
  },
  {
    name: 'both files absent → readable-absent, nothing claimed',
    registry: () => undefined,
    settings: () => undefined,
    expect: { registered: false, registryReadable: true, enabled: null },
  },
  {
    name: 'registry malformed → unreadable',
    registry: () => {
      mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
      writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), '{ broken', 'utf-8');
    },
    settings: (dir) => writeJson(path.join(dir, 'settings.json'), { enabledPlugins: { [WORKBUDDY_PLUGIN_KEY]: true } }),
    expect: { registered: false, registryReadable: false, enabled: true },
  },
  {
    name: 'settings malformed → enablement unknown',
    registry: () => writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { [WORKBUDDY_PLUGIN_KEY]: [{ scope: 'user' }] } }),
    settings: (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'settings.json'), '{ broken', 'utf-8');
    },
    expect: { registered: true, registryReadable: true, enabled: null },
  },
  {
    name: 'non-object JSON values → unreadable/unknown (readers reject arrays and primitives)',
    registry: () => {
      mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
      writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), '[1,2]', 'utf-8');
    },
    settings: (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'settings.json'), '"str"', 'utf-8');
    },
    expect: { registered: false, registryReadable: false, enabled: null },
  },
];

describe('installer plugin-state == install-layout shared interpreter (mirror parity)', () => {
  for (const row of MATRIX) {
    it(`parity: ${row.name}`, () => {
      row.registry();
      row.settings(configDir);
      const paths = resolveWorkbuddyPaths(home);
      const installerView = readWorkbuddyPluginState(paths);
      // The install-layout interpreter consumes the same parsed values the
      // installer's readers see (registry readable == its read+parse ok).
      const shared = interpretWorkbuddyPluginState({
        registryParsed: readJsonOrUndefined(paths.registryPath),
        settingsParsed: readJsonOrUndefined(paths.settingsPath),
        registryReadable: installerView.registryReadable,
      });
      expect(installerView).toEqual(row.expect);
      expect(shared).toEqual(row.expect);
      expect(installerView).toEqual(shared);
    });
  }
});

function readJsonOrUndefined(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}
