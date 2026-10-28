/**
 * Read-only observation of the local Codex install (PRI-1051).
 *
 * Two on-disk layouts decide what Codex actually executes, and different
 * actors own them:
 *
 *   <CODEX_HOME>/plugins/cache/principles/principles-disciple/<semver>/runtime-version.json
 *     — the marketplace snapshot PD publishes; the `$pd-control setup` skill
 *       installs exactly the versions pinned here.
 *   <CODEX_HOME>/plugins/data/principles-disciple-principles/runtime/node_modules/@principles/*
 *     — the runtime the plugin's hooks execute. `pd-cli`'s own dependency
 *       version says nothing about it.
 *
 * One owner for these paths so `pd health --host codex` and
 * `pd version --delivery` cannot disagree about where the truth lives. Every
 * reader is bounded and read-only, degrades to null instead of guessing
 * (rc-9), and never spawns a process (the security write-gate in
 * commands/health-codex-install.ts rejects spawn-based probes).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type CodexReadFs = Pick<typeof fs, 'existsSync' | 'readdirSync' | 'readFileSync' | 'statSync'>;

export interface CodexPluginPin {
  readonly codexAdapter?: string;
  readonly hostRuntime?: string;
  readonly core?: string;
}

export interface InstalledCodexRuntime {
  /** The executed runtime's adapter manifest parsed — the runtime exists. */
  readonly present: boolean;
  readonly codexAdapter: string | null;
  readonly core: string | null;
  readonly hostRuntime: string | null;
  /**
   * mtime of the newest `@principles/*` manifest — when these bytes landed.
   * npm installs write fresh mtimes, so this is the runtime refresh time, not
   * a packaged date. Null when no manifest is readable.
   */
  readonly installedAtMs: number | null;
}

export interface CodexRolloutFile {
  readonly file: string;
  readonly mtimeMs: number;
  /** Creation time; 0 when the platform/filesystem cannot report it. */
  readonly birthtimeMs: number;
}

export function resolveCodexHome(env: { CODEX_HOME?: string }, homeDir: string = os.homedir()): string {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(homeDir, '.codex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalVersion(record: Record<string, unknown>, key: string): string | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readManifest(filePath: string, fsMod: CodexReadFs): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fsMod.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

function readManifestVersion(filePath: string, fsMod: CodexReadFs): string | null {
  const manifest = readManifest(filePath, fsMod);
  return manifest === null ? null : (readOptionalVersion(manifest, 'version') ?? null);
}

interface SemverParts { major: number; minor: number; patch: number }

function parseSemverLoose(value: string): SemverParts | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  const major = Number.parseInt(match[1] ?? '', 10);
  const minor = Number.parseInt(match[2] ?? '', 10);
  const patch = Number.parseInt(match[3] ?? '', 10);
  if (![major, minor, patch].every((n) => Number.isFinite(n))) return null;
  return { major, minor, patch };
}

function compareSemverLoose(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** A3: pick the plugin cache version Codex would use. Codex keeps plugin
 *  versions in semver-named directories (observed: `0.1.0`); when several
 *  exist, the highest semver is the live candidate; non-semver directories
 *  are ignored rather than guessed. Returns null when nothing usable exists. */
export function selectMarketplaceCacheVersionDir(
  codexHome: string,
  fsMod: CodexReadFs = fs,
): { dirName: string; pin: CodexPluginPin } | null {
  const cachePluginRoot = path.join(codexHome, 'plugins', 'cache', 'principles', 'principles-disciple');
  let candidates: { dirName: string; semver: SemverParts; pin: CodexPluginPin }[] = [];
  try {
    for (const dirName of fsMod.readdirSync(cachePluginRoot)) {
      const pinPath = path.join(cachePluginRoot, dirName, 'runtime-version.json');
      if (!fsMod.existsSync(pinPath)) continue;
      const semver = parseSemverLoose(dirName);
      if (!semver) continue; // A3: ignore non-semver directory names instead of guessing
      try {
        const parsed: unknown = JSON.parse(fsMod.readFileSync(pinPath, 'utf8'));
        if (!isPlainObject(parsed)) continue;
        candidates.push({
          dirName,
          semver,
          pin: {
            codexAdapter: readOptionalVersion(parsed, 'codexAdapter'),
            hostRuntime: readOptionalVersion(parsed, 'hostRuntime'),
            core: readOptionalVersion(parsed, 'core'),
          },
        });
      } catch { /* unreadable pin — skip this candidate */ }
    }
  } catch {
    return null; // cache root absent/unreadable
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareSemverLoose(b.semver, a.semver));
  const best = candidates.shift();
  if (!best) return null;
  return { dirName: best.dirName, pin: best.pin };
}

/** The runtime the plugin's hooks execute, plus when it landed. */
export function readInstalledCodexRuntime(codexHome: string, fsMod: CodexReadFs = fs): InstalledCodexRuntime {
  const modulesDir = path.join(
    codexHome, 'plugins', 'data', 'principles-disciple-principles', 'runtime', 'node_modules', '@principles',
  );
  const adapterManifestPath = path.join(modulesDir, 'codex-adapter', 'package.json');
  const adapterManifest = readManifest(adapterManifestPath, fsMod);
  let installedAtMs: number | null = null;
  for (const component of ['codex-adapter', 'core', 'host-runtime']) {
    try {
      const { mtimeMs } = fsMod.statSync(path.join(modulesDir, component, 'package.json'));
      if (Number.isFinite(mtimeMs) && (installedAtMs === null || mtimeMs > installedAtMs)) {
        installedAtMs = mtimeMs;
      }
    } catch { /* component absent */ }
  }
  return {
    present: adapterManifest !== null,
    codexAdapter: adapterManifest === null ? null : (readOptionalVersion(adapterManifest, 'version') ?? null),
    core: readManifestVersion(path.join(modulesDir, 'core', 'package.json'), fsMod),
    hostRuntime: readManifestVersion(path.join(modulesDir, 'host-runtime', 'package.json'), fsMod),
    installedAtMs,
  };
}

/**
 * Newest session transcript (by mtime) — the only process-adjacent evidence
 * available without spawning Codex. Codex appends to the transcript of the
 * session it is running, so the newest one identifies the session that was
 * active last; its creation time is when that host session started.
 */
export function findNewestRolloutFile(codexHome: string, fsMod: CodexReadFs = fs): CodexRolloutFile | null {
  const sessionsRoot = path.join(codexHome, 'sessions');
  let newest: CodexRolloutFile | null = null;
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try { entries = fsMod.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        try {
          const { mtimeMs, birthtimeMs } = fsMod.statSync(full);
          if (!newest || mtimeMs > newest.mtimeMs) {
            newest = { file: full, mtimeMs, birthtimeMs: Number.isFinite(birthtimeMs) ? birthtimeMs : 0 };
          }
        } catch { /* stat race — skip */ }
      }
    }
  };
  walk(sessionsRoot, 0);
  return newest;
}
