/**
 * CodexHostInstaller — implements HostInstaller for OpenAI Codex CLI (ADR-0020 §2.3, SPEC v4.1 §5.7)
 *
 * Writes/merges `~/.codex/hooks.json` pointing to the codex-adapter's pd-hook.js
 * entry. Codex spawns pd-hook.js as a subprocess for each hook event.
 *
 * Install layout (does NOT mix with OpenClaw's ~/.openclaw/ tree):
 *   ~/.pd/codex/
 *   ├── pd-hook-entry.cjs     # wrapper: sets env vars + imports codex-adapter
 *   └── .pd-hooks.marker      # sidecar marker for precise uninstall
 *
 * hooks.json entries (SPEC v4.1 §5.7):
 *   ~/.codex/hooks.json (merged — append, never overwrite)
 *
 * Runtime Contract Rules:
 * - rc-1-treat-as-unknown: hooks.json parsed as unknown, validated.
 * - rc-2-no-as-bypass: uses Object.hasOwn + typeof guards.
 * - rc-3-fail-loud-missing: malformed hooks.json throws.
 * - rc-5-object-hasown-not-in: uses Object.hasOwn for untrusted keys.
 * - rc-9-no-silent-fallback: every result includes reason + nextAction.
 *
 * EP-06 (Source of Truth): hooks.json is the canonical hook config — we
 * merge into it, never overwrite. The marker file is our own bookkeeping
 * for precise uninstall.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { isNpmDependencyResolutionEnabled } from '../installer.js';
import { getPdRuntimeDir } from '../mvp-config.js';
import type {
  HostInstaller,
  HostInstallContext,
  HostInstallResult,
  HostUninstallContext,
  HostUninstallResult,
  HostDetectResult,
  LegacyCodexRegistration,
} from '@principles/core/host';

// NOTE (PRI-625 review round 3 / PRI-669 gate): this installer ships as the
// self-contained npx package — @principles/core is NOT in its dependencies,
// and type-only imports are erased at compile time, so the import above is
// safe. The legacy-registration PARSER must therefore NOT be value-imported
// here. Its single authority lives in @principles/core/host
// (parseLegacyCodexHooksRegistration); the local classification below is the
// npx-parity edge, and a CI parity test pins the two shapes together.

const requireFromModule = createRequire(import.meta.url);

// ─── Codex hook event names (SPEC v4.1 §5.7) ────────────────────────────────
const CODEX_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart'] as const;

const PD_HOOK_MARKER = 'pd-hooks.marker';

// ─── Type guards (rc-2: no `as` bypass) ─────────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Type guard: extracts `.code` from a thrown error without `as NodeJS.ErrnoException`.
 * ESLint `no-undef` flags the `NodeJS` namespace; this helper avoids it.
 */
function getErrorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && Object.hasOwn(err, 'code')) {
    const { code } = err as { code?: unknown };
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

// ─── Path helpers ───────────────────────────────────────────────────────────
function getCodexDir(): string {
  // Shared authority for Marketplace observation and the legacy hook detector.
  // Codex accepts relative CODEX_HOME; path.resolve matches pd-cli's reader.
  const override = process.env.CODEX_HOME;
  return typeof override === 'string' && override.length > 0
    ? path.resolve(override)
    : path.join(os.homedir(), '.codex');
}

function getCodexHooksJsonPath(): string {
  return path.join(getCodexDir(), 'hooks.json');
}

function getPdCodexDir(): string {
  return path.join(os.homedir(), '.pd', 'codex');
}

function getPdHookMarkerPath(): string {
  return path.join(getPdCodexDir(), PD_HOOK_MARKER);
}

/**
 * Resolve the path to the codex-adapter's pd-hook.js entry.
 *
 * Strategy:
 * 1. Try require.resolve('@principles/codex-adapter/pd-hook') from this
 *    package — works in a dev checkout (workspace sibling) or when the
 *    adapter sits in an ancestor node_modules.
 * 2. Fall back to the global npm root (`npm root -g`). A createRequire from
 *    THIS package cannot see global node_modules: when the installer runs via
 *    `npx create-principles-disciple`, the resolution root is the npx cache,
 *    which is not an ancestor of the global root. Without this probe, the
 *    documented flow "npm install -g @principles/codex-adapter, then re-run"
 *    dead-ends: install keeps failing even after the user follows the
 *    nextAction (PRI-523 review finding).
 * 3. Fall back to undefined — installer reports the missing dependency.
 */
function getGlobalNpmRoot(): string | undefined {
  // Registry dependency resolution is legitimate whenever the package is not
  // self-contained (the npm-distributed shape resolves from the registry
  // just like the PD_ALLOW_LEGACY_NPM_INSTALL recovery path).
  if (!isNpmDependencyResolutionEnabled()) return undefined;
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

export function resolveAdapterPdHookFromDir(dir: string): string | undefined {
  try {
    // Probe filename inside the dir so resolution starts at that directory
    // and honors the package's exports map ("./pd-hook").
    return createRequire(path.join(dir, 'pd-adapter-probe.cjs')).resolve('@principles/codex-adapter/pd-hook');
  } catch {
    return undefined;
  }
}

export interface PdHookPathDeps {
  localResolve?: (specifier: string) => string | undefined;
  globalNpmRoot?: () => string | undefined;
  resolveFromDir?: (dir: string) => string | undefined;
}

export function resolvePdHookPath(deps: PdHookPathDeps = {}): string | undefined {
  const localResolve: (specifier: string) => string | undefined = deps.localResolve
    ?? ((specifier) => {
      try { return requireFromModule.resolve(specifier); } catch { return undefined; }
    });
  const globalNpmRoot = deps.globalNpmRoot ?? getGlobalNpmRoot;
  const resolveFromDir = deps.resolveFromDir ?? resolveAdapterPdHookFromDir;

  const local = localResolve('@principles/codex-adapter/pd-hook');
  if (local) return local;

  const globalRoot = globalNpmRoot();
  if (globalRoot) {
    const fromGlobal = resolveFromDir(globalRoot);
    if (fromGlobal) return fromGlobal;
  }
  return undefined;
}

/**
 * Hook entry / matcher-group shapes (rc-2 typing for detectLegacyCodexHookRegistration).
 * The builder that CREATED these groups was retired with the legacy installer
 * (SPEC rev 2 §17); the shapes remain because uninstall and the legacy
 * detector must still recognize what old installers wrote.
 */

// ─── Wrapper script content ─────────────────────────────────────────────────
/**
 * Generate the wrapper script that sets env vars and imports pd-hook.js.
 *
 * This is a CommonJS file so it can use process.env mutation before the
 * ESM pd-hook.js is dynamically imported. Cross-platform (no shell syntax).
 */
export function buildWrapperScriptContent(pdHookPath: string, workspaceDir: string): string {
  return [
    '#!/usr/bin/env node',
    '// Auto-generated by create-principles-disciple installer (CodexHostInstaller).',
    '// Sets PD env vars, then imports the codex-adapter pd-hook entry.',
    '// DO NOT edit manually — re-run the installer to regenerate.',
    '',
    'process.env.PD_HOST_CODEX_ENABLED = "1";',
    `process.env.PD_WORKSPACE_DIR = ${JSON.stringify(workspaceDir)};`,
    '',
    '// Import the codex-adapter pd-hook entry (ESM).',
    '// pd-hook.js reads stdin, processes the hook, writes stdout, exits.',
    // pathToFileURL — not manual `file://` concatenation: a POSIX absolute
    // path would produce file:////... and fail to import.
    `import(${JSON.stringify(pathToFileURL(pdHookPath).href)});`,
    '',
  ].join('\n');
}

// ─── Legacy registration detection (Slice D, SPEC rev 2 §17) ────────────────
// The single PARSING authority lives in @principles/core/host
// (parseLegacyCodexHooksRegistration — pure, no I/O). This installer is the
// npx-parity FS edge: same classification semantics, mirrored here because
// @principles/core is not a runtime dependency of this self-contained
// package. CI pins the two shapes together (codex-host-installer.test.ts →
// parseLegacyCodexHooksRegistration parity).

export function detectLegacyCodexHookRegistration(hooksJsonPathOverride?: string): LegacyCodexRegistration {
  const hooksJsonPath = hooksJsonPathOverride ?? getCodexHooksJsonPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
  } catch {
    return { detected: false, legacyAsyncPostToolUse: false };
  }
  // npx-parity mirror of @principles/core/host parseLegacyCodexHooksRegistration
  // (kept here because @principles/core is not a runtime dep of this package;
  // parity with the core parser is enforced by codex-host-installer.test.ts).
  if (!isRecord(parsed)) return { detected: false, legacyAsyncPostToolUse: false };
  let detected = false;
  let legacyAsyncPostToolUse = false;
  for (const eventName of CODEX_EVENTS) {
    const groups = parsed[eventName];
    if (!isUnknownArray(groups)) continue;
    for (const group of groups) {
      if (!(isRecord(group) && Object.hasOwn(group, '__pd_marker') && group.__pd_marker === 'pd-owned')) continue;
      detected = true;
      const entries = group.hooks;
      if (!isUnknownArray(entries)) continue;
      for (const entry of entries) {
        if (isRecord(entry) && eventName === 'PostToolUse' && Object.hasOwn(entry, 'async') && entry.async === true) {
          legacyAsyncPostToolUse = true;
        }
      }
    }
  }
  return { detected, legacyAsyncPostToolUse };
}

// ─── Codex Marketplace state (three-state detection, read-only) ─────────────
/**
 * Read-only three-state detection of the Codex Marketplace plugin install.
 * Layout Codex writes for the supported path (plugin add principles-disciple):
 *   plugins/cache/principles/principles-disciple/SEMVER/runtime-version.json
 * under the Codex home. Same read-only evidence pd-cli health consumes
 * (selectMarketplaceCacheVersionDir); mirrored read-only here because the
 * self-contained npx package must not depend on pd-cli. A CI parity test pins
 * the two shapes together. rc-9: an unreadable cache root is unknown, never
 * installed state.
 */
export type CodexMarketplaceState =
  | { state: 'installed'; version: string; versionDir: string }
  | { state: 'not_installed' }
  | { state: 'unknown'; reason: string };

/**
 * Same resolution the pd-cli authority uses (resolveCodexHome): the Codex
 * home may be redirected via CODEX_HOME and the Marketplace cache follows
 * that redirect. Like the pd-cli authority, relative paths and parent
 * components are resolved against the current working directory. This is
 * read-only observation of a user-selected Codex home, not a filesystem write.
 */
function resolveCodexHomeForMarketplace(): string {
  return getCodexDir();
}

export function detectCodexMarketplaceState(codexHome?: string): CodexMarketplaceState {
  const home = codexHome ?? resolveCodexHomeForMarketplace();
  const cachePluginRoot = path.join(home, 'plugins', 'cache', 'principles', 'principles-disciple');
  let entries: string[] | undefined;
  try {
    const read = readdirSync(cachePluginRoot);
    // rc-4: validating "is array" before iteration — a non-array listing is
    // unverifiable state, never an empty guess.
    if (!Array.isArray(read)) {
      return { state: 'unknown', reason: 'the Codex Marketplace cache listing is not a directory array: ' + cachePluginRoot };
    }
    entries = read;
  } catch (err) {
    if (getErrorCode(err) === 'ENOENT') return { state: 'not_installed' };
    return {
      state: 'unknown',
      reason: 'cache root unreadable: ' + cachePluginRoot + ' (' + String(err) + ')',
    };
  }
  const semverPattern = /^(\d+)\.(\d+)\.(\d+)$/;
  let best: { dirName: string; parts: [number, number, number] } | undefined;
  let unverifiableCandidate: string | undefined;
  for (const versionDir of entries) {
    const match = semverPattern.exec(versionDir);
    if (match === null) continue;
    // Parity with the authority (selectMarketplaceCacheVersionDir): the pin
    // must PARSE as a JSON object, not merely exist — a corrupt pin means the
    // candidate is unusable, not installed (a bare existsSync here would
    // claim installed state that pd-cli health refuses).
    const pinFile = path.join(cachePluginRoot, versionDir, 'runtime-version.json');
    let pinValid: boolean;
    try {
      const pin: unknown = JSON.parse(readFileSync(pinFile, 'utf-8'));
      pinValid = isRecord(pin);
    } catch {
      pinValid = false;
    }
    if (!pinValid) {
      // Presence of an apparently installed version with an unreadable or
      // malformed pin is UNKNOWN, not proof that no plugin was installed.
      unverifiableCandidate ??= pinFile;
      continue;
    }
    const major = Number.parseInt(match[1] ?? '', 10);
    const minor = Number.parseInt(match[2] ?? '', 10);
    const patch = Number.parseInt(match[3] ?? '', 10);
    if (![major, minor, patch].every((n) => Number.isFinite(n))) continue;
    if (best === undefined
      || major > best.parts[0]
      || (major === best.parts[0] && (minor > best.parts[1] || (minor === best.parts[1] && patch > best.parts[2])))) {
      best = { dirName: versionDir, parts: [major, minor, patch] };
    }
  }
  if (best === undefined) {
    return unverifiableCandidate === undefined
      ? { state: 'not_installed' }
      : { state: 'unknown', reason: 'Codex Marketplace version exists but runtime pin cannot be verified: ' + unverifiableCandidate };
  }
  return { state: 'installed', version: best.dirName, versionDir: path.join(cachePluginRoot, best.dirName) };
}

// ─── Runtime cohort reconciliation (update chain, 2026-11-11) ───────────────
/**
 * The runtime Codex hooks actually load is the PLUGIN_DATA copy, and its
 * intended version is the one pinned by the payload's `runtime-version.json`.
 * Until 2026-11-11 nothing reconciled the two: a Marketplace payload update
 * left PLUGIN_DATA one cohort behind its own pin, and pd-hook only RESOLVED a
 * runtime — it never installed one. These helpers OBSERVE that drift and call
 * the plugin's existing `scripts/pd-setup.cjs` authority to materialize the
 * pin. They are not a second runtime installer.
 */
export interface CodexRuntimeCohort {
  readonly codexAdapter: string;
  readonly hostRuntime: string;
  readonly core: string;
  readonly mcpServer: string;
}

const RUNTIME_COMPONENT_DIRS = {
  codexAdapter: 'codex-adapter',
  hostRuntime: 'host-runtime',
  core: 'core',
  mcpServer: 'pd-mcp-server',
} as const;

export interface CodexCommandResult {
  readonly ok: boolean;
  /** Bounded diagnostic detail (stderr tail / error message) for reason text. */
  readonly detail?: string;
}

export interface CodexInstallerDeps {
  /**
   * Codex home override. Tests inject a temp home; the default is CODEX_HOME
   * or ~/.codex, the same authority the Marketplace detector already uses.
   */
  readonly codexHome?: string;
  /**
   * Canonical PD runtime root (`~/.pd/runtime`). Its component versions define
   * "the PD release being installed", i.e. the target the cached Marketplace
   * payload is compared against. This is the same layout pd-cli's
   * delivery-surfaces authority reads.
   */
  readonly canonicalRuntimeDir?: string;
  /** Command runner (default: spawnSync). Tests inject a fake host boundary. */
  readonly runCommand?: (file: string, args: readonly string[], timeoutMs: number) => CodexCommandResult;
}

function readPackageVersion(pkgJsonPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    if (!isRecord(parsed)) return undefined;
    const value = parsed.version;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function pinField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function buildCohort(values: Record<keyof CodexRuntimeCohort, string | undefined>): CodexRuntimeCohort | undefined {
  const { codexAdapter, hostRuntime, core, mcpServer } = values;
  if (codexAdapter === undefined || hostRuntime === undefined || core === undefined || mcpServer === undefined) {
    return undefined;
  }
  return { codexAdapter, hostRuntime, core, mcpServer };
}

/** The cohort a plugin payload declares in `<pluginRoot>/runtime-version.json`. */
export function readPinnedRuntimeCohort(pluginRoot: string): CodexRuntimeCohort | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path.join(pluginRoot, 'runtime-version.json'), 'utf-8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  return buildCohort({
    codexAdapter: pinField(parsed, 'codexAdapter'),
    hostRuntime: pinField(parsed, 'hostRuntime'),
    core: pinField(parsed, 'core'),
    mcpServer: pinField(parsed, 'mcpServer'),
  });
}

/** The canonical PD runtime's actual versions (`<runtimeDir>/<component>/package.json`). */
export function readCanonicalRuntimeCohort(runtimeDir: string): CodexRuntimeCohort | undefined {
  return buildCohort({
    codexAdapter: readPackageVersion(path.join(runtimeDir, RUNTIME_COMPONENT_DIRS.codexAdapter, 'package.json')),
    hostRuntime: readPackageVersion(path.join(runtimeDir, RUNTIME_COMPONENT_DIRS.hostRuntime, 'package.json')),
    core: readPackageVersion(path.join(runtimeDir, RUNTIME_COMPONENT_DIRS.core, 'package.json')),
    mcpServer: readPackageVersion(path.join(runtimeDir, RUNTIME_COMPONENT_DIRS.mcpServer, 'package.json')),
  });
}

/** The cohort installed in PLUGIN_DATA (`<runtimeDir>/node_modules/<pkg>/package.json`). */
export function readInstalledRuntimeCohort(runtimeDir: string): CodexRuntimeCohort | undefined {
  const packageDirs = {
    codexAdapter: '@principles/codex-adapter',
    hostRuntime: '@principles/host-runtime',
    core: '@principles/core',
    mcpServer: '@principles/pd-mcp-server',
  } as const;
  return buildCohort({
    codexAdapter: readPackageVersion(path.join(runtimeDir, 'node_modules', packageDirs.codexAdapter, 'package.json')),
    hostRuntime: readPackageVersion(path.join(runtimeDir, 'node_modules', packageDirs.hostRuntime, 'package.json')),
    core: readPackageVersion(path.join(runtimeDir, 'node_modules', packageDirs.core, 'package.json')),
    mcpServer: readPackageVersion(path.join(runtimeDir, 'node_modules', packageDirs.mcpServer, 'package.json')),
  });
}

function semverParts(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (match === null) return undefined;
  const major = Number.parseInt(match[1] ?? '', 10);
  const minor = Number.parseInt(match[2] ?? '', 10);
  const patch = Number.parseInt(match[3] ?? '', 10);
  return [major, minor, patch].every((n) => Number.isFinite(n)) ? [major, minor, patch] : undefined;
}

/** Numeric semver compare; unparsable values compare equal (never a guess). */
export function compareRuntimeVersions(a: string, b: string): number {
  const left = semverParts(a);
  const right = semverParts(b);
  if (left === undefined || right === undefined) return 0;
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when ANY pinned component is older than the target cohort. */
export function isRuntimeCohortBehind(pin: CodexRuntimeCohort, target: CodexRuntimeCohort): boolean {
  const keys: readonly (keyof CodexRuntimeCohort)[] = ['codexAdapter', 'hostRuntime', 'core', 'mcpServer'];
  return keys.some((key) => compareRuntimeVersions(pin[key], target[key]) < 0);
}

export function cohortsEqual(left: CodexRuntimeCohort, right: CodexRuntimeCohort): boolean {
  const keys: readonly (keyof CodexRuntimeCohort)[] = ['codexAdapter', 'hostRuntime', 'core', 'mcpServer'];
  return keys.every((key) => compareRuntimeVersions(left[key], right[key]) === 0);
}

export function describeRuntimeCohort(cohort: CodexRuntimeCohort): string {
  return `codex-adapter@${cohort.codexAdapter} host-runtime@${cohort.hostRuntime} core@${cohort.core} mcp-server@${cohort.mcpServer}`;
}

/** `<home>/plugins/cache/<marketplace>/principles-disciple/<version>` → marketplace name. */
function deriveMarketplaceName(versionDir: string): string | undefined {
  const marketplace = path.basename(path.dirname(path.dirname(versionDir)));
  return /^[A-Za-z0-9._-]+$/.test(marketplace) ? marketplace : undefined;
}

/**
 * True when `file` must be dispatched through the Windows command processor.
 *
 * Only a BARE command name needs it: `codex` on Windows is a `.cmd`/`.ps1`
 * shim that CreateProcess cannot execute directly. An executable PATH —
 * absolute, drive-qualified or containing a separator — must be spawned
 * directly, because `shell: true` lets Node join the command line WITHOUT
 * quoting the executable: `D:\Program Files\nodejs\node.exe` reaches cmd.exe as
 * `D:\Program` and the child never starts (regression from #2505, which made
 * `runRuntimeSetup` pass `process.execPath`).
 */
function shouldUseShell(file: string): boolean {
  if (process.platform !== 'win32') return false;
  if (path.win32.isAbsolute(file)) return false;
  return !/[\\/]/.test(file);
}

/**
 * Default command runner. `codex` on Windows is a `.cmd`/`.ps1` shim that
 * CreateProcess cannot execute directly, so it goes through the command
 * processor; every argument on that path is a validated literal
 * (marketplace name `/^[A-Za-z0-9._-]+$/`, no whitespace), never user input.
 * Executable paths are spawned directly so a space in the path cannot split
 * the command line.
 */
function defaultRunCommand(file: string, args: readonly string[], timeoutMs: number): CodexCommandResult {
  const result = spawnSync(file, [...args], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: shouldUseShell(file),
  });
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  const error = result.error instanceof Error ? result.error.message : undefined;
  const ok = result.status === 0 && error === undefined;
  const detail = stderr.length > 0 ? stderr.slice(-400) : error;
  return { ok, ...(detail === undefined ? {} : { detail }) };
}

/**
 * Resolve Codex's PLUGIN_DATA root. ensurePluginData creates
 * `<home>/plugins/data/principles-disciple-<marketplace>`, and Codex sets
 * PLUGIN_DATA for hooks but never creates the directory, so an existing single
 * match wins; otherwise the caller's derived path is used (first-run create).
 */
export function resolvePluginDataRoot(codexHome: string, marketplace: string): string | undefined {
  const dataRoot = path.join(codexHome, 'plugins', 'data');
  try {
    const entries = readdirSync(dataRoot);
    const matches = entries.filter((entry) => entry.startsWith('principles-disciple-'));
    if (matches.length === 1) {
      const [only] = matches;
      return only === undefined ? undefined : path.join(dataRoot, only);
    }
  } catch {
    // Not created yet — the derived path below is the first-run target.
  }
  return /^[A-Za-z0-9._-]+$/.test(marketplace) ? path.join(dataRoot, `principles-disciple-${marketplace}`) : undefined;
}

// ─── CodexHostInstaller ─────────────────────────────────────────────────────
export class CodexHostInstaller implements HostInstaller {
  readonly hostId = 'codex';

  private readonly deps: CodexInstallerDeps;

  constructor(deps: CodexInstallerDeps = {}) {
    this.deps = deps;
  }

  private codexHome(): string {
    return this.deps.codexHome ?? getCodexDir();
  }

  /**
   * Run `codex plugin add <plugin>@<marketplace>`. Re-adding an installed
   * plugin is the host's own in-place refresh path — no uninstall/remove is
   * involved (Owner requirement 2026-11-11).
   */
  private runMarketplaceAdd(marketplace: string): CodexCommandResult {
    const args = ['plugin', 'add', `principles-disciple@${marketplace}`];
    const run = this.deps.runCommand ?? defaultRunCommand;
    return run('codex', args, 120_000);
  }

  /**
   * Materialize the payload's pinned runtime in PLUGIN_DATA through the
   * plugin's EXISTING setup authority (scripts/pd-setup.cjs). `--skip-init`
   * and `--ingest skip` keep this a runtime/binding repair: no workspace
   * initialization, no consent decision, no interactive prompt.
   */
  private runRuntimeSetup(pluginRoot: string, pluginDataRoot: string, workspaceDir: string): CodexCommandResult {
    const setupEntry = path.join(pluginRoot, 'scripts', 'pd-setup.cjs');
    const args = [
      setupEntry,
      '--plugin-root', pluginRoot,
      '--plugin-data', pluginDataRoot,
      '--workspace', workspaceDir,
      '--skip-init',
      '--ingest', 'skip',
      '--json',
    ];
    const run = this.deps.runCommand ?? defaultRunCommand;
    return run(process.execPath, args, 600_000);
  }

  /**
   * Reconcile an installed Marketplace plugin with the PD release being
   * installed:
   *   1. payload: refresh the cache in place when its pins trail the canonical
   *      runtime (`codex plugin add`, no uninstall);
   *   2. runtime: install the payload's own pins into PLUGIN_DATA when they
   *      differ (pd-setup.cjs — the single runtime materialization authority).
   * Every unverifiable/unreachable step is reported with reason + nextAction,
   * never silently swallowed (rc-9).
   */
  private reconcileInstalledPlugin(
    marketplace: { readonly version: string; readonly versionDir: string },
    ctx: HostInstallContext,
  ): HostInstallResult {
    const notes: string[] = [];
    const marketplaceName = deriveMarketplaceName(marketplace.versionDir);
    if (marketplaceName === undefined) {
      return {
        success: false,
        hostId: this.hostId,
        configAction: 'skipped',
        manualActionRequired: true,
        reason: `The Codex Marketplace cache path does not expose a usable marketplace name: ${marketplace.versionDir}`,
        nextAction: 'Re-add the Marketplace and plugin: codex plugin marketplace add <owner/repo>, then codex plugin add principles-disciple@<marketplace>.',
      };
    }

    const canonicalRuntimeDir = this.deps.canonicalRuntimeDir ?? getPdRuntimeDir();
    const canonical = readCanonicalRuntimeCohort(canonicalRuntimeDir);
    const pinBefore = readPinnedRuntimeCohort(marketplace.versionDir);

    let current = { version: marketplace.version, versionDir: marketplace.versionDir };
    let payloadRefreshed = false;

    if (canonical === undefined || pinBefore === undefined) {
      // Not a failure of this installer: the cached payload may still be
      // current. But freshness is UNVERIFIABLE, so say so instead of printing
      // the old "already installed" comfort line (Owner requirement 3).
      notes.push(canonical === undefined
        ? `payload freshness is unverifiable: the canonical PD runtime was not readable at ${canonicalRuntimeDir}`
        : `payload freshness is unverifiable: ${path.join(current.versionDir, 'runtime-version.json')} is unreadable`);
    } else if (isRuntimeCohortBehind(pinBefore, canonical)) {
      const refresh = this.runMarketplaceAdd(marketplaceName);
      if (!refresh.ok) {
        return {
          success: false,
          hostId: this.hostId,
          configAction: 'skipped',
          manualActionRequired: true,
          reason: `The installed Codex plugin (cache ${current.version}, pinned ${describeRuntimeCohort(pinBefore)}) is behind the PD release being installed (${describeRuntimeCohort(canonical)}), and the in-place refresh failed${refresh.detail === undefined ? '' : `: ${refresh.detail}`}.`,
          nextAction: `Run "codex plugin add principles-disciple@${marketplaceName}" (no uninstall needed) and re-run this installer — the installer then aligns the plugin runtime with the refreshed pin.`,
        };
      }
      const after = detectCodexMarketplaceState(this.codexHome());
      if (after.state === 'installed') {
        current = { version: after.version, versionDir: after.versionDir };
      }
      payloadRefreshed = true;
      notes.push(`payload refreshed ${marketplace.version} → ${current.version}`);
      // The refresh can only serve what the Marketplace SOURCE carries. When
      // the source checkout itself trails the installed release, `codex plugin
      // add` succeeds without moving the payload forward — reporting success
      // there would be the false comfort this reconcile exists to remove
      // (rc-9; update-chain promise: one upgrade brings every host forward).
      const pinAfterRefresh = readPinnedRuntimeCohort(current.versionDir);
      if (pinAfterRefresh === undefined || isRuntimeCohortBehind(pinAfterRefresh, canonical)) {
        return {
          success: false,
          hostId: this.hostId,
          configAction: 'skipped',
          manualActionRequired: true,
          reason: `The in-place payload refresh completed, but the Marketplace payload is still behind the PD release being installed`
            + `${pinAfterRefresh === undefined
              ? ` (runtime pin unreadable at ${current.versionDir} after the refresh)`
              : ` (pinned ${describeRuntimeCohort(pinAfterRefresh)} < ${describeRuntimeCohort(canonical)})`}`
            + `. The Marketplace source it serves is itself behind and must be updated first.`,
          nextAction: `Update the Marketplace source checkout (git pull), then re-run the installer — the payload refresh and the pinned-runtime alignment run again in place (no uninstall needed).`,
        };
      }
    } else {
      notes.push(`payload ${current.version} is current for the installed PD release`);
    }

    const pin = readPinnedRuntimeCohort(current.versionDir);
    if (pin === undefined) {
      // A payload whose pin cannot be read is left exactly as it is — the
      // installer must not guess a runtime cohort. Freshness is reported as
      // UNVERIFIED rather than as "already installed" (rc-9 / requirement 3).
      notes.push(`runtime pin unreadable in ${current.versionDir} — runtime alignment unverified`);
      return {
        success: true,
        hostId: this.hostId,
        configPath: current.versionDir,
        configAction: payloadRefreshed ? 'updated' : 'preserved',
        reason: `Codex Marketplace plugin ${current.version}: ${notes.join('; ')}.`,
        nextAction: 'Verify manually with pd-status; reinstall the payload with codex plugin add principles-disciple@'
          + `${marketplaceName} if the runtime pin stays unreadable (no uninstall needed).`,
      };
    }

    const pluginDataRoot = resolvePluginDataRoot(this.codexHome(), marketplaceName);
    if (pluginDataRoot === undefined) {
      return {
        success: false,
        hostId: this.hostId,
        configAction: 'skipped',
        manualActionRequired: true,
        reason: `The Codex plugin data directory could not be resolved for marketplace "${marketplaceName}".`,
        nextAction: 'Run: $pd-control setup — it reports the resolved plugin data path and installs the pinned runtime.',
      };
    }
    const runtimeDir = path.join(pluginDataRoot, 'runtime');
    const installed = readInstalledRuntimeCohort(runtimeDir);
    let runtimeReconciled = false;

    if (installed !== undefined && cohortsEqual(installed, pin)) {
      notes.push(`runtime matches the payload pin (${describeRuntimeCohort(pin)})`);
    } else {
      const setup = this.runRuntimeSetup(current.versionDir, pluginDataRoot, ctx.workspaceDir);
      const verified = readInstalledRuntimeCohort(runtimeDir);
      if (!setup.ok || verified === undefined || !cohortsEqual(verified, pin)) {
        return {
          success: false,
          hostId: this.hostId,
          configAction: 'skipped',
          manualActionRequired: true,
          reason: `The Codex plugin runtime in ${runtimeDir} does not match the payload pin (${describeRuntimeCohort(pin)}) and the automatic install did not verify${setup.detail === undefined ? '' : `: ${setup.detail}`}.`,
          nextAction: 'Run: $pd-control setup — it installs the pinned runtime and verifies the exact bytes. If it also fails, check that npm is on PATH.',
        };
      }
      runtimeReconciled = true;
      notes.push(`runtime installed at the payload pin (${describeRuntimeCohort(pin)})`);
    }

    const updated = payloadRefreshed || runtimeReconciled;
    return {
      success: true,
      hostId: this.hostId,
      configPath: current.versionDir,
      configAction: updated ? 'updated' : 'preserved',
      reason: `Codex Marketplace plugin ${current.version}: ${notes.join('; ')}.`,
      nextAction: updated
        ? 'Start a new Codex session (or restart Codex) so the refreshed plugin and runtime load. Verify with pd-status afterwards.'
        : 'Nothing to update. Start a Codex session and run the plugin setup ($pd-control setup) if conversation-ingestion consent is still pending.',
    };
  }

  /**
   * RETIRED for new registrations (Codex Governance Closure Slice D; SPEC rev
   * 2 §17 — the Marketplace plugin is the only supported new install path;
   * this legacy global-hook installer is migration/uninstall-only).
   *
   * This method NEVER writes hook registrations anymore. It returns a
   * structured refusal that points at the supported path, and when a legacy
   * PD global registration is detected it offers the explicit migration
   * route (precise uninstall → Marketplace plugin → $pd-control setup consent).
   *
   * UPDATE CHAIN (2026-11-11): for an already-installed Marketplace plugin
   * this method now RECONCILES instead of reporting the old "already
   * installed" comfort line — it refreshes a stale payload in place and
   * installs the payload's own runtime pins into PLUGIN_DATA.
   */
  async install(ctx: HostInstallContext): Promise<HostInstallResult> {
    const hooksJsonPath = getCodexHooksJsonPath();
    const legacy = detectLegacyCodexHookRegistration();
    if (legacy.detected) {
      return {
        success: false,
        hostId: this.hostId,
        configPath: hooksJsonPath,
        configAction: 'skipped',
        manualActionRequired: true,
        reason: 'A legacy PD global Codex hook registration was detected (async PostToolUse in ~/.codex/hooks.json). The legacy global installer is retired (SPEC rev 2 §17) and cannot update it.',
        nextAction: 'Migrate to the Marketplace plugin: 1) npx create-principles-disciple uninstall --host codex  (removes ONLY PD-owned entries; evidence is preserved); 2) codex plugin add principles-disciple@principles; 3) run the plugin setup ($pd-control setup) — it presents the ingestion disclosure and records consent.',
      };
    }
    // Marketplace contract (2026-11-07): the retired global-hook installer
    // never writes anything; the Codex end state is reported honestly in
    // three states and never executes the retired registration logic.
    const marketplace = detectCodexMarketplaceState(this.codexHome());
    if (marketplace.state === 'installed') {
      return this.reconcileInstalledPlugin(marketplace, ctx);
    }
    // 'not_installed' and 'unknown' both leave a manual step pending. They are
    // NOT failures of anything this installer attempted (it never writes), so
    // they must not trigger other hosts' rollback — the manualActionRequired
    // flag separates them from real failures (installer.ts aggregation).
    return {
      success: false,
      hostId: this.hostId,
      configPath: hooksJsonPath,
      configAction: 'skipped',
      manualActionRequired: true,
      reason: marketplace.state === 'not_installed'
        ? 'New Codex global hook registrations are retired (SPEC rev 2 §17) and the Marketplace plugin is not installed on this machine. PD will not auto-execute the Marketplace install or edit the Codex plugin config without authorization.'
        : 'New Codex global hook registrations are retired (SPEC rev 2 §17). The Codex Marketplace install state could not be verified: ' + marketplace.reason + '. PD will not guess the state or auto-execute the Marketplace install.',
      nextAction: 'Install the plugin: codex plugin add principles-disciple@principles — then run its setup ($pd-control setup), which verifies Node/runtime/workspace/trust and records the conversation-ingestion consent. Re-run npx create-principles-disciple afterwards; the install is idempotent.',
    };
  }

  async uninstall(_ctx: HostUninstallContext): Promise<HostUninstallResult> {
    const hooksJsonPath = getCodexHooksJsonPath();
    const markerPath = getPdHookMarkerPath();
    const pdCodexDir = getPdCodexDir();
    const removedPaths: string[] = [];
    const preservedPaths: string[] = [];

    // 1. Remove PD-owned entries from hooks.json.
    //    CodeQL TOCTOU fix: try/catch read instead of existsSync+readFileSync.
    try {
      const raw = readFileSync(hooksJsonPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) {
        const config = { ...parsed };
        let modified = false;
        const PD_MARKER = 'pd-owned';

        for (const eventName of CODEX_EVENTS) {
          const groups = config[eventName];
          if (isUnknownArray(groups)) {
            const before = groups.length;
            // rc-2: use Object.hasOwn instead of `as` cast for marker check.
            const filtered: unknown[] = groups.filter((g) =>
              !(isRecord(g) && Object.hasOwn(g, '__pd_marker') && g.__pd_marker === PD_MARKER),
            );
            if (filtered.length === 0) {
              delete config[eventName];
            } else {
              config[eventName] = filtered;
            }
            if (filtered.length !== before) modified = true;
          }
        }

        if (modified) {
          writeFileSync(hooksJsonPath, JSON.stringify(config, null, 2), { encoding: 'utf-8' });
          removedPaths.push(hooksJsonPath);
        }
      }
    } catch (err) {
      const code = getErrorCode(err);
      if (code === 'ENOENT') {
        // hooks.json not found — nothing to clean, proceed to marker cleanup.
      } else {
        // Malformed hooks.json — can't safely merge. Leave it alone.
        preservedPaths.push(hooksJsonPath);
      }
    }

    // 2. Remove wrapper script + marker file
    const wrapperPath = path.join(pdCodexDir, 'pd-hook-entry.cjs');
    if (existsSync(wrapperPath)) {
      try {
        const fs = await import('fs');
        await fs.promises.rm(wrapperPath, { force: true });
        removedPaths.push(wrapperPath);
      } catch {
        preservedPaths.push(wrapperPath);
      }
    }
    if (existsSync(markerPath)) {
      try {
        const fs = await import('fs');
        await fs.promises.rm(markerPath, { force: true });
        removedPaths.push(markerPath);
      } catch {
        preservedPaths.push(markerPath);
      }
    }

    return {
      success: preservedPaths.length === 0,
      hostId: this.hostId,
      removedPaths,
      preservedPaths,
      reason: preservedPaths.length > 0
        ? `Some files could not be removed: ${preservedPaths.join(', ')}`
        : undefined,
      nextAction: preservedPaths.length > 0
        ? `Manually inspect: ${preservedPaths.join(', ')}`
        : 'Codex hooks uninstalled. Verify: open ~/.codex/hooks.json (should have no __pd_marker entries).',
    };
  }

  detect(): HostDetectResult {
    const markerPath = getPdHookMarkerPath();
    const hooksJsonPath = getCodexHooksJsonPath();
    const wrapperPath = path.join(getPdCodexDir(), 'pd-hook-entry.cjs');

    const paths: { exists: boolean; path: string; name: string; type: 'file' | 'dir' }[] = [
      {
        exists: existsSync(markerPath),
        path: markerPath,
        name: 'PD Codex install marker',
        type: 'file' as const,
      },
      {
        exists: existsSync(wrapperPath),
        path: wrapperPath,
        name: 'PD Codex hook entry script',
        type: 'file' as const,
      },
      {
        exists: existsSync(hooksJsonPath),
        path: hooksJsonPath,
        name: 'Codex hooks.json',
        type: 'file' as const,
      },
    ];

    // PD is "installed" for Codex if the marker exists OR hooks.json has PD entries
    let installed = existsSync(markerPath);
    if (!installed && existsSync(hooksJsonPath)) {
      try {
        const raw = readFileSync(hooksJsonPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed)) {
          for (const eventName of CODEX_EVENTS) {
            const groups = parsed[eventName];
            if (isUnknownArray(groups)) {
              const hasPd = groups.some((g) =>
                isRecord(g) && Object.hasOwn(g, '__pd_marker') && g.__pd_marker === 'pd-owned',
              );
              if (hasPd) {
                installed = true;
                break;
              }
            }
          }
        }
      } catch {
        // Malformed hooks.json — treat as not installed (will be cleaned on uninstall)
      }
    }

    // UPDATE CHAIN (2026-11-11): the supported install path is the Marketplace
    // plugin, which leaves NO marker/hooks.json. Detection that only looked at
    // the retired global-hook artifacts reported a Marketplace-only Codex as
    // "not installed", so host auto-coverage skipped it.
    const marketplace = detectCodexMarketplaceState(this.codexHome());
    if (marketplace.state === 'installed') {
      installed = true;
      paths.push({
        exists: true,
        path: marketplace.versionDir,
        name: `Codex Marketplace plugin ${marketplace.version}`,
        type: 'dir',
      });
    }

    return { installed, paths };
  }
}
