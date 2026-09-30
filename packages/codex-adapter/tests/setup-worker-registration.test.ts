import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-setup-worker-'));
  roots.push(home);
  const workspace = path.join(home, '.codex', 'pd-workspace');
  fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), 'version: 1');
  const layout = path.join(home, '.pd', 'runtime', 'install-layout');
  fs.mkdirSync(layout, { recursive: true });
  fs.cpSync(path.join(repo, 'packages', 'install-layout', 'dist'), path.join(layout, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'packages', 'install-layout', 'package.json'), path.join(layout, 'package.json'));
  const manifest = path.join(home, '.pd', 'install.json');
  const previous = { layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'], workspaces: [path.join(home, 'openclaw')], channel: 'stable', releaseMetadataUrl: 'https://example.test/releases' };
  fs.writeFileSync(manifest, JSON.stringify(previous));
  const pluginData = path.join(home, 'plugin-data');
  const runtime = path.join(pluginData, 'runtime');
  const adapter = path.join(runtime, 'node_modules', '@principles', 'codex-adapter', 'dist');
  fs.mkdirSync(adapter, { recursive: true });
  fs.writeFileSync(path.join(adapter, 'pd-hook.js'), '');
  const pins = JSON.parse(fs.readFileSync(path.join(repo, 'plugins', 'principles-disciple', 'runtime-version.json'), 'utf8'));
  fs.writeFileSync(path.join(runtime, '.pd-runtime.json'), JSON.stringify(pins));
  const run = () => spawnSync(process.execPath, [path.join(repo, 'plugins', 'principles-disciple', 'scripts', 'pd-setup.cjs'), '--plugin-root', path.join(repo, 'plugins', 'principles-disciple'), '--plugin-data', pluginData, '--workspace', workspace, '--skip-init', '--ingest', 'skip', '--json'], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex') },
  });
  return { workspace, manifest, previous, run };
}

describe('real plugin setup connects the existing Companion worker', () => {
  it('finds the installer-owned CLI without relying on npm global shims', () => {
    const { workspace } = fixture();
    const home = path.resolve(workspace, '..', '..');
    const entry = path.join(home, '.pd', 'runtime', 'pd-cli', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '');
    const result = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(process.argv[1]).pdCliCommand()))', path.join(repo, 'plugins', 'principles-disciple', 'scripts', 'pd-locate.cjs')], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ command: process.execPath, prefix: [entry] });
  });

  it('registers Codex without losing OpenClaw or update settings, and rerunning does not duplicate workspaces', () => {
    const { workspace, manifest, previous, run } = fixture();
    for (let i = 0; i < 2; i += 1) {
      const result = run();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).workerRegistration).toMatchObject({ status: 'registered' });
      expect(JSON.parse(fs.readFileSync(manifest, 'utf8'))).toEqual({ ...previous, hosts: ['openclaw', 'codex'], workspaces: [...previous.workspaces, workspace] });
    }
  });

  it('refuses a malformed manifest and preserves its exact bytes', () => {
    const { manifest, run } = fixture();
    fs.writeFileSync(manifest, '{broken');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('worker_registration_failed');
    expect(fs.readFileSync(manifest, 'utf8')).toBe('{broken');
  });

  it('reports manual processing explicitly when no canonical installation exists', () => {
    const { manifest, run } = fixture();
    fs.unlinkSync(manifest);
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).workerRegistration).toMatchObject({ status: 'manual_action_required', reason: 'canonical_install_unavailable' });
    expect(fs.existsSync(manifest)).toBe(false);
  });
});
