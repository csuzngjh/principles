/**
 * PRI-1037 — plugin runtime payload contract.
 *
 * Root cause this pins: the shipped plugin used to declare `@principles/core`
 * as `file:./core`, so registry resolution dragged the 17,711-file core tree
 * and the whole pi-ai transitive graph (openai / anthropic / aws-sdk) into both
 * plugin install dirs. OpenClaw's workspace-plugin capture then copied that
 * ~16k-file payload into every `agent exec` state under a hard 120s
 * publication budget, timing out every exec.
 *
 * The shipped plugin must keep exactly the specifiers its self-contained
 * dist/bundle.js still resolves at runtime (the native better-sqlite3 module),
 * and a reinstall must converge stale npm-era payloads instead of merging with
 * them (fse.copy never deletes extraneous entries).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installPluginToStaging } from '../src/installer.js';

const PACKAGE_ROOT = path.resolve(__dirname, '..');

// The host provides these; they are never materialized into the plugin payload.
const HOST_PROVIDED_SPECIFIERS = ['openclaw', '@openclaw/sdk', '@openclaw/plugin-kit'];

function readEsbuildExternals(): string[] {
  const source = fs.readFileSync(path.join(PACKAGE_ROOT, '..', 'openclaw-plugin', 'esbuild.config.js'), 'utf8');
  const specifiers = new Set<string>();
  for (const block of source.matchAll(/external:\s*\[([^\]]*)\]/g)) {
    for (const entry of (block[1] ?? '').matchAll(/'([^']+)'|"([^"]+)"/g)) {
      const specifier = entry[1] ?? entry[2];
      if (specifier !== undefined) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function readShippedPluginKeepList(): string[] {
  const source = fs.readFileSync(path.join(PACKAGE_ROOT, 'scripts', 'bundle-plugin.mjs'), 'utf8');
  const call = source.match(/pruneShippedPluginDependencies\(join\(PLUGIN_DEST, 'package\.json'\), \[([^\]]*)\]\)/);
  if (!call) throw new Error('bundle-plugin.mjs no longer prunes the shipped plugin manifest — PRI-1037 payload contract broken');
  return [...(call[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

let fixtureRoot: string;

function writeShippedPayload(pluginDir: string): void {
  const built = path.join(pluginDir, 'plugin');
  fs.mkdirSync(path.join(built, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(built, 'dist', 'bundle.js'), 'export const ok = true;\n');
  fs.mkdirSync(path.join(built, 'node_modules', 'better-sqlite3'), { recursive: true });
  fs.writeFileSync(
    path.join(built, 'node_modules', 'better-sqlite3', 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version: '13.0.0' }),
  );
  fs.writeFileSync(
    path.join(built, 'package.json'),
    JSON.stringify({ name: 'principles-disciple', version: '9.9.9-test', dependencies: { 'better-sqlite3': '^13.0.0' } }),
  );
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1037-payload-'));
  vi.stubEnv('HOME', fixtureRoot);
  vi.stubEnv('USERPROFILE', fixtureRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('shipped plugin manifest', () => {
  it('keeps exactly the bundle externals that the host does not provide', () => {
    const required = readEsbuildExternals()
      .filter((specifier) => !HOST_PROVIDED_SPECIFIERS.includes(specifier))
      .sort();
    // Guard the guard: better-sqlite3 IS imported by dist/bundle.js, so an
    // empty expectation would silently let the payload lose its native module.
    expect(required).toEqual(['better-sqlite3']);
    expect(readShippedPluginKeepList().sort()).toEqual(required);
  });
});

describe('installPluginToStaging payload convergence', () => {
  it('prunes a stale npm-era payload in both plugin dirs instead of merging with it', async () => {
    const pluginDir = path.join(fixtureRoot, 'payload');
    writeShippedPayload(pluginDir);
    const targets = [
      path.join(fixtureRoot, '.pd', 'runtime', 'plugin'),
      path.join(fixtureRoot, '.openclaw', 'extensions', 'principles-disciple'),
    ];
    for (const target of targets) {
      const staleCore = path.join(target, 'node_modules', '@principles', 'core');
      fs.mkdirSync(staleCore, { recursive: true });
      fs.writeFileSync(path.join(staleCore, 'package.json'), '{"name":"@principles/core"}');
      fs.mkdirSync(path.join(target, 'node_modules', 'openai'), { recursive: true });
      fs.writeFileSync(path.join(target, 'node_modules', 'openai', 'index.js'), 'legacy pi-ai graph');
      fs.symlinkSync(staleCore, path.join(target, 'core'), 'junction');
    }

    await installPluginToStaging(pluginDir, 'en');

    for (const target of targets) {
      expect(fs.existsSync(path.join(target, 'node_modules', '@principles'))).toBe(false);
      expect(fs.existsSync(path.join(target, 'node_modules', 'openai'))).toBe(false);
      // The file:./core surface is gone: no link, and nothing that resolves to core.
      expect(fs.lstatSync(path.join(target, 'core'), { throwIfNoEntry: false })).toBeUndefined();
      // The lean payload is present.
      expect(fs.existsSync(path.join(target, 'dist', 'bundle.js'))).toBe(true);
      expect(fs.existsSync(path.join(target, 'node_modules', 'better-sqlite3', 'package.json'))).toBe(true);
    }
  });
});
