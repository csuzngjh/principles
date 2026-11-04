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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeRestoredStateGaps, installPluginToStaging, preparePluginInstallTarget } from '../src/installer.js';

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

  it('reports no gaps for a healthy tree (negative control)', async () => {
    const pluginDir = path.join(fixtureRoot, 'payload');
    writeShippedPayload(pluginDir);
    await installPluginToStaging(pluginDir, 'en');
    expect(describeRestoredStateGaps()).toEqual([]);
  });
});
