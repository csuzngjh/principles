/**
 * Console install/liveness section for `pd health` — the console sibling of
 * health-mcp.ts. Read-only: health never STARTS the console (the same boundary
 * that keeps the MCP section from spawning the server); the active complement
 * for full startup is `pd console open` / the installer's verify step.
 *
 * Resolution uses the SAME install-layout authorities as `pd console`
 * (resolveInstallLayout + getConsoleServerEntry/getConsoleWebIndex), so there
 * is one resolution truth; integrity reuses checkConsoleRuntimeDependencies
 * (the exact slots the console server imports at startup).
 *
 * Status ladder:
 *  - not_installed          — no install manifest/runtime for this home (neutral)
 *  - installed_running      — a healthy console answered /api/health in the
 *                             default port window (neutral-healthy)
 *  - installed_not_running  — installed and intact, nobody started it (the
 *                             NORMAL on-demand state; neutral)
 *  - broken                 — entry/web bundle missing or a runtime-dependency
 *                             slot is broken: a real install-integrity defect
 *                             (health exit-code failure, PRI-1130 grade).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  getConsoleServerEntry,
  getConsoleWebIndex,
  getInstallLayoutPaths,
  getInstallLayoutPathsFromPdHome,
  resolveInstallLayout,
  type InstallLayoutPaths,
  type PdHomePaths,
} from '@principles/install-layout';
import {
  buildConsoleUrl,
  DEFAULT_PORT,
  isPortInUse,
  PORT_FALLBACK_LIMIT,
  probeConsoleHealth,
} from '../services/console-launcher.js';
import { checkConsoleRuntimeDependencies } from './console.js';

export interface ConsoleHealthSection {
  status: 'installed_running' | 'installed_not_running' | 'not_installed' | 'broken';
  dir: string | null;
  entry: string | null;
  webIndex: string | null;
  /** First broken runtime-dependency slot description (checkConsoleRuntimeDependencies). */
  integrity: string | null;
  running: { url: string | null; port: number | null };
  reason?: string;
  nextAction?: string;
}

const CONSOLE_SCAN_HOST = '127.0.0.1';
/**
 * The default port window `pd console open` binds/falls back through —
 * derived from the launcher's own constants so the window has ONE authority
 * (P4): if the launcher window ever changes, this scan follows it.
 */
const CONSOLE_SCAN_PORTS: readonly number[] = Array.from(
  { length: PORT_FALLBACK_LIMIT },
  (_, i) => DEFAULT_PORT + i,
);
const CONSOLE_PROBE_TIMEOUT_MS = 800;

function notInstalled(reason: string): ConsoleHealthSection {
  return {
    status: 'not_installed',
    dir: null,
    entry: null,
    webIndex: null,
    integrity: null,
    running: { url: null, port: null },
    reason,
    nextAction: 'Run: npx create-principles-disciple',
  };
}

/**
 * Assess the installed console for a PD home dir. Port scanning only READS:
 * isPortInUse + probeConsoleHealth (both carry global mock hooks used by the
 * tests — no bespoke injection seam needed).
 */
export async function assessConsole(
  homeDirInput: string,
  homePaths?: PdHomePaths,
): Promise<ConsoleHealthSection> {
  // CWE-22 guard: normalize the home dir and require an absolute path.
  const homeDir = path.resolve(homeDirInput);
  if (!path.isAbsolute(homeDir)) {
    return notInstalled('home dir is not absolute');
  }
  let paths: InstallLayoutPaths;
  try {
    paths = homePaths !== undefined
      ? getInstallLayoutPathsFromPdHome(homePaths)
      : getInstallLayoutPaths(homeDir);
  } catch (error) {
    return notInstalled(error instanceof Error ? `pd_home_resolution_failed: ${error.message}` : 'pd_home_resolution_failed');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8')) as unknown;
  } catch {
    manifest = undefined;
  }
  const resolved = resolveInstallLayout({
    homeDir,
    ...(homePaths !== undefined ? { homePaths } : {}),
    manifest,
    canonicalRuntimeExists: fs.existsSync(paths.runtimeDir),
    legacyExtensionExists: fs.existsSync(paths.openClawExtensionDir),
  });
  if (resolved.mode === 'missing') return notInstalled('no install manifest / runtime found');

  const entry = getConsoleServerEntry(paths, resolved.mode);
  const webIndex = getConsoleWebIndex(paths, resolved.mode);
  const base: ConsoleHealthSection = {
    status: 'installed_not_running',
    dir: resolved.mode === 'canonical' ? paths.consoleDir : path.join(paths.openClawExtensionDir, 'console'),
    entry,
    webIndex,
    integrity: null,
    running: { url: null, port: null },
  };
  if (!fs.existsSync(entry)) {
    return { ...base, status: 'broken', reason: 'console_server_entry_missing', nextAction: `Re-run installer: npx create-principles-disciple (expected ${entry})` };
  }
  if (!fs.existsSync(webIndex)) {
    return { ...base, status: 'broken', reason: 'console_web_ui_missing', nextAction: `Re-run installer: npx create-principles-disciple (expected ${webIndex})` };
  }
  const dir = base.dir as string;
  const integrityError = checkConsoleRuntimeDependencies(dir);
  if (integrityError) {
    return { ...base, status: 'broken', reason: 'console_runtime_dependency_broken', integrity: integrityError, nextAction: `Re-run installer: npx create-principles-disciple (${integrityError})` };
  }

  for (const port of CONSOLE_SCAN_PORTS) {
    if (!(await isPortInUse(CONSOLE_SCAN_HOST, port))) continue;
    const health = await probeConsoleHealth({ host: CONSOLE_SCAN_HOST, port, timeoutMs: CONSOLE_PROBE_TIMEOUT_MS });
    if (health.healthy) {
      return { ...base, status: 'installed_running', running: { url: buildConsoleUrl(CONSOLE_SCAN_HOST, port), port } };
    }
    // Occupied by something that is not a healthy console — keep scanning.
  }
  return base;
}
