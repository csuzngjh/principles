/**
 * PRI-1051: one verdict across PD's four delivery surfaces.
 *
 * An update is not delivered when the internal chains are green — it is
 * delivered when every surface that exists on this machine carries the
 * canonical release's bytes and, for hosts that load plugins at start, the
 * host has started since those bytes landed. 2026-10-27: the canonical
 * runtime and the OpenClaw extension were on core 1.297.2 while the Codex
 * plugin still executed 1.296.2, and nothing answered that question directly.
 *
 * Every row is DERIVED from the authority that already owns the fact:
 *
 *   canonical-runtime   active.json + live ~/.pd/runtime manifests (version report)
 *   openclaw-extension  the extension shell's own package.json
 *   codex-plugin        marketplace pin + the runtime under plugin data
 *   companion           none — it ships on its own companion-v* track
 *
 * Nothing is cached, persisted or written, and no network is contacted: "a
 * NEWER release exists" remains the update channel's question. A surface that
 * cannot be read is `unknown` with a structured reason, never a silent `ok`
 * (rc-9).
 */
import * as fs from 'fs';
import * as os from 'os';
import { getInstallLayoutPaths, type InstallLayoutPaths } from '@principles/install-layout';
import { buildVersionReport, type VersionReport } from './version-report.js';
import {
  findNewestRolloutFile,
  readInstalledCodexRuntime,
  resolveCodexHome,
  selectMarketplaceCacheVersionDir,
} from './codex-plugin-install.js';

export type DeliverySurfaceId = 'canonical-runtime' | 'openclaw-extension' | 'codex-plugin' | 'companion';

export type DeliverySurfaceStatus =
  | 'ok'
  | 'stale'
  | 'ready_needs_host_restart'
  | 'not_applicable'
  | 'unknown';

export interface DeliverySurface {
  readonly id: DeliverySurfaceId;
  readonly label: string;
  readonly status: DeliverySurfaceStatus;
  /** Whether the update is incomplete while this surface is not `ok`. */
  readonly required: boolean;
  /** What the canonical install says this surface should carry. */
  readonly expected: Readonly<Record<string, string>>;
  /** What this surface actually carries; null values are unreadable fields. */
  readonly actual: Readonly<Record<string, string | null>>;
  readonly reason?: string;
  readonly nextAction?: string;
  readonly detail?: string;
}

export interface DeliveryReport {
  /** True when every required surface is `ok`. */
  readonly ok: boolean;
  readonly surfaces: readonly DeliverySurface[];
}

const COMPONENT_VERSION_KEYS = ['core', 'codex-adapter', 'host-runtime'] as const;

function pickComponents(report: VersionReport, keys: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of keys) {
    const version = report.components[key];
    if (version !== undefined) picked[key] = version;
  }
  return picked;
}

function judgeCanonicalRuntime(report: VersionReport): DeliverySurface {
  const expected = {
    productVersion: report.productVersion,
    generation: String(report.generation),
  };
  const actual: Record<string, string | null> = {
    componentsSource: report.componentsSource ?? 'unknown',
    health: report.health,
    ...pickComponents(report, ['core', 'plugin', 'pd-cli']),
  };
  const base = { id: 'canonical-runtime' as const, label: 'Canonical runtime (~/.pd/runtime)', required: true, expected, actual };

  if (report.source === 'official-legacy-overlay') {
    return {
      ...base,
      status: 'unknown',
      reason: 'legacy_overlay_layout',
      nextAction: 'Run the official installer (npx create-principles-disciple) to migrate this legacy overlay install into the canonical layout.',
    };
  }
  if (report.health === 'corrupt') {
    return {
      ...base,
      status: 'unknown',
      reason: 'active_identity_mismatch',
      nextAction: 'Run the official installer recovery, or re-run the official installer to repair the installation record.',
    };
  }
  if (report.componentsSource !== 'runtime') {
    return {
      ...base,
      status: 'stale',
      reason: 'runtime_dir_missing',
      nextAction: 'Run the official installer (npx create-principles-disciple) to populate the live runtime from the active release.',
    };
  }
  const missing = ['core', 'plugin', 'pd-cli'].filter((component) => report.components[component] === undefined);
  if (missing.length > 0) {
    return {
      ...base,
      status: 'unknown',
      reason: 'runtime_component_missing',
      nextAction: 'Run the official installer (npx create-principles-disciple) to repair the live runtime component manifests.',
      detail: `unreadable manifests: ${missing.join(', ')}`,
    };
  }
  return { ...base, status: 'ok' };
}

function readPackageVersion(filePath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const version = Object.hasOwn(parsed, 'version') ? Reflect.get(parsed, 'version') : undefined;
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

function judgeOpenClawExtension(report: VersionReport, layout: InstallLayoutPaths): DeliverySurface {
  const expectedPlugin = report.components.plugin;
  const expected: Record<string, string> = expectedPlugin === undefined ? {} : { plugin: expectedPlugin };
  const extensionManifest = `${layout.openClawExtensionDir}/package.json`;
  const actual: Record<string, string | null> = { plugin: fs.existsSync(extensionManifest) ? readPackageVersion(extensionManifest) : null };
  const base = {
    id: 'openclaw-extension' as const,
    label: 'OpenClaw extension (~/.openclaw/extensions/principles-disciple)',
    expected,
    actual,
    detail: layout.openClawExtensionDir,
  };

  if (!fs.existsSync(layout.openClawDir)) {
    return {
      ...base,
      status: 'not_applicable',
      required: false,
      reason: 'openclaw_not_installed',
      detail: `${layout.openClawDir} does not exist — OpenClaw is not installed on this machine.`,
    };
  }
  if (!fs.existsSync(layout.openClawExtensionDir)) {
    return {
      ...base,
      status: 'stale',
      required: true,
      reason: 'extension_missing',
      nextAction: 'Run the official installer (npx create-principles-disciple) so the OpenClaw extension shell is re-synced from the canonical runtime.',
    };
  }
  if (actual.plugin === null) {
    return {
      ...base,
      status: 'unknown',
      required: true,
      reason: 'extension_manifest_unreadable',
      nextAction: 'Run the official installer (npx create-principles-disciple) to repair the extension manifest.',
    };
  }
  if (expectedPlugin === undefined) {
    return {
      ...base,
      status: 'unknown',
      required: true,
      reason: 'canonical_component_version_unavailable',
      nextAction: 'Fix the canonical runtime first (see the canonical-runtime row), then re-run this check.',
    };
  }
  if (actual.plugin !== expectedPlugin) {
    return {
      ...base,
      status: 'stale',
      required: true,
      reason: 'extension_version_mismatch',
      nextAction: 'Run the official installer (npx create-principles-disciple) so the OpenClaw extension shell is re-synced from the canonical runtime.',
    };
  }
  return { ...base, status: 'ok', required: true };
}

/**
 * Host-start verdict, kept pure so the unreadable paths are testable without
 * faking filesystem timestamps: a host that started before the plugin bytes
 * landed is still executing the previous ones.
 */
export function judgeHostRestart(
  installedAtMs: number | null,
  newestRollout: { birthtimeMs: number } | null,
): { status: 'ok' | 'ready_needs_host_restart' | 'unknown'; reason?: string } {
  if (newestRollout === null) return { status: 'unknown', reason: 'host_start_time_unavailable' };
  if (newestRollout.birthtimeMs <= 0) return { status: 'unknown', reason: 'host_start_time_unavailable' };
  if (installedAtMs === null) return { status: 'unknown', reason: 'plugin_install_time_unavailable' };
  return newestRollout.birthtimeMs >= installedAtMs
    ? { status: 'ok' }
    : { status: 'ready_needs_host_restart', reason: 'host_started_before_runtime' };
}

function judgeCodexPlugin(
  report: VersionReport,
  env: { CODEX_HOME?: string },
  homeDir: string,
): DeliverySurface {
  const codexHome = resolveCodexHome(env, homeDir);
  const canonical = pickComponents(report, COMPONENT_VERSION_KEYS);
  const expected: Record<string, string> = {};
  if (canonical.core !== undefined) expected.core = canonical.core;
  if (canonical['codex-adapter'] !== undefined) expected.codexAdapter = canonical['codex-adapter'];
  if (canonical['host-runtime'] !== undefined) expected.hostRuntime = canonical['host-runtime'];
  const base = {
    id: 'codex-plugin' as const,
    label: 'Codex plugin (marketplace pin + plugin data runtime)',
    expected,
    detail: codexHome,
  };

  if (!fs.existsSync(codexHome)) {
    return {
      ...base,
      status: 'not_applicable',
      required: false,
      reason: 'codex_not_installed',
      actual: {},
      detail: `${codexHome} does not exist — Codex is not installed on this machine.`,
    };
  }
  const cacheSelection = selectMarketplaceCacheVersionDir(codexHome);
  const installed = readInstalledCodexRuntime(codexHome);
  const actual: Record<string, string | null> = {
    core: installed.core,
    codexAdapter: installed.codexAdapter,
    hostRuntime: installed.hostRuntime,
  };
  const pinDetail = cacheSelection === null
    ? 'pin: unreadable'
    : `pin ${cacheSelection.dirName}: core ${cacheSelection.pin.core ?? 'unreadable'}, adapter ${cacheSelection.pin.codexAdapter ?? 'unreadable'}`;
  const withDetail = (detail: string): string => `${pinDetail}; ${detail}`;

  if (cacheSelection === null) {
    return {
      ...base,
      status: 'unknown',
      required: true,
      actual,
      reason: 'plugin_pin_unavailable',
      nextAction: 'Re-add the plugin (codex plugin add principles-disciple@principles), re-run the $pd-control setup skill, then restart Codex.',
      detail: withDetail('the marketplace snapshot PD publishes is missing or unreadable'),
    };
  }
  if (!installed.present) {
    return {
      ...base,
      status: 'stale',
      required: true,
      actual,
      reason: 'plugin_runtime_missing',
      nextAction: 'Re-run the $pd-control setup skill so the pinned runtime is installed, then restart Codex.',
      detail: withDetail('no runtime under plugin data — hooks cannot execute'),
    };
  }
  if (expected.core === undefined || expected.codexAdapter === undefined) {
    return {
      ...base,
      status: 'unknown',
      required: true,
      actual,
      reason: 'canonical_component_version_unavailable',
      nextAction: 'Fix the canonical runtime first (see the canonical-runtime row), then re-run this check.',
      detail: withDetail('the canonical runtime does not report core/codex-adapter'),
    };
  }
  const canonicalHostRuntime = canonical['host-runtime'];
  const pinBehind = cacheSelection.pin.core !== expected.core
    || cacheSelection.pin.codexAdapter !== expected.codexAdapter
    || (canonicalHostRuntime !== undefined && cacheSelection.pin.hostRuntime !== canonicalHostRuntime);
  if (pinBehind) {
    return {
      ...base,
      status: 'stale',
      required: true,
      actual,
      reason: 'plugin_pin_behind_runtime',
      nextAction: 'Refresh the Codex plugin cache (codex plugin remove principles-disciple@principles && codex plugin add principles-disciple@principles), re-run the $pd-control setup skill, then restart Codex.',
      detail: withDetail('the snapshot PD publishes still pins older versions than the canonical runtime'),
    };
  }
  if (installed.core !== cacheSelection.pin.core
    || installed.codexAdapter !== cacheSelection.pin.codexAdapter
    || (cacheSelection.pin.hostRuntime !== undefined && installed.hostRuntime !== cacheSelection.pin.hostRuntime)) {
    return {
      ...base,
      status: 'stale',
      required: true,
      actual,
      reason: 'plugin_runtime_not_refreshed',
      nextAction: 'Re-run the $pd-control setup skill so the pinned runtime is reinstalled, then restart Codex.',
      detail: withDetail('the executed runtime does not match the pin'),
    };
  }
  const host = judgeHostRestart(installed.installedAtMs, findNewestRolloutFile(codexHome));
  if (host.status === 'ok') {
    return { ...base, status: 'ok', required: true, actual, detail: withDetail('host started after the runtime landed') };
  }
  if (host.status === 'ready_needs_host_restart') {
    return {
      ...base,
      status: 'ready_needs_host_restart',
      required: true,
      actual,
      reason: host.reason,
      nextAction: 'Quit and relaunch Codex — the plugin runtime is loaded at host start.',
    };
  }
  return {
    ...base,
    status: 'unknown',
    required: true,
    actual,
    reason: host.reason ?? 'host_start_time_unavailable',
    nextAction: 'Restart Codex once you can, then re-run this check: without a readable host start time the restart cannot be proven.',
  };
}

function judgeCompanion(): DeliverySurface {
  return {
    id: 'companion',
    label: 'Companion (independent companion-v* release track)',
    status: 'not_applicable',
    required: false,
    expected: {},
    actual: {},
    reason: 'independent_release_track',
    detail: 'The Companion ships on its own release track and self-heals its Console on release changes; a PD product update does not deliver it.',
  };
}

/**
 * Builds the four-surface verdict from the canonical installation state.
 * Throws VersionReportError (same shape as `pd version --json`) when no
 * trustworthy canonical state exists at all.
 */
export function buildDeliveryReport(
  homeDir: string = os.homedir(),
  env: { CODEX_HOME?: string } = process.env,
): DeliveryReport {
  const report = buildVersionReport(homeDir);
  const layout = getInstallLayoutPaths(homeDir);
  const surfaces: DeliverySurface[] = [
    judgeCanonicalRuntime(report),
    judgeOpenClawExtension(report, layout),
    judgeCodexPlugin(report, env, homeDir),
    judgeCompanion(),
  ];
  return {
    ok: surfaces.every((surface) => !surface.required || surface.status === 'ok'),
    surfaces,
  };
}

function formatKeyValues(values: Readonly<Record<string, string | null>>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) return '—';
  return entries.map(([key, value]) => `${key}=${value ?? 'unreadable'}`).join(' ');
}

/** Human-readable rendering for `pd version --delivery` (non-JSON). */
export function formatDeliveryReport(report: DeliveryReport): string {
  const lines: string[] = ['Delivery surfaces:'];
  for (const surface of report.surfaces) {
    lines.push(`  ${surface.id.padEnd(20)} ${surface.status}`);
    if (Object.keys(surface.expected).length > 0) {
      lines.push(`      expected: ${formatKeyValues(surface.expected)}`);
    }
    if (Object.keys(surface.actual).length > 0) {
      lines.push(`      actual:   ${formatKeyValues(surface.actual)}`);
    }
    if (surface.reason !== undefined) lines.push(`      reason:   ${surface.reason}`);
    if (surface.nextAction !== undefined) lines.push(`      next:     ${surface.nextAction}`);
    if (surface.detail !== undefined) lines.push(`      detail:   ${surface.detail}`);
  }
  const pending = report.surfaces.filter((surface) => surface.required && surface.status !== 'ok');
  lines.push(pending.length === 0
    ? 'Delivery: complete — every required surface is ok.'
    : `Delivery: incomplete — ${pending.map((surface) => `${surface.id} (${surface.status})`).join(', ')}.`);
  return lines.join('\n');
}
