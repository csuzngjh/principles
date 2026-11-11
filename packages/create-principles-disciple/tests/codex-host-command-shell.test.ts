/**
 * Windows command dispatch — #2505 regression (2026-11-11).
 *
 * BEFORE: `defaultRunCommand` used `shell: true` for EVERY command on win32.
 * Node concatenates the command line without quoting the executable, so
 * `process.execPath` = `D:\Program Files\nodejs\node.exe` reached cmd.exe as
 * `D:\Program`. The PLUGIN_DATA runtime setup never ran
 * (`'D:\Program' 不是内部或外部命令`) and the Codex runtime stayed one cohort
 * behind the payload pin.
 *
 * Both tests drive the REAL default runner through the public installer, so the
 * assertion is on the argv the child process actually received — not on how the
 * command line was built.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexHostInstaller } from '../src/installers/codex-host-installer.js';
import type { HostInstallContext } from '@principles/core/host';

interface Cohort {
  readonly codexAdapter: string;
  readonly hostRuntime: string;
  readonly core: string;
  readonly mcpServer: string;
}

const OLD_COHORT: Cohort = { codexAdapter: '0.8.5', hostRuntime: '3.1.1', core: '6.0.0', mcpServer: '0.3.2' };
const NEW_COHORT: Cohort = { codexAdapter: '0.8.8', hostRuntime: '3.2.2', core: '7.2.0', mcpServer: '0.3.3' };

const COMPONENT_DIRS = {
  codexAdapter: 'codex-adapter',
  hostRuntime: 'host-runtime',
  core: 'core',
  mcpServer: 'pd-mcp-server',
} as const;

const RUNTIME_PACKAGES = {
  codexAdapter: '@principles/codex-adapter',
  hostRuntime: '@principles/host-runtime',
  core: '@principles/core',
  mcpServer: '@principles/pd-mcp-server',
} as const;

let root: string;
let codexHome: string;
let canonicalRuntimeDir: string;
let argvLog: string;
let previousCodexHome: string | undefined;
let previousArgvLog: string | undefined;
let previousPath: string | undefined;

const ctx: HostInstallContext = {
  workspaceDir: path.join(os.tmpdir(), 'pd-cmd-space-ws'),
  pluginDir: path.join(os.tmpdir(), 'pd-cmd-space-plugin'),
  language: 'en',
  mode: 'smart',
};

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Canonical shared runtime: `<runtimeDir>/<component>/package.json`. */
function writeCanonicalRuntime(cohort: Cohort): void {
  for (const key of Object.keys(COMPONENT_DIRS) as (keyof typeof COMPONENT_DIRS)[]) {
    writeJson(path.join(canonicalRuntimeDir, COMPONENT_DIRS[key], 'package.json'), {
      name: RUNTIME_PACKAGES[key],
      version: cohort[key],
    });
  }
}

function cacheRoot(version: string): string {
  return path.join(codexHome, 'plugins', 'cache', 'principles', 'principles-disciple', version);
}

function pluginDataRoot(): string {
  return path.join(codexHome, 'plugins', 'data', 'principles-disciple-principles');
}

/**
 * Marketplace payload pinning `cohort`, with a stand-in `scripts/pd-setup.cjs`.
 * The stand-in records the argv it ACTUALLY received and materializes the pin
 * into `--plugin-data/runtime` using the real setup script's layout.
 */
function writePayload(dir: string, version: string, cohort: Cohort): string {
  writeJson(path.join(dir, 'runtime-version.json'), cohort);
  writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), { name: 'principles-disciple', version });
  const setupPath = path.join(dir, 'scripts', 'pd-setup.cjs');
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  fs.writeFileSync(setupPath, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const argv = process.argv.slice(1);',
    "fs.appendFileSync(process.env.PD_TEST_ARGV_LOG, JSON.stringify(argv) + '\\n');",
    "const value = (name) => argv[argv.indexOf(name) + 1];",
    "const pluginRoot = value('--plugin-root');",
    "const pluginData = value('--plugin-data');",
    "const pin = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'runtime-version.json'), 'utf8'));",
    'const packages = {',
    "  codexAdapter: '@principles/codex-adapter',",
    "  hostRuntime: '@principles/host-runtime',",
    "  core: '@principles/core',",
    "  mcpServer: '@principles/pd-mcp-server',",
    '};',
    'for (const key of Object.keys(packages)) {',
    "  const dir = path.join(pluginData, 'runtime', 'node_modules', packages[key]);",
    '  fs.mkdirSync(dir, { recursive: true });',
    "  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: packages[key], version: pin[key] }));",
    '}',
    '',
  ].join('\n'), 'utf8');
  return dir;
}

function readRecordedArgv(): string[][] {
  if (!fs.existsSync(argvLog)) return [];
  const raw = fs.readFileSync(argvLog, 'utf8').trim();
  if (raw.length === 0) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as string[]);
}

/**
 * A `codex` stand-in on PATH. `codex plugin add` copies the marketplace source
 * into the versioned cache, which is what the real host does.
 */
function installFakeCodexShim(sourceDir: string, version: string): string {
  const shimDir = path.join(root, 'shim dir');
  fs.mkdirSync(shimDir, { recursive: true });
  const marker = path.join(shimDir, 'shim-ran.txt');
  const scriptPath = path.join(shimDir, 'fake-codex.cjs');
  fs.writeFileSync(scriptPath, [
    "const fs = require('node:fs');",
    'const [, , sourceDir, targetDir, marker] = process.argv;',
    "fs.appendFileSync(marker, process.argv.slice(2).join(' ') + '\\n');",
    'fs.cpSync(sourceDir, targetDir, { recursive: true });',
    '',
  ].join('\n'), 'utf8');

  const command = [
    `"${process.execPath}" "${scriptPath}" "${sourceDir}" "${cacheRoot(version)}" "${marker}"`,
    '',
  ].join('\n');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(shimDir, 'codex.cmd'), `@echo off\r\n${command}`, 'utf8');
  } else {
    const shim = path.join(shimDir, 'codex');
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${command}`, 'utf8');
    fs.chmodSync(shim, 0o755);
  }

  process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`;
  return marker;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cmd-space-'));
  codexHome = path.join(root, '.codex');
  canonicalRuntimeDir = path.join(root, '.pd', 'runtime');
  argvLog = path.join(root, 'argv.log');
  previousCodexHome = process.env.CODEX_HOME;
  previousArgvLog = process.env.PD_TEST_ARGV_LOG;
  previousPath = process.env.PATH;
  // Legacy-registration detection reads CODEX_HOME directly (not deps.codexHome).
  process.env.CODEX_HOME = codexHome;
  process.env.PD_TEST_ARGV_LOG = argvLog;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousArgvLog === undefined) delete process.env.PD_TEST_ARGV_LOG;
  else process.env.PD_TEST_ARGV_LOG = previousArgvLog;
  process.env.PATH = previousPath;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('CodexHostInstaller — PLUGIN_DATA runtime setup through the real default runner', () => {
  it('runs pd-setup.cjs with the full argument vector when process.execPath contains spaces', async () => {
    writeCanonicalRuntime(NEW_COHORT);
    const versionDir = writePayload(cacheRoot('0.3.21'), '0.3.21', NEW_COHORT);
    const installer = new CodexHostInstaller({ codexHome, canonicalRuntimeDir });

    const result = await installer.install(ctx);

    expect(result.success, result.reason).toBe(true);
    // The child received every argument intact — no truncation at the space in
    // `D:\Program Files\nodejs\node.exe`, no mangling of the spaced values.
    expect(readRecordedArgv()).toEqual([[
      path.join(versionDir, 'scripts', 'pd-setup.cjs'),
      '--plugin-root', versionDir,
      '--plugin-data', pluginDataRoot(),
      '--workspace', ctx.workspaceDir,
      '--skip-init',
      '--ingest', 'skip',
      '--json',
    ]]);
    expect(result.reason ?? '').toContain(`codex-adapter@${NEW_COHORT.codexAdapter}`);
    for (const pkg of Object.values(RUNTIME_PACKAGES)) {
      expect(fs.existsSync(path.join(pluginDataRoot(), 'runtime', 'node_modules', pkg, 'package.json')), pkg).toBe(true);
    }
  });

  it('still resolves the bare codex shim through the shell', async () => {
    writeCanonicalRuntime(NEW_COHORT);
    writePayload(cacheRoot('0.3.19'), '0.3.19', OLD_COHORT);
    const sourceDir = path.join(root, 'marketplace-source');
    writePayload(sourceDir, '0.3.21', NEW_COHORT);
    const marker = installFakeCodexShim(sourceDir, '0.3.21');

    const installer = new CodexHostInstaller({ codexHome, canonicalRuntimeDir });
    const result = await installer.install(ctx);

    expect(result.success, result.reason).toBe(true);
    // The shim ran (proving `shell: true` still resolves `codex` to codex.cmd),
    // and the refreshed payload's pin is what PLUGIN_DATA ended up with.
    expect(fs.existsSync(marker), 'the codex shim never ran').toBe(true);
    expect(fs.existsSync(path.join(cacheRoot('0.3.21'), 'runtime-version.json'))).toBe(true);
    expect(readRecordedArgv()[0]?.[4]).toBe(pluginDataRoot());
  });
});
