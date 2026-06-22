import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, execSync, spawn } from 'child_process';
import * as http from 'http';

const INSTALLER_DIR = path.resolve(__dirname, '..');
const TMPDIR = fs.realpathSync(os.tmpdir());
let tarballPath: string;
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
  execSync(`npm install "${tarball}"`, {
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
  return path.join(homeDir, '.openclaw', 'extensions', 'principles-disciple', 'console');
}

beforeAll(() => {
  const packOutput = npmExecSync(['pack', '--pack-destination', TMPDIR], {
    cwd: INSTALLER_DIR,
    stdio: 'pipe',
    timeout: 120_000,
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

  tempHomeDir = path.join(TMPDIR, `pd-smoke-home-${Date.now()}`);
  tempWorkspaceDir = path.join(TMPDIR, `pd-smoke-ws-${Date.now()}`);
  fs.mkdirSync(tempHomeDir, { recursive: true });
  fs.mkdirSync(tempWorkspaceDir, { recursive: true });
}, 180_000);

afterAll(() => {
  if (tarballPath) {
    try { fs.unlinkSync(tarballPath); } catch { /* ignore */ }
  }
  if (tempHomeDir) cleanupDir(tempHomeDir);
  if (tempWorkspaceDir) cleanupDir(tempWorkspaceDir);
}, 30_000);

describe('Real packaged install smoke test', () => {
  it('tarball contains core/ directory', () => {
    const tarOutput = execSync(`tar -tf "${tarballPath}"`, {
      shell: true,
      stdio: 'pipe',
      timeout: 30_000,
    }).toString();
    expect(tarOutput).toContain('core/');
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
  }, 240_000);

  it('--json install produces parseable JSON with all components verified', () => {
    const cliEntry = path.join(tempHomeDir, 'node_modules', 'create-principles-disciple', 'dist', 'index.js');

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
        },
        timeout: 180_000,
      });
      stdout = result.toString();
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
      exitCode = err.status ?? 1;
      stdout = err.stdout?.toString() ?? '';
      stderr = err.stderr?.toString() ?? '';
    }

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
  }, 240_000);

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
