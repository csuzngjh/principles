import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDeliveryReport,
  formatDeliveryReport,
  judgeHostRestart,
  type DeliveryReport,
  type DeliverySurface,
  type DeliverySurfaceId,
} from '../delivery-surfaces.js';

const RELEASE_ID = 'b'.repeat(64);
const RELEASE_DIGEST = '2'.repeat(64);
const PRODUCT_VERSION = '2.3.14';

const CANONICAL_VERSIONS: Readonly<Record<string, string>> = {
  plugin: '2.2.4',
  core: '1.297.2',
  'pd-cli': '1.160.1',
  console: '0.1.0',
  'codex-adapter': '0.5.13',
  'host-runtime': '0.13.4',
};

const temporaryDirectories: string[] = [];

function tempHome(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-delivery-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

interface FixtureOptions {
  /** Replace individual canonical runtime component versions. */
  readonly components?: Readonly<Record<string, string>>;
  /** Omit the live ~/.pd/runtime directory (release cache only). */
  readonly runtimeDirMissing?: boolean;
  /** Omit ~/.pd/releases/<id>/metadata.json so canonical health is 'degraded'. */
  readonly omitReleaseMetadata?: boolean;
  /** Write the OpenClaw extension shell; null omits it. */
  readonly openclawPluginVersion?: string | null;
  /** Create ~/.openclaw so the machine counts as an OpenClaw install. */
  readonly openclawInstalled?: boolean;
  readonly codex?: {
    readonly pinCore?: string;
    readonly pinAdapter?: string;
    readonly installedCore?: string;
    readonly installedAdapter?: string;
    readonly omitPin?: boolean;
    readonly omitRuntime?: boolean;
    /** Birth time of the newest session transcript relative to the runtime bytes. */
    readonly sessionStarted?: 'before-runtime' | 'after-runtime' | 'none';
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function writePackageVersion(filePath: string, version: string): void {
  writeJson(filePath, { name: '@principles/fixture', version });
}

function writeCodexFixture(
  home: string,
  components: Readonly<Record<string, string>>,
  codex: NonNullable<FixtureOptions['codex']>,
): void {
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  if (codex.omitPin !== true) {
    writeJson(
      path.join(codexHome, 'plugins', 'cache', 'principles', 'principles-disciple', '0.2.7', 'runtime-version.json'),
      {
        codexAdapter: codex.pinAdapter ?? components['codex-adapter'],
        core: codex.pinCore ?? components.core,
        hostRuntime: components['host-runtime'],
      },
    );
  }
  if (codex.omitRuntime !== true) {
    const modulesDir = path.join(
      codexHome, 'plugins', 'data', 'principles-disciple-principles', 'runtime', 'node_modules', '@principles',
    );
    const adapterPath = path.join(modulesDir, 'codex-adapter', 'package.json');
    const corePath = path.join(modulesDir, 'core', 'package.json');
    writePackageVersion(adapterPath, codex.installedAdapter ?? codex.pinAdapter ?? components['codex-adapter'] ?? '0.5.13');
    writePackageVersion(corePath, codex.installedCore ?? codex.pinCore ?? components.core ?? '1.297.2');
    writePackageVersion(path.join(modulesDir, 'host-runtime', 'package.json'), components['host-runtime'] ?? '0.13.4');
  }
  const sessionStarted = codex.sessionStarted ?? 'after-runtime';
  if (sessionStarted !== 'none') {
    const rollout = path.join(codexHome, 'sessions', '2026', '10', '28', 'rollout-2026-10-28T09-00-00-fixture.jsonl');
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, `${JSON.stringify({ timestamp: '2026-10-28T01:00:00Z', type: 'session_meta' })}\n`);
    if (sessionStarted === 'before-runtime') {
      // Birth time cannot be set, so move the runtime bytes' mtime into the
      // future: the session (born now) started before those bytes landed.
      const future = new Date(Date.now() + 60_000);
      const modulesDir = path.join(
        codexHome, 'plugins', 'data', 'principles-disciple-principles', 'runtime', 'node_modules', '@principles',
      );
      for (const component of ['codex-adapter', 'core', 'host-runtime']) {
        fs.utimesSync(path.join(modulesDir, component, 'package.json'), future, future);
      }
    }
  }
}

function writeFixtureHome(home: string, options: FixtureOptions = {}): void {
  const pdHome = path.join(home, '.pd');
  writeJson(path.join(pdHome, 'active.json'), {
    schemaVersion: 1,
    generation: 53,
    releaseId: RELEASE_ID,
    releaseMetadataDigest: RELEASE_DIGEST,
    previousReleaseId: 'a'.repeat(64),
    transactionId: 'update-fixture',
    productVersion: PRODUCT_VERSION,
  });
  writeJson(path.join(pdHome, 'install.json'), { channel: 'stable', autoCheck: true });
  if (options.omitReleaseMetadata !== true) {
    writeJson(path.join(pdHome, 'releases', RELEASE_ID, 'metadata.json'), {
      productVersion: PRODUCT_VERSION,
      releaseId: RELEASE_ID,
      metadataDigest: RELEASE_DIGEST,
    });
  }
  const components = { ...CANONICAL_VERSIONS, ...options.components };
  for (const [component, version] of Object.entries(components)) {
    const dir = options.runtimeDirMissing
      ? path.join(pdHome, 'releases', RELEASE_ID, component)
      : path.join(pdHome, 'runtime', component);
    writePackageVersion(path.join(dir, 'package.json'), version);
  }

  if (options.openclawInstalled ?? true) {
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    if (options.openclawPluginVersion !== null) {
      writePackageVersion(
        path.join(home, '.openclaw', 'extensions', 'principles-disciple', 'package.json'),
        options.openclawPluginVersion ?? (components.plugin ?? '2.2.4'),
      );
    }
  }

  const { codex } = options;
  if (codex !== undefined) {
    writeCodexFixture(home, components, codex);
  }
}

function surfaceOf(report: DeliveryReport, id: DeliverySurfaceId): DeliverySurface {
  const surface = report.surfaces.find((candidate) => candidate.id === id);
  if (surface === undefined) throw new Error(`missing surface ${id}`);
  return surface;
}

describe('delivery surfaces (PRI-1051)', () => {
  it('reports ok across all four surfaces when the plugin matches the canonical runtime and the host restarted', () => {
    const home = tempHome();
    writeFixtureHome(home, { codex: {} });
    const report = buildDeliveryReport(home, {});
    expect(report.surfaces.map((surface) => surface.id)).toEqual([
      'canonical-runtime', 'openclaw-extension', 'codex-plugin', 'companion',
    ]);
    expect(report.surfaces.map((surface) => surface.status)).toEqual(['ok', 'ok', 'ok', 'not_applicable']);
    expect(report.ok).toBe(true);
    const companion = surfaceOf(report, 'companion');
    expect(companion.required).toBe(false);
    expect(companion.reason).toBe('independent_release_track');
    expect(formatDeliveryReport(report)).toContain('Delivery: complete');
  });

  it('reports the 2026-10-27 incident: pin behind the canonical runtime is stale with a refresh instruction', () => {
    const home = tempHome();
    writeFixtureHome(home, {
      codex: { pinCore: '1.296.2', pinAdapter: '0.5.12', installedCore: '1.296.2', installedAdapter: '0.5.12' },
    });
    const report = buildDeliveryReport(home, {});
    const codex = surfaceOf(report, 'codex-plugin');
    expect(codex.status).toBe('stale');
    expect(codex.reason).toBe('plugin_pin_behind_runtime');
    expect(codex.nextAction).toContain('codex plugin add');
    expect(codex.expected).toMatchObject({ core: '1.297.2', codexAdapter: '0.5.13' });
    expect(codex.actual).toMatchObject({ core: '1.296.2', codexAdapter: '0.5.12' });
    expect(report.ok).toBe(false);
    expect(formatDeliveryReport(report)).toContain('Delivery: incomplete');
  });

  it('distinguishes an outdated executed runtime from an outdated pin', () => {
    const home = tempHome();
    writeFixtureHome(home, {
      codex: { pinCore: '1.297.2', pinAdapter: '0.5.13', installedCore: '1.296.2', installedAdapter: '0.5.12' },
    });
    const codex = surfaceOf(buildDeliveryReport(home, {}), 'codex-plugin');
    expect(codex.status).toBe('stale');
    expect(codex.reason).toBe('plugin_runtime_not_refreshed');
    expect(codex.nextAction).toContain('$pd-control setup');
  });

  it('reports ready_needs_host_restart when the bytes landed after the newest session started', () => {
    const home = tempHome();
    writeFixtureHome(home, { codex: { sessionStarted: 'before-runtime' } });
    const report = buildDeliveryReport(home, {});
    const codex = surfaceOf(report, 'codex-plugin');
    expect(codex.status).toBe('ready_needs_host_restart');
    expect(codex.nextAction).toMatch(/relaunch Codex/);
    expect(report.ok).toBe(false);
  });

  it('reports ready_needs_host_restart when Codex never loaded the runtime', () => {
    const home = tempHome();
    writeFixtureHome(home, { codex: { sessionStarted: 'none' } });
    const codex = surfaceOf(buildDeliveryReport(home, {}), 'codex-plugin');
    // No transcript is evidence of "never started", not an unprovable state:
    // an anonymous unknown here reads as a permanent defect on a fresh install.
    expect(codex.status).toBe('ready_needs_host_restart');
    expect(codex.reason).toBe('host_not_started_since_install');
    expect(codex.nextAction).toMatch(/Launch Codex/);
    expect(codex.detail).toContain('no Codex session transcript');
  });

  it('reports a degraded canonical install as unknown instead of a complete delivery', () => {
    const home = tempHome();
    writeFixtureHome(home, { omitReleaseMetadata: true });
    const report = buildDeliveryReport(home, {});
    const canonical = surfaceOf(report, 'canonical-runtime');
    // `pd version` calls the same install degraded; claiming 'ok' here would
    // print "Delivery: complete" with exit 0 over an unreadable release record.
    expect(canonical.actual.health).toBe('degraded');
    expect(canonical.status).toBe('unknown');
    expect(canonical.reason).toBe('canonical_health_degraded');
    expect(report.ok).toBe(false);
    expect(formatDeliveryReport(report)).toContain('Delivery: incomplete');
  });

  it('reports a missing plugin runtime as stale even when the pin is current', () => {
    const home = tempHome();
    writeFixtureHome(home, { codex: { omitRuntime: true } });
    const codex = surfaceOf(buildDeliveryReport(home, {}), 'codex-plugin');
    expect(codex.status).toBe('stale');
    expect(codex.reason).toBe('plugin_runtime_missing');
  });

  it('reports an unreadable marketplace pin as unknown rather than stale', () => {
    const home = tempHome();
    writeFixtureHome(home, { codex: { omitPin: true } });
    const codex = surfaceOf(buildDeliveryReport(home, {}), 'codex-plugin');
    expect(codex.status).toBe('unknown');
    expect(codex.reason).toBe('plugin_pin_unavailable');
    expect(codex.nextAction).toBeTruthy();
  });

  it('does not require a Codex surface when Codex is not installed', () => {
    const home = tempHome();
    writeFixtureHome(home);
    const report = buildDeliveryReport(home, {});
    const codex = surfaceOf(report, 'codex-plugin');
    expect(codex.status).toBe('not_applicable');
    expect(codex.required).toBe(false);
    expect(report.ok).toBe(true);
  });

  it('does not require an OpenClaw surface when OpenClaw is not installed', () => {
    const home = tempHome();
    writeFixtureHome(home, { openclawInstalled: false });
    const openclaw = surfaceOf(buildDeliveryReport(home, {}), 'openclaw-extension');
    expect(openclaw.status).toBe('not_applicable');
    expect(openclaw.reason).toBe('openclaw_not_installed');
    expect(openclaw.required).toBe(false);
  });

  it('reports a lagging OpenClaw extension shell as stale', () => {
    const home = tempHome();
    writeFixtureHome(home, { openclawPluginVersion: '2.2.3' });
    const openclaw = surfaceOf(buildDeliveryReport(home, {}), 'openclaw-extension');
    expect(openclaw.status).toBe('stale');
    expect(openclaw.reason).toBe('extension_version_mismatch');
    expect(openclaw.expected).toEqual({ plugin: '2.2.4' });
    expect(openclaw.actual).toEqual({ plugin: '2.2.3' });
  });

  it('reports a missing OpenClaw extension shell as stale, not ok', () => {
    const home = tempHome();
    writeFixtureHome(home, { openclawPluginVersion: null });
    const openclaw = surfaceOf(buildDeliveryReport(home, {}), 'openclaw-extension');
    expect(openclaw.status).toBe('stale');
    expect(openclaw.reason).toBe('extension_missing');
  });

  it('reports a canonical install without the live runtime directory as stale', () => {
    const home = tempHome();
    writeFixtureHome(home, { runtimeDirMissing: true });
    const canonical = surfaceOf(buildDeliveryReport(home, {}), 'canonical-runtime');
    expect(canonical.status).toBe('stale');
    expect(canonical.reason).toBe('runtime_dir_missing');
    expect(canonical.actual.componentsSource).toBe('release-cached');
  });

  it('judges host restart only from evidence, never from absence of evidence', () => {
    expect(judgeHostRestart(1000, { birthtimeMs: 2000 })).toEqual({ status: 'ok' });
    expect(judgeHostRestart(2000, { birthtimeMs: 1000 })).toEqual({
      status: 'ready_needs_host_restart', reason: 'host_started_before_runtime',
    });
    expect(judgeHostRestart(2000, { birthtimeMs: 0 })).toEqual({ status: 'unknown', reason: 'host_start_time_unavailable' });
    expect(judgeHostRestart(2000, null)).toEqual({ status: 'unknown', reason: 'host_start_time_unavailable' });
    expect(judgeHostRestart(null, { birthtimeMs: 1000 })).toEqual({ status: 'unknown', reason: 'plugin_install_time_unavailable' });
  });
});
