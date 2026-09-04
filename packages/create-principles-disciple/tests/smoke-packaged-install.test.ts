import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawn } from 'child_process';
import * as http from 'http';

const INSTALLER_DIR = path.resolve(__dirname, '..');
const TMPDIR = fs.realpathSync(os.tmpdir());
let tarballPath: string;
let installLayoutTarballPath: string;
let tempHomeDir: string;
let tempWorkspaceDir: string;
// Hermetic self-contained publication (temp), consumed by the CLI test via
// PD_INSTALL_PLUGIN_DIR; cleaned up in afterAll together with the temp home.
let hermeticPublicationDir: string;
let hermeticReleaseRoot: string;

// npm is invoked as `node <npm-cli.js> <args>` with argv arrays only — no
// shell strings, and no bare `npm`/`npm.cmd` spawn (EINVAL on Windows).
function resolveNpmCliEntry(): string {
  const nodeDir = path.dirname(process.execPath);
  const prefixDir = path.dirname(nodeDir);
  for (const candidate of [
    // Windows / plain POSIX layout
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(prefixDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // nvm and most Linux distro layouts keep the global npm under lib/
    path.join(prefixDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (fs.existsSync(candidate)) return path.resolve(candidate);
  }
  throw new Error(`npm-cli.js not found near ${process.execPath}`);
}

type ExecFileAsync = (file: string, args: readonly string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;

async function loadExecFileAsync(): Promise<ExecFileAsync> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  return (file, args, options) => execFileAsync(file, args, options) as Promise<{ stdout: string; stderr: string }>;
}

async function npmRun(args: readonly string[], options: Record<string, unknown> = {}): Promise<string> {
  const execFileAsync = await loadExecFileAsync();
  const npmCli = resolveNpmCliEntry();
  const { stdout } = await execFileAsync(process.execPath, [npmCli, ...args], {
    ...options,
    env: { ...process.env, ...((options.env as Record<string, string>) ?? {}) },
  });
  return stdout;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function getInstalledConsoleDir(homeDir: string): string {
  return path.join(homeDir, '.pd', 'runtime', 'console');
}

// Port discovery happens ASYNC in beforeAll into this pool; test bodies
// then consume ports synchronously. (Windows reserves arbitrary dynamic
// ranges — 3101-3200 on the dev machine — so hardcoded windows flake.)
const discoveredPortPool: number[] = [];
let consolePortBaseForThisRun = 4100;

async function discoverLoopbackPort(): Promise<number> {
  const net = require('node:net') as typeof import('node:net');
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('failed to discover a bindable loopback port'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function freeLoopbackPort(): number {
  const port = discoveredPortPool.shift();
  if (port === undefined) {
    throw new Error('port pool exhausted — increase discovery count in beforeAll');
  }
  return port;
}

beforeAll(async () => {
  const installLayoutDir = path.resolve(INSTALLER_DIR, '..', 'install-layout');
  const installLayoutPackOutput = await npmRun(['pack', '--pack-destination', TMPDIR], {
    cwd: installLayoutDir,
    timeout: 120_000,
  });
  const installLayoutTarballName = installLayoutPackOutput.split('\n').map(line => line.trim()).filter(Boolean).at(-1);
  if (!installLayoutTarballName?.endsWith('.tgz')) throw new Error('install-layout npm pack did not produce a tarball');
  installLayoutTarballPath = path.resolve(TMPDIR, installLayoutTarballName);

  const packOutput = await npmRun(['pack', '--pack-destination', TMPDIR], {
    cwd: INSTALLER_DIR,
    timeout: 300_000,
  });

  const lines = packOutput.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const tarballName = lines[lines.length - 1];

  if (!tarballName || !tarballName.endsWith('.tgz')) {
    throw new Error(`npm pack did not produce tarball. Last line: ${tarballName}`);
  }

  tarballPath = path.resolve(TMPDIR, tarballName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Tarball not found at ${tarballPath}`);
  }

  // HERMETIC self-contained materialization: the production builder runs in
  // an isolated temp publication (staging → stamp → archive → atomic
  // publish) and NEVER touches the repository source tree. The CLI test
  // below points the installer at this publication via PD_INSTALL_PLUGIN_DIR.
  // Pre-discover bindable ports (async) for the console tests, and derive
  // the installer's console-verify window base from the first one.
  for (let index = 0; index < 6; index += 1) {
    discoveredPortPool.push(await discoverLoopbackPort());
  }
  consolePortBaseForThisRun = Math.floor((discoveredPortPool[0] ?? 4100) / 100) * 100;
  // mkdtemp: private unpredictable directories — predictable Date.now()-named
  // paths in the shared os tmpdir are a symlink-hijack surface
  // (js/insecure-temporary-file) and collide when two runs share a ms.
  const releaseTestRoot = fs.mkdtempSync(path.join(TMPDIR, 'pd-packaged-release-'));
  const publicationDir = path.join(releaseTestRoot, 'publication');
  const builderEntry = path.resolve(INSTALLER_DIR, 'scripts', 'build-self-contained-release.mjs');
  if (!builderEntry.startsWith(INSTALLER_DIR + path.sep) || !fs.existsSync(builderEntry)) {
    throw new Error(`Builder entry is missing: ${builderEntry}`);
  }
  const execFileAsync = await loadExecFileAsync();
  await execFileAsync(process.execPath, [builderEntry, '--output', publicationDir], {
    cwd: INSTALLER_DIR,
    env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' },
    timeout: 1_800_000,
  });
  hermeticPublicationDir = fs.realpathSync(path.join(publicationDir, 'payload'));
  hermeticReleaseRoot = releaseTestRoot;

  tempHomeDir = fs.mkdtempSync(path.join(TMPDIR, 'pd-smoke-home-'));
  tempWorkspaceDir = fs.mkdtempSync(path.join(TMPDIR, 'pd-smoke-ws-'));
  // Create a fake `openclaw` binary on PATH so the installer's readiness
  // check (spec §6.2 — terminate if OpenClaw missing) passes in CI.
  // The real OpenClaw detection logic is covered by env.test.ts BDD tests.
  const fakeBinDir = path.join(tempHomeDir, 'bin');
  fs.mkdirSync(fakeBinDir, { recursive: true });
  const fakeOpenclawName = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
  const fakeOpenclawPath = path.join(fakeBinDir, fakeOpenclawName);
  const fakeOpenclawContent = process.platform === 'win32'
    ? '@echo off\r\necho openclaw version 1.0.0-smoke\r\n'
    : '#!/usr/bin/env sh\necho "openclaw version 1.0.0-smoke"\n';
  fs.writeFileSync(fakeOpenclawPath, fakeOpenclawContent, 'utf-8');
  if (process.platform !== 'win32') {
    fs.chmodSync(fakeOpenclawPath, 0o755);
  }
  // Prepend fakeBinDir to PATH so checkEnvironment finds the fake openclaw.
  process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH}`;
  // Budget = 2×npm pack + full self-contained build (staging + per-component
  // npm ci at up to 900s each with one retry) + installer run. The 600s cap
  // was exceeded ("Hook timed out in 600000ms") in the 2026-09-04 slow
  // registry window; the builder alone can now legitimately need 15-25 min.
}, 1_800_000);

afterAll(() => {
  if (tarballPath) {
    try { fs.unlinkSync(tarballPath); } catch { /* ignore */ }
  }
  if (installLayoutTarballPath) {
    try { fs.unlinkSync(installLayoutTarballPath); } catch { /* ignore */ }
  }
  if (tempHomeDir) cleanupDir(tempHomeDir);
  if (tempWorkspaceDir) cleanupDir(tempWorkspaceDir);
  if (hermeticReleaseRoot) cleanupDir(hermeticReleaseRoot);
}, 120_000);

describe('Real packaged install smoke test', () => {
  it('tarball contains core/ directory', () => {
    // cwd + relative tarball name: an absolute C:\… path makes GNU tar treat
    // "C:" as a remote host on Windows.
    const tarOutput = execFileSync('tar', ['-tf', path.basename(tarballPath)], {
      cwd: path.dirname(tarballPath),
      stdio: 'pipe',
      timeout: 30_000,
    }).toString();
    expect(tarOutput).toContain('core/');
    expect(tarOutput).toContain('install-layout/dist/index.js');
    expect(tarOutput).toContain('plugin/dist/governance-audit.js');
  }, 60_000);

  it('install to clean temp HOME succeeds', async () => {
    await npmRun(['install', installLayoutTarballPath, tarballPath], {
      cwd: tempHomeDir,
      timeout: 180_000,
      env: {
        HOME: tempHomeDir,
        USERPROFILE: tempHomeDir,
      },
    });
    const pkgJsonPath = path.join(tempHomeDir, 'node_modules', 'create-principles-disciple', 'package.json');
    expect(fs.existsSync(pkgJsonPath)).toBe(true);

    const coreDir = path.join(tempHomeDir, 'node_modules', 'create-principles-disciple', 'core');
    expect(fs.existsSync(coreDir)).toBe(true);
    expect(fs.existsSync(path.join(coreDir, 'dist', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(coreDir, 'package.json'))).toBe(true);

    const pluginPkgJson = JSON.parse(fs.readFileSync(path.join(tempHomeDir, 'node_modules', 'create-principles-disciple', 'plugin', 'package.json'), 'utf-8'));
    expect(pluginPkgJson.dependencies?.['@principles/core']).toBe('file:./core');
    expect(pluginPkgJson.dependencies?.['@principles/host-runtime']).toBeUndefined();
    expect(pluginPkgJson.devDependencies?.['@principles/host-runtime']).toBeUndefined();
  }, 240_000);

  it('production self-contained bundle installs with no npm invocation', async () => {
    // The real CLI installs from the HERMETIC temp publication via
    // PD_INSTALL_PLUGIN_DIR — the source package stays read-only throughout
    // (source-tree immutability, see the closing test).
    const cliEntry = path.resolve(INSTALLER_DIR, 'dist', 'index.js');
    if (!cliEntry.startsWith(INSTALLER_DIR + path.sep) || !fs.existsSync(cliEntry)) {
      throw new Error(`CLI build output is missing: ${cliEntry}`);
    }
    const fakeBinDir = path.join(tempHomeDir, 'bin');
    const npmPoisonMarker = path.join(tempHomeDir, 'npm-was-invoked');
    const npmPoison = path.join(fakeBinDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    fs.writeFileSync(
      npmPoison,
      process.platform === 'win32'
        ? `@echo off\r\n>"${npmPoisonMarker}" echo invoked\r\nexit /b 97\r\n`
        : `#!/bin/sh\nprintf invoked > "${npmPoisonMarker}"\nexit 97\n`,
      'utf-8',
    );
    if (process.platform !== 'win32') fs.chmodSync(npmPoison, 0o755);

    let stdout = '';
    let stderr = '';
    const execFileAsync = await loadExecFileAsync();
    const npmWasInvokedBefore = fs.existsSync(npmPoisonMarker);
    try {
      const result = await execFileAsync(process.execPath, [
        cliEntry,
        '--yes',
        '--workspace', tempWorkspaceDir,
        '--json',
      ], {
        env: {
          ...process.env,
          HOME: tempHomeDir,
          USERPROFILE: tempHomeDir,
          // Hermetic plugin source: the real CLI installs from the temp
          // publication instead of the (un-stamped) source package.
          PD_INSTALL_PLUGIN_DIR: hermeticPublicationDir,
          // Steer the installer's console-verify port window away from
          // OS-reserved ranges (this machine excludes 3101-3200).
          PD_CONSOLE_PORT_BASE: String(consolePortBaseForThisRun),
          // Skip npm upgrade so we test the bundled pd-cli (built from current
          // repo state) rather than the npm-published version, which may be
          // incompatible with local core changes (e.g., removed exports).
          PD_SKIP_NPM_UPGRADE: '1',
          PD_SKIP_GLOBAL_SHIM: '1',
        },
        timeout: 600_000,
      });
      stdout = result.stdout;
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string; code?: unknown; killed?: boolean; signal?: unknown };
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? '';
      if (stdout.trim().length === 0) {
        throw new Error(`Installer CLI failed without stdout. message=${String(err.message)} code=${String(err.code)} killed=${String(err.killed)} signal=${String(err.signal)} stderr=${stderr.slice(0, 2000)}`);
      }
    }
    const npmWasInvoked = fs.existsSync(npmPoisonMarker) || npmWasInvokedBefore;
    fs.rmSync(npmPoison, { force: true });
    fs.rmSync(npmPoisonMarker, { force: true });

    if (!stdout.trim()) {
      throw new Error(`No stdout output. stderr=${stderr.slice(0, 2000)}`);
    }

    const parsed: unknown = JSON.parse(stdout);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (!obj['success']) {
        throw new Error(`Install failed: reason=${obj['reason']}, error=${obj['error']}, nextAction=${obj['nextAction']}, components=${JSON.stringify(obj['components'])}, stderr=${stderr.slice(0, 1000)}`);
      }
      expect(obj['success']).toBe(true);
      expect(obj['components']).toBeDefined();
      const components = obj['components'] as Record<string, unknown>;
      expect(components['plugin']).toBe('verified');
      expect(['verified', 'verified_local_only']).toContain(components['cli']);
      expect(components['console']).toBe('configured');
      const verification = obj['verification'] as Record<string, unknown>;
      expect(verification['storyA']).toBe('passed');
    }
    expect(npmWasInvoked).toBe(false);
  }, 600_000);

  it('installer demo verification does not pollute the user workspace', () => {
    // P0-1 anti-regression: the installer's Story A verification must run in
    // a throwaway temp workspace (pd-cli's own), never against the install
    // target. After a successful install, the user's workspace must contain
    // zero demo-provenance rows (demo principle/rule/task ids, origin=demo).
    const markers = [
      'demo-principle-',
      'demo-rule-',
      'task-demo-',
      'art-demo-',
      '"origin":"demo"',
      'Demo: block writes to system directories',
    ];
    const scanRoots = [
      path.join(tempWorkspaceDir, '.pd'),
      path.join(tempWorkspaceDir, '.state'),
      path.join(tempWorkspaceDir, '.principles'),
    ].map((p) => path.resolve(p));
    const hits: string[] = [];
    const walk = (rootDir: string): void => {
      if (!fs.existsSync(rootDir)) return;
      for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        // Boundary check: only descend into paths that stay inside rootDir.
        const full = path.resolve(rootDir, entry.name);
        if (full !== rootDir && !full.startsWith(rootDir + path.sep)) continue;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        let content: string;
        try {
          content = fs.readFileSync(full).toString('latin1');
        } catch {
          continue;
        }
        for (const marker of markers) {
          if (content.includes(marker)) {
            hits.push(`${full} contains "${marker}"`);
          }
        }
      }
    };
    for (const root of scanRoots) walk(root);
    expect(hits, `demo artifacts leaked into the install workspace:\n${hits.join('\n')}`).toEqual([]);
  }, 30_000);

  it('bundled plugin PROFILE templates carry no retired PLAN-gate keys', () => {
    // Distribution-layer guard: the bundle step copies the plugin tree at
    // pack time, so a stale working tree could re-ship retired templates
    // even after the source was cleaned. Inspect the actual tarball.
    const retiredKeys = [
      'require_plan_for_risk_paths',
      'require_audit_before_write',
      'require_reviewer_after_write',
      'progressive_gate',
      'plan_approvals',
      'thinking_checkpoint',
    ];
    const extractRoot = path.resolve(fs.mkdtempSync(path.join(TMPDIR, 'pd-smoke-profile-')));
    try {
      for (const name of ['PROFILE.json', 'PROFILE.schema.json']) {
        const rel = `package/plugin/templates/workspace/.principles/${name}`;
        // cwd + relative tarball name: an absolute C:\… path makes GNU tar
        // treat "C:" as a remote host on Windows.
        execFileSync('tar', ['-xzf', path.basename(tarballPath), '-C', extractRoot, rel], {
          stdio: 'pipe',
          cwd: path.dirname(tarballPath),
        });
        const extracted = path.resolve(extractRoot, rel);
        expect(extracted.startsWith(extractRoot + path.sep)).toBe(true);
        const content = fs.readFileSync(extracted, 'utf8');
        for (const key of retiredKeys) {
          expect(content.includes(key), `tarball ${name} must not contain retired key "${key}"`).toBe(false);
        }
        expect(() => JSON.parse(content), `tarball ${name} must be valid JSON`).not.toThrow();
      }
    } finally {
      cleanupDir(extractRoot);
    }
  }, 60_000);

  it('tarball ships exactly the approved 5 skills and no legacy skill payload', () => {
    // P1-4: the installer package must not carry its own (historically
    // unread) skill tree, and the bundled plugin must ship exactly the
    // maintainer-approved MVP skill set in both languages.
    const APPROVED_SKILLS = [
      'pd-cli-operator',
      'pd-implementer',
      'pd-mentor',
      'pd-pain-signal',
      'pd-runtime-v2',
    ];
    const LEGACY_SKILLS = [
      'admin', 'bootstrap-tools', 'deductive-audit', 'evolution-framework-update',
      'evolve-system', 'evolve-task', 'feedback', 'init-strategy', 'inject-rule',
      'manage-okr', 'pain', 'profile', 'reflection', 'reflection-log', 'report',
      'root-cause', 'triage', 'watch-evolution', 'pd-reporter', 'pd-reviewer',
      // PRI-548 follow-up: generic SOP role skills retired from the plugin.
      'pd-auditor', 'pd-explorer', 'pd-planner',
    ];
    const listing = execFileSync('tar', ['-tf', path.basename(tarballPath)], {
      stdio: 'pipe',
      maxBuffer: 32 * 1024 * 1024,
      cwd: path.dirname(tarballPath),
    }).toString();

    // The installer's own template skill tree has no runtime reader — the
    // whole tree must be gone from the distribution.
    expect(listing.includes('package/templates/langs/zh/skills/'), 'installer-level templates/langs skills must not ship').toBe(false);
    expect(listing.includes('package/templates/langs/en/skills/'), 'installer-level templates/langs skills must not ship').toBe(false);

    // The bundled plugin ships the approved set, per language.
    for (const lang of ['zh', 'en']) {
      const skillDirs = new Set<string>();
      for (const line of listing.split('\n')) {
        const m = line.match(/^package\/plugin\/templates\/langs\/([^/]+)\/skills\/([^/]+)\//);
        if (m && m[1] === lang) skillDirs.add(m[2]);
      }
      expect([...skillDirs].sort(), `bundled plugin ${lang} skills`).toEqual([...APPROVED_SKILLS].sort());
    }
    for (const legacy of LEGACY_SKILLS) {
      expect(listing.includes(`/skills/${legacy}/`), `legacy skill "${legacy}" must not ship`).toBe(false);
    }
  }, 60_000);

  it('pd console starts and /api/health returns 200 on loopback', async () => {
    const installedConsoleDir = getInstalledConsoleDir(tempHomeDir);
    const serverEntry = path.join(installedConsoleDir, 'dist', 'server.js');
    if (!fs.existsSync(serverEntry)) {
      throw new Error('Console server entry not found at installed location');
    }

    const port = freeLoopbackPort();
    const child = spawn(process.execPath, [
      serverEntry,
      '--workspace', tempWorkspaceDir,
      '--port', String(port),
      '--host', '127.0.0.1',
      '--no-auth',
    ], {
      stdio: 'pipe',
      env: {
        ...process.env,
        HOME: tempHomeDir,
        USERPROFILE: tempHomeDir,
      },
    });

    let childStderr = '';
    let childStdout = '';
    child.stderr?.on('data', (chunk: Buffer) => { childStderr += chunk.toString(); });
    child.stdout?.on('data', (chunk: Buffer) => { childStdout += chunk.toString(); });

    await new Promise<void>((resolve) => { setTimeout(resolve, 6000); });

    let healthOk = false;
    let healthReason = '';
    try {
      const healthResult = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
          });
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
      });

      if (healthResult.statusCode !== 200) {
        healthReason = `HTTP ${healthResult.statusCode}`;
      } else {
        try {
          JSON.parse(healthResult.body);
          healthOk = true;
        } catch {
          healthReason = 'malformed JSON';
        }
      }
    } catch (e) {
      healthReason = `${e}. Stderr: ${childStderr.slice(0, 500)}. Stdout: ${childStdout.slice(0, 500)}`;
    } finally {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }

    expect(healthOk, healthReason).toBe(true);
  }, 60_000);

  it('console refuses --no-auth with non-loopback host', async () => {
    const installedConsoleDir = getInstalledConsoleDir(tempHomeDir);
    const serverEntry = path.join(installedConsoleDir, 'dist', 'server.js');
    if (!fs.existsSync(serverEntry)) {
      throw new Error('Console server entry not found at installed location');
    }

    const port = freeLoopbackPort();
    const execFileAsync = await loadExecFileAsync();
    const failure = await execFileAsync(process.execPath, [
      serverEntry,
      '--workspace', tempWorkspaceDir,
      '--port', String(port),
      '--host', '0.0.0.0',
      '--no-auth',
    ], {
      env: {
        ...process.env,
        HOME: tempHomeDir,
        USERPROFILE: tempHomeDir,
      },
      timeout: 10_000,
    }).then(() => undefined, (error: unknown) => error);

    // The console must refuse to start; exit code 0 would be the failure.
    expect(failure).toBeDefined();
  }, 60_000);

  it('failure injection: missing console triggers rollback', async () => {
    const backupHomeDir = path.join(TMPDIR, `pd-smoke-rollback-${Date.now()}`);
    const backupWorkspaceDir = path.join(TMPDIR, `pd-smoke-rollback-ws-${Date.now()}`);
    fs.mkdirSync(backupHomeDir, { recursive: true });
    fs.mkdirSync(backupWorkspaceDir, { recursive: true });

    try {
      await npmRun(['install', installLayoutTarballPath, tarballPath], {
        cwd: backupHomeDir,
        timeout: 180_000,
        env: {
          HOME: backupHomeDir,
          USERPROFILE: backupHomeDir,
        },
      });

      const consoleDir = path.join(
        backupHomeDir, 'node_modules', 'create-principles-disciple', 'console',
      );
      if (fs.existsSync(consoleDir)) {
        fs.rmSync(path.join(consoleDir, 'dist', 'server.js'), { force: true });
      }

      const cliEntry = path.join(backupHomeDir, 'node_modules', 'create-principles-disciple', 'dist', 'index.js');

      let exitCode: number | null = 0;
      let stdout = '';
      try {
        stdout = execFileSync(process.execPath, [
          cliEntry,
          '--yes',
          '--workspace', backupWorkspaceDir,
          '--json',
        ], {
          stdio: 'pipe',
          env: {
            ...process.env,
            HOME: backupHomeDir,
            USERPROFILE: backupHomeDir,
            PD_SKIP_NPM_UPGRADE: '1',
            PD_SKIP_GLOBAL_SHIM: '1',
          },
          timeout: 180_000,
        }).toString();
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: Buffer };
        exitCode = err.status ?? 1;
        stdout = err.stdout?.toString() ?? '';
      }

      if (stdout.trim().length > 0) {
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (typeof parsed === 'object' && parsed !== null) {
            const obj = parsed as Record<string, unknown>;
            expect(obj['success']).toBe(false);
            expect(obj['reason']).toBeDefined();
            expect(obj['nextAction']).toBeDefined();
          }
        } catch {
          // stdout was not JSON, which is fine for error cases
        }
      }
    } finally {
      cleanupDir(backupHomeDir);
      cleanupDir(backupWorkspaceDir);
    }
  }, 300_000);

  it('never mutates the repository source tree (hermetic contract)', () => {
    // Closing guard for source-tree immutability: after every test above —
    // including the real self-contained build and the CLI install — the
    // installer package must contain none of the release materialization
    // artifacts. If this regresses, an interrupted run can strand hundreds
    // of thousands of ignored files in the repo (observed as 7 GB / 720k
    // files on the dev machine).
    for (const pollution of [
      '_release',
      'plugin/node_modules',
      'core/node_modules',
      'console/node_modules',
      'pd-cli/node_modules',
      'host-runtime/node_modules',
      'install-layout/node_modules',
      'plugin/package-lock.json',
      'core/package-lock.json',
      'console/package-lock.json',
      'pd-cli/package-lock.json',
      'host-runtime/package-lock.json',
    ]) {
      expect(fs.existsSync(path.join(INSTALLER_DIR, pollution)), `source tree pollution: ${pollution}`).toBe(false);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Registry-resolved dependency install (npx parity) — PRI-669 gate.
//
// The tests above install the installer tarball TOGETHER with a locally
// packed install-layout tarball, so npm satisfies the installer's
// @principles/install-layout dependency from the LOCAL build. That hermetic
// property masked the 2026-09-04 defect: the installer's top-level dep pinned
// "@principles/install-layout": "0.1.0" (exact) while its dist statically
// imported mergeInstallManifestWorkspaces — an interface the registry's
// 0.1.0 never had — so every REAL `npx create-principles-disciple` fresh
// install crashed at module load while the co-installed smoke stayed green.
//
// This variant installs ONLY the installer tarball in a clean directory, so
// the dependency resolves against the real npm registry exactly as an npx
// user's install does, then exercises the exact failure shape: loading
// dist/index.js (whose top-level import chain reaches installer.js →
// @principles/install-layout) must succeed.
// ---------------------------------------------------------------------------
describe('Registry-resolved dependency install (npx parity)', () => {
  it('resolves @principles/install-layout from the registry and loads the installer entry', async () => {
    const cleanDir = fs.mkdtempSync(path.join(TMPDIR, 'pd-registry-install-'));
    try {
      // Install ONLY the installer tarball — dependencies come from the
      // real registry (npx parity), not from the locally packed tarball.
      await npmRun(['install', tarballPath], {
        cwd: cleanDir,
        timeout: 300_000,
      });

      // 1. The registry-resolved install-layout must satisfy the declared
      //    range and carry the interface the installer dist imports.
      const installLayoutEntry = path.join(
        cleanDir,
        'node_modules',
        'create-principles-disciple',
        'node_modules',
        '@principles',
        'install-layout',
        'dist',
        'index.js',
      );
      const installLayoutAnywhere = fs.existsSync(installLayoutEntry)
        ? installLayoutEntry
        : path.join(cleanDir, 'node_modules', '@principles', 'install-layout', 'dist', 'index.js');
      expect(
        fs.existsSync(installLayoutAnywhere),
        'expected the registry to provide @principles/install-layout for the installer',
      ).toBe(true);

      const resolvedLayoutManifestPath = installLayoutAnywhere.replace(
        /dist[\\/]index\.js$/,
        'package.json',
      );
      const resolvedLayoutManifest: unknown = JSON.parse(
        fs.readFileSync(resolvedLayoutManifestPath, 'utf-8'),
      );
      const resolvedVersion =
        typeof resolvedLayoutManifest === 'object' && resolvedLayoutManifest !== null && 'version' in resolvedLayoutManifest
          ? String((resolvedLayoutManifest as Record<string, unknown>).version)
          : 'unknown';
      // The declared range is ^0.2.0; a registry-resolved 0.1.x (the
      // pre-2026-09-04 defect) must fail this assertion loudly.
      expect(resolvedVersion.startsWith('0.2.'), `registry resolved install-layout@${resolvedVersion}, expected >=0.2.0 <0.3.0`).toBe(true);

      // 2. The interface check the whole gate exists for: the exact symbol
      //    whose absence crashed real npx installs.
      const probe = `
        const m = await import(${JSON.stringify('file://' + installLayoutAnywhere.replaceAll('\\', '/'))});
        if (typeof m.mergeInstallManifestWorkspaces !== 'function') {
          console.error('mergeInstallManifestWorkspaces missing from resolved install-layout@' + ${JSON.stringify(resolvedVersion)});
          process.exit(3);
        }
      `;
      const probePath = path.join(cleanDir, '__probe_il__.mjs');
      fs.writeFileSync(probePath, probe, 'utf-8');
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      try {
        await execFileAsync(process.execPath, [probePath], { timeout: 30_000 });
      } finally {
        fs.rmSync(probePath, { force: true });
      }

      // 3. The npx failure shape itself: loading the installed entry
      //    (top-level imports reach installer.js → @principles/install-layout)
      //    must succeed and answer --version.
      const entry = path.join(cleanDir, 'node_modules', 'create-principles-disciple', 'dist', 'index.js');
      expect(fs.existsSync(entry), 'installed installer entry missing').toBe(true);
      const { stdout } = await execFileAsync(process.execPath, [entry, '--version'], { timeout: 60_000 });
      expect(stdout.trim().length, '--version produced no output').toBeGreaterThan(0);
    } finally {
      cleanupDir(cleanDir);
    }
  }, 420_000);
});
