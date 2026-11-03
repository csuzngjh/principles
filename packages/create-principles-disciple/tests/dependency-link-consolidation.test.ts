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
import { ensurePdCliResolution, ensureConsoleResolution } from '../src/installer.js';

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

/** Directory link with the platform-appropriate primitive. */
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
