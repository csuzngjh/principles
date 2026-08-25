import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, execSync, spawn } from 'child_process';
import * as http from 'http';

const INSTALLER_DIR = path.resolve(__dirname, '..');
const TMPDIR = fs.realpathSync(os.tmpdir());
let tarballPath: string;
let installLayoutTarballPath: string;
let tempHomeDir: string;
let tempWorkspaceDir: string;

function npmExecSync(args: string[], options: Record<string, unknown> = {}): Buffer {
  const cmd = ['npm', ...args].join(' ');
  return execSync(cmd, {
    ...options,
    shell: true,
    env: { ...process.env, ...(options.env as Record<string, string> ?? {}) },
  });
}

function npmInstallSync(tarball: string, cwd: string, env?: Record<string, string>): void {
  execSync(`npm install "${installLayoutTarballPath}" "${tarball}"`, {
    cwd,
    shell: true,
    stdio: 'pipe',
    env: { ...process.env, ...(env ?? {}) },
    timeout: 180_000,
  });
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

beforeAll(() => {
  const installLayoutDir = path.resolve(INSTALLER_DIR, '..', 'install-layout');
  const installLayoutPackOutput = npmExecSync(['pack', '--pack-destination', TMPDIR], {
    cwd: installLayoutDir,
    stdio: 'pipe',
    timeout: 120_000,
  }).toString().trim();
  const installLayoutTarballName = installLayoutPackOutput.split('\n').map(line => line.trim()).filter(Boolean).at(-1);
  if (!installLayoutTarballName?.endsWith('.tgz')) throw new Error('install-layout npm pack did not produce a tarball');
  installLayoutTarballPath = path.resolve(TMPDIR, installLayoutTarballName);

  const packOutput = npmExecSync(['pack', '--pack-destination', TMPDIR], {
    cwd: INSTALLER_DIR,
    stdio: 'pipe',
    timeout: 300_000,
  }).toString().trim();

  const lines = packOutput.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const tarballName = lines[lines.length - 1];

  if (!tarballName || !tarballName.endsWith('.tgz')) {
    throw new Error(`npm pack did not produce tarball. Last line: ${tarballName}`);
  }

  tarballPath = path.resolve(TMPDIR, tarballName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Tarball not found at ${tarballPath}`);
  }

  execFileSync(process.execPath, [path.join(INSTALLER_DIR, 'scripts', 'bundle-plugin.mjs'), '--self-contained'], {
    cwd: INSTALLER_DIR,
    stdio: 'pipe',
    timeout: 300_000,
  });

  tempHomeDir = path.join(TMPDIR, `pd-smoke-home-${Date.now()}`);
  tempWorkspaceDir = path.join(TMPDIR, `pd-smoke-ws-${Date.now()}`);
  fs.mkdirSync(tempHomeDir, { recursive: true });
  fs.mkdirSync(tempWorkspaceDir, { recursive: true });
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
}, 600_000);

afterAll(() => {
  if (tarballPath) {
    try { fs.unlinkSync(tarballPath); } catch { /* ignore */ }
  }
  if (installLayoutTarballPath) {
    try { fs.unlinkSync(installLayoutTarballPath); } catch { /* ignore */ }
  }
  if (tempHomeDir) cleanupDir(tempHomeDir);
  if (tempWorkspaceDir) cleanupDir(tempWorkspaceDir);
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

  it('install to clean temp HOME succeeds', () => {
    npmInstallSync(tarballPath, tempHomeDir, {
      HOME: tempHomeDir,
      USERPROFILE: tempHomeDir,
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

  it('production self-contained bundle installs with no npm invocation', () => {
    // npm pack's prepack runs the real production bundler. Execute that built
    // installer directly so PLUGIN_DIR points at the self-contained component
    // trees (including node_modules) rather than npm's node_modules-stripped
    // tarball representation.
    const cliEntry = path.join(INSTALLER_DIR, 'dist', 'index.js');
    const fakeBinDir = path.join(tempHomeDir, 'bin');
    const npmPoisonMarker = path.join(tempHomeDir, 'npm-was-invoked');
    const npmPoison = path.join(fakeBinDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    fs.writeFileSync(
      npmPoison,
      process.platform === 'win32'
        ? `@echo off\r\n>"${npmPoisonMarker}" echo invoked\r\nexit /b 97\r\n`
        : `#!/bin/sh\nprintf invoked > "${npmPoisonMarker}"\nexit 97\n`,
      'utf8',
    );
    if (process.platform !== 'win32') fs.chmodSync(npmPoison, 0o755);

    let stdout = '';
    let exitCode = 0;
    let stderr = '';
    try {
      const result = execFileSync(process.execPath, [
        cliEntry,
        '--yes',
        '--workspace', tempWorkspaceDir,
        '--json',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOME: tempHomeDir,
          USERPROFILE: tempHomeDir,
          // Skip npm upgrade so we test the bundled pd-cli (built from current
          // repo state) rather than the npm-published version, which may be
          // incompatible with local core changes (e.g., removed exports).
          PD_SKIP_NPM_UPGRADE: '1',
          PD_SKIP_GLOBAL_SHIM: '1',
        },
        timeout: 600_000,
      });
      stdout = result.toString();
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
      exitCode = err.status ?? 1;
      stdout = err.stdout?.toString() ?? '';
      stderr = err.stderr?.toString() ?? '';
    }
    const npmWasInvoked = fs.existsSync(npmPoisonMarker);
    fs.rmSync(npmPoison, { force: true });
    fs.rmSync(npmPoisonMarker, { force: true });

    if (!stdout.trim()) {
      throw new Error(`No stdout output. exitCode=${exitCode}, stderr=${stderr.slice(0, 2000)}`);
    }

    const parsed: unknown = JSON.parse(stdout);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (!obj.success) {
        throw new Error(`Install failed: reason=${obj.reason}, error=${obj.error}, nextAction=${obj.nextAction}, components=${JSON.stringify(obj.components)}, stderr=${stderr.slice(0, 1000)}`);
      }
      expect(obj.success).toBe(true);
      expect(obj.components).toBeDefined();
      const components = obj.components as Record<string, unknown>;
      expect(components.plugin).toBe('verified');
      expect(['verified', 'verified_local_only']).toContain(components.cli);
      expect(components.console).toBe('configured');
      const verification = obj.verification as Record<string, unknown>;
      expect(verification.storyA).toBe('passed');
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
    // P1-4: the installer package must not carry its own (historical,
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

    const port = 3200 + Math.floor(Math.random() * 100);
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

    expect(healthOk).toBe(true);
  }, 60_000);

  it('console refuses --no-auth with non-loopback host', () => {
    const installedConsoleDir = getInstalledConsoleDir(tempHomeDir);
    const serverEntry = path.join(installedConsoleDir, 'dist', 'server.js');
    if (!fs.existsSync(serverEntry)) {
      throw new Error('Console server entry not found at installed location');
    }

    const port = 3300 + Math.floor(Math.random() * 100);
    let exitCode: number | null = null;
    try {
      execFileSync(process.execPath, [
        serverEntry,
        '--workspace', tempWorkspaceDir,
        '--port', String(port),
        '--host', '0.0.0.0',
        '--no-auth',
      ], {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: tempHomeDir,
          USERPROFILE: tempHomeDir,
        },
        timeout: 10_000,
      });
    } catch (e: unknown) {
      const err = e as { status?: number };
      exitCode = err.status ?? 1;
    }

    expect(exitCode).not.toBe(0);
  });

  it('failure injection: missing console triggers rollback', () => {
    const backupHomeDir = path.join(TMPDIR, `pd-smoke-rollback-${Date.now()}`);
    const backupWorkspaceDir = path.join(TMPDIR, `pd-smoke-rollback-ws-${Date.now()}`);
    fs.mkdirSync(backupHomeDir, { recursive: true });
    fs.mkdirSync(backupWorkspaceDir, { recursive: true });

    try {
      npmInstallSync(tarballPath, backupHomeDir, {
        HOME: backupHomeDir,
        USERPROFILE: backupHomeDir,
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
            expect(obj.success).toBe(false);
            expect(obj.reason).toBeDefined();
            expect(obj.nextAction).toBeDefined();
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
});
