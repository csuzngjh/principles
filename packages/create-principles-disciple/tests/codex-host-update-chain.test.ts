/**
 * Update chain (2026-11-11) — Codex Marketplace plugin.
 *
 * The gap this file pins down: a PD upgrade refreshed nothing for Codex. The
 * Marketplace installer returned "already installed" whenever the cache
 * existed, so a payload one cohort behind the release stayed behind, and
 * PLUGIN_DATA kept a runtime that trailed the payload's OWN pin. The Owner's
 * requirement is that one upgrade moves every installed host forward without
 * an uninstall/reinstall.
 *
 * Each test states the BEFORE behaviour it replaces in its name/comment, and
 * the fake command runner is the host boundary (no real `codex`, no network).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodexHostInstaller,
  type CodexCommandResult,
  type CodexRuntimeCohort,
} from '../src/installers/codex-host-installer.js';
import { detectInstalledHosts } from '../src/installers/index.js';
import { WORKBUDDY_PLUGIN_KEY } from '../src/installers/workbuddy-host-installer.js';
import type { HostInstallContext } from '@principles/core/host';

const OLD_COHORT = { codexAdapter: '0.8.7', hostRuntime: '3.2.1', core: '7.0.0', mcpServer: '0.3.3' } as const;
const NEW_COHORT = { codexAdapter: '0.8.8', hostRuntime: '3.2.2', core: '7.2.0', mcpServer: '0.3.3' } as const;
const CACHE_MARKETPLACE = 'principles';

const ctx: HostInstallContext = {
  workspaceDir: path.join(os.tmpdir(), 'pd-update-chain-ws'),
  pluginDir: path.join(os.tmpdir(), 'pd-update-chain-plugin'),
  language: 'en',
  mode: 'smart',
};

let home: string;
let codexHome: string;
let canonicalRuntimeDir: string;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writePin(pluginRoot: string, cohort: CodexRuntimeCohort, version: string): void {
  writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), { name: 'principles-disciple', version });
  writeJson(path.join(pluginRoot, 'runtime-version.json'), cohort);
}

function writeCanonical(cohort: CodexRuntimeCohort, dir: string = canonicalRuntimeDir): void {
  const dirs = { codexAdapter: 'codex-adapter', hostRuntime: 'host-runtime', core: 'core', mcpServer: 'pd-mcp-server' } as const;
  for (const key of Object.keys(dirs) as (keyof typeof dirs)[]) {
    writeJson(path.join(dir, dirs[key], 'package.json'), { name: `@principles/${dirs[key]}`, version: cohort[key] });
  }
}

function writeRuntime(runtimeDir: string, cohort: CodexRuntimeCohort): void {
  const packages = {
    codexAdapter: '@principles/codex-adapter',
    hostRuntime: '@principles/host-runtime',
    core: '@principles/core',
    mcpServer: '@principles/pd-mcp-server',
  } as const;
  for (const key of Object.keys(packages) as (keyof typeof packages)[]) {
    writeJson(path.join(runtimeDir, 'node_modules', packages[key], 'package.json'), { name: packages[key], version: cohort[key] });
  }
  // A resolvable pd-hook entry, so the REAL hook wrapper can be spawned
  // against this fixture and its resolution asserted (not just package.json).
  const adapterDir = path.join(runtimeDir, 'node_modules', '@principles', 'codex-adapter');
  writeJson(path.join(adapterDir, 'package.json'), {
    name: '@principles/codex-adapter',
    version: cohort.codexAdapter,
    exports: { './pd-hook': './dist/pd-hook.js' },
  });
  fs.mkdirSync(path.join(adapterDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(adapterDir, 'dist', 'pd-hook.js'),
    `process.stdout.write('PD_HOOK_RUNTIME ${cohort.codexAdapter}\\n');\nprocess.stdout.write('{}\\n');\n`, 'utf8');
}

const pdHookPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'plugins', 'principles-disciple', 'hooks', 'pd-hook.cjs',
);

/** Run the real hook wrapper; it resolves the adapter from PLUGIN_DATA. */
function runRealHook(): string {
  const result = spawnSync(process.execPath, [pdHookPath], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, PLUGIN_DATA: pluginDataRoot() },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function cacheRoot(version: string, homeDir: string = codexHome): string {
  return path.join(homeDir, 'plugins', 'cache', CACHE_MARKETPLACE, 'principles-disciple', version);
}

/**
 * A REAL scripts/pd-setup.cjs stand-in for exercising the production default
 * command runner (no injected fake): materializes the payload pin into
 * --plugin-data/runtime and records the argv it received, so a test can prove
 * the arguments were not split by a command-processor command line.
 */
const PD_SETUP_STANDIN = [
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  "function val(flag) { const i = process.argv.indexOf(flag); return i === -1 ? undefined : process.argv[i + 1]; }",
  "const pluginRoot = val('--plugin-root');",
  "const dataRoot = val('--plugin-data');",
  "const pin = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'runtime-version.json'), 'utf8'));",
  "const names = { codexAdapter: '@principles/codex-adapter', hostRuntime: '@principles/host-runtime', core: '@principles/core', mcpServer: '@principles/pd-mcp-server' };",
  "for (const key of Object.keys(names)) {",
  "  const dir = path.join(dataRoot, 'runtime', 'node_modules', names[key]);",
  "  fs.mkdirSync(dir, { recursive: true });",
  "  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: names[key], version: pin[key] }));",
  "}",
  "fs.mkdirSync(dataRoot, { recursive: true });",
  "fs.writeFileSync(path.join(dataRoot, 'argv-received.json'), JSON.stringify(process.argv.slice(2)));",
].join('\n');

function pluginDataRoot(): string {
  return path.join(codexHome, 'plugins', 'data', `principles-disciple-${CACHE_MARKETPLACE}`);
}

function seedSourcePayload(version: string, cohort: CodexRuntimeCohort): string {
  const sourceRoot = path.join(home, 'marketplace-source', 'plugins', 'principles-disciple');
  writePin(sourceRoot, cohort, version);
  return sourceRoot;
}

/** Fake host boundary: performs the same cache copy `codex plugin add` does. */
function fakeHost(overrides: {
  refreshOk?: boolean;
  refreshDetail?: string;
  setupOk?: boolean;
} = {}): { runCommand: (file: string, args: readonly string[], timeoutMs: number) => CodexCommandResult; calls: string[][] } {
  const calls: string[][] = [];
  const runCommand = (file: string, args: readonly string[]): CodexCommandResult => {
    calls.push([file, ...args]);
    if (file === 'codex') {
      if (overrides.refreshOk === false) return { ok: false, detail: overrides.refreshDetail ?? 'marketplace unreachable' };
      // `codex plugin add <plugin>@<marketplace>` installs the marketplace
      // source's current payload version into the cache (the host's copy).
      const source = path.join(home, 'marketplace-source', 'plugins', 'principles-disciple');
      const manifest = JSON.parse(fs.readFileSync(path.join(source, '.codex-plugin', 'plugin.json'), 'utf8')) as { version: string };
      fs.cpSync(source, cacheRoot(manifest.version), { recursive: true });
      return { ok: true };
    }
    // pd-setup.cjs: materialize the payload pin into --plugin-data/runtime.
    const dataIndex = args.indexOf('--plugin-data');
    const dataDir = dataIndex === -1 ? undefined : args[dataIndex + 1];
    if (dataDir === undefined || overrides.setupOk === false) {
      return { ok: false, detail: 'npm install failed' };
    }
    const version = path.basename(path.dirname(path.dirname(args[0] ?? '')));
    const pin = JSON.parse(fs.readFileSync(path.join(cacheRoot(version), 'runtime-version.json'), 'utf8')) as CodexRuntimeCohort;
    writeRuntime(path.join(dataDir, 'runtime'), pin);
    return { ok: true };
  };
  return { runCommand, calls };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-update-chain-'));
  codexHome = path.join(home, '.codex');
  canonicalRuntimeDir = path.join(home, '.pd', 'runtime');
  // Cached payload one cohort behind the PD release + a runtime that trails
  // its OWN pin — exactly the 2026-11-11 state.
  writePin(cacheRoot('0.3.19'), OLD_COHORT, '0.3.19');
  writeCanonical(NEW_COHORT);
  writeRuntime(path.join(pluginDataRoot(), 'runtime'), OLD_COHORT);
  seedSourcePayload('0.3.20', NEW_COHORT);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('Codex marketplace update chain', () => {
  it('refreshes the stale payload in place and installs the payload pin into PLUGIN_DATA', async () => {
    const host = fakeHost();
    const installer = new CodexHostInstaller({ codexHome, canonicalRuntimeDir, runCommand: host.runCommand });

    const result = await installer.install(ctx);

    expect(result.success).toBe(true);
    expect(result.configAction).toBe('updated');
    // BEFORE: "Codex Marketplace plugin already installed" — nothing changed.
    expect(result.reason).toContain('payload refreshed 0.3.19 → 0.3.20');
    expect(result.reason).toContain('runtime installed at the payload pin');
    expect(fs.existsSync(cacheRoot('0.3.20'))).toBe(true);
    const runtimeCore = JSON.parse(fs.readFileSync(
      path.join(pluginDataRoot(), 'runtime', 'node_modules', '@principles', 'core', 'package.json'), 'utf8',
    )) as { version: string };
    expect(runtimeCore.version).toBe(NEW_COHORT.core);

    // No uninstall/remove anywhere in the host command.
    const codexCall = host.calls.find((call) => call[0] === 'codex');
    expect(codexCall?.slice(1)).toEqual(['plugin', 'add', `principles-disciple@${CACHE_MARKETPLACE}`]);
    const setupCall = host.calls.find((call) => call[0] !== 'codex');
    expect(setupCall).toContain('--skip-init');
    expect(setupCall).toContain('--plugin-data');
  });

  it('makes the REAL pd-hook resolve the runtime the upgrade installed (before: the stale one)', async () => {
    // BEFORE the reconcile the hook resolves the old PLUGIN_DATA runtime. This
    // is asserted through the real wrapper's resolution, not a config string.
    expect(runRealHook()).toContain(`PD_HOOK_RUNTIME ${OLD_COHORT.codexAdapter}`);

    const host = fakeHost();
    const installer = new CodexHostInstaller({ codexHome, canonicalRuntimeDir, runCommand: host.runCommand });
    expect((await installer.install(ctx)).success).toBe(true);

    // AFTER: same hook entry, same PLUGIN_DATA root — now the new adapter.
    const after = runRealHook();
    expect(after).toContain(`PD_HOOK_RUNTIME ${NEW_COHORT.codexAdapter}`);
    expect(after).not.toContain(`PD_HOOK_RUNTIME ${OLD_COHORT.codexAdapter}`);
  });

  it('reports the stale payload explicitly when the in-place refresh cannot run (never a silent "already installed")', async () => {
    const host = fakeHost({ refreshOk: false, refreshDetail: 'codex: marketplace not found' });
    const installer = new CodexHostInstaller({ codexHome, canonicalRuntimeDir, runCommand: host.runCommand });

    const result = await installer.install(ctx);

    expect(result.success).toBe(false);
    expect(result.manualActionRequired).toBe(true);
    expect(result.reason).toContain('is behind the PD release being installed');
    expect(result.reason).toContain('marketplace not found');
    expect(result.nextAction).toContain('codex plugin add principles-disciple@principles');
    expect(result.nextAction).not.toContain('remove');
    // Nothing was mutated by the failed path.
    expect(fs.existsSync(cacheRoot('0.3.20'))).toBe(false);
  });

  it('installs a runtime that trails the payload pin even when the payload itself is current', async () => {
    // Payload already at the release, runtime still one cohort behind its pin.
    writePin(cacheRoot('0.3.19'), NEW_COHORT, '0.3.19');
    const host = fakeHost();
    const installer = new CodexHostInstaller({ codexHome, canonicalRuntimeDir, runCommand: host.runCommand });

    const result = await installer.install(ctx);

    expect(result.success).toBe(true);
    expect(result.configAction).toBe('updated');
    expect(result.reason).toContain('payload 0.3.19 is current');
    expect(result.reason).toContain('runtime installed at the payload pin');
    // No payload refresh was needed, so the host CLI was never called.
    expect(host.calls.some((call) => call[0] === 'codex')).toBe(false);
  });

  it('does not claim freshness when the canonical runtime is unreadable', async () => {
    // Traffic is NOT `preserved` + "already installed": freshness must be
    // stated as unverifiable so the operator is not given false comfort.
    writePin(cacheRoot('0.3.19'), OLD_COHORT, '0.3.19');
    writeRuntime(path.join(pluginDataRoot(), 'runtime'), OLD_COHORT);
    fs.mkdirSync(path.join(home, 'empty-runtime'), { recursive: true });
    const host = fakeHost();
    const installer = new CodexHostInstaller({
      codexHome,
      canonicalRuntimeDir: path.join(home, 'empty-runtime'),
      runCommand: host.runCommand,
    });

    const result = await installer.install(ctx);

    expect(result.success).toBe(true);
    expect(result.reason).toContain('freshness is unverifiable');
    expect(result.reason).not.toContain('already installed');
  });

  it('fails loudly when the Marketplace source itself is behind (refresh succeeds but cannot help)', async () => {
    // The source serves exactly the stale payload the cache already has, so
    // `codex plugin add` "succeeds" without moving anything forward. BEFORE
    // the post-refresh check this returned success + "payload refreshed
    // 0.3.19 → 0.3.19" while the host stayed behind the release.
    seedSourcePayload('0.3.19', OLD_COHORT);
    const host = fakeHost();
    const installer = new CodexHostInstaller({ codexHome, canonicalRuntimeDir, runCommand: host.runCommand });

    const result = await installer.install(ctx);

    expect(result.success).toBe(false);
    expect(result.manualActionRequired).toBe(true);
    expect(result.configAction).toBe('skipped');
    expect(result.reason).toContain('still behind the PD release being installed');
    expect(result.reason).toContain(`core@${OLD_COHORT.core}`);
    expect(result.reason).toContain(`core@${NEW_COHORT.core}`);
    expect(result.reason).toContain('source it serves is itself behind');
    expect(result.nextAction).toContain('git pull');
    expect(result.nextAction).not.toContain('plugin remove');
    // The refused path did not align PLUGIN_DATA: it still holds the old cohort.
    const runtimeCore = JSON.parse(fs.readFileSync(
      path.join(pluginDataRoot(), 'runtime', 'node_modules', '@principles', 'core', 'package.json'), 'utf8',
    )) as { version: string };
    expect(runtimeCore.version).toBe(OLD_COHORT.core);
  });

  it('runs pd-setup with REAL argv that survive spaces in paths (no command processor)', async () => {
    // Payload already current (pin == canonical) so no `codex` call happens;
    // only the runtime alignment runs — through the REAL default command
    // runner (no injected fake). Every path involved contains a space, which a
    // command-processor command line (args joined without quoting) would split
    // apart (2026-11-11 review P2).
    const spacedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd spaced home-'));
    try {
      const spacedCodexHome = path.join(spacedHome, '.co dex');
      const spacedCanonical = path.join(spacedHome, 'canon ical');
      const spacedData = path.join(spacedCodexHome, 'plugins', 'data', `principles-disciple-${CACHE_MARKETPLACE}`);
      const spacedCache = cacheRoot('0.3.19', spacedCodexHome);
      writePin(spacedCache, NEW_COHORT, '0.3.19');
      writeCanonical(NEW_COHORT, spacedCanonical);
      writeRuntime(path.join(spacedData, 'runtime'), OLD_COHORT);
      fs.mkdirSync(path.dirname(path.join(spacedCache, 'scripts', 'pd-setup.cjs')), { recursive: true });
      fs.writeFileSync(path.join(spacedCache, 'scripts', 'pd-setup.cjs'), PD_SETUP_STANDIN, 'utf8');

      const installer = new CodexHostInstaller({ codexHome: spacedCodexHome, canonicalRuntimeDir: spacedCanonical });
      const result = await installer.install(ctx);

      expect(result.success, result.reason).toBe(true);
      expect(result.configAction).toBe('updated');
      // The setup received the exact paths — proof there was no shell split.
      const argv = JSON.parse(fs.readFileSync(path.join(spacedData, 'argv-received.json'), 'utf8')) as string[];
      const dataIdx = argv.indexOf('--plugin-data');
      expect(dataIdx).toBeGreaterThan(-1);
      expect(argv[dataIdx + 1]).toBe(spacedData);
      // And the runtime really moved to the payload pin.
      const runtimeCore = JSON.parse(fs.readFileSync(
        path.join(spacedData, 'runtime', 'node_modules', '@principles', 'core', 'package.json'), 'utf8',
      )) as { version: string };
      expect(runtimeCore.version).toBe(NEW_COHORT.core);
    } finally {
      fs.rmSync(spacedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);
});

describe('installed-host detection (upgrade coverage)', () => {
  it('detects only PD footprints, never a bare host directory', () => {
    // Start from a home with no PD footprint at all.
    fs.rmSync(path.join(codexHome, 'plugins'), { recursive: true, force: true });
    // WorkBuddy app dir without a PD registration is NOT a PD install (OD-03).
    fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true });
    expect(detectInstalledHosts(home, codexHome)).toEqual([]);

    fs.mkdirSync(path.join(home, '.openclaw', 'extensions', 'principles-disciple'), { recursive: true });
    writeJson(path.join(home, '.workbuddy', 'plugins', 'installed_plugins.json'), {
      schemaVersion: 2,
      plugins: { [WORKBUDDY_PLUGIN_KEY]: { version: '0.2.2' } },
    });
    // Re-seed the Codex marketplace cache (removed above).
    writePin(cacheRoot('0.3.19'), OLD_COHORT, '0.3.19');

    const detected = detectInstalledHosts(home, codexHome).map((entry) => entry.hostId).sort();
    expect(detected).toEqual(['codex', 'openclaw', 'workbuddy']);
  });
});
