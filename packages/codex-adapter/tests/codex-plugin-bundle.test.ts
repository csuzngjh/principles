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

  it('registers exactly the four MVP-Core events', () => {
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'UserPromptSubmit']);
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
      CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, created_at TEXT NOT NULL);
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
