import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  // Gate 4: this fixture runs pd-setup against the REPO plugin payload (its
  // historical shape), which now writes mcp-binding.json into the plugin
  // root — a machine-specific file that must never linger in the checkout.
  const leakedBinding = path.join(repo, 'plugins', 'principles-disciple', 'mcp-binding.json');
  if (fs.existsSync(leakedBinding)) fs.rmSync(leakedBinding, { force: true });
});

function fixture(extraEnv: Record<string, string> = {}) {
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
  // The MCP server entry the launcher binding points at must exist as a file.
  const mcpEntry = path.join(runtime, 'node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js');
  fs.mkdirSync(path.dirname(mcpEntry), { recursive: true });
  fs.writeFileSync(mcpEntry, '// fabricated entry for the registration fixture\n');
  const pins = JSON.parse(fs.readFileSync(path.join(repo, 'plugins', 'principles-disciple', 'runtime-version.json'), 'utf8')) as { codexAdapter: string; hostRuntime: string; core: string; mcpServer: string };
  // PRI-1046: setup verifies the installed manifests, not only the adapter entry,
  // so the fixture must fabricate the bytes a genuinely satisfied pin leaves
  // behind. The marker alone is no longer enough to short-circuit the install.
  for (const [name, version] of [['codex-adapter', pins.codexAdapter], ['host-runtime', pins.hostRuntime], ['core', pins.core], ['pd-mcp-server', pins.mcpServer]] as const) {
    const packageDir = path.join(runtime, 'node_modules', '@principles', name);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: `@principles/${name}`, version }));
  }
  fs.writeFileSync(path.join(runtime, '.pd-runtime.json'), JSON.stringify(pins));
  const run = () => spawnSync(process.execPath, [path.join(repo, 'plugins', 'principles-disciple', 'scripts', 'pd-setup.cjs'), '--plugin-root', path.join(repo, 'plugins', 'principles-disciple'), '--plugin-data', pluginData, '--workspace', workspace, '--skip-init', '--ingest', 'skip', '--json'], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), ...extraEnv },
  });
  return { home, workspace, manifest, previous, pins, runtime, run };
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
    // Gate 4: the MCP binding is written only after registration succeeds, so
    // a failed setup never leaves a binding the next launcher would trust.
    expect(fs.existsSync(path.join(repo, 'plugins', 'principles-disciple', 'mcp-binding.json'))).toBe(false);
  });

  it('reports manual processing explicitly when no canonical installation exists', () => {
    const { manifest, run } = fixture();
    fs.unlinkSync(manifest);
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).workerRegistration).toMatchObject({ status: 'manual_action_required', reason: 'canonical_install_unavailable' });
    expect(fs.existsSync(manifest)).toBe(false);
  });

  it('reports manual processing when a canonical manifest has no canonical runtime module', () => {
    const { home, manifest, previous, run } = fixture();
    fs.rmSync(path.join(home, '.pd', 'runtime', 'install-layout'), { recursive: true, force: true });
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('worker_registration_failed');
    expect(JSON.parse(result.stdout).workerRegistration).toMatchObject({ status: 'manual_action_required', reason: 'canonical_install_unavailable' });
    expect(JSON.parse(fs.readFileSync(manifest, 'utf8'))).toEqual(previous);
  });

  it('reports manual processing for a legacy manifest without requiring the canonical module', () => {
    const { home, manifest, run } = fixture();
    fs.rmSync(path.join(home, '.pd', 'runtime', 'install-layout'), { recursive: true, force: true });
    fs.writeFileSync(manifest, JSON.stringify({ layoutVersion: 1, mode: 'legacy', hosts: ['openclaw'] }));
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('worker_registration_failed');
    expect(JSON.parse(result.stdout).workerRegistration).toMatchObject({ status: 'manual_action_required', reason: 'canonical_install_unavailable' });
  });

  it('reports manual workspace initialization when the workspace has no config', () => {
    const { workspace, run } = fixture();
    fs.rmSync(path.join(workspace, '.pd', 'config.yaml'));
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).workerRegistration).toMatchObject({ status: 'manual_action_required', reason: 'workspace_not_initialized' });
  });

  it('fails loud when the workspace config path is not a file', () => {
    const { workspace, run } = fixture();
    fs.rmSync(path.join(workspace, '.pd', 'config.yaml'));
    fs.mkdirSync(path.join(workspace, '.pd', 'config.yaml'));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('worker_registration_failed');
    expect(result.stderr).toContain('workspace_config_invalid');
  });
});

// PRI-1046: npm can report a successful install while leaving a pinned package
// out of the top-level tree, and the marker used to be written from the desired
// pins without reading the bytes. These two cases pin both halves of the fix:
// the short-circuit still works when the bytes agree, and a marker that
// disagrees with them no longer buys a pass.
describe('pd-setup attests the installed runtime bytes', () => {
  // Port 9 (discard) refuses TCP connections, so any reinstall attempt fails
  // fast and deterministically instead of depending on the real registry.
  const unreachableRegistry = { npm_config_registry: 'http://127.0.0.1:9/' };

  it('short-circuits the reinstall only while the installed bytes match the pins', () => {
    const { run } = fixture(unreachableRegistry);
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).runtimeInstalled).toBe('already-present');
  });

  it('refuses to short-circuit a marker that recorded a local MCP source', () => {
    // A local --mcp-server-source install must not be silently reused after the
    // operator stops passing the source: the registry package has to replace
    // those bytes. The unreachable registry makes the forced reinstall loud.
    const { runtime, pins, run } = fixture(unreachableRegistry);
    fs.writeFileSync(path.join(runtime, '.pd-runtime.json'), JSON.stringify({
      ...pins,
      mcpServerSource: path.join(os.tmpdir(), 'pd-gone-local-mcp-source'),
    }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runtime_install_failed');
    // The failed reinstall must not rewrite the marker as if it had succeeded.
    expect(fs.readFileSync(path.join(runtime, '.pd-runtime.json'), 'utf8')).not.toContain('installedAt');
  });

  it('refuses a marker whose claim the installed bytes contradict', () => {
    const { runtime, run } = fixture(unreachableRegistry);
    // The npm silent-drop shape: the marker claims the core pin while the
    // top-level tree has no core at all (a nested copy can satisfy a caret
    // range, never the exact pin).
    fs.rmSync(path.join(runtime, 'node_modules', '@principles', 'core'), { recursive: true, force: true });
    const result = run();
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).not.toContain('"ok": true');
    // The reason names the reinstall attempt, not the post-install mismatch:
    // removing the marker gate makes this assert runtime_pin_mismatch instead,
    // because the lying marker short-circuits the repair away.
    expect(result.stderr).toContain('runtime_install_failed');
    expect(fs.readFileSync(path.join(runtime, '.pd-runtime.json'), 'utf8')).not.toContain('installedAt');
  });
});

// PRI-1046 follow-up: when npm exits 0 but leaves a tree the pins can never be
// satisfied from, setup must repair once from a clean tree instead of handing
// the Owner a nextAction that says "hand-delete node_modules".
describe('pd-setup repairs a runtime tree npm claimed to install', () => {
  type Pins = { codexAdapter: string; hostRuntime: string; core: string };

  /** The three local packages `--*-source` accepts, at the pinned versions. */
  function buildSources(pins: Pins) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-setup-sources-'));
    roots.push(base);
    const make = (dir: string, name: string, version: string, entries: string[]) => {
      for (const entry of entries) {
        fs.mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true });
        fs.writeFileSync(path.join(dir, entry), '');
      }
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
      return dir;
    };
    return {
      adapter: make(path.join(base, 'codex-adapter'), '@principles/codex-adapter', pins.codexAdapter, ['dist/pd-hook.js']),
      hostRuntime: make(path.join(base, 'host-runtime'), '@principles/host-runtime', pins.hostRuntime, ['dist/index.js']),
      core: make(path.join(base, 'core'), '@principles/core', pins.core, ['dist/runtime-v2/index.js']),
    };
  }

  it('reinstalls once from a clean tree, then still fails loud when no bytes arrive', () => {
    const { home, workspace, runtime, pins } = fixture();
    const sources = buildSources(pins);
    // Pre-publish wiring (see fixture): the mcpServer pin is younger than the
    // published cohort here, so the retry resolves it from a local stub source
    // instead of the registry — same path the other three local sources use.
    const mcpStub = path.join(path.dirname(sources.adapter), 'pd-mcp-server');
    fs.mkdirSync(path.join(mcpStub, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(mcpStub, 'package.json'), JSON.stringify({ name: '@principles/pd-mcp-server', version: pins.mcpServer }));
    fs.writeFileSync(path.join(mcpStub, 'dist', 'index.js'), '');
    // `package-lock-only` makes the real npm resolve the three local packages,
    // write a lockfile and exit 0 without populating node_modules — the exact
    // "success without bytes" shape, produced offline and deterministically.
    fs.rmSync(path.join(runtime, 'node_modules', '@principles', 'core'), { recursive: true, force: true });
    const result = spawnSync(process.execPath, [
      path.join(repo, 'plugins', 'principles-disciple', 'scripts', 'pd-setup.cjs'),
      '--plugin-root', path.join(repo, 'plugins', 'principles-disciple'),
      '--plugin-data', path.dirname(runtime), '--workspace', workspace, '--skip-init', '--ingest', 'skip',
      '--adapter-source', sources.adapter, '--host-runtime-source', sources.hostRuntime, '--core-source', sources.core,
      '--json',
    ], {
      encoding: 'utf8', timeout: 240_000,
      env: {
        ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
        npm_config_package_lock_only: 'true', PD_SETUP_MCP_SERVER_SOURCE: mcpStub,
      },
    });
    expect(result.status, result.stdout).toBe(1);
    // Removing the retry would drop this note; the final reason would still name
    // a mismatch, so only the note proves the repair actually ran.
    expect(result.stderr).toContain('note=runtime_reinstall_after_byte_mismatch');
    expect(result.stderr).toContain('runtime_pin_mismatch:');
    expect(result.stderr).toContain(`@principles/core@not-installed!=${pins.core}`);
    // The clean reset discarded the whole tree (the seeded adapter and
    // host-runtime copies included), and the marker was never rewritten by a
    // failed run.
    expect(fs.existsSync(path.join(runtime, 'node_modules'))).toBe(false);
    expect(fs.readFileSync(path.join(runtime, '.pd-runtime.json'), 'utf8')).not.toContain('installedAt');
    // npm genuinely ran again after the reset: the retry rewrote the lockfile.
    expect(fs.existsSync(path.join(runtime, 'package-lock.json'))).toBe(true);
  }, 300_000);
});

// Gate 4 (PRI-1071), runs LAST in this file (in-file order is sequential, so
// it cannot race the afterEach cleanup above): mcp-binding.json is
// machine-specific and lives only in INSTALLED plugin copies written by
// $pd-control setup — it must never linger in the repo checkout payload.
describe('repo payload hygiene (Gate 4)', () => {
  it('the shipped plugin payload contains no machine-specific mcp-binding.json', () => {
    expect(fs.existsSync(path.join(repo, 'plugins', 'principles-disciple', 'mcp-binding.json'))).toBe(false);
  });
});
