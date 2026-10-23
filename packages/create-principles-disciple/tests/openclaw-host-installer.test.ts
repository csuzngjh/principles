/**
 * Boundary regression tests for OpenClawHostInstaller (PRI-1021).
 *
 * `~/.openclaw/plugins/installs.json` is the OpenClaw host's own plugin
 * install index. Since OpenClaw 2026.10.5, the mere presence of that legacy
 * file makes `openclaw doctor --fix` refuse its state-migration chain, which
 * in turn blocks gateway startup (exit code 78). PD previously created it on
 * every install, so PD installs were bricking OpenClaw upgrades.
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
import type { HostInstallContext } from '@principles/core/host';

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
    fs.writeFileSync(
      path.join(openclawDir(), 'openclaw.json'),
      JSON.stringify({ gateway: { port: 18789 }, plugins: { entries: {} } }, null, 2),
    );

    const result = await new OpenClawHostInstaller().install(makeCtx());

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(openclawDir(), 'plugins', 'installs.json'))).toBe(false);
    expect(fs.existsSync(path.join(openclawDir(), 'plugins'))).toBe(false);
  });

  it('still registers PD in openclaw.json', async () => {
    const configPath = path.join(openclawDir(), 'openclaw.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          gateway: { port: 18789 },
          plugins: { allow: ['feishu'], entries: { 'principles-disciple': { enabled: false } } },
        },
        null,
        2,
      ),
    );

    const result = await new OpenClawHostInstaller().install(makeCtx());

    expect(result.success).toBe(true);
    expect(result.configAction).toBe('updated');
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.plugins.allow).toContain('principles-disciple');
    expect(written.plugins.entries['principles-disciple'].enabled).toBe(true);
    expect(written.plugins.entries['principles-disciple'].hooks.allowConversationAccess).toBe(true);
  });

  it('leaves a pre-existing installs.json byte-identical', async () => {
    fs.writeFileSync(
      path.join(openclawDir(), 'openclaw.json'),
      JSON.stringify({ plugins: { entries: {} } }, null, 2),
    );
    const installsPath = path.join(openclawDir(), 'plugins', 'installs.json');
    fs.mkdirSync(path.dirname(installsPath), { recursive: true });
    const original = JSON.stringify(
      { version: 1, installRecords: { other: { source: 'path' } } },
      null,
      2,
    );
    fs.writeFileSync(installsPath, original);

    const result = await new OpenClawHostInstaller().install(makeCtx());

    expect(result.success).toBe(true);
    expect(fs.readFileSync(installsPath, 'utf-8')).toBe(original);
  });
});
