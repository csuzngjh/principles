/**
 * Boundary regression tests for OpenClawHostInstaller (PRI-1021).
 *
 * `~/.openclaw/plugins/installs.json` is the OpenClaw host's own plugin
 * install index. Since OpenClaw 2026.10.5, the mere presence of that legacy
 * file makes `openclaw doctor --fix` refuse its state-migration chain, which
 * in turn blocks gateway startup (exit code 78). PD wrote it on every install
 * that updated `openclaw.json`, so PD installs were bricking OpenClaw
 * upgrades.
 *
 * Contract after the fix: install() writes ONLY openclaw.json. It never
 * creates the `plugins` directory, never writes installs.json, and plugin
 * registration (allow list + entries + allowConversationAccess) still works.
 *
 * Real filesystem with os.homedir redirected to a temp dir (never touches
 * the real ~/.openclaw).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const state = vi.hoisted(() => ({ home: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => state.home,
  };
});

import { OpenClawHostInstaller } from '../src/installers/openclaw-host-installer.js';
import type { HostInstallContext, HostInstallResult } from '@principles/core/host';

let tmpHome: string;

function makeCtx(): HostInstallContext {
  return {
    workspaceDir: tmpHome,
    pluginDir: path.join(tmpHome, 'pkg'),
    language: 'zh',
    mode: 'smart',
  };
}

function openclawDir(): string {
  return path.join(tmpHome, '.openclaw');
}

function configPath(): string {
  return path.join(openclawDir(), 'openclaw.json');
}

function installsJsonPath(): string {
  return path.join(openclawDir(), 'plugins', 'installs.json');
}

function writeConfig(config: unknown): void {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
}

/**
 * Every case asserts this. `install()` also has a success:true /
 * configAction:'skipped' result for an unreadable openclaw.json, so `success`
 * alone would stay true if the os.homedir seam ever stopped applying — the
 * negative assertions would then pass vacuously while the code wrote to the
 * real ~/.openclaw.
 */
function expectRegisteredInSandbox(result: HostInstallResult): void {
  expect(result.success).toBe(true);
  expect(result.configAction).toBe('updated');
  expect(result.configPath).toBe(configPath());
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-installs-json-test-'));
  state.home = tmpHome;
  fs.mkdirSync(openclawDir(), { recursive: true });
});

afterEach(() => {
  state.home = '';
  if (tmpHome && fs.existsSync(tmpHome)) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

describe('OpenClawHostInstaller.install — host-owned install index boundary', () => {
  it('does not create ~/.openclaw/plugins/installs.json', async () => {
    writeConfig({ gateway: { port: 18789 }, plugins: { entries: {} } });

    const result = await new OpenClawHostInstaller().install(makeCtx());

    expectRegisteredInSandbox(result);
    expect(fs.existsSync(installsJsonPath())).toBe(false);
    expect(fs.existsSync(path.join(openclawDir(), 'plugins'))).toBe(false);
  });

  it('still registers PD in openclaw.json', async () => {
    writeConfig({
      gateway: { port: 18789 },
      plugins: { allow: ['feishu'], entries: { 'principles-disciple': { enabled: false } } },
    });

    const result = await new OpenClawHostInstaller().install(makeCtx());

    expectRegisteredInSandbox(result);
    const plugins = readConfig().plugins as Record<string, unknown>;
    expect(plugins.allow).toContain('principles-disciple');
    const entries = plugins.entries as Record<string, Record<string, unknown>>;
    expect(entries['principles-disciple'].enabled).toBe(true);
    const hooks = entries['principles-disciple'].hooks as Record<string, unknown>;
    expect(hooks.allowConversationAccess).toBe(true);
  });

  it('leaves a pre-existing installs.json byte-identical', async () => {
    writeConfig({ plugins: { entries: {} } });
    fs.mkdirSync(path.dirname(installsJsonPath()), { recursive: true });
    const original = JSON.stringify(
      { version: 1, installRecords: { other: { source: 'path' } } },
      null,
      2,
    );
    fs.writeFileSync(installsJsonPath(), original);

    const result = await new OpenClawHostInstaller().install(makeCtx());

    expectRegisteredInSandbox(result);
    expect(fs.readFileSync(installsJsonPath(), 'utf-8')).toBe(original);
  });
});
