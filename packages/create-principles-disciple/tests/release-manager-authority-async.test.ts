/**
 * `createReleaseManagerAuthorityAsync`: the readiness gate for callers that
 * serve requests (the Console's `/api/update/check` and `/api/update/apply-full`).
 *
 * Contracts under test:
 * 1. SAME DECISION as the synchronous factory — proven differentially across
 *    the readiness matrix, because both factories must run one rule.
 * 2. The event loop is not held while the deployed executor tree is re-hashed.
 * 3. `digestDirectoryAsync` IS `digestDirectory`: same tree, same order, same
 *    per-file record, same refusal — a registration made by the installer's
 *    synchronous digest is accepted.
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InstallLayoutError,
  digestDirectory,
  digestDirectoryAsync,
  ensurePdHomeLayout,
  resolvePdHomePaths,
} from '../src/update/install-layout.js';
import {
  createReleaseManagerAuthority,
  createReleaseManagerAuthorityAsync,
  type ReleaseManagerAuthority,
  type ReleaseManagerAuthorityOptions,
} from '../src/update/release-manager-authority.js';
import { createShadowFixture, disposeShadowFixtures, trackTempDir } from './helpers/shadow-release-fixture.js';

afterEach(async () => {
  await disposeShadowFixtures();
});

function makeTempHome(): string {
  return trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rm-authority-async-')));
}

/** What the route reads off the authority. `manager` is a class instance: it is
 * compared through the decision it took part in, not by identity. */
function verdict(authority: ReleaseManagerAuthority): unknown {
  return {
    kinds: authority.kinds,
    installStatus: authority.installStatus,
    metadataSource: authority.metadataSource,
  };
}

/**
 * Path + content digest of every file under `root`, so ANY write — creation,
 * mutation, deletion — shows up as a delta. Same containment guard as the
 * synchronous factory's zero-write test: nothing outside the root is read.
 */
function snapshotTree(root: string, current: string = root, seen = new Map<string, string>()): Map<string, string> {
  const rootResolved = path.resolve(root);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return seen;
  }
  for (const entry of entries) {
    const entryPath = path.resolve(current, entry.name);
    // Containment guard: never follow anything that escapes the snapshot root.
    if (!entryPath.startsWith(rootResolved + path.sep)) continue;
    if (entry.isDirectory()) {
      snapshotTree(root, entryPath, seen);
    } else if (entry.isFile()) {
      seen.set(path.relative(rootResolved, entryPath), createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex'));
    } else {
      seen.set(path.relative(rootResolved, entryPath), `other:${entry.name}`);
    }
  }
  return seen;
}

function plantExecutorTree(executorDir: string): void {
  // Created out of digest order and with real breadth, so the gate has to
  // list, sort and read before it can decide.
  for (let dir = 0; dir < 12; dir += 1) {
    fs.mkdirSync(path.join(executorDir, `part-${dir}`), { recursive: true });
    for (let file = 40; file >= 0; file -= 1) {
      fs.writeFileSync(path.join(executorDir, `part-${dir}`, `file-${file}.js`), `// ${dir}:${file}\n`);
    }
  }
}

describe('async readiness gate decides exactly like the synchronous one', () => {
  const cases: Array<{
    name: string;
    /** Builds the PD home and returns the factory options. */
    build: () => Promise<ReleaseManagerAuthorityOptions> | ReleaseManagerAuthorityOptions;
    /** The reasons the async factory must report on `check`. */
    reasons: readonly string[];
  }> = [
    {
      name: 'bare installation without a metadata source',
      build: () => {
        const home = makeTempHome();
        return { pdHome: path.join(home, '.pd'), metadataBaseUrl: undefined, openclawHome: path.join(home, 'no-openclaw') };
      },
      reasons: ['metadata_source_unconfigured', 'bootstrap_not_installed', 'journal_not_supported'],
    },
    {
      name: 'installer skeleton without a registration',
      build: () => {
        const home = makeTempHome();
        const paths = resolvePdHomePaths(path.join(home, '.pd'));
        ensurePdHomeLayout(paths);
        return { pdHome: paths.home, metadataBaseUrl: undefined, openclawHome: path.join(home, 'no-openclaw') };
      },
      reasons: ['metadata_source_unconfigured', 'bootstrap_not_registered'],
    },
    {
      name: 'skeleton whose registration carries no digest',
      build: () => {
        const home = makeTempHome();
        const paths = resolvePdHomePaths(path.join(home, '.pd'));
        ensurePdHomeLayout(paths);
        fs.writeFileSync(paths.bootstrapManifestPath, JSON.stringify({ bootstrapVersion: '1.0.0', installedAt: '2026-08-25T00:00:00Z' }));
        return { pdHome: paths.home, metadataBaseUrl: undefined, openclawHome: path.join(home, 'no-openclaw') };
      },
      reasons: ['metadata_source_unconfigured', 'bootstrap_not_registered'],
    },
    {
      // `manager.inspect()` reads the registration too, so a corrupt file is
      // an unreadable installation state (`install_state_corrupt`), reached
      // before the manifest branch of the gate.
      name: 'skeleton whose registration file is corrupt',
      build: () => {
        const home = makeTempHome();
        const paths = resolvePdHomePaths(path.join(home, '.pd'));
        ensurePdHomeLayout(paths);
        fs.writeFileSync(paths.bootstrapManifestPath, '{ not json');
        return { pdHome: paths.home, metadataBaseUrl: undefined, openclawHome: path.join(home, 'no-openclaw') };
      },
      reasons: ['metadata_source_unconfigured', 'install_state_corrupt'],
    },
    {
      name: 'corrupt active record',
      build: () => {
        const home = makeTempHome();
        const paths = resolvePdHomePaths(path.join(home, '.pd'));
        ensurePdHomeLayout(paths);
        fs.writeFileSync(paths.activeRecordPath, JSON.stringify({ generation: 'three' }));
        return { pdHome: paths.home, metadataBaseUrl: 'http://127.0.0.1:1' };
      },
      reasons: ['install_state_corrupt'],
    },
    {
      name: 'registered fixture without a metadata source',
      build: async () => {
        const fixture = await createShadowFixture();
        return { pdHome: fixture.pdHome, metadataBaseUrl: undefined };
      },
      reasons: ['metadata_source_unconfigured'],
    },
    {
      name: 'registered fixture with a metadata source — ready',
      build: async () => {
        const fixture = await createShadowFixture();
        return { pdHome: fixture.pdHome, metadataBaseUrl: fixture.repository.baseUrl };
      },
      reasons: [],
    },
    {
      name: 'executor tree edited after registration',
      build: async () => {
        const fixture = await createShadowFixture();
        fs.appendFileSync(path.join(resolvePdHomePaths(fixture.pdHome).bootstrapExecutorDir, 'bootstrap-entry.js'), '// tampered\n');
        return { pdHome: fixture.pdHome, metadataBaseUrl: fixture.repository.baseUrl };
      },
      reasons: ['bootstrap_identity_mismatch'],
    },
    {
      name: 'registered executor tree removed',
      build: async () => {
        const fixture = await createShadowFixture();
        fs.rmSync(resolvePdHomePaths(fixture.pdHome).bootstrapExecutorDir, { recursive: true, force: true });
        return { pdHome: fixture.pdHome, metadataBaseUrl: fixture.repository.baseUrl };
      },
      reasons: ['bootstrap_identity_mismatch'],
    },
  ];

  for (const testCase of cases) {
    it(`same verdict for: ${testCase.name}`, async () => {
      const options = await testCase.build();
      const viaSync = createReleaseManagerAuthority(options);
      const viaAsync = await createReleaseManagerAuthorityAsync(options);

      expect(viaAsync.kinds.check).toEqual({ ready: testCase.reasons.length === 0, reasons: testCase.reasons });
      expect(viaAsync.kinds['apply-full']).toEqual(viaAsync.kinds.check);
      expect(verdict(viaAsync)).toEqual(verdict(viaSync));
    });
  }

  it('never creates, writes, renames, or removes anything while assessing', async () => {
    const fixture = await createShadowFixture();
    const root = path.dirname(fixture.pdHome);
    const before = snapshotTree(root);

    const viaAsync = await createReleaseManagerAuthorityAsync({ pdHome: fixture.pdHome, metadataBaseUrl: fixture.repository.baseUrl });

    expect(viaAsync.kinds.check.ready).toBe(true);
    expect(snapshotTree(root)).toEqual(before);
  });
});

describe('async readiness gate does not hold the event loop', () => {
  /**
   * The witness is a callback armed BEFORE the call: it may only run while the
   * loop is free, and its value is captured in the same turn the call settles.
   */
  function armLoopWitness(): () => boolean {
    let ran = false;
    setImmediate(() => { ran = true; });
    return () => ran;
  }

  it('lets pending callbacks run while the executor tree is re-hashed, and still verifies it', async () => {
    const fixture = await createShadowFixture();
    const paths = resolvePdHomePaths(fixture.pdHome);
    plantExecutorTree(paths.bootstrapExecutorDir);
    // Registered with the SYNC digest, exactly as the installer registers it.
    fs.writeFileSync(paths.bootstrapManifestPath, `${JSON.stringify({
      bootstrapVersion: '1.0.0',
      installedAt: '2026-08-25T00:00:00Z',
      executorDigest: digestDirectory(paths.bootstrapExecutorDir),
    }, null, 2)}\n`);

    const loopRan = armLoopWitness();
    const authority = await Promise.resolve(createReleaseManagerAuthorityAsync({
      pdHome: fixture.pdHome,
      metadataBaseUrl: fixture.repository.baseUrl,
    })).then((settled) => ({ settled, loopRan: loopRan() }));

    expect(authority.loopRan).toBe(true);
    expect(authority.settled.kinds.check).toEqual({ ready: true, reasons: [] });
  });
});

describe('digestDirectoryAsync IS digestDirectory', () => {
  function plantUnorderedTree(tree: string): void {
    fs.mkdirSync(path.join(tree, 'empty-dir'), { recursive: true });
    fs.mkdirSync(path.join(tree, 'b', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(tree, 'a'), { recursive: true });
    // Written out of order, with names whose code-point order differs from
    // locale order (`Z` vs `a`, `é` vs `z`): both walkers must sort alike.
    for (const [relative, contents] of [
      ['b/nested/Z.js', 'upper'],
      ['b/nested/a.js', 'lower'],
      ['a/é.js', 'accent'],
      ['a/z.js', 'plain'],
      ['root.js', 'root'],
    ] as const) {
      fs.writeFileSync(path.join(tree, relative), contents);
    }
  }

  it('same tree, same order, same per-file record', async () => {
    const tree = path.join(makeTempHome(), 'tree');
    plantUnorderedTree(tree);

    const sync = digestDirectory(tree);
    expect(await digestDirectoryAsync(tree)).toBe(sync);

    // Negative control: the digest is over content AND relative path.
    fs.writeFileSync(path.join(tree, 'a', 'z.js'), 'changed');
    const changed = await digestDirectoryAsync(tree);
    expect(changed).toBe(digestDirectory(tree));
    expect(changed).not.toBe(sync);
  });

  it("refuses a missing executor directory with the sync form's error", async () => {
    const missing = path.join(makeTempHome(), 'absent');
    const thrownBy = (run: () => unknown): unknown => {
      try {
        run();
        return null;
      } catch (error) {
        return error;
      }
    };

    const asyncError = await digestDirectoryAsync(missing).then(() => null, (error: unknown) => error);
    const syncError = thrownBy(() => digestDirectory(missing));

    expect(asyncError).toBeInstanceOf(InstallLayoutError);
    expect(syncError).toBeInstanceOf(InstallLayoutError);
    if (asyncError instanceof InstallLayoutError && syncError instanceof InstallLayoutError) {
      expect(asyncError.field).toBe(syncError.field);
      expect(asyncError.message).toBe(syncError.message);
    }
  });
});
