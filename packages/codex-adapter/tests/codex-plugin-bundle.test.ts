import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
 * dists and their node_modules dependencies into the exact layout $pd-control setup's
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

beforeEach(() => {
  const home = tempDir('pd-plugin-codex-home-');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  // All child processes inherit this isolated host home, so setup/status/
  // disable tests can only resolve workspaces beneath their own fixture.
  vi.stubEnv('CODEX_HOME', codexHome);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

// First-run install fixtures use LOCAL packed tarballs of this worktree's
// runtime cohort, never the public registry's copy of the pins. A Version
// Packages PR materializes pins for versions that are not published until the
// release itself runs (#2510: installing the pins from public npm made the PR
// permanently red with ETARGET, blocking the release that would publish them).
// Exact-version resolution against the real registry is a POST-publish
// responsibility: publish-npm.yml's codex-plugin-delivery-verify job runs
// sync-codex-runtime-pins.mjs --verify (identity per pin) and check:runtime-pin
// (installs all four pins from the registry), and publish-finalize is hard-gated
// on that job.
type RuntimeSampleKey = 'codexAdapter' | 'hostRuntime' | 'core' | 'mcpServer';
type RuntimeVersions = Record<RuntimeSampleKey, string>;
type RuntimeSamples = {
  versions: RuntimeVersions;
  sources: Record<RuntimeSampleKey, string>;
  /** @principles/install-layout is a transitive runtime dependency of both
   *  codex-adapter and host-runtime, but pd-setup only forwards the four
   *  --*-source flags. Without a local artifact here the edge falls through to
   *  the registry, which cannot serve a Version Packages range until publish
   *  (#2543 ETARGET). */
  installLayout: { source: string; version: string };
};

const localRuntimeSamples = [
  { key: 'codexAdapter', dir: path.join(repoRoot, 'packages', 'codex-adapter'), flag: '--adapter-source' },
  { key: 'hostRuntime', dir: path.join(repoRoot, 'packages', 'host-runtime'), flag: '--host-runtime-source' },
  { key: 'core', dir: path.join(repoRoot, 'packages', 'principles-core'), flag: '--core-source' },
  { key: 'mcpServer', dir: path.join(repoRoot, 'packages', 'pd-mcp-server'), flag: '--mcp-server-source' },
] as const;

const installLayoutPackageDir = path.join(repoRoot, 'packages', 'install-layout');

const nodeRequireForNpm = createRequire(import.meta.url);
const { packTarballPath, runNpm } = nodeRequireForNpm('./helpers/run-npm.cjs') as {
  packTarballPath: (packDir: string, filename: unknown) => string;
  runNpm: (args: string[], options: { cwd: string; encoding: 'utf8'; stdio: ['ignore', 'pipe', 'pipe'] }) => string;
};

/** npm-pack one runtime package from this worktree, then unpack the tarball
 *  with the system tar so callers receive exactly the artifact npm would
 *  publish (package.json + files whitelist), not the raw workspace directory. */
function packLocalRuntimePackage(packRoot: string, key: string, dir: string): { source: string; version: string } {
  const packDir = path.join(packRoot, `${key}-pack`);
  fs.mkdirSync(packDir);
  // --ignore-scripts: dist is already built by the suite's build step; packing
  // must not rebuild (or produce bytes that differ from what the tests read).
  const output = runNpm(['pack', '--ignore-scripts', '--json', '--', dir], { cwd: packDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const packed: unknown = JSON.parse(output);
  if (!Array.isArray(packed) || !isRecord(packed[0]) || typeof packed[0].filename !== 'string') {
    throw new Error(`npm pack returned an unexpected result for ${dir}: ${String(output).slice(0, 400)}`);
  }
  const tarball = packTarballPath(packDir, packed[0].filename);
  const extractDir = path.join(packRoot, `${key}-src`);
  fs.mkdirSync(extractDir);
  const extracted = spawnSync('tar', ['-xzf', tarball, '-C', extractDir], { encoding: 'utf8' });
  if (extracted.status !== 0) {
    throw new Error(`failed to extract ${tarball}: ${String(extracted.stderr).slice(0, 400)}`);
  }
  const source = path.join(extractDir, 'package');
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (!isRecord(manifest) || typeof manifest.version !== 'string') {
    throw new Error(`${tarball} carries no package version`);
  }
  return { source, version: manifest.version };
}

function packLocalRuntimeSamples(): RuntimeSamples {
  const packRoot = tempDir('pd-local-runtime-samples-');
  const versions = {} as RuntimeVersions;
  const sources = {} as Record<RuntimeSampleKey, string>;
  for (const entry of localRuntimeSamples) {
    const packed = packLocalRuntimePackage(packRoot, entry.key, entry.dir);
    sources[entry.key] = packed.source;
    versions[entry.key] = packed.version;
  }
  return { versions, sources, installLayout: packLocalRuntimePackage(packRoot, 'installLayout', installLayoutPackageDir) };
}

/** ensurePluginData derives the canonical data dir from the cache layout:
 *  ~/.codex/plugins/cache/<marketplace>/principles-disciple/<version> →
 *  ~/.codex/plugins/data/principles-disciple-<marketplace>. */
function firstRunRuntimeDir(fakeHome: string): string {
  return path.join(fakeHome, '.codex', 'plugins', 'data', 'principles-disciple-principles', 'runtime');
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function copyPackage(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(path.join(sourceDir, 'dist'), path.join(targetDir, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(sourceDir, 'package.json'), path.join(targetDir, 'package.json'));
}

/** Resolve a dependency directory the way Node resolution would from
 * `fromDir`: the nearest `node_modules/<dep>` on the ancestor path, ending at
 * the repo-root node_modules. npm may nest workspace deps (exact-pinned
 * versions conflicting at the root), so a root-only lookup silently misses
 * them and seeds a runtime that cannot load. Root-HOISTED deps are the dual
 * case: they live at `rootNm/<dep>` itself, never at
 * `rootNm/node_modules/<dep>`, so the ancestor walk must check the root
 * package slot explicitly (Pi 1.2's eager import graph pulls root-hoisted
 * `partial-json` on the injection path and a missed seed crashes the hook). */
function findNodeModulesDir(fromDir: string, dep: string, rootNm: string): string | null {
  let dir = fromDir;
  // Workspace deps surface in node_modules as junctions/symlinks; resolve to
  // the real package dir first or the ancestor walk never sees its nested deps.
  try { dir = fs.realpathSync(dir); } catch { /* keep as-is */ }
  while (true) {
    const candidate = path.join(dir, 'node_modules', dep);
    if (fs.existsSync(candidate)) return candidate;
    if (dir === rootNm || dir === path.dirname(rootNm)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const rootHoisted = path.join(rootNm, dep);
  return fs.existsSync(rootHoisted) ? rootHoisted : null;
}

/** Copy a package plus its transitive runtime dependencies resolved through
 * the real node_modules layout into the seeded runtime layout (what
 * `npm install` produces). */
function copyPackageWithDeps(sourceDir: string, targetDir: string, nm: string, rootNm: string): void {
  copyPackage(sourceDir, targetDir);
  const queue: Array<{ source: string; target: string }> = [{ source: sourceDir, target: targetDir }];
  const seen = new Set<string>();
  // Pi 1.2 widened the transitive closure (provider SDKs + proxy agents nest
  // and chain deeper than 0.85's graph); 8 BFS layers keeps the seed complete
  // without making the bound the failure mode.
  for (let depth = 0; depth < 8 && queue.length > 0; depth += 1) {
    const layer = queue.splice(0);
    for (const item of layer) {
      let deps: Record<string, string> = {};
      try { deps = JSON.parse(fs.readFileSync(path.join(item.source, 'package.json'), 'utf8')).dependencies ?? {}; } catch { /* copied pkg.json is authoritative */ }
      for (const dep of Object.keys(deps)) {
        const depTarget = path.join(nm, dep);
        if (seen.has(dep) || fs.existsSync(depTarget)) continue;
        seen.add(dep);
        const depSource = findNodeModulesDir(item.source, dep, rootNm);
        if (depSource === null) {
          // Build-time-only deps (e.g. better-sqlite3's node-addon-api headers)
          // are legitimately absent from the install tree; skipping them is
          // fine, but it must stay observable — a silently missing RUNTIME dep
          // here is what once seeded a wrapper that could not load.
          console.warn(`[copyPackageWithDeps] unresolvable dep "${dep}" of ${item.source} — skipped`);
          continue;
        }
        // dereference: workspace symlinks under node_modules must become real dirs
        // (Codex 0.147 skips symlinks when installing plugins).
        fs.cpSync(depSource, depTarget, { recursive: true, dereference: true });
        queue.push({ source: depSource, target: depTarget });
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
    for (const skill of ['pd-cli-operator', 'pd-pain-signal', 'pd-review', 'pd-control']) {
      const skillFile = path.join(pluginDir, 'skills', skill, 'SKILL.md');
      expect(fs.existsSync(skillFile)).toBe(true);
      const raw = fs.readFileSync(skillFile, 'utf8');
      expect(raw.startsWith('---')).toBe(true);
      expect(raw).toMatch(/^name:\s*pd-/m);
      expect(raw).toMatch(/^description:\s*\S/m);
    }
  });

  it('pd-pain-signal ships the agent-assisted entry and no longer demands a prefix resend', () => {
    const raw = fs.readFileSync(path.join(pluginDir, 'skills', 'pd-pain-signal', 'SKILL.md'), 'utf8');
    // The native prefix entry stays the first-class path...
    expect(raw).toContain('PD记录痛苦：');
    // ...and the agent-assisted bridge is the answer to an explicit no-prefix
    // request, wired to the real registration command.
    expect(raw).toContain('pd pain explicit');
    // The retired absolute rule: a missing prefix must not push the resend
    // burden back onto the Owner as the default solution.
    expect(raw).not.toContain('ask the Owner to submit it');
    expect(raw).not.toContain('provide the exact message format');
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
    expect(result.stderr).toContain('$pd-control');
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
    //    their dependency closure in the exact layout $pd-control setup produces.
    const nm = path.join(pluginData = tempDir('pd-plugin-data-'), 'runtime', 'node_modules');
    const rootNm = path.join(repoRoot, 'node_modules');
    copyPackageWithDeps(path.join(repoRoot, 'packages', 'codex-adapter'), path.join(nm, '@principles', 'codex-adapter'), nm, rootNm);
    copyPackageWithDeps(path.join(repoRoot, 'packages', 'host-runtime'), path.join(nm, '@principles', 'host-runtime'), nm, rootNm);
    copyPackageWithDeps(path.join(repoRoot, 'packages', 'principles-core'), path.join(nm, '@principles', 'core'), nm, rootNm);
    // 3. Workspace: host.codex ON + one approved prompt principle in SQLite.
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    const { getDefaultPdConfig, SqliteActivationStateStore, SqliteConnection } = await import('@principles/core/runtime');
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

  it('pd-status treats a core runtime pin mismatch as degraded', () => {
    const workspace = tempDir('pd-status-core-ws-');
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), JSON.stringify({ features: {} }), 'utf8');
    const dataDir = tempDir('pd-status-core-data-');
    // Pins are release authority, not test constants: the ordinary maintenance
    // PR rewrites runtime-version.json on every published cohort, so a frozen
    // tuple here would fail the very PR that advances the pins (PRI-1040,
    // see runtime-pin-guard.test.ts).
    const pins = JSON.parse(fs.readFileSync(path.join(pluginDir, 'runtime-version.json'), 'utf8')) as {
      codexAdapter: string; hostRuntime: string; core: string; mcpServer: string;
    };
    const [coreMajor = 0, coreMinor = 0, corePatch = 0] = pins.core.split('.').map(Number);
    // Exactly one package is stale: adapter, host-runtime and the MCP server
    // still match the pin while core is one patch ahead, so the degraded
    // state can only come from the core comparison.
    const installedCore = `${coreMajor}.${coreMinor}.${corePatch + 1}`;
    const runtimePackages = path.join(dataDir, 'runtime', 'node_modules', '@principles');
    for (const [name, version] of [['codex-adapter', pins.codexAdapter], ['host-runtime', pins.hostRuntime], ['core', installedCore], ['pd-mcp-server', pins.mcpServer]]) {
      const packageDir = path.join(runtimePackages, name);
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: `@principles/${name}`, version }), 'utf8');
    }
    const result = spawnSync(process.execPath, [path.join(pluginDir, 'scripts', 'pd-status.cjs'),
      '--plugin-root', pluginDir, '--plugin-data', dataDir, '--workspace', workspace, '--json'],
      { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
    const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; state: string; detail?: string }> };
    const runtimeCheck = report.checks.find((check) => check.name === 'runtime');
    expect(runtimeCheck?.state).toBe('degraded');
    expect(runtimeCheck?.detail).toContain(`core@${installedCore}`);
    expect(runtimeCheck?.detail).toContain(`pinned ${pins.codexAdapter}+${pins.hostRuntime}+${pins.core}+mcp-server@${pins.mcpServer}`);
  }, 60_000);

  it('pd-status degrades when runtime-version.json has no mcpServer pin (pd-setup would reject it)', () => {
    const workspace = tempDir('pd-status-nopin-ws-');
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), JSON.stringify({ features: {} }), 'utf8');
    const dataDir = tempDir('pd-status-nopin-data-');
    const pins = JSON.parse(fs.readFileSync(path.join(pluginDir, 'runtime-version.json'), 'utf8')) as {
      codexAdapter: string; hostRuntime: string; core: string; mcpServer: string;
    };
    const withoutMcpPin: Record<string, string> = { ...pins };
    delete withoutMcpPin.mcpServer;
    const fakeRoot = tempDir('pd-status-nopin-root-');
    fs.mkdirSync(path.join(fakeRoot, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'principles-disciple', version: '0.0.1' }), 'utf8');
    fs.writeFileSync(path.join(fakeRoot, 'runtime-version.json'), JSON.stringify(withoutMcpPin), 'utf8');
    const runtimePackages = path.join(dataDir, 'runtime', 'node_modules', '@principles');
    for (const [name, version] of [['codex-adapter', pins.codexAdapter], ['host-runtime', pins.hostRuntime], ['core', pins.core], ['pd-mcp-server', pins.mcpServer]]) {
      const packageDir = path.join(runtimePackages, name);
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: `@principles/${name}`, version }), 'utf8');
    }
    const result = spawnSync(process.execPath, [path.join(pluginDir, 'scripts', 'pd-status.cjs'),
      '--plugin-root', fakeRoot, '--plugin-data', dataDir, '--workspace', workspace, '--json'],
      { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
    const report = JSON.parse(result.stdout) as { checks: Array<{ name: string; state: string; detail?: string }> };
    const runtimeCheck = report.checks.find((check) => check.name === 'runtime');
    expect(runtimeCheck?.state).toBe('degraded');
    expect(runtimeCheck?.detail).toContain('mcpServer pin');
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

describe('installed runtime bytes against the pins (pd-locate, PRI-1046)', () => {
  type Pins = { codexAdapter: string; hostRuntime: string; core: string; mcpServer: string };
  async function loadLocate() {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    return req(path.join(pluginDir, 'scripts', 'pd-locate.cjs')) as {
      readInstalledRuntimeVersions: (runtimeDir: string) => Pins;
      verifyInstalledRuntime: (runtimeDir: string, pins: Pins) => { ok: boolean; installed: Pins; mismatched: { packageName: string; pinned: string; installed: string }[] };
    };
  }

  function fabricate(versions: Partial<Record<keyof Pins, string | null | undefined>>): { runtimeDir: string; pins: Pins } {
    const pins: Pins = { codexAdapter: '0.5.13', hostRuntime: '0.13.1', core: '1.296.2', mcpServer: '0.1.0' };
    const runtimeDir = tempDir('pd-runtime-bytes-');
    for (const [key, packageName] of [['codexAdapter', 'codex-adapter'], ['hostRuntime', 'host-runtime'], ['core', 'core'], ['mcpServer', 'pd-mcp-server']] as const) {
      // rc-5: hasOwn distinguishes "not asked about" from "explicitly broken".
      const requested = Object.hasOwn(versions, key);
      const version = requested ? versions[key] : pins[key];
      if (version === null) continue;
      const packageDir = path.join(runtimeDir, 'node_modules', '@principles', packageName);
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(version === undefined
        ? { name: `@principles/${packageName}` }
        : { name: `@principles/${packageName}`, version }), 'utf8');
    }
    return { runtimeDir, pins };
  }

  it('agrees only when every installed manifest carries exactly its pinned version', async () => {
    const locate = await loadLocate();
    const { runtimeDir, pins } = fabricate({});
    expect(locate.verifyInstalledRuntime(runtimeDir, pins)).toMatchObject({ ok: true, installed: pins, mismatched: [] });
  }, 60_000);

  it('names the disagreeing package instead of waving the whole tuple through', async () => {
    const locate = await loadLocate();
    const { runtimeDir, pins } = fabricate({ core: '1.296.1' });
    const report = locate.verifyInstalledRuntime(runtimeDir, pins);
    expect(report.ok).toBe(false);
    expect(report.mismatched).toEqual([{ packageName: '@principles/core', pinned: pins.core, installed: '1.296.1' }]);
  }, 60_000);

  it('treats an absent package, a versionless manifest and an unreadable pin as mismatch, never as agreement (rc-1/rc-3)', async () => {
    const locate = await loadLocate();
    const absent = fabricate({ core: null });
    expect(locate.verifyInstalledRuntime(absent.runtimeDir, absent.pins).mismatched)
      .toEqual([{ packageName: '@principles/core', pinned: absent.pins.core, installed: 'not-installed' }]);
    const unreadable = fabricate({ core: undefined });
    expect(locate.verifyInstalledRuntime(unreadable.runtimeDir, unreadable.pins).mismatched)
      .toEqual([{ packageName: '@principles/core', pinned: unreadable.pins.core, installed: 'unknown' }]);
    const agreed = fabricate({});
    const brokenPins = { ...agreed.pins, core: '' };
    expect(locate.verifyInstalledRuntime(agreed.runtimeDir, brokenPins).ok).toBe(false);
    // An empty runtime dir cannot satisfy any pin.
    expect(locate.verifyInstalledRuntime(tempDir('pd-runtime-empty-'), agreed.pins).mismatched).toHaveLength(4);
  }, 60_000);
});

describe('installed snapshot freshness and runtime reset (pd-locate/pd-status, PRI-1046 follow-up)', () => {
  type Pins = { codexAdapter: string; hostRuntime: string; core: string; mcpServer: string };

  async function loadLocate() {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    return req(path.join(pluginDir, 'scripts', 'pd-locate.cjs')) as {
      resetInstalledRuntime: (runtimeDir: string) => { ok: boolean; removed: string[]; reason?: string };
      resolvePluginSourceSnapshot: (pluginRoot: string) => {
        ok: boolean; reason?: string; marketplace?: string; source?: string; pluginDir?: string;
        installedVersion?: string; sourceVersion?: string;
      };
    };
  }

  /** Real Codex install layout + a `[marketplaces.<name>]` table, exactly as
   * Codex writes it: a literal (single-quoted) local path, or a basic
   * (double-quoted) string whose backslashes are escaped. */
  function seedMarketplace(options: { installed: string; source?: string; sourceType?: string; quote?: 'literal' | 'basic'; omitSource?: boolean }) {
    const home = tempDir('pd-marketplace-');
    const codexHome = path.join(home, '.codex');
    const root = path.join(codexHome, 'plugins', 'cache', 'principles', 'principles-disciple', options.installed);
    fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'principles-disciple', version: options.installed }), 'utf8');
    // The pins ship with the snapshot, which is exactly why a stale snapshot is
    // self-consistent: it must be caught by comparing with the SOURCE.
    fs.copyFileSync(path.join(pluginDir, 'runtime-version.json'), path.join(root, 'runtime-version.json'));
    // Gate 4: a structurally valid MCP binding so the mcpBinding status check
    // reports ok on this fabricated root (pd-status validates shape + the
    // canonical entry + the installed server version).
    const seededPins = JSON.parse(fs.readFileSync(path.join(pluginDir, 'runtime-version.json'), 'utf8')) as { mcpServer: string };
    const seedRuntimeDir = path.join(os.tmpdir(), 'pd-marketplace-seed-runtime');
    fs.writeFileSync(path.join(root, 'mcp-binding.json'), JSON.stringify({
      schemaVersion: 'pd.mcp-binding.v1',
      host: 'codex',
      workspaceDir: path.join(os.tmpdir(), 'pd-marketplace-seed-ws'),
      runtimeDir: seedRuntimeDir,
      serverEntry: path.join(seedRuntimeDir, 'node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'),
      versions: { mcpServer: seededPins.mcpServer },
    }), 'utf8');
    const sourceDir = path.join(home, 'marketplace-source');
    fs.mkdirSync(path.join(sourceDir, '.codex-plugin'), { recursive: true });
    if (options.source !== undefined) {
      fs.writeFileSync(path.join(sourceDir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'principles-disciple', version: options.source }), 'utf8');
    }
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      '[features]',
      'hooks = true',
      '',
      '[marketplaces.principles]',
      `source_type = "${options.sourceType ?? 'local'}"`,
      ...(options.omitSource ? [] : [options.quote === 'basic' ? `source = ${JSON.stringify(sourceDir)}` : `source = '${sourceDir}'`]),
      '',
    ].join('\n'), 'utf8');
    return { home, codexHome, root, sourceDir };
  }

  function seedPinnedRuntime(dataDir: string) {
    const pins = JSON.parse(fs.readFileSync(path.join(pluginDir, 'runtime-version.json'), 'utf8')) as Pins;
    for (const [name, version] of [['codex-adapter', pins.codexAdapter], ['host-runtime', pins.hostRuntime], ['core', pins.core], ['pd-mcp-server', pins.mcpServer]] as const) {
      const packageDir = path.join(dataDir, 'runtime', 'node_modules', '@principles', name);
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: `@principles/${name}`, version }), 'utf8');
    }
    // The launcher's canonical entry must exist for the binding to be healthy.
    const entry = path.join(dataDir, 'runtime', 'node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// fabricated entry for the status fixture\n', 'utf8');
  }

  function statusReport(
    seeded: ReturnType<typeof seedMarketplace>,
    options: { bindWorkspace?: string; removeServerEntry?: boolean } = {}
  ) {
    const workspace = tempDir('pd-marketplace-ws-');
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), JSON.stringify({ features: {} }), 'utf8');
    const dataDir = tempDir('pd-marketplace-data-');
    seedPinnedRuntime(dataDir);
    // Bind exactly like pd-setup would: the reported workspace, the data-dir
    // runtime, and the canonical entry the launcher verifies.
    const pins = JSON.parse(fs.readFileSync(path.join(pluginDir, 'runtime-version.json'), 'utf8')) as Pins;
    const runtimeDir = path.join(dataDir, 'runtime');
    const serverEntry = path.join(runtimeDir, 'node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js');
    fs.writeFileSync(path.join(seeded.root, 'mcp-binding.json'), JSON.stringify({
      schemaVersion: 'pd.mcp-binding.v1',
      host: 'codex',
      workspaceDir: options.bindWorkspace ?? workspace,
      runtimeDir,
      serverEntry,
      versions: { mcpServer: pins.mcpServer, core: pins.core },
    }), 'utf8');
    if (options.removeServerEntry) fs.rmSync(serverEntry, { force: true });
    const result = spawnSync(process.execPath, [path.join(pluginDir, 'scripts', 'pd-status.cjs'),
      '--plugin-root', seeded.root, '--plugin-data', dataDir, '--workspace', workspace, '--json'],
      {
        cwd: workspace, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, CODEX_HOME: seeded.codexHome, HOME: seeded.home, USERPROFILE: seeded.home },
      });
    const report = JSON.parse(result.stdout) as {
      ok: boolean; checks: Array<{ name: string; state: string; detail?: string; nextAction?: string }>;
    };
    return { result, report, snapshot: report.checks.find((check) => check.name === 'snapshot') };
  }

  /** The PD repo layout: config.toml points at a MARKETPLACE root (a checkout)
   *  whose .agents/plugins/marketplace.json points at the plugin subdirectory.
   *  This is the layout on the Owner's machine, and the one the check used to
   *  report as permanently unreadable (PRI-1052). */
  function seedRepoMarketplace(options: {
    installed: string;
    source: string;
    manifest?:
      | 'ok'
      | 'missing'
      | 'entry-without-path'
      | 'path-to-nowhere'
      | 'escaping-path'
      | 'sibling-prefix-path'
      | 'not-listed'
      | 'path-to-file';
  }) {
    const home = tempDir('pd-repo-marketplace-');
    const codexHome = path.join(home, '.codex');
    const root = path.join(codexHome, 'plugins', 'cache', 'principles', 'principles-disciple', options.installed);
    fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'principles-disciple', version: options.installed }), 'utf8');
    fs.copyFileSync(path.join(pluginDir, 'runtime-version.json'), path.join(root, 'runtime-version.json'));
    // Gate 4: valid MCP binding shape (see seedMarketplace).
    const seededPins = JSON.parse(fs.readFileSync(path.join(pluginDir, 'runtime-version.json'), 'utf8')) as { mcpServer: string };
    const seedRuntimeDir = path.join(os.tmpdir(), 'pd-repo-marketplace-seed-runtime');
    fs.writeFileSync(path.join(root, 'mcp-binding.json'), JSON.stringify({
      schemaVersion: 'pd.mcp-binding.v1',
      host: 'codex',
      workspaceDir: path.join(os.tmpdir(), 'pd-repo-marketplace-seed-ws'),
      runtimeDir: seedRuntimeDir,
      serverEntry: path.join(seedRuntimeDir, 'node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'),
      versions: { mcpServer: seededPins.mcpServer },
    }), 'utf8');
    const marketplaceRoot = path.join(home, 'repo-checkout');
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'principles-disciple');
    fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'principles-disciple', version: options.source }), 'utf8');
    const flavour = options.manifest ?? 'ok';
    if (flavour !== 'missing') {
      const entryPath = {
        ok: './plugins/principles-disciple',
        'entry-without-path': undefined,
        'path-to-nowhere': './plugins/does-not-exist',
        'escaping-path': '../outside-checkout',
        // A directory whose NAME starts with ".." is still inside the root: a
        // prefix check would reject it, a segment-boundary check must not.
        'sibling-prefix-path': './..checkout',
        // A marketplace entry pointing at a file, not a plugin directory.
        'path-to-file': './plugins/principles-disciple-file',
        // The marketplace resolves, but it does not list this plugin at all.
        'not-listed': './plugins/principles-disciple',
      }[flavour];
      if (flavour === 'sibling-prefix-path') {
        fs.mkdirSync(path.join(marketplaceRoot, '..checkout', '.codex-plugin'), { recursive: true });
        fs.writeFileSync(path.join(marketplaceRoot, '..checkout', '.codex-plugin', 'plugin.json'),
          JSON.stringify({ name: 'principles-disciple', version: options.source }), 'utf8');
      }
      if (flavour === 'path-to-file') {
        fs.mkdirSync(path.join(marketplaceRoot, 'plugins'), { recursive: true });
        fs.writeFileSync(path.join(marketplaceRoot, 'plugins', 'principles-disciple-file'), '{}', 'utf8');
      }
      const entry = {
        name: flavour === 'not-listed' ? 'some-other-plugin' : 'principles-disciple',
        source: entryPath === undefined ? { source: 'local' } : { source: 'local', path: entryPath },
      };
      fs.mkdirSync(path.join(marketplaceRoot, '.agents', 'plugins'), { recursive: true });
      fs.writeFileSync(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
        JSON.stringify({ name: 'principles', plugins: [entry] }), 'utf8');
    }
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      '[features]',
      'hooks = true',
      '',
      '[marketplaces.principles]',
      'source_type = "local"',
      `source = '${marketplaceRoot}'`,
      '',
    ].join('\n'), 'utf8');
    return { home, codexHome, root, sourceDir: marketplaceRoot };
  }

  it('degrades when the installed snapshot is older than its marketplace source (numeric, not lexical, order)', async () => {
    const stale = statusReport(seedMarketplace({ installed: '0.9.0', source: '0.10.0' }));
    expect(stale.snapshot?.state).toBe('degraded');
    expect(stale.snapshot?.detail).toContain('installed plugin 0.9.0 is older than its marketplace source 0.10.0');
    // Update chain (2026-11-11): refreshing is in place — the operator is never
    // told to uninstall the plugin first.
    expect(stale.snapshot?.nextAction).toContain('codex plugin add principles-disciple@principles');
    expect(stale.snapshot?.nextAction).not.toContain('plugin remove');
    expect(stale.report.ok).toBe(false);
    expect(stale.result.status).toBe(1);
  }, 60_000);

  it('flags a marketplace source that is behind the installed PD release, even when cache and source agree', () => {
    const seeded = seedMarketplace({ installed: '0.2.5', source: '0.2.5' });
    // The source carries its own pins, and the canonical runtime on this
    // machine is NEWER. cache == source is exactly the false comfort the Owner
    // rejected (2026-11-11): nothing here is current.
    fs.writeFileSync(path.join(seeded.sourceDir, 'runtime-version.json'), JSON.stringify({
      codexAdapter: '0.8.7', hostRuntime: '3.2.1', core: '7.0.0', mcpServer: '0.3.3',
    }), 'utf8');
    const releaseDir = path.join(seeded.home, '.pd', 'runtime');
    for (const [dir, version] of [['codex-adapter', '0.8.8'], ['host-runtime', '3.2.2'], ['core', '7.2.0'], ['pd-mcp-server', '0.3.3']] as const) {
      fs.mkdirSync(path.join(releaseDir, dir), { recursive: true });
      fs.writeFileSync(path.join(releaseDir, dir, 'package.json'), JSON.stringify({ name: dir, version }), 'utf8');
    }

    const stale = statusReport(seeded);

    expect(stale.snapshot?.state).toBe('degraded');
    expect(stale.snapshot?.detail).toContain('matches its marketplace source, but that source is behind the installed PD release');
    expect(stale.snapshot?.detail).toContain('core@7.0.0 < 7.2.0');
    expect(stale.snapshot?.nextAction).toContain('git pull');
    expect(stale.snapshot?.nextAction).not.toContain('plugin remove');
  }, 90_000);

  it('flags a local marketplace source checkout that trails its own origin/main (2026-11-11)', () => {
    // Cache == source == release, so every earlier check passes. The only
    // remaining fact is that the SOURCE CHECKOUT itself is behind upstream —
    // the "matches the marketplace source" false comfort the Owner rejected.
    const seeded = seedMarketplace({ installed: '0.2.5', source: '0.2.5' });
    const git = (args: string[]) => spawnSync('git', ['-C', seeded.sourceDir, ...args], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    expect(git(['init']).status).toBe(0);
    git(['config', 'user.email', 'fixture@example.com']);
    git(['config', 'user.name', 'PD fixture']);
    fs.writeFileSync(path.join(seeded.sourceDir, 'marker.txt'), 'base', 'utf8');
    expect(git(['add', '.']).status).toBe(0);
    expect(git(['commit', '-m', 'base']).status).toBe(0);
    const base = String(git(['rev-parse', 'HEAD']).stdout).trim();
    // The upstream commit exists only in origin/main (no network involved).
    fs.writeFileSync(path.join(seeded.sourceDir, 'marker.txt'), 'upstream', 'utf8');
    expect(git(['add', '.']).status).toBe(0);
    expect(git(['commit', '-m', 'upstream']).status).toBe(0);
    const upstream = String(git(['rev-parse', 'HEAD']).stdout).trim();
    expect(git(['update-ref', 'refs/remotes/origin/main', upstream]).status).toBe(0);
    expect(git(['reset', '--hard', base]).status).toBe(0);

    const stale = statusReport(seeded);

    expect(stale.snapshot?.state).toBe('degraded');
    expect(stale.snapshot?.detail).toContain('local checkout is 1 commit(s) behind origin/main');
    expect(stale.snapshot?.nextAction).toContain('pull --ff-only');
    expect(stale.snapshot?.nextAction).not.toContain('plugin remove');
    expect(stale.report.ok).toBe(false);
  }, 120_000);

  it('stays healthy when the snapshot matches the source, and flags a source that moved back', () => {
    const fresh = statusReport(seedMarketplace({ installed: '0.2.5', source: '0.2.5', quote: 'basic' }));
    expect(fresh.snapshot?.state).toBe('ok');
    expect(fresh.snapshot?.detail).toContain('matches marketplace source');
    expect(fresh.report.ok).toBe(true);
    expect(fresh.result.status).toBe(0);

    // A source checkout behind the installed plugin is drift, not health: the
    // next host refresh would install the older payload (2026-11-11).
    const ahead = statusReport(seedMarketplace({ installed: '0.2.6', source: '0.2.5' }));
    expect(ahead.snapshot?.state).toBe('degraded');
    expect(ahead.snapshot?.detail).toContain('is newer than its marketplace source');
  }, 90_000);

  it('degrades mcpBinding when pd-recall serves a different workspace than --workspace', () => {
    const elsewhere = tempDir('pd-status-other-ws-');
    const report = statusReport(seedMarketplace({ installed: '0.2.5', source: '0.2.5' }), { bindWorkspace: elsewhere });
    const binding = report.report.checks.find((check) => check.name === 'mcpBinding');
    expect(binding?.state).toBe('degraded');
    expect(binding?.detail).toContain('bound to');
    expect(binding?.nextAction).toContain('$pd-control setup');
  }, 90_000);

  it('degrades mcpBinding when the recorded MCP server entry is gone', () => {
    const report = statusReport(seedMarketplace({ installed: '0.2.5', source: '0.2.5' }), { removeServerEntry: true });
    const binding = report.report.checks.find((check) => check.name === 'mcpBinding');
    expect(binding?.state).toBe('degraded');
    expect(binding?.detail).toContain('missing workspace or MCP server entry');
  }, 90_000);

  it('separates "nothing to compare" from "comparison blocked by broken state" (rc-9)', () => {
    // A non-local marketplace has no checkout to diff against: not applicable.
    const remote = statusReport(seedMarketplace({ installed: '0.2.1', source: '9.9.9', sourceType: 'git' }));
    expect(remote.snapshot?.state).toBe('ok');
    expect(remote.snapshot?.detail).toContain('not verifiable (marketplace_source_not_local:git)');

    // A source checkout that was deleted freezes the cache with no other
    // signal — the same "looks healthy while wrong" shape as a stale snapshot.
    const brokenSource = statusReport(seedMarketplace({ installed: '0.2.1' }));
    expect(brokenSource.snapshot?.state).toBe('degraded');
    expect(brokenSource.snapshot?.detail).toContain('not verifiable (source_plugin_json_unreadable)');
    expect(brokenSource.snapshot?.nextAction).toContain('Restore the marketplace source checkout');
    expect(brokenSource.report.ok).toBe(false);

    // A local marketplace entry with no source path is damaged config, never
    // silently downgraded to "not applicable".
    const sourceMissing = statusReport(seedMarketplace({ installed: '0.2.1', omitSource: true }));
    expect(sourceMissing.snapshot?.state).toBe('degraded');
    expect(sourceMissing.snapshot?.detail).toContain('not verifiable (marketplace_source_missing)');
    expect(sourceMissing.snapshot?.nextAction).toContain('has no source path');
  }, 120_000);

  it('compares against the repo-root marketplace layout instead of failing every check (PRI-1052)', () => {
    const current = statusReport(seedRepoMarketplace({ installed: '0.2.5', source: '0.2.5' }));
    expect(current.snapshot?.state).toBe('ok');
    expect(current.snapshot?.detail).toContain('matches marketplace source');
    // The false alarm is what made the Owner distrust this check: a healthy
    // install must end at exit 0 with nothing to repair.
    expect(current.snapshot?.nextAction).toBeUndefined();
    expect(current.report.ok).toBe(true);
    expect(current.result.status).toBe(0);
  }, 90_000);

  it('still catches a stale snapshot behind a repo-root marketplace (the alarm this check exists for)', () => {
    const stale = statusReport(seedRepoMarketplace({ installed: '0.2.1', source: '0.2.5' }));
    expect(stale.snapshot?.state).toBe('degraded');
    expect(stale.snapshot?.detail).toContain('installed plugin 0.2.1 is older than its marketplace source 0.2.5');
    expect(stale.snapshot?.nextAction).toContain('codex plugin add principles-disciple@principles');
    expect(stale.snapshot?.nextAction).not.toContain('plugin remove');
    expect(stale.report.ok).toBe(false);
    expect(stale.result.status).toBe(1);
  }, 90_000);

  it('accepts a sibling directory whose name starts with ".." as still inside the marketplace root', () => {
    const sibling = statusReport(seedRepoMarketplace({ installed: '0.2.5', source: '0.2.5', manifest: 'sibling-prefix-path' }));
    expect(sibling.snapshot?.state).toBe('ok');
    expect(sibling.snapshot?.detail).toContain('matches marketplace source');
    expect(sibling.result.status).toBe(0);
  }, 90_000);

  it('treats an unmodelled marketplace layout as unknown, never "repair the checkout" (PRI-1052)', () => {
    const cases = [
      ['missing', 'marketplace_manifest_unreadable'],
      ['escaping-path', 'marketplace_plugin_source_outside_root'],
    ] as const;
    for (const [flavour, reason] of cases) {
      const seeded = statusReport(seedRepoMarketplace({ installed: '0.2.1', source: '0.2.5', manifest: flavour }));
      expect(seeded.snapshot?.state, flavour).toBe('ok');
      expect(seeded.snapshot?.detail, flavour).toContain(`not verifiable (${reason})`);
      // The layout is unknown, not proven damaged: no repair order.
      expect(seeded.snapshot?.nextAction, flavour).toBeUndefined();
      expect(seeded.result.status, flavour).toBe(0);
    }
  }, 120_000);

  /**
   * PRI-1052 review fix: these reasons are decided AFTER the marketplace
   * manifest for THIS plugin was read. A stale cache can hide behind a renamed
   * or deleted plugin directory, so "not comparable" would have been a silent
   * 0-exit regression of the very alarm this check exists for (rc-9).
   */
  it('stays degraded when the marketplace entry names a plugin that is gone (PRI-1052 review fix)', () => {
    const cases = [
      ['not-listed', 'marketplace_plugin_not_listed:principles-disciple', 'does not list principles-disciple'],
      ['entry-without-path', 'marketplace_plugin_source_missing', 'carries no source.path'],
      ['path-to-nowhere', 'marketplace_plugin_source_path_missing', 'does not exist'],
      ['path-to-file', 'marketplace_plugin_source_not_directory', 'points at a file'],
    ] as const;
    for (const [flavour, reason, recoveryFragment] of cases) {
      const seeded = statusReport(seedRepoMarketplace({ installed: '0.2.1', source: '0.2.5', manifest: flavour }));
      expect(seeded.snapshot?.state, flavour).toBe('degraded');
      expect(seeded.snapshot?.detail, flavour).toContain(`not verifiable (${reason})`);
      expect(seeded.snapshot?.nextAction, flavour).toContain(recoveryFragment);
      // The old blanket message sent the Owner to fix a healthy checkout.
      expect(seeded.snapshot?.nextAction, flavour).not.toContain('Restore the marketplace source checkout');
      expect(seeded.report.ok, flavour).toBe(false);
      expect(seeded.result.status, flavour).toBe(1);
    }
  }, 180_000);

  it('resolves the plugin dir from the marketplace entry and refuses paths that escape the root', async () => {
    const locate = await loadLocate();
    const previous = process.env.CODEX_HOME;
    const repoLayout = seedRepoMarketplace({ installed: '0.2.1', source: '0.2.5' });
    try {
      vi.stubEnv('CODEX_HOME', repoLayout.codexHome);
      expect(locate.resolvePluginSourceSnapshot(repoLayout.root)).toMatchObject({
        ok: true,
        marketplace: 'principles',
        installedVersion: '0.2.1',
        sourceVersion: '0.2.5',
        pluginDir: path.join(repoLayout.sourceDir, 'plugins', 'principles-disciple'),
      });
      const escaping = seedRepoMarketplace({ installed: '0.2.1', source: '0.2.5', manifest: 'escaping-path' });
      vi.stubEnv('CODEX_HOME', escaping.codexHome);
      expect(locate.resolvePluginSourceSnapshot(escaping.root))
        .toEqual({ ok: false, reason: 'marketplace_plugin_source_outside_root' });
    } finally {
      if (previous === undefined) vi.stubEnv('CODEX_HOME', '');
      else vi.stubEnv('CODEX_HOME', previous);
    }
  }, 60_000);

  it('only compares cache roots and marketplace tables it can actually resolve', async () => {
    const locate = await loadLocate();
    expect(locate.resolvePluginSourceSnapshot(tempDir('pd-not-a-cache-'))).toEqual({ ok: false, reason: 'plugin_root_outside_cache' });

    const seeded = seedMarketplace({ installed: '0.2.1', source: '0.2.5' });
    const previous = process.env.CODEX_HOME;
    vi.stubEnv('CODEX_HOME', seeded.codexHome);
    try {
      expect(locate.resolvePluginSourceSnapshot(seeded.root)).toMatchObject({
        ok: true, marketplace: 'principles', source: seeded.sourceDir, installedVersion: '0.2.1', sourceVersion: '0.2.5',
      });
      // A marketplace the config never declared cannot be judged.
      const unknown = path.join(seeded.codexHome, 'plugins', 'cache', 'elsewhere', 'principles-disciple', '0.2.1');
      fs.mkdirSync(unknown, { recursive: true });
      expect(locate.resolvePluginSourceSnapshot(unknown)).toEqual({ ok: false, reason: 'marketplace_not_configured:elsewhere' });
    } finally {
      if (previous === undefined) vi.stubEnv('CODEX_HOME', '');
      else vi.stubEnv('CODEX_HOME', previous);
    }
  }, 60_000);

  it('resets the installed tree but keeps the runtime package.json and marker', async () => {
    const locate = await loadLocate();
    const runtimeDir = tempDir('pd-runtime-reset-');
    fs.mkdirSync(path.join(runtimeDir, 'node_modules', '@principles', 'core'), { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'package-lock.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(runtimeDir, 'package.json'), '{"name":"pd-plugin-runtime"}', 'utf8');
    fs.writeFileSync(path.join(runtimeDir, '.pd-runtime.json'), '{}', 'utf8');
    expect(locate.resetInstalledRuntime(runtimeDir)).toEqual({ ok: true, removed: ['node_modules', 'package-lock.json'] });
    expect(fs.existsSync(path.join(runtimeDir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(runtimeDir, 'package-lock.json'))).toBe(false);
    expect(fs.existsSync(path.join(runtimeDir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(runtimeDir, '.pd-runtime.json'))).toBe(true);
    // Idempotent: a second clean retry has nothing to remove.
    expect(locate.resetInstalledRuntime(runtimeDir)).toEqual({ ok: true, removed: [] });
  }, 60_000);
});

describe('first-run $pd-control setup (real user flow)', () => {
  let samples: RuntimeSamples;
  beforeAll(() => { samples = packLocalRuntimeSamples(); }, 600_000);

  /** Build the Codex cache first-run fixture: a copy of the shipped plugin
   *  payload whose pin names THIS worktree's locally packed cohort. */
  function firstRunSetup(options: { pinOverrides?: Partial<RuntimeVersions>; omitSources?: RuntimeSampleKey[]; env?: Record<string, string> } = {}) {
    // Codex 0.147 SETS PLUGIN_DATA for hooks but does NOT create the dir —
    // $pd-control setup must own first-run creation (derive marketplace from the
    // installed cache path) or every fresh install dead-ends.
    const fakeHome = tempDir('pd-firstrun-home-');
    const pluginManifest: unknown = JSON.parse(fs.readFileSync(path.join(pluginDir, '.codex-plugin', 'plugin.json'), 'utf8'));
    if (!isRecord(pluginManifest) || typeof pluginManifest.version !== 'string') {
      throw new Error('Codex plugin manifest is missing its string version');
    }
    const cachePlugin = path.join(fakeHome, '.codex', 'plugins', 'cache', 'principles', 'principles-disciple', pluginManifest.version);
    fs.mkdirSync(cachePlugin, { recursive: true });
    fs.cpSync(pluginDir, cachePlugin, { recursive: true });
    const shippedPin: unknown = JSON.parse(fs.readFileSync(path.join(pluginDir, 'runtime-version.json'), 'utf8'));
    if (!isRecord(shippedPin) || typeof shippedPin.codexAdapter !== 'string' || typeof shippedPin.hostRuntime !== 'string' || typeof shippedPin.core !== 'string' || typeof shippedPin.mcpServer !== 'string') {
      throw new Error('runtime pin file is missing a package version');
    }
    // Keep the shipped file's shape/note but point it at the local cohort: the
    // published values only become true AFTER the release publishes them.
    const pins = { ...shippedPin, ...samples.versions, ...(options.pinOverrides ?? {}) };
    fs.writeFileSync(path.join(cachePlugin, 'runtime-version.json'), `${JSON.stringify(pins, null, 2)}\n`);
    const workspace = tempDir('pd-firstrun-ws-');
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    // A Version Packages PR rewrites codex-adapter's @principles/install-layout
    // range to the cohort version, but pd-setup forwards only the four
    // --*-source flags, so that transitive edge would resolve from the registry
    // and fail ETARGET until the release publishes it (#2543). Seed the runtime
    // manifest with the locally packed artifact; pd-setup writes this file only
    // when it is absent, so pre-seeding is authoritative for this fixture.
    const runtimeDir = firstRunRuntimeDir(fakeHome);
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, 'package.json'),
      `${JSON.stringify({
        name: 'pd-plugin-runtime',
        private: true,
        dependencies: { '@principles/install-layout': `file:${samples.installLayout.source}` },
      }, null, 2)}\n`,
    );
    const omitted = new Set(options.omitSources ?? []);
    const sourceArgs = localRuntimeSamples
      .filter((entry) => !omitted.has(entry.key))
      .flatMap((entry) => [entry.flag, samples.sources[entry.key]]);
    const result = spawnSync(process.execPath, [path.join(cachePlugin, 'scripts', 'pd-setup.cjs'), '--workspace', workspace, '--skip-init', '--json', ...sourceArgs], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 240_000,
      // Redirect the home dir cross-platform: os.homedir() reads HOME on POSIX and USERPROFILE/HOMEDRIVE+HOMEPATH on Windows.
      env: { ...process.env, CODEX_HOME: path.join(fakeHome, '.codex'), HOME: fakeHome, USERPROFILE: fakeHome, HOMEDRIVE: path.parse(fakeHome).root.slice(0, 2), HOMEPATH: fakeHome.slice(2).split(path.sep).join('/'), PLUGIN_DATA: undefined, ...options.env },
    });
    return { fakeHome, cachePlugin, workspace, pins, result };
  }

  it('creates the plugin data dir Codex never creates, and npm-installs exactly the pinned runtime', async () => {
    const { fakeHome, cachePlugin, workspace, pins, result } = firstRunSetup();
    expect(result.status, result.stderr.slice(0, 400)).toBe(0);
    const report: unknown = JSON.parse(result.stdout);
    if (!isRecord(report)) {
      throw new Error('setup report is malformed');
    }
    const { pluginRoot, pluginData, runtime } = report;
    if (typeof pluginRoot !== 'string' || typeof pluginData !== 'string' || !isRecord(runtime)) {
      throw new Error('setup report is missing its plugin root, data directory, or runtime versions');
    }
    if (typeof runtime.codexAdapter !== 'string' || typeof runtime.hostRuntime !== 'string' || typeof runtime.core !== 'string' || typeof runtime.mcpServer !== 'string') {
      throw new Error('setup report contains malformed runtime versions');
    }
    expect(pluginRoot).toBe(cachePlugin);
    // The data dir was derived + created under the fake home, not the real one.
    expect(pluginData.startsWith(fakeHome)).toBe(true);
    // The install was served by the local samples, never by the public registry:
    // this is the assertion that keeps the case independent of "is the pin
    // published yet" without weakening what it proves.
    expect(report.runtimeSource).toBe('local_adapter_build');
    expect(fs.existsSync(path.join(pluginData, 'runtime', 'node_modules', '@principles', 'codex-adapter', 'dist', 'pd-hook.js'))).toBe(true);
    // PRI-810: assert against the pin SOURCE OF TRUTH, not a hardcoded copy —
    // the previous hardcoded '0.1.0' expectations locked the drift in place.
    expect(runtime.codexAdapter).toBe(pins.codexAdapter);
    expect(runtime.hostRuntime).toBe(pins.hostRuntime);
    expect(runtime.core).toBe(pins.core);
    expect(runtime.mcpServer).toBe(pins.mcpServer);
    // The transitive @principles/install-layout edge resolved to this
    // worktree's artifact, not a registry copy: the seeded file: entry is what
    // keeps the release-time cohort range installable before publish (#2543).
    const installedInstallLayout: unknown = readJson(path.join(pluginData, 'runtime', 'node_modules', '@principles', 'install-layout', 'package.json'));
    const localInstallLayout: unknown = readJson(path.join(installLayoutPackageDir, 'package.json'));
    if (!isRecord(installedInstallLayout) || !isRecord(localInstallLayout)) {
      throw new Error('@principles/install-layout manifest is missing or malformed');
    }
    expect(installedInstallLayout.version).toBe(localInstallLayout.version);

    // Gate 4 (PRI-1071): the setup wrote the PD-owned MCP binding beside the
    // plugin payload, pointing the launcher at the installed server entry.
    const mcpBinding: unknown = JSON.parse(fs.readFileSync(path.join(cachePlugin, 'mcp-binding.json'), 'utf8'));
    if (isRecord(mcpBinding)) {
      expect(mcpBinding.schemaVersion).toBe('pd.mcp-binding.v1');
      expect(mcpBinding.host).toBe('codex');
      expect(mcpBinding.workspaceDir).toBe(workspace);
      expect(mcpBinding.runtimeDir).toBe(path.join(pluginData, 'runtime'));
      expect(mcpBinding.serverEntry).toBe(path.join(pluginData, 'runtime', 'node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'));
      expect(mcpBinding.versions).toEqual({ mcpServer: pins.mcpServer, core: pins.core });
    } else {
      throw new Error('mcp-binding.json is malformed');
    }
    expect(fs.existsSync(path.join(pluginData, 'runtime', 'node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'))).toBe(true);

    // PRI-1046: the report mirrors the pins the script ASKED for. The honest
    // assertion is the bytes npm actually left under runtime/node_modules —
    // npm can exit 0 while dropping one of them from the top-level tree.
    const { createRequire: requireForBytes } = await import('node:module');
    const locateForBytes = requireForBytes(import.meta.url)(path.join(cachePlugin, 'scripts', 'pd-locate.cjs')) as {
      readInstalledRuntimeVersions: (runtimeDir: string) => { codexAdapter: string; hostRuntime: string; core: string; mcpServer: string };
    };
    expect(locateForBytes.readInstalledRuntimeVersions(path.join(pluginData, 'runtime'))).toEqual({
      codexAdapter: pins.codexAdapter,
      hostRuntime: pins.hostRuntime,
      core: pins.core,
      mcpServer: pins.mcpServer,
    });
    // The marker that short-circuits every later run must attest those bytes AND
    // the local samples that produced them — a marker written from the pins
    // alone (without proving which bytes were installed) would let a wrong
    // version short-circuit every later run.
    expect(JSON.parse(fs.readFileSync(path.join(pluginData, 'runtime', '.pd-runtime.json'), 'utf8'))).toMatchObject({
      codexAdapter: pins.codexAdapter,
      hostRuntime: pins.hostRuntime,
      core: pins.core,
      mcpServer: pins.mcpServer,
      adapterSource: samples.sources.codexAdapter,
      hostRuntimeSource: samples.sources.hostRuntime,
      coreSource: samples.sources.core,
      mcpServerSource: samples.sources.mcpServer,
    });

    // CodeRabbit (PR #2304): a first-run fixture that ships a comment-only
    // dist/index.js proves nothing about the installed MCP server. Launch the
    // REAL npm-installed pinned server bytes through the shipped launcher and
    // require discovery, so a placeholder install can no longer pass this test.
    const discovery = spawnSync(process.execPath, [path.join(cachePlugin, 'mcp', 'launcher.cjs')], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        CODEX_HOME: path.join(fakeHome, '.codex'),
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        HOMEDRIVE: path.parse(fakeHome).root.slice(0, 2),
        HOMEPATH: fakeHome.slice(2).split(path.sep).join('/'),
        PLUGIN_DATA: undefined,
      },
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'first-run-probe', version: '1' } } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
    });
    expect(discovery.status, discovery.stderr.slice(0, 600)).toBe(0);
    expect(discovery.stdout).toContain('pd_recall_principle_pains');

    // PRI-810 regression guard: the freshly installed runtime must satisfy the
    // Owner emergency-control capability contract (global pause / safety
    // isolation / retired-contract backstop). Runs IN-PROCESS against the real
    // installed bytes $pd-control setup just produced — a pin that regresses to a
    // guard-less version fails HERE. pathToFileURL (not a bare path) keeps the
    // dynamic import valid on Windows drive-letter paths.
    const probeModule = (await import(pathToFileURL(path.join(cachePlugin, 'scripts', 'verify-pinned-runtime-capability.cjs')).href)) as {
      verifyPinnedRuntimeCapability: (options: { runtimeDir: string }) => Promise<{ ok: boolean; scenarioResults: { name: string; pass: boolean; outcome: unknown }[] }>;
    };
    const probeReport = await probeModule.verifyPinnedRuntimeCapability({ runtimeDir: path.join(report.pluginData, 'runtime') });
    expect(probeReport.ok, JSON.stringify(probeReport.scenarioResults)).toBe(true);
    expect(probeReport.scenarioResults.every((s) => s.pass)).toBe(true);
  }, 420_000);

  it('refuses a pin that is not the exact local cohort version, including a floating "latest" token', () => {
    // The pin must name a version the sample actually IS. A floating token is
    // not "any available version": the local sample is the exact cohort build,
    // so accepting `latest` would silently install whatever happens to be there.
    const { fakeHome, result } = firstRunSetup({ pinOverrides: { codexAdapter: 'latest' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('adapter_source_invalid');
    expect(result.stdout).not.toContain('"ok": true');
    expect(fs.existsSync(path.join(firstRunRuntimeDir(fakeHome), '.pd-runtime.json'))).toBe(false);
  }, 120_000);

  it('fails loud with runtime_install_failed when a pinned version cannot be resolved, never installing another version', () => {
    // Deterministic stand-in for the ETARGET the release line observed on
    // #2510: the pin names a version no sample provides and the registry cannot
    // resolve it. Port 9 refuses TCP, so no network/registry state is involved.
    // The contract under test is setup's own: fail loud, write no marker, never
    // fall back to a different/latest version.
    const { fakeHome, result } = firstRunSetup({
      pinOverrides: { codexAdapter: '0.0.0' },
      omitSources: ['codexAdapter'],
      env: { npm_config_registry: 'http://127.0.0.1:9/' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runtime_install_failed');
    expect(result.stdout).not.toContain('"ok": true');
    expect(fs.existsSync(path.join(firstRunRuntimeDir(fakeHome), '.pd-runtime.json'))).toBe(false);
  }, 180_000);
});

describe('pd-disable.cjs kill switch', () => {
  it('flips host.codex.enabled in the nearest .pd/config.yaml and is idempotent', async () => {
    const workspace = tempDir('pd-disable-ws-');
    fs.mkdirSync(path.join(workspace, '.pd', 'sub'), { recursive: true });
    const { getDefaultPdConfig } = await import('@principles/core/runtime');
    const config = getDefaultPdConfig();
    config.features['host.codex'].enabled = true;
    // js-yaml 5 is ESM-only: no default export — use the namespace.
    const yamlDump = (await import('js-yaml')).dump(config, { lineWidth: -1 });
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

describe('PRI-645 sparse fresh config × bundled $pd-cli-operator / $pd-control disable', () => {
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

  it('$pd-cli-operator reports registry-default (ok) instead of a fake degradation on features: {}', async () => {
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

  it('$pd-control disable inserts the explicit override into a sparse fresh config and re-enables (block YAML)', async () => {
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

  it('$pd-control disable inserts the override into a sparse flow-style (JSON) config', async () => {
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

// ── PR #2106 review rounds: single-authority locator entrypoint ──
//
// Round 1 fixed the PowerShell cache ordering (numeric semver via
// `Sort-Object { [version]$_.Directory.Parent.Name }`). Round 2 removes the
// deeper defect: the skills used to glob for EACH TARGET SCRIPT and pick the
// highest version by that script file, which silently fell back to an older
// plugin when the newest install stopped shipping the script, and could not
// prove marketplace provenance. Every skill command now globs only for the
// shipped locator (scripts/pd-locate.cjs) and runs the target through
// `--exec`: the locator pins the plugin root once (plugin.json-validated,
// numeric semver, marketplace tie → explicit ambiguity error), then requires
// the script to exist in THAT root — never falling back to an older version.

describe('skill locator entrypoint via pd-locate.cjs (PR #2106 review round 2)', () => {
  const numericSortExpr = /Sort-Object \{ \[version\]\$_\.Directory\.Parent\.Name \}/;
  const targetScripts = ['pd-status.cjs', 'pd-setup.cjs', 'pd-disable.cjs', 'pd-review.cjs'];
  const realLocator = path.join(pluginDir, 'scripts', 'pd-locate.cjs');
  // Stub target scripts print their own absolute path + the argv they received,
  // so tests can see WHICH installed version ran and that `--`-separated flags
  // were passed through to the target.
  const stubScript = "console.log(require('path').resolve(__filename)); console.log(JSON.stringify(process.argv.slice(2)));";

  interface VersionSeed { version: string; scripts?: string[] }
  interface MarketplaceSeed { name: string; versions: VersionSeed[] }

  /** Seed a fake CODEX_HOME plugin cache in the REAL install layout: every
   * version dir gets a `.codex-plugin/plugin.json` stub, a copy of the REAL
   * pd-locate.cjs, and stub target scripts. `scripts: []` (or omitting the
   * target) seeds a version that ships the locator but NOT that target —
   * exactly the layout that used to trigger the silent older-version
   * fallback. Returns the fake CODEX_HOME path. */
  function seedInstalledCache(fakeHome: string, marketplaces: MarketplaceSeed[]): string {
    const codexHome = path.join(fakeHome, '.codex');
    for (const mp of marketplaces) {
      for (const v of mp.versions) {
        const root = path.join(codexHome, 'plugins', 'cache', mp.name, 'principles-disciple', v.version);
        fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
        fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'principles-disciple' }), 'utf8');
        fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
        fs.copyFileSync(realLocator, path.join(root, 'scripts', 'pd-locate.cjs'));
        for (const script of v.scripts ?? []) {
          fs.writeFileSync(path.join(root, 'scripts', script), stubScript, 'utf8');
        }
      }
    }
    return codexHome;
  }

  /** Extract the full PowerShell skill command (assignment + node line) that
   * runs `--exec scripts/<targetScript>` so the dynamic tests execute the
   * DOCUMENTED text, not a re-typed copy. */
  function extractSkillCommand(skillFile: string, targetScript: string): string {
    const raw = fs.readFileSync(skillFile, 'utf8');
    const homeAssignment = raw.match(/^[ \t]*\$pdCodexHome = .*$/m)?.[0];
    const nodeLine = raw
      .split(/\r?\n/)
      .find((line) => line.includes('Get-ChildItem') && line.includes(`--exec scripts/${targetScript}`));
    if (!homeAssignment || !nodeLine) {
      throw new Error(`no PowerShell locator command for ${targetScript} found in ${skillFile}`);
    }
    // `exit $LASTEXITCODE` propagates the node child's exit code out of pwsh,
    // so fail-loud contracts can be asserted on status, not just on stderr.
    return `${homeAssignment}; ${nodeLine.trim()}; exit $LASTEXITCODE`;
  }

  /** Windows prefers pwsh with a powershell.exe fallback; elsewhere only
   * pwsh exists. A spawnSync probe distinguishes ENOENT from failure. */
  function findPowerShell(): string | undefined {
    const candidates = process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh'];
    for (const bin of candidates) {
      const probe = spawnSync(bin, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 30_000 });
      if (probe.error === undefined) return bin;
    }
    return undefined;
  }

  function runInPwsh(psBin: string, command: string, fakeHome: string, codexHome: string) {
    return spawnSync(psBin, ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: codexHome, USERPROFILE: fakeHome },
      timeout: 60_000,
    });
  }

  it('SKILL.md PowerShell snippets route through the shipped locator, never per-target-script cache globs', () => {
    for (const skill of ['pd-cli-operator', 'pd-control', 'pd-review']) {
      const raw = fs.readFileSync(path.join(pluginDir, 'skills', skill, 'SKILL.md'), 'utf8');
      expect(raw, skill).not.toContain('Sort-Object FullName');
      const lines = raw.split(/\r?\n/).filter((line) => line.includes('Get-ChildItem'));
      expect(lines.length, skill).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, `${skill}: ${line.trim()}`).toMatch(numericSortExpr);
        expect(line, `${skill}: ${line.trim()}`).toContain('--exec scripts/');
        const glob = line.match(/Get-ChildItem "([^"]+)"/)?.[1] ?? '';
        expect(glob, `${skill}: ${line.trim()}`).toContain('pd-locate.cjs');
        for (const target of targetScripts) {
          // Globbing a target script directly would reintroduce per-script
          // (fallback-prone) cache selection.
          expect(glob, `${skill}: ${line.trim()}`).not.toContain(target);
        }
      }
    }
  });

  it('status skill command selects 1.10.0 over 1.9.0 and passes -- --json through (scenario A)', (ctx) => {
    const psBin = findPowerShell();
    if (!psBin) {
      console.log('[PR #2106] no PowerShell (pwsh/powershell) found on this machine — skipping the dynamic locator scenario A');
      ctx.skip();
      return;
    }
    const fakeHome = tempDir('pd-locate-e2e-home-');
    const codexHome = seedInstalledCache(fakeHome, [
      { name: 'm1', versions: [{ version: '1.9.0', scripts: ['pd-status.cjs'] }, { version: '1.10.0', scripts: ['pd-status.cjs'] }] },
    ]);
    const result = runInPwsh(psBin, extractSkillCommand(path.join(pluginDir, 'skills', 'pd-cli-operator', 'SKILL.md'), 'pd-status.cjs'), fakeHome, codexHome);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1.10.0');
    expect(result.stdout).not.toContain('1.9.0');
    expect(result.stdout).toContain('["--json"]'); // flags after -- reached the target script
  }, 90_000);

  it('status skill command refuses to run an older version when the newest install lacks the script (scenario B)', (ctx) => {
    const psBin = findPowerShell();
    if (!psBin) {
      console.log('[PR #2106] no PowerShell (pwsh/powershell) found on this machine — skipping the dynamic locator scenario B');
      ctx.skip();
      return;
    }
    const fakeHome = tempDir('pd-locate-e2e-home-');
    // Newest install ships the locator + plugin.json but NOT pd-status.cjs;
    // 1.9.0 ships everything. The old per-script glob would have run 1.9.0.
    const codexHome = seedInstalledCache(fakeHome, [
      { name: 'm1', versions: [{ version: '1.9.0', scripts: ['pd-status.cjs'] }, { version: '1.10.0', scripts: [] }] },
    ]);
    const result = runInPwsh(psBin, extractSkillCommand(path.join(pluginDir, 'skills', 'pd-cli-operator', 'SKILL.md'), 'pd-status.cjs'), fakeHome, codexHome);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('plugin_script_missing');
    // No fallback execution: the 1.9.0 stub never ran (node children inherit
    // pwsh's streams, so combined output proves which script — if any — ran).
    expect(`${result.stdout}${result.stderr}`).not.toContain(path.join('1.9.0', 'scripts', 'pd-status.cjs'));
    expect(`${result.stdout}${result.stderr}`).not.toContain('["--json"]');
  }, 90_000);

  it('status skill command fails loud on a marketplace tie instead of guessing (scenario C)', (ctx) => {
    const psBin = findPowerShell();
    if (!psBin) {
      console.log('[PR #2106] no PowerShell (pwsh/powershell) found on this machine — skipping the dynamic locator scenario C');
      ctx.skip();
      return;
    }
    const fakeHome = tempDir('pd-locate-e2e-home-');
    const codexHome = seedInstalledCache(fakeHome, [
      { name: 'm1', versions: [{ version: '1.10.0', scripts: ['pd-status.cjs'] }] },
      { name: 'm2', versions: [{ version: '1.10.0', scripts: ['pd-status.cjs'] }] },
    ]);
    const result = runInPwsh(psBin, extractSkillCommand(path.join(pluginDir, 'skills', 'pd-cli-operator', 'SKILL.md'), 'pd-status.cjs'), fakeHome, codexHome);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('plugin_root_ambiguous');
    expect(`${result.stdout}${result.stderr}`).not.toContain('pd-status.cjs'); // no stub executed
  }, 90_000);

  // Library-level contract of the CLI entry itself: plain node, no pwsh, runs
  // on every platform. These pin the exact behavior the skill commands rely on.
  describe('pd-locate.cjs --exec CLI (node-level, cross-platform)', () => {
    function runLocator(codexHome: string, fakeHome: string, args: string[]) {
      return spawnSync(process.execPath, [realLocator, ...args], {
        encoding: 'utf8',
        env: { ...process.env, CODEX_HOME: codexHome, USERPROFILE: fakeHome },
        timeout: 60_000,
      });
    }

    it('picks the newest version across marketplaces and passes -- flags through', () => {
      const fakeHome = tempDir('pd-locate-lib-home-');
      const codexHome = seedInstalledCache(fakeHome, [
        { name: 'm1', versions: [{ version: '1.9.0', scripts: ['pd-status.cjs'] }] },
        { name: 'm2', versions: [{ version: '1.10.0', scripts: ['pd-status.cjs'] }] },
      ]);
      const result = runLocator(codexHome, fakeHome, ['--exec', 'scripts/pd-status.cjs', '--', '--json']);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(path.join('m2', 'principles-disciple', '1.10.0', 'scripts', 'pd-status.cjs'));
      expect(result.stdout).toContain('["--json"]');
      expect(result.stdout).not.toContain('1.9.0');
    }, 90_000);

    it('fails with plugin_root_ambiguous when two marketplaces tie at the newest version', () => {
      const fakeHome = tempDir('pd-locate-lib-home-');
      const codexHome = seedInstalledCache(fakeHome, [
        { name: 'm1', versions: [{ version: '1.10.0', scripts: ['pd-status.cjs'] }] },
        { name: 'm2', versions: [{ version: '1.10.0', scripts: ['pd-status.cjs'] }] },
      ]);
      const result = runLocator(codexHome, fakeHome, ['--exec', 'scripts/pd-status.cjs']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('plugin_root_ambiguous');
      expect(result.stderr).toContain('m1');
      expect(result.stderr).toContain('m2');
      expect(`${result.stdout}${result.stderr}`).not.toContain('pd-status.cjs'); // nothing executed
    }, 90_000);

    it('fails with plugin_script_missing when the newest root lacks the script — no older-version fallback', () => {
      const fakeHome = tempDir('pd-locate-lib-home-');
      const codexHome = seedInstalledCache(fakeHome, [
        { name: 'm1', versions: [{ version: '1.9.0', scripts: ['pd-status.cjs'] }, { version: '1.10.0', scripts: [] }] },
      ]);
      const result = runLocator(codexHome, fakeHome, ['--exec', 'scripts/pd-status.cjs']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('plugin_script_missing');
      expect(result.stderr).toContain('refusing to fall back');
      expect(result.stderr).toContain('1.10.0');
      expect(`${result.stdout}${result.stderr}`).not.toContain(path.join('1.9.0', 'scripts', 'pd-status.cjs'));
    }, 90_000);

    it('rejects --exec paths that escape the plugin root (absolute and ..)', () => {
      const fakeHome = tempDir('pd-locate-lib-home-');
      const codexHome = seedInstalledCache(fakeHome, [
        { name: 'm1', versions: [{ version: '1.10.0', scripts: ['pd-status.cjs'] }] },
      ]);
      for (const bad of ['../escape.cjs', path.join(codexHome, 'plugins', 'cache', 'escape.cjs')]) {
        const result = runLocator(codexHome, fakeHome, ['--exec', bad]);
        expect(result.status, bad).not.toBe(0);
        expect(result.stderr, bad).toContain('script_path_invalid');
      }
    }, 90_000);

    it('fails with plugin_not_installed on an empty cache', () => {
      const fakeHome = tempDir('pd-locate-lib-home-');
      const codexHome = path.join(fakeHome, '.codex');
      fs.mkdirSync(path.join(codexHome, 'plugins', 'cache'), { recursive: true });
      const result = runLocator(codexHome, fakeHome, ['--exec', 'scripts/pd-status.cjs']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('plugin_not_installed');
    }, 90_000);

    it('--plugin-root takes precedence over cache enumeration', () => {
      const fakeHome = tempDir('pd-locate-lib-home-');
      // A root OUTSIDE the (empty) cache that is a valid plugin install.
      const fakeRoot = tempDir('pd-locate-explicit-root-');
      fs.mkdirSync(path.join(fakeRoot, '.codex-plugin'), { recursive: true });
      fs.writeFileSync(path.join(fakeRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'principles-disciple' }), 'utf8');
      fs.mkdirSync(path.join(fakeRoot, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(fakeRoot, 'scripts', 'x.cjs'), stubScript, 'utf8');
      const codexHome = path.join(fakeHome, '.codex');
      fs.mkdirSync(path.join(codexHome, 'plugins', 'cache'), { recursive: true });
      const result = runLocator(codexHome, fakeHome, ['--plugin-root', fakeRoot, '--exec', 'scripts/x.cjs']);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(path.join(fakeRoot, 'scripts', 'x.cjs'));
    }, 90_000);

    it('prints usage and exits non-zero without --exec', () => {
      const fakeHome = tempDir('pd-locate-lib-home-');
      const codexHome = path.join(fakeHome, '.codex');
      fs.mkdirSync(codexHome, { recursive: true });
      const result = runLocator(codexHome, fakeHome, []);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Usage');
    }, 90_000);
  });
});
