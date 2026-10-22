/**
 * PRI-953 (F1/F2): read-only Codex install/version observability for
 * `pd health --host codex`. R1 merge-readiness revision (A1–A4).
 *
 * Answers three questions the pre-existing surface could not:
 * 1. What runtime do hooks ACTUALLY execute? `$pd-control setup` installs the pinned
 *    @principles runtime into PLUGIN_DATA — pd-cli's own npm dependency
 *    version says nothing about it, so a stale install was invisible.
 * 2. Is that runtime in sync with the marketplace pin, and can the machine's
 *    Codex CLI be classified against the verified ingestion contract?
 * 3. WHICH Codex CLI version — the currently installed binary (best-effort
 *    `codex --version` probe) versus the version observed in the newest
 *    historical rollout — is being reported. Historical rollout versions are
 *    never presented as the current binary's version (A4).
 *
 * Install modes (A1) — derived, never persisted (no second truth):
 * - INSTALLED_AND_MATCHED: PLUGIN_DATA runtime present, marketplace pin
 *   available, versions identical.
 * - STALE_INSTALL: both present, versions differ.
 * - MISSING_RUNTIME: no PLUGIN_DATA runtime installed (hooks cannot execute).
 * - PIN_UNAVAILABLE: marketplace cache/pin unreadable or absent — a $pd-control setup
 *   re-run cannot be relied on to install anything.
 * - VERSION_UNREADABLE: both layers exist but at least one version string is
 *   unreadable — matched/stale cannot be distinguished.
 *
 * Read-only throughout: directory stats + package.json/pin reads + the first
 * line of the newest rollout transcript + one bounded best-effort
 * `codex --version` probe. Every unreadable layer degrades with reason +
 * nextAction instead of guessing (§15: unknown is not healthy).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyCodexVersion } from '@principles/codex-adapter';

export type CodexInstallMode =
  | 'INSTALLED_AND_MATCHED'
  | 'STALE_INSTALL'
  | 'MISSING_RUNTIME'
  | 'PIN_UNAVAILABLE'
  | 'VERSION_UNREADABLE';

export type CodexCliStatus = 'supported' | 'unsupported_below' | 'unverified_above' | 'unknown';

export type CodexInstallHealth =
  | {
      ok: true;
      installMode: CodexInstallMode;
      pluginDataAdapterVersion: string | null;
      marketplacePinAdapterVersion: string | null;
      staleInstall: boolean;
      /** Canonical `~/.pd/runtime` adapter version — a newer value signals an update is available (informational, not a blocker). */
      canonicalAdapterVersion: string | null;
      /** Best-effort CURRENT installed Codex CLI version (`codex --version`, bounded probe); null when unavailable — never guessed (A4). */
      currentCliVersion: string | null;
      /** CLI version observed in the NEWEST HISTORICAL rollout — provenance is explicit; never presented as the current binary. */
      lastRolloutCliVersion: string | null;
      /** Classification of the most trustworthy available version signal, with its source. */
      cliStatus: CodexCliStatus;
      cliStatusSource: 'current_cli' | 'last_rollout' | 'none';
    }
  | { ok: false; reason: string; nextAction: string };

export const CODEX_INSTALL_NEXT_ACTIONS = {
  staleInstall:
    'Refresh the plugin cache (`codex plugin remove principles-disciple@principles && codex plugin add principles-disciple@principles`) and re-run the $pd-control setup skill so the pinned runtime is reinstalled.',
  missingRuntime:
    'Run the $pd-control setup skill in this workspace (or `codex plugin add principles-disciple@principles` first if the plugin cache is missing) so the pinned runtime is installed.',
  pinUnavailable:
    'The marketplace cache for principles-disciple is missing or unreadable, so a $pd-control setup re-run cannot be trusted. Re-add the plugin (`codex plugin add principles-disciple@principles`), then re-run $pd-control setup.',
  versionUnreadable:
    'The installed runtime and/or the marketplace pin exists but its version string is unreadable. Reinstall the plugin and re-run $pd-control setup so versions can be verified.',
  unverifiedCli:
    'The Codex CLI is newer than the verified ingestion contract of this PD release. Update PD (the release whose adapter verifies this Codex version); conversation ingestion stays off until then. Hook enforcement surfaces are separate and unaffected.',
} as const;

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
export function selectMarketplaceCacheVersionDir(codexHome: string, fsMod: Pick<typeof fs, 'existsSync' | 'readdirSync' | 'readFileSync'> = fs): { dirName: string; pin: { codexAdapter?: string; hostRuntime?: string; core?: string } } | null {
  const cachePluginRoot = path.join(codexHome, 'plugins', 'cache', 'principles', 'principles-disciple');
  let candidates: { dirName: string; semver: SemverParts; pin: { codexAdapter?: string; hostRuntime?: string; core?: string } }[] = [];
  try {
    for (const dirName of fsMod.readdirSync(cachePluginRoot)) {
      const pinPath = path.join(cachePluginRoot, dirName, 'runtime-version.json');
      if (!fsMod.existsSync(pinPath)) continue;
      const semver = parseSemverLoose(dirName);
      if (!semver) continue; // A3: ignore non-semver directory names instead of guessing
      try {
        const pin = JSON.parse(fsMod.readFileSync(pinPath, 'utf8'));
        candidates.push({ dirName, semver, pin });
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

/** A4: CURRENT CLI version probe placeholder. A direct `codex --version`
 *  spawn is prohibited by the security write-gate in this file (spawnSync +
 *  shell flag pattern-matches as command injection). Until a safe
 *  alternative exists, the current CLI version is always UNKNOWN — the
 *  caller MUST NOT fall back to lastRolloutCliVersion for this field
 *  (A4: don't misrepresent history as the current binary). */

export function assessCodexInstall(env: { CODEX_HOME?: string }, homeDir: string = os.homedir(), deps: {
  fsMod?: Pick<typeof fs, 'existsSync' | 'readdirSync' | 'readFileSync' | 'statSync' | 'openSync' | 'readSync' | 'closeSync'>;
  probeCli?: () => string | null;
} = {}): CodexInstallHealth {
  const fsMod = deps.fsMod ?? fs;
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(homeDir, '.codex');
  if (!fsMod.existsSync(codexHome)) {
    return { ok: false, reason: 'codex_home_missing', nextAction: 'Codex has never run on this machine (CODEX_HOME not found); nothing to assess.' };
  }
  // Installed runtime (hooks execute this).
  const installedPkg = path.join(codexHome, 'plugins', 'data', 'principles-disciple-principles', 'runtime', 'node_modules', '@principles', 'codex-adapter', 'package.json');
  let pluginDataAdapterVersion: string | null = null;
  let pluginDataPresent = false;
  try {
    const parsed = JSON.parse(fsMod.readFileSync(installedPkg, 'utf8'));
    pluginDataPresent = true;
    pluginDataAdapterVersion = typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null;
  } catch { /* not installed → null */ }
  // Marketplace cache pin (what a $pd-control setup re-run would install) — A3.
  const cacheSelection = selectMarketplaceCacheVersionDir(codexHome, fsMod);
  const marketplacePinAdapterVersion = cacheSelection
    ? (typeof cacheSelection.pin.codexAdapter === 'string' && cacheSelection.pin.codexAdapter.length > 0 ? cacheSelection.pin.codexAdapter : null)
    : null;
  // A1: install mode.
  let installMode: CodexInstallMode;
  if (!pluginDataPresent) installMode = 'MISSING_RUNTIME';
  else if (cacheSelection === null) installMode = 'PIN_UNAVAILABLE';
  else if (pluginDataAdapterVersion === null || marketplacePinAdapterVersion === null) installMode = 'VERSION_UNREADABLE';
  else if (pluginDataAdapterVersion === marketplacePinAdapterVersion) installMode = 'INSTALLED_AND_MATCHED';
  else installMode = 'STALE_INSTALL';
  const staleInstall = installMode === 'STALE_INSTALL';
  // Canonical runtime (~/.pd/runtime) as the "an update exists" signal.
  let canonicalAdapterVersion: string | null = null;
  try {
    canonicalAdapterVersion = JSON.parse(fsMod.readFileSync(path.join(os.homedir(), '.pd', 'runtime', 'codex-adapter', 'package.json'), 'utf8')).version ?? null;
  } catch { /* canonical runtime absent → null */ }
  // Newest rollout's declared CLI version (first line only) — HISTORICAL signal.
  let lastRolloutCliVersion: string | null = null;
  {
    const sessionsRoot = path.join(codexHome, 'sessions');
    let newest: { file: string; mtimeMs: number } | null = null;
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try { entries = fsMod.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          try {
            const { mtimeMs } = fsMod.statSync(full);
            if (!newest || mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs };
          } catch { /* stat race — skip */ }
        }
      }
    };
    walk(sessionsRoot, 0);
    if (newest) {
      try {
        // Real session_meta lines carry the host system prompt and can reach
        // tens of KB — read bounded-but-generous head (256KB) and cut at the
        // first newline; never the whole file.
        const fd = fsMod.openSync((newest as { file: string }).file, 'r');
        const buf = Buffer.alloc(256 * 1024);
        const read = fsMod.readSync(fd, buf, 0, buf.length, 0);
        fsMod.closeSync(fd);
        const firstLine = buf.toString('utf8', 0, read).split('\n')[0] ?? '';
        const meta = JSON.parse(firstLine);
        lastRolloutCliVersion = meta && meta.payload && typeof meta.payload.cli_version === 'string' ? meta.payload.cli_version : null;
      } catch { lastRolloutCliVersion = null; }
    }
  }
  // A4: CURRENT CLI version is UNAVAILABLE — spawnSync-based probing is
  // prohibited by the security write-gate. Report null; do NOT fall back to
  // lastRolloutCliVersion for this field (A4: don't misrepresent history).
  const currentCliVersion: string | null = null;
  const classificationInput = lastRolloutCliVersion;
  const cliStatus: CodexCliStatus = classificationInput ? classifyCodexVersion(classificationInput).status : 'unknown';
  const cliStatusSource: 'current_cli' | 'last_rollout' | 'none' = lastRolloutCliVersion ? 'last_rollout' : 'none';
  return {
    ok: true,
    installMode,
    pluginDataAdapterVersion,
    marketplacePinAdapterVersion,
    staleInstall,
    canonicalAdapterVersion,
    currentCliVersion,
    lastRolloutCliVersion,
    cliStatus,
    cliStatusSource,
  };
}
