/**
 * A quiet install that asked to be narrated reports its steps.
 *
 * The update executor runs the installer with no terminal: `quiet: true`. Until
 * it could ask for narration, every `if (spinner) updateProgress(...)` step
 * went nowhere, and a multi-minute install was invisible from the Console.
 * This drives the REAL `install()` on the REAL filesystem — a payload bundle
 * that passes the form gate and then fails at its first checked step, which is
 * as far as a narration needs to go — and pins:
 *
 * 1. With `onProgress`, each step the installer takes is reported in order,
 *    with the weighted completion the spinner would have printed.
 * 2. Without it, the run is exactly what it was: same verdict, same reason.
 *    Narration changes no decision.
 * 3. A quiet run never reaches for a terminal: no spinner is started.
 *
 * HOME is pinned to a sandbox before anything runs (the package's home-write
 * sentinel fails the file if a fixture escapes it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { InstallOptions } from '../src/prompts.js';

const mocks = vi.hoisted(() => ({ spinnerStarts: 0 }));
vi.mock('child_process', () => ({ execFileSync: vi.fn(() => ''), execSync: vi.fn(() => '') }));
vi.mock('../src/utils/env.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkOpenClawGateway: vi.fn(),
    stopOpenClawGateway: vi.fn(),
    restartOpenClawGateway: vi.fn(),
  };
});
vi.mock('ora', () => ({
  default: () => ({ start: () => { mocks.spinnerStarts += 1; return { text: '', succeed: () => undefined, warn: () => undefined, fail: () => undefined }; } }),
}));
import { install } from '../src/installer.js';
import { checkOpenClawGateway } from '../src/utils/env.js';
import { stampPayloadIdentity } from './helpers/payload-identity.js';

const COMPONENTS = ['core', 'host-runtime', 'codex-adapter', 'plugin', 'pd-cli', 'console', 'install-layout', 'release-manager', 'pd-mcp-server'];

/** An npm-distributed payload bundle on real disk: complete enough for the form gate, empty inside. */
function writeEmptyBundle(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-narration-bundle-'));
  for (const component of COMPONENTS) {
    fs.mkdirSync(path.join(dir, component, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, component, 'package.json'), JSON.stringify({ name: `@principles/${component}`, version: '0.0.0' }));
  }
  fs.writeFileSync(path.join(dir, 'pd-mcp-server', 'dist', 'index.js'), 'export {};\n');
  fs.mkdirSync(path.join(dir, 'release-manager', 'dist', 'update'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'release-manager', 'dist', 'update', 'release-manager-authority.js'), 'export {};\n');
  fs.writeFileSync(path.join(dir, 'release-manager', 'dist', 'update', 'console-surface.js'), 'export {};\n');
  fs.mkdirSync(path.join(dir, 'console', 'dist', 'web'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'console', 'dist', 'server.js'), 'export {};\n');
  fs.writeFileSync(path.join(dir, 'console', 'dist', 'web', 'index.html'), '<html></html>\n');
  // The installer refuses a payload without an embedded product identity
  // before it takes a single step (PRI-874); stamp it the way the train does.
  stampPayloadIdentity(dir, '1.2.3');
  return dir;
}

describe('a quiet install narrates its steps when asked', () => {
  let home: string;
  let workspace: string;
  let bundle: string;
  const savedEnvironment: Record<string, string | undefined> = {};
  const ENVIRONMENT_KEYS = ['HOME', 'USERPROFILE', 'PD_ALLOW_LEGACY_NPM_INSTALL', 'PD_SKIP_GLOBAL_SHIM', 'PD_SKIP_NPM_UPGRADE', 'PD_SKIP_CONSOLE_AUTOLAUNCH'] as const;
  let options: InstallOptions;

  beforeEach(() => {
    for (const key of ENVIRONMENT_KEYS) savedEnvironment[key] = process.env[key];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-narration-home-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-narration-ws-'));
    bundle = writeEmptyBundle();
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    // Never touch the real npm global bin dir, the registry, or a console.
    process.env.PD_SKIP_GLOBAL_SHIM = '1';
    process.env.PD_SKIP_NPM_UPGRADE = '1';
    process.env.PD_SKIP_CONSOLE_AUTOLAUNCH = '1';
    delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    mocks.spinnerStarts = 0;
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false });
    options = { language: 'en', mode: 'smart', workspaceDir: workspace, channels: [], overwriteConfig: false, host: 'openclaw', stopGateway: false };
  });

  afterEach(() => {
    for (const key of ENVIRONMENT_KEYS) {
      if (savedEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnvironment[key];
    }
    for (const directory of [home, workspace, bundle]) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('reports each step it takes, in order, with the weighted completion a spinner would print', async () => {
    const steps: Array<{ message: string; percent: number | null }> = [];

    await install(options, bundle, { quiet: true, nonInteractive: true, onProgress: (progress) => { steps.push(progress); } });

    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]?.message).toBe('Checking built plugin...');
    // The completion is the installer's own step weighting: a number in 0–100
    // that never goes backwards.
    const percents: number[] = [];
    for (const step of steps) {
      expect(step.percent).toBeTypeOf('number');
      if (typeof step.percent === 'number') percents.push(step.percent);
    }
    for (const percent of percents) {
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(100);
    }
    expect([...percents].sort((left, right) => left - right)).toEqual(percents);
    // A quiet run has no terminal to draw on: narration never starts a spinner.
    expect(mocks.spinnerStarts).toBe(0);
  });

  it('changes no decision: with and without narration the run ends the same way', async () => {
    const plain = await install(options, bundle, { quiet: true, nonInteractive: true });
    const narrated = await install(options, bundle, {
      quiet: true, nonInteractive: true,
      onProgress: () => undefined,
    });

    expect(narrated.success).toBe(false);
    expect(plain.success).toBe(false);
    expect(narrated.reason).toBe(plain.reason);
    expect(narrated.error).toBe(plain.error);
    expect(mocks.spinnerStarts).toBe(0);
  });
});
