/**
 * Canonical version report builder (SPEC §12).
 *
 * `pd --version` prints one stable short text line; `pd version --json`
 * exposes the full canonical report: productVersion, releaseId, components,
 * bootstrapVersion, channel, source, generation, health, and the last
 * transaction. The canonical product identity comes from the installation
 * state under ~/.pd — never from a checkout's package.json.
 *
 * The record shapes here mirror the canonical contracts owned by
 * create-principles-disciple/src/update/ (the deep ReleaseManager module);
 * this reader is deliberately thin: it READS installation state and never
 * performs update logic.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type VersionReportSource = 'official-installer' | 'official-legacy-overlay' | 'unknown';

/**
 * Where the component versions in a report were read from (SPEC §12, additive
 * field). The installed canonical runtime is the live truth
 * (`~/.pd/runtime/<component>/package.json`); the release cache under
 * `~/.pd/releases/<id>/` remains the fallback for layouts without a runtime
 * directory, and the legacy overlay reports its own bundle.
 */
export type VersionComponentsSource = 'runtime' | 'release-cached' | 'legacy-overlay';

export interface VersionReport {
  readonly productVersion: string;
  readonly releaseId: string;
  readonly components: Readonly<Record<string, string>>;
  /**
   * Which layout the component versions were read from. Additive diagnostic
   * ahead of the canonical SPEC §12 contract update (the authoritative copy
   * lives in create-principles-disciple/src/update/product-identity.ts):
   * optional so older consumers of this mirror stay compatible; the builder
   * always emits it.
   */
  readonly componentsSource?: VersionComponentsSource;
  readonly bootstrapVersion: string;
  readonly channel: 'stable' | 'candidate';
  readonly source: VersionReportSource;
  readonly generation: number;
  readonly health: 'healthy' | 'degraded' | 'corrupt';
  readonly lastTransaction: Readonly<{ id: string; kind: string; outcome: string }> | null;
}

export class VersionReportError extends Error {
  readonly reason: string;
  readonly nextAction: string;

  constructor(reason: string, message: string, nextAction: string) {
    super(message);
    this.name = 'VersionReportError';
    this.reason = reason;
    this.nextAction = nextAction;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonIfPresent(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new VersionReportError(
      'state_corrupt',
      `Installation state file is not valid JSON: ${filePath} (${error instanceof Error ? error.message : String(error)})`,
      'Run the official installer recovery, or re-run the official installer to repair the installation record.',
    );
  }
  if (!isPlainObject(value)) {
    throw new VersionReportError(
      'state_corrupt',
      `Installation state file is not a JSON object: ${filePath}`,
      'Run the official installer recovery, or re-run the official installer to repair the installation record.',
    );
  }
  return value;
}

/** `pd --version` short stable text contract. */
export function formatShortVersion(report: Pick<VersionReport, 'productVersion' | 'releaseId'>): string {
  return `Principles Disciple ${report.productVersion} (${report.releaseId.slice(0, 12)})`;
}

function buildLegacyOverlayReport(overlayDir: string, bootstrap: Record<string, unknown> | null): VersionReport {
  // The current official installer copies the plugin package directly into
  // the OpenClaw extension root. Older overlay bundles kept it under plugin/;
  // accept that layout only when the canonical root manifest is absent.
  const rootManifest = readJsonIfPresent(path.join(overlayDir, 'package.json'));
  const pluginManifest = rootManifest ?? readJsonIfPresent(path.join(overlayDir, 'plugin', 'package.json'));
  const version = pluginManifest?.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new VersionReportError(
      'legacy_overlay_manifest_invalid',
      `The legacy overlay at ${overlayDir} has no readable plugin version.`,
      'Re-install PD with the official installer to migrate this installation into the supported layout.',
    );
  }
  const bootstrapVersion = bootstrap?.bootstrapVersion;
  return {
    productVersion: version,
    releaseId: '0'.repeat(64),
    components: { plugin: version },
    componentsSource: 'legacy-overlay',
    bootstrapVersion: typeof bootstrapVersion === 'string' ? bootstrapVersion : 'unknown',
    channel: 'stable',
    source: 'official-legacy-overlay',
    generation: 0,
    health: 'degraded',
    lastTransaction: null,
  };
}

function readLastTransaction(historyPath: string): VersionReport['lastTransaction'] {
  if (!fs.existsSync(historyPath)) return null;
  const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  const lastLine = lines[lines.length - 1];
  if (lastLine === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(lastLine) as unknown;
  } catch (error) {
    throw new VersionReportError(
      'state_corrupt',
      `The last transaction record is not valid JSON: ${historyPath} (${error instanceof Error ? error.message : String(error)})`,
      'Run the official installer recovery to reconcile the transaction journal before trusting the installed version.',
    );
  }
  if (!isPlainObject(value)) return null;
  const { transactionId, kind, outcome } = value;
  if (typeof transactionId !== 'string' || typeof kind !== 'string' || typeof outcome !== 'string') {
    return null;
  }
  return { id: transactionId, kind, outcome };
}

/**
 * Builds the canonical version report from the installation state. Throws
 * VersionReportError with an installer next-action when no installation
 * exists at all.
 */
export function buildVersionReport(homeDir: string = os.homedir()): VersionReport {
  const pdHome = path.join(homeDir, '.pd');
  const active = readJsonIfPresent(path.join(pdHome, 'active.json'));
  const bootstrap = readJsonIfPresent(path.join(pdHome, 'bootstrap', 'bootstrap.json'));
  const installConfig = readJsonIfPresent(path.join(pdHome, 'install.json'));

  const overlayDir = path.join(homeDir, '.openclaw', 'extensions', 'principles-disciple');

  if (active === null && fs.existsSync(overlayDir)) {
    return buildLegacyOverlayReport(overlayDir, bootstrap);
  }
  if (active === null && !fs.existsSync(pdHome)) {
    throw new VersionReportError(
      'not_installed',
      'No PD installation was found under ~/.pd or the legacy overlay location.',
      'Install PD with the official installer (npx create-principles-disciple), then run pd version again.',
    );
  }
  if (active === null) {
    throw new VersionReportError(
      'active_record_missing',
      'The ~/.pd installation exists but has no active release record.',
      'Run the official installer to complete the installation, or re-run it to repair the record.',
    );
  }

  const { generation, releaseId, productVersion } = active;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1
    || typeof releaseId !== 'string' || releaseId.length === 0
    || typeof productVersion !== 'string' || productVersion.length === 0) {
    throw new VersionReportError(
      'active_record_corrupt',
      'The active release record under ~/.pd is malformed.',
      'Run the official installer recovery, or re-run the official installer to repair the installation record.',
    );
  }

  const releaseDir = path.join(pdHome, 'releases', releaseId);
  const releaseManifest = readJsonIfPresent(path.join(releaseDir, 'metadata.json'));
  const releaseMetadataMatchesActive = releaseManifest !== null
    && releaseManifest.productVersion === productVersion
    && releaseManifest.releaseId === releaseId
    && releaseManifest.metadataDigest === active.releaseMetadataDigest;
  const health: VersionReport['health'] = releaseManifest === null
    ? 'degraded'
    : releaseMetadataMatchesActive ? 'healthy' : 'corrupt';

  // The live canonical runtime is the primary component-version source; the
  // release cache stays as the fallback for layouts without a runtime
  // directory (and per component when the runtime copy is absent). Component
  // versions are read, never judged: independently versioned components are
  // not corruption, and health remains bound to the active-identity
  // verification above (a runtime full of readable package versions alone
  // never makes the report healthy). A malformed component manifest degrades
  // to an omitted component — this command exists to diagnose broken
  // installs, so one corrupt manifest must not kill the whole report.
  const runtimeDir = path.join(pdHome, 'runtime');
  const componentsBaseDir = fs.existsSync(runtimeDir) ? runtimeDir : releaseDir;
  const componentsSource: VersionReport['componentsSource'] = componentsBaseDir === runtimeDir
    ? 'runtime'
    : 'release-cached';
  const readComponentManifest = (component: string): Record<string, unknown> | null => {
    try {
      return readJsonIfPresent(path.join(componentsBaseDir, component, 'package.json'));
    } catch {
      return null; // malformed live manifest: omit the component, keep the report
    }
  };
  const components: Record<string, string> = {};
  for (const component of ['plugin', 'console', 'core', 'pd-cli', 'host-runtime', 'install-layout', 'codex-adapter', 'release-manager']) {
    let manifest = readComponentManifest(component);
    if (manifest === null && componentsBaseDir === runtimeDir) {
      // Per-component fallback: a partially populated runtime dir (partial
      // sync) must not silently drop components that the release cache can
      // still report.
      try {
        manifest = readJsonIfPresent(path.join(releaseDir, component, 'package.json'));
      } catch {
        manifest = null;
      }
    }
    const version = manifest?.version;
    if (typeof version === 'string') {
      components[component] = version;
    }
  }

  const bootstrapVersion = bootstrap?.bootstrapVersion;
  const channelValue = installConfig?.channel;

  return {
    productVersion,
    releaseId,
    components,
    componentsSource,
    bootstrapVersion: typeof bootstrapVersion === 'string' ? bootstrapVersion : 'unknown',
    channel: channelValue === 'candidate' ? 'candidate' : 'stable',
    source: 'official-installer',
    generation,
    health,
    lastTransaction: readLastTransaction(path.join(pdHome, 'logs', 'history.jsonl')),
  };
}
