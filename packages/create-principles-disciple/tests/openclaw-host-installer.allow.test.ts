/**
 * Regression tests for OpenClawHostInstaller.install() plugins.allow handling.
 *
 * Bug being locked out: install() used to CREATE plugins.allow =
 * ["principles-disciple"] when the key was absent. OpenClaw semantics: once
 * plugins.allow is non-empty, every discovered non-bundled plugin NOT on the
 * list is silently disabled — so on machines that already auto-load other
 * plugins (feishu / tavily / ...), installing PD silently disabled them.
 *
 * Contract after the fix:
 * - allow absent  → stays absent (auto-load behavior preserved)
 * - allow present → principles-disciple appended if missing, other ids kept
 * - allow malformed (non-array) → install() fails loud with reason
 *
 * Real filesystem with os.homedir redirected to a temp dir (never touches
 * the real ~/.openclaw).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const state = vi.hoisted(() => ({ home: '' }));

// Redirect os.homedir so getOpenClawDir() resolves inside the temp sandbox.
// The class under test builds its own paths from os.homedir(), so this is the
// only seam needed — no fs mocking, tests run against the real filesystem.
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

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-allow-test-'));
  state.home = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.openclaw'), { recursive: true });
});

afterEach(() => {
  state.home = '';
  if (tmpHome && fs.existsSync(tmpHome)) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

function writeConfig(config: unknown): string {
  const configPath = path.join(tmpHome, '.openclaw', 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function readConfig(): Record<string, unknown> {
  const configPath = path.join(tmpHome, '.openclaw', 'openclaw.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
}

describe('OpenClawHostInstaller.install() — plugins.allow handling', () => {
  it('does NOT create plugins.allow when the key is absent (would disable other plugins)', async () => {
    writeConfig({ plugins: { entries: { feishu: { enabled: true } } } });

    const result = await new OpenClawHostInstaller().install(makeCtx());

    expect(result.success).toBe(true);
    const written = readConfig();
    const plugins = written.plugins as Record<string, unknown> | undefined;
    expect(plugins).toBeDefined();
    // The critical invariant: no allow key was created
    expect(Object.hasOwn(plugins!, 'allow')).toBe(false);
    // feishu entry untouched, PD entry enabled
    const entries = plugins!.entries as Record<string, unknown>;
    expect(entries['feishu']).toEqual({ enabled: true });
    expect((entries['principles-disciple'] as Record<string, unknown>)['enabled']).toBe(true);
    // Operator-visible note about why allow was left alone (rc-9)
    expect(result.nextAction).toContain('plugins.allow');
  });

  it('appends principles-disciple to an EXISTING allow list, preserving other ids', async () => {
    writeConfig({ plugins: { allow: ['feishu', 'tavily'], entries: {} } });

    const result = await new OpenClawHostInstaller().install(makeCtx());

    expect(result.success).toBe(true);
    const plugins = (readConfig().plugins as Record<string, unknown>);
    expect(plugins.allow).toEqual(['feishu', 'tavily', 'principles-disciple']);
  });

  it('keeps an existing allow list unchanged when principles-disciple is already listed', async () => {
    writeConfig({ plugins: { allow: ['principles-disciple', 'feishu'] } });

    const result = await new OpenClawHostInstaller().install(makeCtx());

    expect(result.success).toBe(true);
    const plugins = (readConfig().plugins as Record<string, unknown>);
    expect(plugins.allow).toEqual(['principles-disciple', 'feishu']);
  });

  it('fails loud when plugins.allow exists but is not an array', async () => {
    writeConfig({ plugins: { allow: 'nope' } });

    const result = await new OpenClawHostInstaller().install(makeCtx());

    // Caught by validateOpenClawConfig before install()'s own defensive
    // branch — both are fail-loud; assert the observable contract.
    expect(result.success).toBe(false);
    expect(result.reason).toContain('plugins.allow');
    expect(result.reason).toContain('array');
    // Fail-loud: the config file must be preserved untouched
    expect(readConfig()).toEqual({ plugins: { allow: 'nope' } });
  });
});
