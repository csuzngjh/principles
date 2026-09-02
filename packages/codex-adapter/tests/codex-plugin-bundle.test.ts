import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/**
 * Codex plugin bundle contract tests (PRI-524 / PRI-523 acceptance 5 + ERR-040).
 *
 * The plugin under plugins/principles-disciple is the distributable source of
 * truth: these tests exercise its real files — manifest shape (mirroring the
 * Codex plugin-creator validator rules), hooks/hooks.json wiring, marketplace
 * entry, the wrapper's fail-open contract, and an installed-layout run with a
 * PLUGIN_ROOT path containing spaces (ADR-0020 §10.5) against the real
 * host-runtime dispatch. The PLUGIN_DATA runtime is seeded by copying built
 * dists and their node_modules dependencies into the exact layout $pd-setup's
 * npm install produces; tarball installability itself is proven separately by
 * published-codex-adapter-bundle.test.ts.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pluginDir = path.join(repoRoot, 'plugins', 'principles-disciple');
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  // Large seeded node_modules dirs are slow to delete on Windows; the
  // explicit timeout keeps vitest's default 10s hookTimeout from failing
  // an otherwise green suite during cleanup.
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 0 }); } catch { /* best effort */ }
  }
}, 180_000);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function copyPackage(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(path.join(sourceDir, 'dist'), path.join(targetDir, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(sourceDir, 'package.json'), path.join(targetDir, 'package.json'));
}

/** Copy a package plus its transitive runtime dependencies from the worktree's
 * node_modules into the seeded runtime layout (what `npm install` produces). */
function copyPackageWithDeps(sourceDir: string, targetDir: string, nm: string, rootNm: string): void {
  copyPackage(sourceDir, targetDir);
  const queue: Array<{ dir: string; target: string }> = [{ dir: sourceDir, target: targetDir }];
  const seen = new Set<string>();
  for (let depth = 0; depth < 5 && queue.length > 0; depth += 1) {
    const layer = queue.splice(0);
    for (const item of layer) {
      let deps: Record<string, string> = {};
      try { deps = JSON.parse(fs.readFileSync(path.join(item.dir, 'package.json'), 'utf8')).dependencies ?? {}; } catch { /* copied pkg.json is authoritative */ }
      for (const dep of Object.keys(deps)) {
        const depSource = path.join(rootNm, dep);
        const depTarget = path.join(nm, dep);
        if (seen.has(dep) || fs.existsSync(depTarget) || !fs.existsSync(depSource)) continue;
        seen.add(dep);
        // dereference: workspace symlinks under rootNm must become real dirs
        // (Codex 0.147 skips symlinks when installing plugins).
        fs.cpSync(depSource, depTarget, { recursive: true, dereference: true });
        queue.push({ dir: depTarget, target: depTarget });
      }
    }
  }
}

describe('plugin manifest contract (.codex-plugin/plugin.json)', () => {
  const manifest = readJson(path.join(pluginDir, '.codex-plugin', 'plugin.json')) as Record<string, unknown>;

  it('carries the required real values (name/version/description/author/interface)', () => {
    expect(manifest.name).toBe('principles-disciple');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof manifest.description).toBe('string');
    expect(manifest.description).not.toContain('[TODO');
    expect(isRecord(manifest.author) && typeof manifest.author.name === 'string' && manifest.author.name.length > 0).toBe(true);
    expect(isRecord(manifest.interface) && typeof manifest.interface.displayName === 'string').toBe(true);
  });

  it('omits manifest fields the Codex validator rejects (hooks) and relies on default hooks discovery', () => {
    expect(Object.hasOwn(manifest, 'hooks')).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, 'hooks', 'hooks.json'))).toBe(true);
  });

  it('uses ./-relative paths inside the plugin root for declared components', () => {
    const value = manifest.skills;
    expect(typeof value).toBe('string');
    expect(String(value).startsWith('./')).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, String(value)))).toBe(true);
  });

  it('declares https:// URLs only', () => {
    for (const key of ['homepage', 'repository'] as const) {
      const value = manifest[key];
      if (typeof value === 'string') expect(value.startsWith('https://')).toBe(true);
    }
  });
});

describe('hooks/hooks.json wiring', () => {
  interface Handler { type: string; command: string; commandWindows?: string; timeout?: number; async?: boolean; additionalContextLimit?: number }
  interface MatcherGroup { matcher?: string; hooks: Handler[] }
  const config = readJson(path.join(pluginDir, 'hooks', 'hooks.json')) as Record<string, unknown>;
  const hooks = config.hooks as Record<string, MatcherGroup[]>;

  it('uses the verified top-level {"hooks": {...}} wrapper shape (Codex 0.147 ground truth)', () => {
    expect(Object.keys(config)).toEqual(['hooks']);
  });

  it('registers exactly the four MVP-Core events plus Stop (Slice A ingestion trigger)', () => {
    // Stop was added by Codex Governance Closure Slice A (PRI-622; G1 probe
    // report §2: Stop is the turn-complete event; SPEC §8 forbids registering
    // SessionEnd for the same purpose). Its work is gated by the default-off
    // codex_conversation_ingestion flag inside pd-hook.
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(hooks.Stop[0].matcher).toBeUndefined();
    expect(hooks.Stop[0].hooks[0].async).toBeUndefined();
  });

  it('routes every event through the wrapper with quoted ${PLUGIN_ROOT} and NO commandWindows', () => {
    for (const groups of Object.values(hooks)) {
      for (const group of groups) {
        for (const handler of group.hooks) {
          expect(handler.type).toBe('command');
          // Codex itself expands ${PLUGIN_ROOT} on every platform (verified
          // on-device, Windows included). commandWindows with %PLUGIN_ROOT%
          // is NOT cmd-expanded by Codex — hooks configured with it never
          // resolve their script path and fail before the wrapper runs.
          expect(handler.command).toBe('node "${PLUGIN_ROOT}/hooks/pd-hook.cjs"');
          expect(handler.commandWindows).toBeUndefined();
          expect(typeof handler.timeout).toBe('number');
          expect(handler.timeout).toBeGreaterThan(0);
        }
      }
    }
    // UserPromptSubmit carries no matcher (Codex has no matcher for it);
    // PreToolUse gates the same tool surface as the reviewed global-hooks path.
    // PostToolUse must NOT use async: Codex 0.147 CLI skips async hooks with a
    // warning ("async hooks are not supported yet") — verified on-device.
    expect(hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(hooks.PreToolUse[0].matcher).toBe('Bash|apply_patch');
    expect(hooks.PostToolUse[0].matcher).toBe('.*');
    expect(hooks.PostToolUse[0].hooks[0].async).toBeUndefined();
    expect(hooks.UserPromptSubmit[0].hooks[0].additionalContextLimit).toBeGreaterThan(0);
  });
});

describe('repo marketplace entry (.agents/plugins/marketplace.json)', () => {
  const marketplace = readJson(path.join(repoRoot, '.agents', 'plugins', 'marketplace.json')) as Record<string, unknown>;

  it('points at the plugin with the full policy block and category', () => {
    expect(typeof marketplace.name).toBe('string');
    const plugins = marketplace.plugins as Array<Record<string, unknown>>;
    expect(plugins).toHaveLength(1);
    const entry = plugins[0];
    expect(entry.name).toBe('principles-disciple');
    expect(isRecord(entry.source) && entry.source.source === 'local' && String(entry.source.path).startsWith('./')).toBe(true);
    expect(isRecord(entry.policy) && entry.policy.installation === 'AVAILABLE' && entry.policy.authentication === 'ON_INSTALL').toBe(true);
    expect(typeof entry.category).toBe('string');
    // The referenced plugin dir exists and is a real directory (0.147 skips
    // symlinks when installing plugins — the source must be plain files).
    const stats = fs.lstatSync(path.join(repoRoot, String((entry.source as Record<string, unknown>).path)));
    expect(stats.isDirectory()).toBe(true);
  });

  it('ships every skill the plan requires with SKILL.md frontmatter', () => {
    for (const skill of ['pd-setup', 'pd-status', 'pd-review', 'pd-disable']) {
      const skillFile = path.join(pluginDir, 'skills', skill, 'SKILL.md');
      expect(fs.existsSync(skillFile)).toBe(true);
      const raw = fs.readFileSync(skillFile, 'utf8');
      expect(raw.startsWith('---')).toBe(true);
      expect(raw).toMatch(/^name:\s*pd-/m);
      expect(raw).toMatch(/^description:\s*\S/m);
    }
  });
});

describe('wrapper (hooks/pd-hook.cjs) runtime resolution', () => {
  const wrapper = path.join(pluginDir, 'hooks', 'pd-hook.cjs');

  it('fails open with a structured diagnostic when no runtime is installed', () => {
    const emptyData = tempDir('pd-plugin-empty-data-');
    const result = spawnSync(process.execPath, [wrapper], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', cwd: emptyData, model: 'm', transcript_path: null, source: 'startup' }),
      encoding: 'utf8',
      env: { ...process.env, PLUGIN_DATA: emptyData, PATH: process.env.PATH ?? '' },
      timeout: 60_000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(result.stderr).toContain('pd_runtime_not_installed');
    expect(result.stderr).toContain('$pd-setup');
  }, 90_000);
});

describe('installed-layout plugin run with a spaced PLUGIN_ROOT (ADR-0020 §10.5)', () => {
  const workspaceDir = tempDir('pd-plugin-e2e-ws-');
  let spacedRoot = '';
  let pluginData = '';

  beforeAll(async function setupInstalledLayout() {
    // 1. Simulate a real install: copy the plugin into a path WITH spaces.
    spacedRoot = path.join(tempDir('pd plugin root-'), 'principles-disciple');
    fs.cpSync(pluginDir, spacedRoot, { recursive: true });
    // 2. Seed PLUGIN_DATA/runtime/node_modules with the built packages and
    //    their dependency closure in the exact layout $pd-setup produces.
    const nm = path.join(pluginData = tempDir('pd-plugin-data-'), 'runtime', 'node_modules');
    const rootNm = path.join(repoRoot, 'node_modules');
    copyPackageWithDeps(path.join(repoRoot, 'packages', 'codex-adapter'), path.join(nm, '@principles', 'codex-adapter'), nm, rootNm);
    copyPackageWithDeps(path.join(repoRoot, 'packages', 'host-runtime'), path.join(nm, '@principles', 'host-runtime'), nm, rootNm);
    copyPackageWithDeps(path.join(repoRoot, 'packages', 'principles-core'), path.join(nm, '@principles', 'core'), nm, rootNm);
    // 3. Workspace: host.codex ON + one approved prompt principle in SQLite.
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    const { getDefaultPdConfig, SqliteActivationStateStore, SqliteConnection } = await import('@principles/core/runtime-v2');
    const config = getDefaultPdConfig();
    config.features['host.codex'].enabled = true;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    const connection = new SqliteConnection(workspaceDir);
    const now = new Date().toISOString();
    connection.getDb().prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('art-plugin-e2e', 'principle', 'task-plugin-e2e', 'P_PLUGIN_E2E', '[]', 'validated', JSON.stringify({ principleId: 'P_PLUGIN_E2E', text: 'PLUGIN_E2E_PRINCIPLE_DIRECTIVE' }), now, now);
    await new SqliteActivationStateStore(connection).recordActivation({ activationId: 'act-plugin-e2e', idempotencyKey: 'plugin-e2e::prompt', artifactId: 'art-plugin-e2e', channel: 'prompt', action: 'prompt_activate', targetRef: 'ledger://P_PLUGIN_E2E', activatedAt: now, deactivatedAt: null });
    connection.close();
  }, 120_000);

  function runWrapper(payload: Record<string, unknown>) {
    return spawnSync(process.execPath, [path.join(spacedRoot, 'hooks', 'pd-hook.cjs')], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      cwd: workspaceDir,
      env: { ...process.env, PLUGIN_ROOT: spacedRoot, PLUGIN_DATA: pluginData },
      timeout: 60_000,
    });
  }

  it('injects the approved principle into UserPromptSubmit from the installed layout', () => {
    const result = runWrapper({
      hook_event_name: 'UserPromptSubmit', session_id: 'plugin-e2e', turn_id: 't1', transcript_path: null,
      cwd: workspaceDir, model: 'gpt-5.6-sol', permission_mode: 'default', prompt: 'hello',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('PLUGIN_E2E_PRINCIPLE_DIRECTIVE') },
    });
  }, 90_000);

  it('persists PostToolUse evidence into the workspace trajectory database', () => {
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const db = new Database(path.join(stateDir, 'trajectory.db'));
    db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL);
      CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;`);
    db.close();
    const result = runWrapper({
      hook_event_name: 'PostToolUse', session_id: 'plugin-e2e', turn_id: 't2', transcript_path: null,
      cwd: workspaceDir, model: 'gpt-5.6-sol', permission_mode: 'default',
      tool_name: 'write_file', tool_use_id: 'call-1',
      tool_input: { file_path: path.join(workspaceDir, 'denied.txt'), content: 'x' },
      tool_response: { exitCode: 1, error: 'EACCES' },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse' } });
    const check = new Database(path.join(stateDir, 'trajectory.db'), { readonly: true });
    const rows = check.prepare('SELECT session_id, tool_name, outcome FROM tool_calls').all();
    check.close();
    expect(rows).toEqual([{ session_id: 'plugin-e2e', tool_name: 'write_file', outcome: 'failure' }]);
  }, 90_000);

  it('kill switch fails loud outside an initialized workspace (never silently succeeds)', () => {
    const disabledWorkspace = tempDir('pd-plugin-disabled-ws-');
    const disable = spawnSync(process.execPath, [path.join(spacedRoot, 'scripts', 'pd-disable.cjs')], {
      cwd: disabledWorkspace, encoding: 'utf8', timeout: 30_000,
    });
    expect(disable.status).toBe(1);
    expect(disable.stderr).toContain('workspace_not_initialized');
  }, 60_000);
});

describe('review-round regressions (PR #1316 review)', () => {
  it('pd-locate.compareVersionDirs sorts numerically and drops invalid versions lowest', async () => {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const { compareVersionDirs } = req(path.join(pluginDir, 'scripts', 'pd-locate.cjs')) as { compareVersionDirs: (a: string, b: string) => number };
    expect(compareVersionDirs('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersionDirs('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersionDirs('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersionDirs('not-a-version', '0.0.1')).toBeLessThanOrEqual(0);
  });

  it('PRI-645: pd-disable writes the override into a host.codex block lacking enabled and never touches a sibling (block YAML)', () => {
    const workspace = tempDir('pd-disable-sibling-ws-');
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    // host.codex block WITHOUT enabled; a sibling feature WITH enabled must survive.
    fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), [
      'features:',
      '  host.codex:',
      '    category: core',
      '  prompt:',
      '    category: core',
      '    enabled: true',
      'internalAgents:',
      '  defaultRuntime: profile-full',
      '',
    ].join('\n'), 'utf8');
    const configPath = path.join(workspace, '.pd', 'config.yaml');
    const script = path.join(pluginDir, 'scripts', 'pd-disable.cjs');
    const result = spawnSync(process.execPath, [script], { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
    // PRI-645: an explicit Owner kill switch must always land its override —
    // an enabled-less host.codex block gets one INSERTED, not a failure.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('host.codex.enabled=false');
    const after = fs.readFileSync(configPath, 'utf8');
    expect(after).toMatch(/host\.codex:[\s\S]*?enabled:\s*false[\s\S]*?prompt:[\s\S]*?enabled:\s*true/);
    expect(after).toContain('    enabled: true'); // sibling prompt untouched
  }, 60_000);

  it('rejects --workspace without a value instead of silently using cwd', () => {
    for (const scriptName of ['pd-disable.cjs', 'pd-review.cjs', 'pd-setup.cjs', 'pd-status.cjs']) {
      const result = spawnSync(process.execPath, [path.join(pluginDir, 'scripts', scriptName), '--workspace'], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 30_000 });
      expect(result.status, scriptName).not.toBe(0);
      expect(result.stderr, scriptName).toContain('workspace_value_missing');
    }
  }, 90_000);

  it('pd-status reads host.codex from flow-style (JSON) configs', () => {
    const workspace = tempDir('pd-status-json-ws-');
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), JSON.stringify({
      features: { 'host.codex': { category: 'core', enabled: true } },
    }), 'utf8');
    const dataDir = tempDir('pd-status-data-');
    const result = spawnSync(process.execPath, [path.join(pluginDir, 'scripts', 'pd-status.cjs'),
      '--plugin-root', pluginDir, '--plugin-data', dataDir, '--workspace', workspace, '--json'],
      { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
    expect(result.status === 0 || result.status === 1).toBe(true); // report always renders
    const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; detail?: string }> };
    const wsCheck = report.checks.find((check) => check.name === 'workspace');
    expect(wsCheck?.detail).toContain('host.codex enabled');
  }, 60_000);

  it('pd-status reports pin state honestly when runtime exists but pins are unreadable', () => {
    const workspace = tempDir('pd-status-pin-ws-');
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), JSON.stringify({
      features: { 'host.codex': { category: 'core', enabled: true } },
    }), 'utf8');
    const dataDir = tempDir('pd-status-pin-data-');
    // Adapter present, but plugin root override points at a dir with no runtime-version.json.
    const fakeRoot = tempDir('pd-status-fake-root-');
    fs.mkdirSync(fakeRoot, { recursive: true });
    const result = spawnSync(process.execPath, [path.join(pluginDir, 'scripts', 'pd-status.cjs'),
      '--plugin-root', fakeRoot, '--plugin-data', dataDir, '--workspace', workspace, '--json'],
      { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
    const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; detail?: string }> };
    const runtimeCheck = report.checks.find((check) => check.name === 'runtime');
    expect(runtimeCheck?.detail).toContain('not installed');
    expect(runtimeCheck?.detail).not.toContain('pinned match');
  }, 60_000);
});

describe('pd-cli discovery Windows fallback (pd-locate)', () => {
  async function loadLocate() {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    return req(path.join(pluginDir, 'scripts', 'pd-locate.cjs')) as {
      pdEntryFromGlobalRoot: (root: string) => string | undefined;
      pdEntryFromShimLines: (lines: string[]) => string | undefined;
    };
  }

  it('pdEntryFromShimLines derives the JS entry from an npm bin dir that owns pd-cli', async () => {
    const locate = await loadLocate();
    const binDir = tempDir('pd-bindir-');
    const entry = path.join(binDir, 'node_modules', '@principles', 'pd-cli', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'module.exports = {};\n', 'utf8');
    expect(locate.pdEntryFromShimLines([path.join(binDir, 'pd.cmd')])).toBe(entry);
    // A shim whose bin dir does NOT own pd-cli (non-npm `pd` on PATH) is skipped.
    const foreign = path.join(tempDir('pd-foreign-bin-'), 'pd.cmd');
    expect(locate.pdEntryFromShimLines([foreign, path.join(binDir, 'pd.cmd')])).toBe(entry);
    expect(locate.pdEntryFromShimLines([foreign])).toBeUndefined();
    // Empty lines and trailing whitespace are tolerated (ERR-001: external input).
    expect(locate.pdEntryFromShimLines(['', '   ', path.join(binDir, 'pd.cmd')])).toBe(entry);
    expect(locate.pdEntryFromShimLines([])).toBeUndefined();
  }, 60_000);

  it('pdEntryFromGlobalRoot returns the entry only when it exists', async () => {
    const locate = await loadLocate();
    const root = tempDir('pd-globalroot-');
    expect(locate.pdEntryFromGlobalRoot(root)).toBeUndefined();
    const entry = path.join(root, '@principles', 'pd-cli', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'module.exports = {};\n', 'utf8');
    expect(locate.pdEntryFromGlobalRoot(root)).toBe(entry);
  }, 60_000);
});

describe('first-run $pd-setup (real user flow)', () => {
  it('creates the plugin data dir Codex never creates, and npm-installs the pinned runtime', () => {
    // Codex 0.147 SETS PLUGIN_DATA for hooks but does NOT create the dir —
    // $pd-setup must own first-run creation (derive marketplace from the
    // installed cache path) or every fresh install dead-ends.
    const fakeHome = tempDir('pd-firstrun-home-');
    const cachePlugin = path.join(fakeHome, '.codex', 'plugins', 'cache', 'principles', 'principles-disciple', '0.1.0');
    fs.mkdirSync(cachePlugin, { recursive: true });
    fs.cpSync(pluginDir, cachePlugin, { recursive: true });
    const workspace = tempDir('pd-firstrun-ws-');
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });

    const result = spawnSync(process.execPath, [path.join(cachePlugin, 'scripts', 'pd-setup.cjs'), '--workspace', workspace, '--skip-init', '--json'], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 240_000,
      // Redirect the home dir cross-platform: os.homedir() reads HOME on POSIX and USERPROFILE/HOMEDRIVE+HOMEPATH on Windows.
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, HOMEDRIVE: path.parse(fakeHome).root.slice(0, 2), HOMEPATH: fakeHome.slice(2).split(path.sep).join('/'), PLUGIN_DATA: undefined },
    });
    expect(result.status, result.stderr.slice(0, 400)).toBe(0);
    const report = JSON.parse(result.stdout) as { pluginData: string; runtime: Record<string, string>; runtimeInstalled: string };
    // The data dir was derived + created under the fake home, not the real one.
    expect(report.pluginData.startsWith(fakeHome)).toBe(true);
    expect(fs.existsSync(path.join(report.pluginData, 'runtime', 'node_modules', '@principles', 'codex-adapter', 'dist', 'pd-hook.js'))).toBe(true);
    expect(report.runtime.codexAdapter).toBe('0.1.0');
    expect(report.runtime.hostRuntime).toBe('0.1.0');
  }, 300_000);
});

describe('pd-disable.cjs kill switch', () => {
  it('flips host.codex.enabled in the nearest .pd/config.yaml and is idempotent', async () => {
    const workspace = tempDir('pd-disable-ws-');
    fs.mkdirSync(path.join(workspace, '.pd', 'sub'), { recursive: true });
    const { getDefaultPdConfig } = await import('@principles/core/runtime-v2');
    const config = getDefaultPdConfig();
    config.features['host.codex'].enabled = true;
    const yamlDump = (await import('js-yaml')).default.dump(config, { lineWidth: -1 });
    fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), yamlDump, 'utf8');

    const script = path.join(pluginDir, 'scripts', 'pd-disable.cjs');
    // Run from a SUBDIRECTORY — the script must resolve the workspace upward.
    const first = spawnSync(process.execPath, [script], { cwd: path.join(workspace, '.pd', 'sub'), encoding: 'utf8', timeout: 30_000 });
    expect(first.status).toBe(0);
    const after = fs.readFileSync(path.join(workspace, '.pd', 'config.yaml'), 'utf8');
    expect(after).toMatch(/host\.codex:[\s\S]*?enabled:\s*false/);

    const second = spawnSync(process.execPath, [script], { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already disabled');

    const enable = spawnSync(process.execPath, [script, '--enable'], { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
    expect(enable.status).toBe(0);
    expect(fs.readFileSync(path.join(workspace, '.pd', 'config.yaml'), 'utf8')).toMatch(/host\.codex:[\s\S]*?enabled:\s*true/);
  }, 60_000);

  it('also handles flow-style (JSON) configs, which PD production tests write', () => {
    const workspace = tempDir('pd-disable-json-ws-');
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    const config = {
      features: {
        'host.codex': { category: 'core', enabled: true },
        prompt: { category: 'core', enabled: true },
      },
    };
    const configPath = path.join(workspace, '.pd', 'config.yaml');
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

    const script = path.join(pluginDir, 'scripts', 'pd-disable.cjs');
    const disable = spawnSync(process.execPath, [script], { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
    expect(disable.status).toBe(0);
    const rewritten = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { features: Record<string, { enabled: unknown }> };
    expect(rewritten.features['host.codex'].enabled).toBe(false);
    expect(rewritten.features.prompt.enabled).toBe(true);
  }, 60_000);
});

// ── PRI-645: fresh sparse bootstrap (`features: {}`) × bundled Owner tools ──
//
// The kill switch and status skill are the Owner-facing control plane. They
// must understand sparse config semantics: an absent host.codex entry means
// "follows registry default" (effective ON on a fresh install) — never a
// fake degradation, and never a failed kill switch. These tests run the REAL
// bundled scripts against the REAL fresh-config shape.

describe('PRI-645 sparse fresh config × bundled $pd-status / $pd-disable', () => {
  /** Run a bundled skill script in a temp workspace. Subprocess shape per the
   * registered write-gate seam: dynamic import + boundary-validated entry +
   * promisified execFile (never rejects — returns captured stdout/stderr). */
  async function runBundledScript(scriptName: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const scriptsRoot = path.join(pluginDir, 'scripts');
    const script = path.resolve(scriptsRoot, scriptName);
    if (!script.startsWith(scriptsRoot + path.sep) || !fs.existsSync(script)) {
      throw new Error(`script escapes scripts root: ${script}`);
    }
    try {
      return await execFileAsync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  function writeSparseConfig(workspace: string, content: string): string {
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    const configPath = path.join(workspace, '.pd', 'config.yaml');
    fs.writeFileSync(configPath, content, 'utf8');
    return configPath;
  }

  it('$pd-status reports registry-default (ok) instead of a fake degradation on features: {}', async () => {
    const workspace = tempDir('pd-status-sparse-ws-');
    writeSparseConfig(workspace, 'version: 1\nfeatures: {}\n');
    const dataDir = tempDir('pd-status-sparse-data-');
    const result = await runBundledScript('pd-status.cjs', ['--plugin-root', pluginDir, '--plugin-data', dataDir, '--workspace', workspace, '--json'], workspace);
    const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; state: string; detail?: string }> };
    const wsCheck = report.checks.find((check) => check.name === 'workspace');
    expect(wsCheck?.state).toBe('ok');
    expect(wsCheck?.detail).toContain('follows registry default');
    expect(result.stdout).not.toContain('host_codex_entry_missing');
  }, 60_000);

  it('$pd-disable inserts the explicit override into a sparse fresh config and re-enables (block YAML)', async () => {
    const workspace = tempDir('pd-disable-sparse-ws-');
    const configPath = writeSparseConfig(workspace, 'version: 1\nfeatures: {}\n');

    const disable = await runBundledScript('pd-disable.cjs', [], workspace);
    expect(disable.stdout).toContain('host.codex.enabled=false');
    const afterDisable = fs.readFileSync(configPath, 'utf8');
    expect(afterDisable).toMatch(/features:[\s\S]*?host\.codex:[\s\S]*?category:\s*core[\s\S]*?enabled:\s*false/);

    // The written override is honored on re-run (idempotent no-change).
    const again = await runBundledScript('pd-disable.cjs', [], workspace);
    expect(again.stdout).toContain('already disabled');

    const enable = await runBundledScript('pd-disable.cjs', ['--enable'], workspace);
    expect(enable.stdout).toContain('host.codex.enabled=true');
    expect(fs.readFileSync(configPath, 'utf8')).toMatch(/host\.codex:[\s\S]*?enabled:\s*true/);
  }, 60_000);

  it('$pd-disable inserts the override into a sparse flow-style (JSON) config', async () => {
    const workspace = tempDir('pd-disable-sparse-json-ws-');
    const configPath = writeSparseConfig(workspace, JSON.stringify({ version: 1, features: {} }));

    const disable = await runBundledScript('pd-disable.cjs', [], workspace);
    expect(disable.stdout).toContain('host.codex.enabled=false');
    const rewritten = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { version: number; features: Record<string, { category?: string; enabled: unknown }> };
    expect(rewritten.version).toBe(1);
    expect(rewritten.features['host.codex']).toEqual({ category: 'core', enabled: false });
  }, 60_000);

  // ── PRI-645 review round 2: tri-state status semantics ──
  // valid explicit override → true/false; valid sparse absence → follows
  // registry default (ok); malformed present entry or invalid features
  // section → degraded (never a health false-positive).

  async function sparseStatusCheck(workspace: string): Promise<{ state?: string; detail?: string }> {
    const dataDir = tempDir('pd-status-tri-data-');
    const result = await runBundledScript('pd-status.cjs', ['--plugin-root', pluginDir, '--plugin-data', dataDir, '--workspace', workspace, '--json'], workspace);
    const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; state: string; detail?: string }> };
    return report.checks.find((check) => check.name === 'workspace') ?? {};
  }

  it('status: sparse flow-style JSON features: {} → ok, follows registry default', async () => {
    const workspace = tempDir('pd-status-sparse-json-ws-');
    writeSparseConfig(workspace, JSON.stringify({ version: 1, features: {} }));
    const wsCheck = await sparseStatusCheck(workspace);
    expect(wsCheck.state).toBe('ok');
    expect(wsCheck.detail).toContain('follows registry default');
  }, 60_000);

  it('status: host.codex present but enabled missing (block YAML) → degraded, not registry default', async () => {
    const workspace = tempDir('pd-status-missing-enabled-ws-');
    writeSparseConfig(workspace, 'features:\n  host.codex:\n    category: core\n');
    const wsCheck = await sparseStatusCheck(workspace);
    expect(wsCheck.state).toBe('degraded');
    expect(wsCheck.detail).toContain('host_codex_entry_invalid');
    expect(wsCheck.detail ?? '').not.toContain('follows registry default');
  }, 60_000);

  it('status: host.codex present with non-boolean enabled (JSON) → degraded', async () => {
    const workspace = tempDir('pd-status-bad-enabled-ws-');
    writeSparseConfig(workspace, JSON.stringify({ features: { 'host.codex': { category: 'core', enabled: 'yes' } } }));
    const wsCheck = await sparseStatusCheck(workspace);
    expect(wsCheck.state).toBe('degraded');
    expect(wsCheck.detail).toContain('host_codex_entry_invalid');
  }, 60_000);

  it('status: host.codex scalar entry (block YAML) → degraded', async () => {
    const workspace = tempDir('pd-status-scalar-entry-ws-');
    writeSparseConfig(workspace, 'features:\n  host.codex: broken\n');
    const wsCheck = await sparseStatusCheck(workspace);
    expect(wsCheck.state).toBe('degraded');
    expect(wsCheck.detail).toContain('host_codex_entry_invalid');
  }, 60_000);

  it('status: features section missing entirely → degraded (validatePdConfig requires it)', async () => {
    const workspace = tempDir('pd-status-no-features-ws-');
    writeSparseConfig(workspace, 'version: 1\nruntimeProfiles: {}\n');
    const wsCheck = await sparseStatusCheck(workspace);
    expect(wsCheck.state).toBe('degraded');
    expect(wsCheck.detail).toContain('features section invalid');
  }, 60_000);

  it('status: valid explicit false override → degraded DISABLED (distinct from invalid)', async () => {
    const workspace = tempDir('pd-status-explicit-false-ws-');
    writeSparseConfig(workspace, 'features:\n  host.codex:\n    category: core\n    enabled: false\n');
    const wsCheck = await sparseStatusCheck(workspace);
    expect(wsCheck.state).toBe('degraded');
    expect(wsCheck.detail).toContain('DISABLED');
    expect(wsCheck.detail ?? '').not.toContain('invalid');
  }, 60_000);
});
