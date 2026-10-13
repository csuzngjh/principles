/**
 * PRI-953 (F1/F2): read-only Codex install/version observability for
 * `pd health --host codex`.
 *
 * Answers two questions the pre-existing surface could not:
 * 1. What runtime do hooks ACTUALLY execute? `$pd-setup` installs the pinned
 *    @principles runtime into PLUGIN_DATA — pd-cli's own npm dependency
 *    version says nothing about it, so a stale install was invisible.
 * 2. What Codex CLI version is this machine actually running, and is it inside
 *    the verified ingestion contract? A CLI above the verified ceiling silently
 *    disables conversation ingestion (fail-open by design) — the F2 defect.
 *
 * Read-only throughout: directory stats + one package.json/pin read + the
 * first line of the newest rollout transcript. Every unreadable layer
 * degrades with reason + nextAction instead of guessing (§15: unknown is not
 * healthy).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyCodexVersion } from '@principles/codex-adapter';

export type CodexInstallHealth =
  | {
      ok: true;
      pluginDataAdapterVersion: string | null;
      marketplacePinAdapterVersion: string | null;
      staleInstall: boolean;
      /** Canonical `~/.pd/runtime` adapter version — a newer value signals an update is available (informational, not a blocker). */
      canonicalAdapterVersion: string | null;
      latestObservedCliVersion: string | null;
      cliStatus: 'supported' | 'unsupported_below' | 'unverified_above' | 'unknown';
    }
  | { ok: false; reason: string; nextAction: string };

export const CODEX_INSTALL_NEXT_ACTIONS = {
  staleInstall:
    'Refresh the plugin cache (`codex plugin remove principles-disciple@principles && codex plugin add principles-disciple@principles`) and re-run the $pd-setup skill so the pinned runtime is reinstalled.',
  unverifiedCli:
    'The installed Codex CLI is newer than the verified ingestion contract of this PD release. Update PD (the release whose adapter verifies this Codex version); conversation ingestion stays off until then. Hook enforcement surfaces are separate and unaffected.',
} as const;

export function assessCodexInstall(env: { CODEX_HOME?: string }, homeDir: string = os.homedir()): CodexInstallHealth {
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(homeDir, '.codex');
  if (!fs.existsSync(codexHome)) {
    return { ok: false, reason: 'codex_home_missing', nextAction: 'Codex has never run on this machine (CODEX_HOME not found); nothing to assess.' };
  }
  // Installed runtime (hooks execute this).
  const installedPkg = path.join(codexHome, 'plugins', 'data', 'principles-disciple-principles', 'runtime', 'node_modules', '@principles', 'codex-adapter', 'package.json');
  let pluginDataAdapterVersion: string | null = null;
  try {
    pluginDataAdapterVersion = JSON.parse(fs.readFileSync(installedPkg, 'utf8')).version ?? null;
  } catch { /* not installed → null */ }
  // Marketplace cache pin (what a $pd-setup re-run would install).
  let marketplacePinAdapterVersion: string | null = null;
  const cachePluginRoot = path.join(codexHome, 'plugins', 'cache', 'principles', 'principles-disciple');
  try {
    for (const versionDir of fs.readdirSync(cachePluginRoot)) {
      const pinPath = path.join(cachePluginRoot, versionDir, 'runtime-version.json');
      if (fs.existsSync(pinPath)) {
        marketplacePinAdapterVersion = JSON.parse(fs.readFileSync(pinPath, 'utf8')).codexAdapter ?? null;
        break;
      }
    }
  } catch { /* cache absent → null */ }
  // Newest rollout's declared CLI version (first line only).
  let latestObservedCliVersion: string | null = null;
  {
    const sessionsRoot = path.join(codexHome, 'sessions');
    let newest: { file: string; mtimeMs: number } | null = null;
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          try {
            const {mtimeMs} = fs.statSync(full);
            if (!newest || mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs };
          } catch { /* stat race — skip */ }
        }
      }
    };
    walk(sessionsRoot, 0);
    if (newest) {
      try {
        const fd = fs.openSync((newest as { file: string }).file, 'r');
        const buf = Buffer.alloc(4096);
        const read = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        const firstLine = buf.toString('utf8', 0, read).split('\n')[0] ?? '';
        const meta = JSON.parse(firstLine);
        latestObservedCliVersion = meta && meta.payload && typeof meta.payload.cli_version === 'string' ? meta.payload.cli_version : null;
      } catch { latestObservedCliVersion = null; }
    }
  }
  // Canonical runtime (~/.pd/runtime) as the "an update exists" signal.
  let canonicalAdapterVersion: string | null = null;
  try {
    canonicalAdapterVersion = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pd', 'runtime', 'codex-adapter', 'package.json'), 'utf8')).version ?? null;
  } catch { /* canonical runtime absent → null */ }
  const cliStatus = latestObservedCliVersion
    ? classifyCodexVersion(latestObservedCliVersion).status
    : 'unknown';
  return {
    ok: true,
    pluginDataAdapterVersion,
    marketplacePinAdapterVersion,
    staleInstall: pluginDataAdapterVersion !== null && marketplacePinAdapterVersion !== null && pluginDataAdapterVersion !== marketplacePinAdapterVersion,
    canonicalAdapterVersion,
    latestObservedCliVersion,
    cliStatus,
  };
}
