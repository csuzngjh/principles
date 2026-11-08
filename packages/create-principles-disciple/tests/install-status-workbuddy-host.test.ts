/**
 * C4 (2026-11-07): the TOP-LEVEL install status must be truthful for a
 * WorkBuddy-only machine. checkInstallStatus('all') unions OpenClaw + Codex +
 * WorkBuddy PD-owned surfaces — the PD-owned local marketplace dir counts —
 * so a machine where ONLY WorkBuddy was installed must NOT be reported as
 * "PD is not installed".
 *
 * Full env pinning (HOME + USERPROFILE → sandbox) after the proven
 * uninstall-host-scoped pattern, so the real machine's ~/.openclaw, ~/.codex
 * and ~/.pd can never leak into the verdict.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkInstallStatus } from '../src/uninstaller.js';

const TMP = fs.realpathSync(os.tmpdir());

let savedEnv: Record<string, string | undefined> = {};
let sandbox = '';

function seedWorkbuddyOnly(): void {
  const marketplace = path.join(sandbox, '.pd', 'workbuddy-marketplace');
  fs.mkdirSync(path.join(marketplace, '.codebuddy-plugin'), { recursive: true });
  fs.writeFileSync(path.join(marketplace, '.codebuddy-plugin', 'marketplace.json'), JSON.stringify({ name: 'principles-disciple-market' }, null, 2));
  fs.mkdirSync(path.join(marketplace, 'principles-disciple', '.codebuddy-plugin'), { recursive: true });
  fs.writeFileSync(path.join(marketplace, 'principles-disciple', '.codebuddy-plugin', 'plugin.json'), JSON.stringify({ name: 'principles-disciple', version: '0.3.0' }, null, 2));
  const configDir = path.join(sandbox, '.workbuddy');
  fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'principles-disciple@principles-disciple-market': true } }, null, 2));
  fs.writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'principles-disciple@principles-disciple-market': [{ scope: 'user', version: '0.3.0' }] } }, null, 2));
}

function seedOpenClawAndCodex(): void {
  const extDir = path.join(sandbox, '.openclaw', 'extensions', 'principles-disciple');
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'package.json'), '{"name":"principles-disciple"}');
  const codexMarker = path.join(sandbox, '.pd', 'codex', 'pd-hooks.marker');
  fs.mkdirSync(path.dirname(codexMarker), { recursive: true });
  fs.writeFileSync(codexMarker, 'owned');
}

describe('C4 — top-level install status is truthful for WorkBuddy installs', () => {
  beforeEach(() => {
    savedEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      WORKBUDDY_CONFIG_DIR: process.env.WORKBUDDY_CONFIG_DIR,
    };
    sandbox = fs.mkdtempSync(path.join(TMP, 'pd-status-wb-'));
    process.env.HOME = sandbox;
    process.env.USERPROFILE = sandbox;
    delete process.env.WORKBUDDY_CONFIG_DIR;
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('WorkBuddy-only machine: top-level status reports INSTALLED (never "PD is not installed")', () => {
    seedWorkbuddyOnly();
    const status = checkInstallStatus('all');
    expect(status.isInstalled).toBe(true);
    const workbuddyRow = status.paths.find((p) => p.path.includes('workbuddy-marketplace'));
    expect(workbuddyRow?.exists).toBe(true);
  });

  it('multi-host machine: all host surfaces reported present', () => {
    seedWorkbuddyOnly();
    seedOpenClawAndCodex();
    const status = checkInstallStatus('all');
    expect(status.isInstalled).toBe(true);
    const presentRows = status.paths.filter((p) => p.exists);
    expect(presentRows.length).toBeGreaterThanOrEqual(3);
    expect(presentRows.some((p) => p.path.includes('.openclaw'))).toBe(true);
    expect(presentRows.some((p) => p.path.includes('codex'))).toBe(true);
    expect(presentRows.some((p) => p.path.includes('workbuddy-marketplace'))).toBe(true);
  });

  it('nothing installed: status stays honest (negative control)', () => {
    const status = checkInstallStatus('all');
    expect(status.isInstalled).toBe(false);
  });
});
