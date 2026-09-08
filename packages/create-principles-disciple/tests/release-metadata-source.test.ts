/**
 * PRI-709 P0-1 — Release metadata source contract.
 *
 * PRI-698 Phase 0 Audit finding F-4: `PD_RELEASE_METADATA_URL` had no supply
 * side. It was read directly by consumers, so no install could ever resolve a
 * metadata repository from durable state. These tests pin:
 *
 * 1. Resolution order — explicit > env > install_config > unconfigured.
 * 2. `invalid` short-circuits (an operator's broken override is never silently
 *    bypassed in favour of install state).
 * 3. `~/.pd/install.json` is merge-owned: no writer may clobber another
 *    writer's fields (the bug that made the two historical writers mutually
 *    destructive).
 * 4. The durable tier actually makes the ReleaseManager authority ready with
 *    no environment variable present.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RELEASE_METADATA_URL_ENV,
  isReleaseMetadataUrl,
  normalizeReleaseMetadataUrl,
  resolveReleaseMetadataSource,
} from '../src/update/release-metadata-source.js';
import {
  InstallLayoutError,
  ensurePdHomeLayout,
  mergeIntoInstallJson,
  readInstallConfig,
  resolvePdHomePaths,
  writeInstallConfig,
} from '../src/update/install-layout.js';
import { createReleaseManagerAuthority } from '../src/update/release-manager-authority.js';
import { createShadowFixture, disposeShadowFixtures, trackTempDir } from './helpers/shadow-release-fixture.js';

const TEST_URL = 'https://releases.example.com/pd';

function makeTempHome(): string {
  return trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-meta-src-')));
}

afterEach(async () => {
  await disposeShadowFixtures();
  delete process.env[RELEASE_METADATA_URL_ENV];
});

describe('normalizeReleaseMetadataUrl', () => {
  it('accepts non-empty http/https URLs and trims surrounding whitespace', () => {
    expect(normalizeReleaseMetadataUrl(TEST_URL)).toBe(TEST_URL);
    expect(normalizeReleaseMetadataUrl(`  ${TEST_URL}  `)).toBe(TEST_URL);
    expect(normalizeReleaseMetadataUrl('http://127.0.0.1:8099')).toBe('http://127.0.0.1:8099');
  });

  it('rejects empty, non-string, non-http and unparseable values', () => {
    for (const value of ['', '   ', undefined, null, 42, {}, 'file:///etc/passwd', 'not a url', 'ftp://x.example']) {
      expect(normalizeReleaseMetadataUrl(value)).toBeNull();
    }
    expect(isReleaseMetadataUrl(TEST_URL)).toBe(true);
    expect(isReleaseMetadataUrl('ftp://x.example')).toBe(false);
  });
});

describe('resolveReleaseMetadataSource', () => {
  it('resolves in order explicit > env > install_config', () => {
    // install_config only
    expect(resolveReleaseMetadataSource({
      env: undefined,
      installConfig: { releaseMetadataUrl: TEST_URL },
    })).toEqual({ kind: 'install_config', metadataBaseUrl: TEST_URL, detail: null });

    // env beats install_config
    expect(resolveReleaseMetadataSource({
      env: 'http://env.example',
      installConfig: { releaseMetadataUrl: TEST_URL },
    })).toEqual({ kind: 'env', metadataBaseUrl: 'http://env.example', detail: null });

    // explicit beats env
    expect(resolveReleaseMetadataSource({
      explicit: 'http://explicit.example',
      env: 'http://env.example',
      installConfig: { releaseMetadataUrl: TEST_URL },
    })).toEqual({ kind: 'explicit', metadataBaseUrl: 'http://explicit.example', detail: null });
  });

  it('treats an empty override as absent instead of an empty URL', () => {
    expect(resolveReleaseMetadataSource({
      explicit: '   ',
      env: undefined,
      installConfig: { releaseMetadataUrl: TEST_URL },
    })).toEqual({ kind: 'install_config', metadataBaseUrl: TEST_URL, detail: null });
  });

  it('reports unconfigured with an undefined URL when no source exists', () => {
    const resolved = resolveReleaseMetadataSource({ env: undefined, installConfig: null });
    expect(resolved).toEqual({ kind: 'unconfigured', metadataBaseUrl: undefined, detail: null });
    expect(resolveReleaseMetadataSource()).toEqual({
      kind: 'unconfigured',
      metadataBaseUrl: undefined,
      detail: null,
    });
  });

  it('short-circuits an invalid source instead of falling through to a lower tier', () => {
    expect(resolveReleaseMetadataSource({
      env: 'ftp://nope.example',
      installConfig: { releaseMetadataUrl: TEST_URL },
    })).toEqual({ kind: 'invalid', metadataBaseUrl: undefined, detail: 'env_url_invalid' });

    expect(resolveReleaseMetadataSource({
      explicit: '/not/a/url',
      env: undefined,
      installConfig: { releaseMetadataUrl: TEST_URL },
    })).toEqual({ kind: 'invalid', metadataBaseUrl: undefined, detail: 'explicit_url_invalid' });
  });

  it('reads PD_RELEASE_METADATA_URL from the process env by default', () => {
    process.env[RELEASE_METADATA_URL_ENV] = TEST_URL;
    expect(resolveReleaseMetadataSource()).toEqual({
      kind: 'env',
      metadataBaseUrl: TEST_URL,
      detail: null,
    });
  });
});

describe('install.json is merge-owned', () => {
  it('a config write preserves installer-owned manifest fields (and vice versa)', () => {
    const home = makeTempHome();
    const paths = resolvePdHomePaths(path.join(home, '.pd'));
    ensurePdHomeLayout(paths);

    // Installer-owned shape first (what ~/.pd/install.json looks like today).
    fs.writeFileSync(paths.installConfigPath, `${JSON.stringify({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['openclaw'],
      workspaces: ['D:\\\\.openclaw\\\\workspace'],
    }, null, 2)}\n`);

    writeInstallConfig(paths, { channel: 'candidate', autoCheck: true, releaseMetadataUrl: TEST_URL });
    const onDisk = JSON.parse(fs.readFileSync(paths.installConfigPath, 'utf8')) as Record<string, unknown>;

    expect(onDisk).toMatchObject({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['openclaw'],
      channel: 'candidate',
      autoCheck: true,
      releaseMetadataUrl: TEST_URL,
    });
    // The manifest parser must still accept the merged shape — the historical
    // clobber made it fail with install_manifest_malformed.
    expect(readInstallConfig(paths)).toEqual({
      channel: 'candidate',
      autoCheck: true,
      releaseMetadataUrl: TEST_URL,
    });
  });

  it('mergeIntoInstallJson preserves fields it does not own', () => {
    const home = makeTempHome();
    const filePath = path.join(home, 'install.json');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ layoutVersion: 1, channel: 'stable' }, null, 2)}\n`);

    mergeIntoInstallJson(filePath, { hosts: ['codex'] });

    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      layoutVersion: 1,
      channel: 'stable',
      hosts: ['codex'],
    });
  });

  it('round-trips a pre-existing install.json that has no releaseMetadataUrl', () => {
    const home = makeTempHome();
    const paths = resolvePdHomePaths(path.join(home, '.pd'));
    ensurePdHomeLayout(paths);
    writeInstallConfig(paths, { channel: 'stable', autoCheck: false });
    // Absent on disk ⇒ absent from the typed config (not an empty string).
    expect(readInstallConfig(paths)).toEqual({ channel: 'stable', autoCheck: false });
    expect('releaseMetadataUrl' in (JSON.parse(fs.readFileSync(paths.installConfigPath, 'utf8')) as object)).toBe(false);
  });

  it('a config write that omits releaseMetadataUrl PRESERVES the durable tier (review fix)', () => {
    const home = makeTempHome();
    const paths = resolvePdHomePaths(path.join(home, '.pd'));
    ensurePdHomeLayout(paths);
    writeInstallConfig(paths, { channel: 'stable', autoCheck: false, releaseMetadataUrl: TEST_URL });

    // A future writer that only owns channel/autoCheck must not silently drop
    // the installer-supplied durable tier.
    writeInstallConfig(paths, { channel: 'candidate', autoCheck: true });

    const onDisk = JSON.parse(fs.readFileSync(paths.installConfigPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toMatchObject({ channel: 'candidate', autoCheck: true, releaseMetadataUrl: TEST_URL });
    expect(readInstallConfig(paths)).toEqual({
      channel: 'candidate',
      autoCheck: true,
      releaseMetadataUrl: TEST_URL,
    });
  });

  it('treats an empty releaseMetadataUrl as not configured, not as a corrupt install (review fix)', () => {
    const home = makeTempHome();
    const paths = resolvePdHomePaths(path.join(home, '.pd'));
    ensurePdHomeLayout(paths);
    for (const empty of ['', '   ']) {
      fs.writeFileSync(paths.installConfigPath, `${JSON.stringify({
        channel: 'stable',
        autoCheck: false,
        releaseMetadataUrl: empty,
      }, null, 2)}\n`);
      // Consistent with the resolver: an unset override is absent, and it must
      // not brick ReleaseManager readiness for the whole install.
      expect(readInstallConfig(paths)).toEqual({ channel: 'stable', autoCheck: false });
    }
  });

  it('fails loud on a malformed releaseMetadataUrl instead of degrading to unconfigured', () => {
    const home = makeTempHome();
    const paths = resolvePdHomePaths(path.join(home, '.pd'));
    ensurePdHomeLayout(paths);
    fs.writeFileSync(paths.installConfigPath, `${JSON.stringify({
      channel: 'stable',
      autoCheck: false,
      releaseMetadataUrl: 'ftp://nope.example',
    }, null, 2)}\n`);

    try {
      readInstallConfig(paths);
      expect.unreachable('a malformed releaseMetadataUrl must fail loud');
    } catch (error) {
      expect(error).toBeInstanceOf(InstallLayoutError);
      expect((error as InstallLayoutError).field).toBe('releaseMetadataUrl');
    }
  });
});

describe('authority resolves the durable install_config tier', () => {
  it('becomes check-ready from ~/.pd/install.json with no environment variable set', async () => {
    delete process.env[RELEASE_METADATA_URL_ENV];
    const fixture = await createShadowFixture();
    const paths = resolvePdHomePaths(fixture.pdHome);

    const before = createReleaseManagerAuthority({ pdHome: fixture.pdHome, metadataBaseUrl: undefined });
    expect(before.metadataSource).toEqual({ kind: 'unconfigured', metadataBaseUrl: undefined, detail: null });
    expect(before.kinds.check.reasons).toEqual(['metadata_source_unconfigured']);

    // Simulate the installer's durable supply path.
    writeInstallConfig(paths, { channel: 'stable', autoCheck: false, releaseMetadataUrl: fixture.repository.baseUrl });

    const after = createReleaseManagerAuthority({ pdHome: fixture.pdHome, metadataBaseUrl: undefined });
    expect(after.metadataSource).toEqual({
      kind: 'install_config',
      metadataBaseUrl: fixture.repository.baseUrl,
      detail: null,
    });
    expect(after.kinds.check).toEqual({ ready: true, reasons: [] });
    expect(after.kinds['apply-full']).toEqual({ ready: true, reasons: [] });
  });

  it('an explicit override still wins over the durable tier', async () => {
    const fixture = await createShadowFixture();
    const paths = resolvePdHomePaths(fixture.pdHome);
    writeInstallConfig(paths, { channel: 'stable', autoCheck: false, releaseMetadataUrl: TEST_URL });

    const authority = createReleaseManagerAuthority({
      pdHome: fixture.pdHome,
      metadataBaseUrl: fixture.repository.baseUrl,
    });
    expect(authority.metadataSource).toEqual({
      kind: 'explicit',
      metadataBaseUrl: fixture.repository.baseUrl,
      detail: null,
    });
    expect(authority.kinds.check.ready).toBe(true);
  });

  it('a malformed install.json URL is install_state_corrupt, never a silent fallback', async () => {
    const fixture = await createShadowFixture();
    const paths = resolvePdHomePaths(fixture.pdHome);
    fs.writeFileSync(paths.installConfigPath, `${JSON.stringify({
      channel: 'stable',
      autoCheck: false,
      releaseMetadataUrl: 'not-a-url',
    }, null, 2)}\n`);

    const authority = createReleaseManagerAuthority({ pdHome: fixture.pdHome, metadataBaseUrl: undefined });
    expect(authority.metadataSource.metadataBaseUrl).toBeUndefined();
    expect(authority.kinds.check.ready).toBe(false);
    expect(authority.kinds.check.reasons).toContain('install_state_corrupt');
    expect(authority.kinds.check.reasons).toContain('metadata_source_unconfigured');
  });
});
