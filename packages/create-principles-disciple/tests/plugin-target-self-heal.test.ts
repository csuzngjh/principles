/**
 * PRI-1102 — the plugin install target must self-heal from dirty state instead
 * of aborting with ENOENT.
 *
 * Observed in an isolated install: an interrupted run left
 * `~/.openclaw/extensions/principles-disciple` as a junction whose target was
 * gone. `existsSync` follows the link and reports "missing" (so the backup step
 * skips it), and `fse.ensureDir` then treats the reparse point as an existing
 * directory — the follow-up mkdir raised ENOENT and killed the whole install.
 *
 * These cases use the real filesystem on purpose: the defect is a filesystem
 * (reparse point) behavior, not a branch inside a helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realpathSync } from 'fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeRestoredStateGaps, installPluginToStaging, preparePluginInstallTarget } from '../src/installer.js';

// PRI-1102 fail-closed contract: an UNREADABLE link must never be unlinked.
// The real implementation stays the default; a test can force an errno.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    realpathSync: vi.fn((value: fs.PathLike) => actual.realpathSync(value)),
  };
});

let fixtureRoot: string;

function writeShippedPayload(pluginDir: string): void {
  const built = path.join(pluginDir, 'plugin');
  fs.mkdirSync(path.join(built, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(built, 'dist', 'bundle.js'), 'export const ok = true;\n');
  fs.writeFileSync(
    path.join(built, 'package.json'),
    JSON.stringify({ name: 'principles-disciple', version: '9.9.9-test' }),
  );
}

function installTargets(): string[] {
  return [
    path.join(fixtureRoot, '.pd', 'runtime', 'plugin'),
    path.join(fixtureRoot, '.openclaw', 'extensions', 'principles-disciple'),
  ];
}

function extTarget(): string {
  return path.join(fixtureRoot, '.openclaw', 'extensions', 'principles-disciple');
}

function runtimeTarget(): string {
  return path.join(fixtureRoot, '.pd', 'runtime', 'plugin');
}

/** The runtime tree itself — the path the rollback health check inspects. */
function runtimeTree(): string {
  return path.join(fixtureRoot, '.pd', 'runtime');
}

/**
 * The pre-run state a healthy install leaves behind: every component entry the
 * rollback health check demands (Console server + web index, PD CLI entry,
 * runtime plugin bundle/manifest, OpenClaw extension entries).
 */
function writeHealthyInstallTree(): void {
  const consoleDir = path.join(runtimeTree(), 'console', 'dist');
  fs.mkdirSync(path.join(consoleDir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(consoleDir, 'server.js'), '// console\n');
  fs.writeFileSync(path.join(consoleDir, 'web', 'index.html'), '<html></html>\n');

  const pdCliDir = path.join(runtimeTree(), 'pd-cli', 'dist');
  fs.mkdirSync(pdCliDir, { recursive: true });
  fs.writeFileSync(path.join(pdCliDir, 'index.js'), '// cli\n');

  const runtimePluginDir = path.join(runtimeTree(), 'plugin');
  fs.mkdirSync(path.join(runtimePluginDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(runtimePluginDir, 'dist', 'bundle.js'), '// plugin\n');
  fs.writeFileSync(path.join(runtimePluginDir, 'openclaw.plugin.json'), '{}');

  const ext = extTarget();
  fs.mkdirSync(path.join(ext, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'dist', 'bundle.js'), '// ext plugin\n');
  fs.writeFileSync(path.join(ext, 'openclaw.plugin.json'), '{}');
  fs.writeFileSync(path.join(ext, 'package.json'), '{}');
}

/**
 * A junction whose target no longer exists — the exact residue an interrupted
 * install leaves behind. The target has to exist while the link is created,
 * so it is removed afterwards.
 */
function createDanglingJunction(linkPath: string): void {
  const ghost = path.join(fixtureRoot, 'ghost-target');
  fs.mkdirSync(ghost, { recursive: true });
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(ghost, linkPath, 'junction');
  fs.rmSync(ghost, { recursive: true, force: true });
  expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  expect(() => fs.realpathSync(linkPath)).toThrow();
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1102-dirty-'));
  vi.stubEnv('HOME', fixtureRoot);
  vi.stubEnv('USERPROFILE', fixtureRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('installPluginToStaging on a dirty install target', () => {
  it('replaces a dangling link with a real directory and installs the payload', async () => {
    const pluginDir = path.join(fixtureRoot, 'payload');
    writeShippedPayload(pluginDir);
    createDanglingJunction(extTarget());

    // The link's target is gone, so a copy into it cannot work — pre-fix this
    // threw ENOENT and aborted the install.
    await installPluginToStaging(pluginDir, 'en');

    const link = extTarget();
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fs.statSync(link).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(link, 'dist', 'bundle.js'))).toBe(true);
    expect(fs.existsSync(path.join(link, 'package.json'))).toBe(true);
    // The other target (absent before) is created too.
    expect(fs.existsSync(path.join(runtimeTarget(), 'dist', 'bundle.js'))).toBe(true);
  });

  it('rebuilds a half-installed target that is missing its files', async () => {
    const pluginDir = path.join(fixtureRoot, 'payload');
    writeShippedPayload(pluginDir);
    const target = extTarget();
    fs.mkdirSync(path.join(target, 'node_modules', 'openai'), { recursive: true });
    fs.writeFileSync(path.join(target, 'node_modules', 'openai', 'index.js'), 'legacy graph');

    await installPluginToStaging(pluginDir, 'en');

    expect(fs.existsSync(path.join(target, 'dist', 'bundle.js'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'package.json'))).toBe(true);
    // The stale npm-era tree is still pruned (PRI-1037 contract).
    expect(fs.existsSync(path.join(target, 'node_modules', 'openai'))).toBe(false);
  });

  it('does not touch a healthy existing directory (negative control)', async () => {
    const pluginDir = path.join(fixtureRoot, 'payload');
    writeShippedPayload(pluginDir);
    const target = extTarget();
    fs.mkdirSync(target, { recursive: true });
    const sentinel = path.join(target, 'operator-note.txt');
    fs.writeFileSync(sentinel, 'do not delete');
    const before = fs.statSync(target);

    await preparePluginInstallTarget(target);
    await installPluginToStaging(pluginDir, 'en');

    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.statSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('do not delete');
    // Same directory identity — it was not removed and recreated.
    expect(fs.statSync(target).ino).toBe(before.ino);
  });

  it('leaves a link that still resolves in place (negative control)', async () => {
    const elsewhere = path.join(fixtureRoot, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    const link = extTarget();
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(elsewhere, link, 'junction');

    await preparePluginInstallTarget(link);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(elsewhere));
    expect(fs.existsSync(elsewhere)).toBe(true);
  });
});

describe('preparePluginInstallTarget fail-closed contract', () => {
  it.each(['EACCES', 'EPERM'])('refuses to unlink a link whose resolution fails with %s', async (code) => {
    const elsewhere = path.join(fixtureRoot, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    const link = extTarget();
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(elsewhere, link, 'junction');

    vi.mocked(realpathSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(`${code}: operation not permitted, realpath '${link}'`), { code });
    });

    await expect(preparePluginInstallTarget(link)).rejects.toThrow(/Cannot resolve plugin install target/);
    // The link AND its target must survive an unreadable resolution.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(elsewhere)).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(elsewhere));
  });

  it.runIf(process.platform === 'win32')('removes a real NTFS junction whose target was deleted', async () => {
    createDanglingJunction(extTarget());
    expect(fs.lstatSync(extTarget()).isSymbolicLink()).toBe(true);

    await preparePluginInstallTarget(extTarget());

    const after = fs.lstatSync(extTarget());
    expect(after.isSymbolicLink()).toBe(false);
    expect(after.isDirectory()).toBe(true);
  });
});

describe('describeRestoredStateGaps', () => {
  it('reports a dangling extension link instead of treating the rollback as healthy', () => {
    createDanglingJunction(extTarget());
    const gaps = describeRestoredStateGaps();
    expect(gaps.some((gap) => gap.includes(extTarget()) && gap.includes('dangling link'))).toBe(true);
  });

  it('reports missing install trees', () => {
    const gaps = describeRestoredStateGaps();
    expect(gaps.some((gap) => gap.includes(extTarget()) && gap.includes('missing'))).toBe(true);
    expect(gaps.some((gap) => gap.includes(runtimeTree()) && gap.includes('missing'))).toBe(true);
  });

  it('reports a missing Console component even when the runtime root exists', () => {
    writeHealthyInstallTree();
    fs.rmSync(path.join(runtimeTree(), 'console'), { recursive: true, force: true });

    const gaps = describeRestoredStateGaps();

    const consoleDir = path.join(runtimeTree(), 'console');
    expect(gaps.some((gap) => gap.includes(consoleDir) && gap.includes('missing'))).toBe(true);
  });

  it('reports a component directory that is not a directory', () => {
    writeHealthyInstallTree();
    const consoleDir = path.join(runtimeTree(), 'console');
    fs.rmSync(consoleDir, { recursive: true, force: true });
    fs.writeFileSync(consoleDir, 'not a directory');

    const gaps = describeRestoredStateGaps();

    expect(gaps.some((gap) => gap.includes(consoleDir) && gap.includes('not a directory'))).toBe(true);
  });

  it('reports a required Console entry that is missing from an existing component', () => {
    writeHealthyInstallTree();
    fs.rmSync(path.join(runtimeTree(), 'console', 'dist', 'web', 'index.html'));

    const gaps = describeRestoredStateGaps();

    expect(gaps.some((gap) => gap.
      includes(path.join(runtimeTree(), 'console', 'dist', 'web', 'index.html'))
      && gap.includes('missing'))).toBe(true);
    // A missing entry is a gap; the sibling entry is still checked and healthy.
    expect(gaps.some((gap) => gap.includes(path.join(runtimeTree(), 'console', 'dist', 'server.js')))).toBe(false);
  });

  it('reports a missing OpenClaw extension entry instead of trusting the directory', () => {
    writeHealthyInstallTree();
    fs.rmSync(path.join(extTarget(), 'dist', 'bundle.js'));

    const gaps = describeRestoredStateGaps();

    expect(gaps.some((gap) => gap.
      includes(path.join(extTarget(), 'dist', 'bundle.js'))
      && gap.includes('missing'))).toBe(true);
  });

  it('reports a required entry that is a directory, not a file', () => {
    writeHealthyInstallTree();
    const cliEntry = path.join(runtimeTree(), 'pd-cli', 'dist', 'index.js');
    fs.rmSync(cliEntry, { force: true });
    fs.mkdirSync(cliEntry, { recursive: true });

    const gaps = describeRestoredStateGaps();

    expect(gaps.some((gap) => gap.includes(cliEntry) && gap.includes('not a file'))).toBe(true);
  });

  it('reports no gaps for a healthy tree (negative control)', async () => {
    const pluginDir = path.join(fixtureRoot, 'payload');
    writeShippedPayload(pluginDir);
    writeHealthyInstallTree();
    await installPluginToStaging(pluginDir, 'en');
    expect(describeRestoredStateGaps()).toEqual([]);
  });
});
