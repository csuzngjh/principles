/**
 * G3 §10.5 (SPEC-PD-RELEASE-ARCH-SIMPLIFICATION-001 §10 item 5) — regression
 * suite for the consolidated INSTALLED-component dependency links.
 *
 * Contract under test (production exports called by install() right after the
 * dependency stage):
 *   - ensurePdCliResolution()  → <runtime>/pd-cli/node_modules/* links
 *   - ensureConsoleResolution() → <runtime>/console/node_modules/* links
 *
 * Every case runs against a REAL sandboxed install layout under a temporary
 * HOME. Nothing here touches ~/.pd, ~/.openclaw or the real workspace. The
 * module-resolution case spawns a real Node process, so "the files exist" is
 * never accepted as proof that the layout resolves.
 *
 * 8 required regression dimensions:
 *   1. npm-materialized physical copy → replaced by a link
 *   2. correct link → idempotent (second pass does not recreate it)
 *   3. wrong-target link / dangling link → repaired
 *   4. missing sibling → fail-closed (loud, no silent skip)
 *   5. path traversal (target ref AND dependency name) → rejected
 *   6. Windows junction and POSIX symlink shapes both asserted
 *   7. pd-cli + console real ESM resolution from the installed layout
 *   8. failure path leaves only links INSIDE the deployed component tree, which
 *      is exactly what install()'s existing whole-runtime restore/cleanup
 *      already reclaims (rollback mechanism itself unchanged)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensurePdCliResolution, ensureConsoleResolution, ensureHostRuntimeResolution, ensureReleaseManagerResolution } from '../src/installer.js';

const PD_CLI_DEPS: Record<string, string> = {
  '@principles/core': 'file:../core',
  '@principles/host-runtime': 'file:../host-runtime',
  '@principles/codex-adapter': 'file:../codex-adapter',
  '@principles/workbuddy-adapter': 'file:../workbuddy-adapter',
  '@principles/install-layout': 'file:../install-layout',
  'principles-disciple': 'file:../plugin',
};

const CONSOLE_DEPS: Record<string, string> = {
  '@principles/core': 'file:../core',
  '@principles/host-runtime': 'file:../host-runtime',
  '@principles/install-layout': 'file:../install-layout',
  'principles-disciple': 'file:../plugin',
  'create-principles-disciple': 'file:../release-manager',
};

/** A sibling runtime component: a resolvable CJS package with a marker. */
function writeSibling(runtimeDir: string, dirName: string, packageName: string): void {
  const dir = path.join(runtimeDir, dirName);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', main: 'dist/index.js' }),
  );
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), `module.exports = { marker: ${JSON.stringify(packageName)} };\n`);
}

/**
 * An npm-materialized copy: a real directory with a STALE marker, exactly
 * what `npm ci --install-links` leaves behind. It resolves, so the old
 * existsSync() short-circuit silently kept it.
 */
function materializeCopy(componentDir: string, dependencyName: string): void {
  const copyDir = path.join(componentDir, 'node_modules', dependencyName);
  fs.mkdirSync(path.join(copyDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(copyDir, 'package.json'), JSON.stringify({ name: dependencyName, version: '0.0.1-stale', main: 'dist/index.js' }));
  fs.writeFileSync(path.join(copyDir, 'dist', 'index.js'), `module.exports = { marker: 'stale-copy' };\n`);
}

function writeComponent(
  runtimeDir: string,
  dirName: string,
  packageName: string,
  dependencies: Record<string, string>,
  probeImports: string[],
): string {
  const dir = path.join(runtimeDir, dirName);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', type: 'module', dependencies }),
  );
  const lines = probeImports.map((dep, index) => `import dep${index} from ${JSON.stringify(dep)};`).join('\n');
  const markers = probeImports.map((_, index) => 'dep' + index + '.marker').join(', ');
  fs.writeFileSync(path.join(dir, 'dist', 'probe.js'), `${lines}\nconsole.log(JSON.stringify([${markers}]));\n`);
  return dir;
}

function lstat(pathname: string): fs.Stats {
  return fs.lstatSync(pathname);
}

function realpath(pathname: string): string {
  return fs.realpathSync(pathname);
}

describe('G3 §10.5 consolidated installed-component dependency links', () => {
  let savedEnv: Record<string, string | undefined>;
  let sandboxRoot: string;
  let runtimeDir: string;

  beforeEach(() => {
    savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    sandboxRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g3-105-links-')));
    process.env.HOME = sandboxRoot;
    process.env.USERPROFILE = sandboxRoot;
    runtimeDir = path.join(sandboxRoot, '.pd', 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });

    writeSibling(runtimeDir, 'core', '@principles/core');
    writeSibling(runtimeDir, 'host-runtime', '@principles/host-runtime');
    writeSibling(runtimeDir, 'codex-adapter', '@principles/codex-adapter');
    writeSibling(runtimeDir, 'workbuddy-adapter', '@principles/workbuddy-adapter');
    writeSibling(runtimeDir, 'install-layout', '@principles/install-layout');
    writeSibling(runtimeDir, 'plugin', 'principles-disciple');
    writeSibling(runtimeDir, 'release-manager', 'create-principles-disciple');

    writeComponent(runtimeDir, 'pd-cli', '@principles/pd-cli', PD_CLI_DEPS, Object.keys(PD_CLI_DEPS));
    writeComponent(runtimeDir, 'console', '@principles/pd-console', CONSOLE_DEPS, Object.keys(CONSOLE_DEPS));
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (sandboxRoot) fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 10 });
  });

  const pdCliDir = () => path.join(runtimeDir, 'pd-cli');
  const consoleDir = () => path.join(runtimeDir, 'console');
  const linkOf = (componentDir: string, dependencyName: string) =>
    path.join(componentDir, 'node_modules', dependencyName);

  it('1. replaces npm-materialized physical copies with runtime sibling links', () => {
    for (const dependencyName of Object.keys(PD_CLI_DEPS)) materializeCopy(pdCliDir(), dependencyName);
    for (const dependencyName of Object.keys(CONSOLE_DEPS)) materializeCopy(consoleDir(), dependencyName);

    ensurePdCliResolution();
    ensureConsoleResolution();

    for (const [dependencyName, ref] of Object.entries(PD_CLI_DEPS)) {
      const link = linkOf(pdCliDir(), dependencyName);
      const stat = lstat(link);
      expect(stat.isSymbolicLink(), `${dependencyName} must be a link, not a materialized copy`).toBe(true);
      const siblingName = ref.slice('file:../'.length);
      expect(realpath(link)).toBe(realpath(path.join(runtimeDir, siblingName)));
    }
    for (const [dependencyName, ref] of Object.entries(CONSOLE_DEPS)) {
      const link = linkOf(consoleDir(), dependencyName);
      expect(lstat(link).isSymbolicLink(), `${dependencyName} must be a link, not a materialized copy`).toBe(true);
      expect(realpath(link)).toBe(realpath(path.join(runtimeDir, ref.slice('file:../'.length))));
    }
    // The stale physical content is gone, not shadowed.
    expect(fs.readFileSync(path.join(linkOf(pdCliDir(), '@principles/core'), 'dist', 'index.js'), 'utf8'))
      .toContain('@principles/core');
  });

  it('2. a correct link is idempotent (second pass does not recreate it)', () => {
    ensurePdCliResolution();
    ensureConsoleResolution();
    const link = linkOf(pdCliDir(), '@principles/core');
    const before = lstat(link);
    const beforeIdentity = { ino: before.ino, birthtimeMs: before.birthtimeMs, mtimeMs: before.mtimeMs, target: realpath(link) };

    ensurePdCliResolution();
    ensureConsoleResolution();

    const after = lstat(link);
    expect(after.isSymbolicLink()).toBe(true);
    expect({ ino: after.ino, birthtimeMs: after.birthtimeMs, mtimeMs: after.mtimeMs, target: realpath(link) })
      .toEqual(beforeIdentity);
  });

  it('3a. a link aimed at the wrong sibling is repaired', () => {
    const link = linkOf(pdCliDir(), '@principles/core');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    createDirLink(path.join(runtimeDir, 'host-runtime'), link);
    expect(realpath(link)).toBe(realpath(path.join(runtimeDir, 'host-runtime')));

    ensurePdCliResolution();

    expect(realpath(link)).toBe(realpath(path.join(runtimeDir, 'core')));
  });

  it('3b. a dangling link (target removed) is repaired', () => {
    const link = linkOf(pdCliDir(), '@principles/core');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    const vanished = path.join(runtimeDir, '.vanished-target');
    fs.mkdirSync(vanished, { recursive: true });
    createDirLink(vanished, link);
    fs.rmSync(vanished, { recursive: true, force: true });
    expect(fs.existsSync(link), 'precondition: the link is dangling').toBe(false);
    expect(lstat(link).isSymbolicLink()).toBe(true);

    ensurePdCliResolution();

    expect(realpath(link)).toBe(realpath(path.join(runtimeDir, 'core')));
  });

  it('4. a missing sibling fails closed (no silent skip, no link for the missing dep)', () => {
    const missing = path.join(runtimeDir, 'host-runtime');
    fs.rmSync(missing, { recursive: true, force: true });

    expect(() => ensurePdCliResolution()).toThrow(/missing/i);
    expect(fs.existsSync(linkOf(pdCliDir(), '@principles/host-runtime')), 'no link may point at the missing sibling').toBe(false);
  });

  it('5a. a sibling target ref that escapes the runtime root is rejected', () => {
    writeComponent(runtimeDir, 'pd-cli', '@principles/pd-cli', { '@principles/core': 'file:../../outside' }, ['@principles/core']);

    expect(() => ensurePdCliResolution()).toThrow(/unsupported file dependency ref/i);
    expect(fs.existsSync(linkOf(pdCliDir(), '@principles/core'))).toBe(false);
  });

  it('5b. a dependency NAME that escapes node_modules is rejected', () => {
    writeComponent(runtimeDir, 'pd-cli', '@principles/pd-cli', { '../../evil': 'file:../core' }, ['../../evil']);

    expect(() => ensurePdCliResolution()).toThrow(/unsupported dependency name/i);
    expect(fs.existsSync(path.join(runtimeDir, 'evil'))).toBe(false);
    expect(fs.existsSync(path.join(pdCliDir(), 'node_modules', '..', '..', 'evil'))).toBe(false);
  });

  it('6. Windows uses an absolute junction target; POSIX uses a relative dir symlink', () => {
    ensurePdCliResolution();
    const link = linkOf(pdCliDir(), '@principles/core');
    const rawTarget = fs.readlinkSync(link);
    if (process.platform === 'win32') {
      expect(path.isAbsolute(rawTarget), `junction target must be absolute, got ${rawTarget}`).toBe(true);
      expect(realpath(rawTarget)).toBe(realpath(path.join(runtimeDir, 'core')));
    } else {
      expect(path.isAbsolute(rawTarget), `symlink target must stay relative, got ${rawTarget}`).toBe(false);
      expect(path.resolve(path.dirname(link), rawTarget)).toBe(realpath(path.join(runtimeDir, 'core')));
    }
  });

  it('7. pd-cli and console resolve their declared packages from the installed layout', () => {
    ensurePdCliResolution();
    ensureConsoleResolution();

    const pdCliProbe = runProbe(pdCliDir());
    expect(pdCliProbe.status, pdCliProbe.stderr).toBe(0);
    expect(JSON.parse(pdCliProbe.stdout)).toEqual(Object.keys(PD_CLI_DEPS));

    const consoleProbe = runProbe(consoleDir());
    expect(consoleProbe.status, consoleProbe.stderr).toBe(0);
    expect(JSON.parse(consoleProbe.stdout)).toEqual(Object.keys(CONSOLE_DEPS));
  });

  it('8. a failed link pass mutates ONLY the deployed component tree (rollback premise)', () => {
    writeComponent(runtimeDir, 'pd-cli', '@principles/pd-cli', PD_CLI_DEPS, Object.keys(PD_CLI_DEPS));
    fs.rmSync(path.join(runtimeDir, 'install-layout'), { recursive: true, force: true });
    const outsideBefore = snapshotTopLevel(runtimeDir);

    expect(() => ensurePdCliResolution()).toThrow(/missing/i);

    // Nothing outside <runtime>/pd-cli was created or changed: the whole
    // mutation surface is the tree install() already restores/cleans on
    // failure (restoreBackup / cleanUnactivatedFreshInstall), so the existing
    // rollback path reclaims any partially-created link.
    expect(snapshotTopLevel(runtimeDir)).toEqual(outsideBefore);
    for (const dependencyName of Object.keys(PD_CLI_DEPS)) {
      const link = linkOf(pdCliDir(), dependencyName);
      if (fs.existsSync(link)) {
        expect(realpath(link)).toBe(realpath(path.join(runtimeDir, PD_CLI_DEPS[dependencyName]!.slice('file:../'.length))));
      }
    }
  });
});

/**
 * PRI-1145: the installed host-runtime declares the same `file:../<component>`
 * siblings as every other runtime component, but it was the only one with no
 * `ensure*Resolution()` caller — so the npm-materialized `node_modules/
 * @principles/core` physical copy survived in the install, leaving a second core
 * byte outside the canonical-runtime invariant. Same contract as its siblings:
 * physical copy → canonical link, wrong target → repaired, missing sibling →
 * fail closed.
 */
describe('PRI-1145 installed host-runtime dependency links', () => {
  const HOST_RUNTIME_DEPS: Record<string, string> = {
    '@principles/core': 'file:../core',
    '@principles/install-layout': 'file:../install-layout',
  };

  let savedEnv: Record<string, string | undefined>;
  let sandboxRoot: string;
  let runtimeDir: string;

  beforeEach(() => {
    savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    sandboxRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri-1145-host-runtime-')));
    process.env.HOME = sandboxRoot;
    process.env.USERPROFILE = sandboxRoot;
    runtimeDir = path.join(sandboxRoot, '.pd', 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });

    writeSibling(runtimeDir, 'core', '@principles/core');
    writeSibling(runtimeDir, 'install-layout', '@principles/install-layout');
    writeComponent(runtimeDir, 'host-runtime', '@principles/host-runtime', HOST_RUNTIME_DEPS, Object.keys(HOST_RUNTIME_DEPS));
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (sandboxRoot) fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 10 });
  });

  const hostRuntimeDir = () => path.join(runtimeDir, 'host-runtime');
  const linkOf = (dependencyName: string) => path.join(hostRuntimeDir(), 'node_modules', dependencyName);

  it('1. replaces npm-materialized physical copies with canonical runtime sibling links', () => {
    for (const dependencyName of Object.keys(HOST_RUNTIME_DEPS)) materializeCopy(hostRuntimeDir(), dependencyName);
    expect(lstat(linkOf('@principles/core')).isSymbolicLink()).toBe(false);

    ensureHostRuntimeResolution();

    for (const [dependencyName, ref] of Object.entries(HOST_RUNTIME_DEPS)) {
      const link = linkOf(dependencyName);
      expect(lstat(link).isSymbolicLink(), `${dependencyName} must be a link, not a physical copy`).toBe(true);
      expect(realpath(link)).toBe(realpath(path.join(runtimeDir, ref.slice('file:../'.length))));
    }
    // The stale copy content is gone, not shadowed behind the link.
    expect(fs.readFileSync(path.join(linkOf('@principles/core'), 'dist', 'index.js'), 'utf8')).toContain('@principles/core');
  });

  it('2. a correct link is idempotent and a wrong-target link is repaired', () => {
    ensureHostRuntimeResolution();
    const link = linkOf('@principles/core');
    const before = lstat(link);
    const identity = { ino: before.ino, birthtimeMs: before.birthtimeMs, mtimeMs: before.mtimeMs, target: realpath(link) };
    ensureHostRuntimeResolution();
    const after = lstat(link);
    expect({ ino: after.ino, birthtimeMs: after.birthtimeMs, mtimeMs: after.mtimeMs, target: realpath(link) }).toEqual(identity);

    fs.rmSync(link, { recursive: true, force: true });
    createDirLink(path.join(runtimeDir, 'install-layout'), link);
    expect(realpath(link)).toBe(realpath(path.join(runtimeDir, 'install-layout')));

    ensureHostRuntimeResolution();

    expect(realpath(linkOf('@principles/core'))).toBe(realpath(path.join(runtimeDir, 'core')));
  });

  it('3. a missing sibling fails closed instead of leaving a physical copy', () => {
    materializeCopy(hostRuntimeDir(), '@principles/core');
    fs.rmSync(path.join(runtimeDir, 'install-layout'), { recursive: true, force: true });

    expect(() => ensureHostRuntimeResolution()).toThrow(/missing/i);
    expect(fs.existsSync(linkOf('@principles/install-layout')), 'no link may point at the missing sibling').toBe(false);
    // Plan-then-mutate: the valid core operation must not be half-applied.
    expect(lstat(linkOf('@principles/core')).isSymbolicLink()).toBe(false);
  });

  it('4. the deployed host-runtime resolves both declared siblings through real ESM', () => {
    for (const dependencyName of Object.keys(HOST_RUNTIME_DEPS)) materializeCopy(hostRuntimeDir(), dependencyName);

    ensureHostRuntimeResolution();

    const probe = runProbe(hostRuntimeDir());
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual(Object.keys(HOST_RUNTIME_DEPS));
  });
});

/**
 * PRI-1201: the installed release-manager component declares the same
 * `file:../<component>` sibling contract as every other runtime component
 * (@principles/install-layout), but it had no `ensure*Resolution()` caller —
 * the second instance of the PRI-1145 defect. Same contract as its siblings:
 * physical copy → canonical link, wrong target → repaired, missing sibling →
 * fail closed.
 */
describe('PRI-1201 installed release-manager dependency links', () => {
  const RELEASE_MANAGER_DEPS: Record<string, string> = {
    '@principles/install-layout': 'file:../install-layout',
  };

  let savedEnv: Record<string, string | undefined>;
  let sandboxRoot: string;
  let runtimeDir: string;

  beforeEach(() => {
    savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    sandboxRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri-1201-release-manager-')));
    process.env.HOME = sandboxRoot;
    process.env.USERPROFILE = sandboxRoot;
    runtimeDir = path.join(sandboxRoot, '.pd', 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });

    writeSibling(runtimeDir, 'install-layout', '@principles/install-layout');
    writeComponent(runtimeDir, 'release-manager', 'create-principles-disciple', RELEASE_MANAGER_DEPS, Object.keys(RELEASE_MANAGER_DEPS));
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (sandboxRoot) fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 10 });
  });

  const releaseManagerDir = () => path.join(runtimeDir, 'release-manager');
  const linkOf = (dependencyName: string) => path.join(releaseManagerDir(), 'node_modules', dependencyName);

  it('1. replaces the npm-materialized physical copy with the canonical install-layout link', () => {
    materializeCopy(releaseManagerDir(), '@principles/install-layout');
    expect(lstat(linkOf('@principles/install-layout')).isSymbolicLink()).toBe(false);

    ensureReleaseManagerResolution();

    const link = linkOf('@principles/install-layout');
    expect(lstat(link).isSymbolicLink(), 'install-layout must be a link, not a physical copy').toBe(true);
    expect(realpath(link)).toBe(realpath(path.join(runtimeDir, 'install-layout')));
    // The stale copy content is gone, not shadowed behind the link.
    expect(fs.readFileSync(path.join(link, 'dist', 'index.js'), 'utf8')).toContain('@principles/install-layout');
  });

  it('2. a correct link is idempotent and a wrong-target link is repaired', () => {
    ensureReleaseManagerResolution();
    const link = linkOf('@principles/install-layout');
    const before = lstat(link);
    const identity = { ino: before.ino, birthtimeMs: before.birthtimeMs, mtimeMs: before.mtimeMs, target: realpath(link) };
    ensureReleaseManagerResolution();
    const after = lstat(link);
    expect({ ino: after.ino, birthtimeMs: after.birthtimeMs, mtimeMs: after.mtimeMs, target: realpath(link) }).toEqual(identity);

    fs.rmSync(link, { recursive: true, force: true });
    // Wrong target: an existing directory that is NOT the declared sibling.
    createDirLink(releaseManagerDir(), link);
    expect(realpath(link)).toBe(realpath(releaseManagerDir()));

    ensureReleaseManagerResolution();

    expect(realpath(linkOf('@principles/install-layout'))).toBe(realpath(path.join(runtimeDir, 'install-layout')));
  });

  it('3. a missing install-layout sibling fails closed instead of leaving a physical copy', () => {
    materializeCopy(releaseManagerDir(), '@principles/install-layout');
    fs.rmSync(path.join(runtimeDir, 'install-layout'), { recursive: true, force: true });

    expect(() => ensureReleaseManagerResolution()).toThrow(/missing/i);
    // Plan-then-mutate: the physical copy must not be half-replaced.
    expect(lstat(linkOf('@principles/install-layout')).isSymbolicLink()).toBe(false);
  });

  it('4. the deployed release-manager resolves install-layout through real ESM', () => {
    materializeCopy(releaseManagerDir(), '@principles/install-layout');

    ensureReleaseManagerResolution();

    const probe = runProbe(releaseManagerDir());
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual(Object.keys(RELEASE_MANAGER_DEPS));
  });
});

/**
 * P1 (PR #2319 review): a dependency NAME becomes a path segment under
 * node_modules, so "." / ".." / empty segments / separators must never reach
 * path.join() — normalization would turn them into node_modules, the scope
 * parent or the component root, and the physical-copy repair pass would
 * recursively delete that directory. Every case below seeds sentinel files in
 * exactly those directories and in an external tree, so the assertion is
 * "nothing was deleted", not a string match.
 */
describe('P1 dependency-name boundary (real filesystem, no string assertions)', () => {
  let savedEnv: Record<string, string | undefined>;
  let sandboxRoot: string;
  let runtimeDir: string;

  const SENTINEL = 'sentinel-content-must-survive';
  const MALICIOUS_NAMES: Array<[label: string, name: string]> = [
    ['dot', '.'],
    ['dot-dot', '..'],
    ['scoped-dot', '@scope/.'],
    ['scoped-dot-dot', '@scope/..'],
    ['parent-escape', '../outside'],
    ['scoped-parent-escape', '@scope/../../outside'],
    ['empty-segment', '@scope//package'],
    ['backslash', '..\\outside'],
  ];

  beforeEach(() => {
    savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    sandboxRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g3-105-p1-')));
    process.env.HOME = sandboxRoot;
    process.env.USERPROFILE = sandboxRoot;
    runtimeDir = path.join(sandboxRoot, '.pd', 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    writeSibling(runtimeDir, 'core', '@principles/core');
    writeSibling(runtimeDir, 'host-runtime', '@principles/host-runtime');
    fs.mkdirSync(path.join(sandboxRoot, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(sandboxRoot, 'outside', '.outside-sentinel'), SENTINEL);
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (sandboxRoot) fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 10 });
  });

  const componentDir = () => path.join(runtimeDir, 'pd-cli');
  const sentinelFiles = (): string[] => [
    path.join(componentDir(), '.component-sentinel'),
    path.join(componentDir(), 'node_modules', '.modules-sentinel'),
    path.join(componentDir(), 'node_modules', '@principles', '.scope-sentinel'),
    path.join(componentDir(), 'node_modules', '@scope', '.scope-sentinel'),
  ];

  function seedSentinels(): void {
    fs.mkdirSync(path.join(componentDir(), 'node_modules', '@principles'), { recursive: true });
    fs.mkdirSync(path.join(componentDir(), 'node_modules', '@scope'), { recursive: true });
    for (const file of sentinelFiles()) fs.writeFileSync(file, SENTINEL);
  }

  function expectNothingDestroyed(): void {
    expect(fs.lstatSync(componentDir()).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(componentDir(), 'node_modules')).isDirectory()).toBe(true);
    for (const file of sentinelFiles()) {
      expect(fs.existsSync(file), `${file} must still exist`).toBe(true);
      expect(fs.readFileSync(file, 'utf8'), `${file} must be unchanged`).toBe(SENTINEL);
    }
    const outside = path.join(sandboxRoot, 'outside');
    expect(fs.readdirSync(outside)).toEqual(['.outside-sentinel']);
    expect(fs.readFileSync(path.join(outside, '.outside-sentinel'), 'utf8')).toBe(SENTINEL);
  }

  it.each(MALICIOUS_NAMES)('rejects the %s dependency name "%s" and destroys nothing', (_label, name) => {
    seedSentinels();
    writeComponent(runtimeDir, 'pd-cli', '@principles/pd-cli', { [name]: 'file:../core' }, ['@principles/core']);

    expect(() => ensurePdCliResolution()).toThrow(/unsupported dependency name/i);
    expectNothingDestroyed();
  });

  it('an invalid later entry aborts before ANY earlier valid link is materialized', () => {
    seedSentinels();
    writeComponent(
      runtimeDir,
      'pd-cli',
      '@principles/pd-cli',
      { '@principles/core': 'file:../core', '..': 'file:../host-runtime' },
      ['@principles/core', '@principles/host-runtime'],
    );

    expect(() => ensurePdCliResolution()).toThrow(/unsupported dependency name/i);
    expect(fs.existsSync(path.join(componentDir(), 'node_modules', '@principles', 'core')), 'no valid link may be created').toBe(false);
    expect(fs.existsSync(path.join(componentDir(), 'node_modules', '@principles', 'host-runtime'))).toBe(false);
    expectNothingDestroyed();
  });

  it('refuses a symlinked node_modules parent (a delete could escape the component)', () => {
    writeComponent(runtimeDir, 'pd-cli', '@principles/pd-cli', { '@principles/core': 'file:../core' }, ['@principles/core']);
    const externalNodeModules = path.join(sandboxRoot, 'outside', 'node_modules');
    fs.mkdirSync(externalNodeModules, { recursive: true });
    fs.writeFileSync(path.join(externalNodeModules, '.outside-sentinel'), SENTINEL);
    fs.writeFileSync(path.join(componentDir(), '.component-sentinel'), SENTINEL);
    createDirLink(externalNodeModules, path.join(componentDir(), 'node_modules'));

    expect(() => ensurePdCliResolution()).toThrow(/must not be a symbolic link/i);
    expect(fs.existsSync(path.join(externalNodeModules, '.outside-sentinel'))).toBe(true);
    expect(fs.readFileSync(path.join(externalNodeModules, '.outside-sentinel'), 'utf8')).toBe(SENTINEL);
    expect(fs.existsSync(path.join(componentDir(), '.component-sentinel'))).toBe(true);
  });

  it('refuses a symlinked scoped parent (the scope directory is not replaced or deleted through)', () => {
    writeComponent(runtimeDir, 'pd-cli', '@principles/pd-cli', { '@principles/core': 'file:../core' }, ['@principles/core']);
    fs.mkdirSync(path.join(componentDir(), 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(componentDir(), 'node_modules', '.modules-sentinel'), SENTINEL);
    const externalScope = path.join(sandboxRoot, 'outside', 'scope', '@principles');
    fs.mkdirSync(path.join(externalScope, 'core'), { recursive: true });
    fs.writeFileSync(path.join(externalScope, '.outside-sentinel'), SENTINEL);
    fs.writeFileSync(path.join(externalScope, 'core', '.core-sentinel'), SENTINEL);
    createDirLink(externalScope, path.join(componentDir(), 'node_modules', '@principles'));

    expect(() => ensurePdCliResolution()).toThrow(/must not be a symbolic link/i);
    expect(fs.existsSync(path.join(externalScope, '.outside-sentinel'))).toBe(true);
    expect(fs.readFileSync(path.join(externalScope, 'core', '.core-sentinel'), 'utf8')).toBe(SENTINEL);
    expect(fs.existsSync(path.join(componentDir(), 'node_modules', '.modules-sentinel'))).toBe(true);
  });

  it('refuses a sibling that resolves outside the runtime dir', () => {
    writeComponent(runtimeDir, 'pd-cli', '@principles/pd-cli', { '@principles/core': 'file:../core' }, ['@principles/core']);
    const outsideCore = path.join(sandboxRoot, 'outside', 'core');
    fs.mkdirSync(outsideCore, { recursive: true });
    fs.writeFileSync(path.join(outsideCore, '.outside-sentinel'), SENTINEL);
    fs.rmSync(path.join(runtimeDir, 'core'), { recursive: true, force: true });
    createDirLink(outsideCore, path.join(runtimeDir, 'core'));

    expect(() => ensurePdCliResolution()).toThrow(/resolves outside the runtime dir/i);
    expect(fs.existsSync(path.join(outsideCore, '.outside-sentinel'))).toBe(true);
    expect(fs.readFileSync(path.join(outsideCore, '.outside-sentinel'), 'utf8')).toBe(SENTINEL);
  });
});
function createDirLink(target: string, linkPath: string): void {
  if (process.platform === 'win32') fs.symlinkSync(target, linkPath, 'junction');
  else fs.symlinkSync(target, linkPath, 'dir');
}

function runProbe(componentDir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [path.join(componentDir, 'dist', 'probe.js')], {
    cwd: componentDir,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Top-level runtime entries + their link-ness; detects aggregates outside the component dir. */
function snapshotTopLevel(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    entries[entry.name] = entry.isSymbolicLink() ? `link:${realpath(full)}` : `dir:${entry.isDirectory()}`;
  }
  return entries;
}
