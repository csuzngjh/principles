/**
 * CLI Full-Flow E2E — drives the real compiled pd binary.
 *
 * Every other test in this package imports handler functions directly. This
 * file validates the actual user path: spawning `node dist/index.js <args>`
 * via child_process.execFile and asserting on exit code / stdout / stderr.
 *
 * Uses Node.js built-in child_process (not execa) to avoid vitest forks-pool
 * compatibility issues.
 *
 * ERR checklist:
 * - EP-04 (CLI and Operator Contract): verifies --json emits exactly one
 *   parseable JSON object (Rule 1), invalid commands exit non-zero (Rule 2),
 *   and JSON-mode stdout is not polluted with banners.
 * - EP-09 (Test Reality Gap): drives the real compiled binary, not imported
 *   helpers — proves the Commander wiring, dependency loading (including
 *   better-sqlite3), and workspace resolution all work end-to-end.
 * - EP-02 (Production Path Wiring): exercises the production entry point
 *   (dist/index.js), confirming commands are registered and reachable.
 * - ERR-001: error fields from execFile are validated with type guards, not `as`.
 * - ERR-071: all temp workspaces are tracked and cleaned in afterEach.
 *
 * Note: pd-cli has no `pd init` command. `runtime activation list` is the
 * closest production path that bootstraps `.pd/state.db` on a fresh workspace
 * (SqliteConnection constructor creates the directory and DB file).
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';

const execFileAsync = promisify(execFile);
const PD_BIN = getBuiltPdCliPath();

const WORKSPACES: string[] = [];

afterEach(() => {
  while (WORKSPACES.length > 0) {
    const ws = WORKSPACES.pop();
    if (ws) {
      try {
        fs.rmSync(ws, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `[afterEach] Failed to clean ${ws}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
});

beforeAll(() => {
  // ERR-009/ERR-010: fail loud if the compiled binary is missing.
  if (!fs.existsSync(PD_BIN)) {
    throw new Error(
      `[cli-full-flow] Compiled binary not found at ${PD_BIN}. ` +
        `Run "npm run build --workspace=@principles/pd-cli" before running this test.`,
    );
  }
});

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-e2e-'));
  WORKSPACES.push(ws);
  return ws;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

/**
 * Type guard: extract a string field from an unknown error object.
 * ERR-001: no `as` casts on untrusted error data — use Reflect.get + typeof.
 */
function readStringField(obj: unknown, field: string): string {
  if (typeof obj !== 'object' || obj === null) return '';
  if (!Object.hasOwn(obj, field)) return '';
  const value: unknown = Reflect.get(obj, field);
  return typeof value === 'string' ? value : '';
}

/**
 * Type guard: extract a numeric exit code from an unknown error object.
 * ERR-001: no `as` casts on untrusted error data — use Reflect.get + typeof.
 */
function readExitCode(obj: unknown): number {
  if (typeof obj !== 'object' || obj === null) return 1;
  if (!Object.hasOwn(obj, 'code')) return 1;
  const code: unknown = Reflect.get(obj, 'code');
  return typeof code === 'number' ? code : 1;
}

async function runPd(
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [PD_BIN, ...args], {
      timeout: options.timeout ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
      env: options.env,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    return {
      stdout: readStringField(err, 'stdout'),
      stderr: readStringField(err, 'stderr'),
      exitCode: readExitCode(err),
    };
  }
}

describe('CLI full flow', () => {
  it('pd --help exits 0 and lists main commands', async () => {
    const { stdout, exitCode } = await runPd(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: pd');
    // Verify key command groups are registered and visible to users
    expect(stdout).toContain('pain');
    expect(stdout).toContain('runtime');
    expect(stdout).toContain('diagnose');
    expect(stdout).toContain('candidate');
  });

  it('pd --version exits 0 and prints version', async () => {
    const home = makeWorkspace();
    const { stdout, exitCode } = await runPd(['--version'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(exitCode).toBe(0);
    // SPEC §12 stable short-text contract. On a machine without a supported
    // installation the CLI falls back to its own package version and marks
    // itself as a development checkout instead of impersonating a release.
    expect(stdout.trim()).toMatch(/^Principles Disciple \d+\.\d+\.\d+ \([a-f0-9]{12}|^Principles Disciple \d+\.\d+\.\d+ \(development-checkout\)$/);
  });

  it('pd --version refuses a corrupt installed state instead of impersonating a development checkout', async () => {
    const home = makeWorkspace();
    fs.mkdirSync(path.join(home, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.pd', 'active.json'), '{');
    const { stdout, stderr, exitCode } = await runPd(['--version'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/not valid JSON/i);
    expect(stderr).toMatch(/Next:/);
    expect(stderr).not.toContain('development-checkout');
  });

  it('pd version --json returns exactly one structured refusal for corrupt JSON state', async () => {
    const home = makeWorkspace();
    fs.mkdirSync(path.join(home, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.pd', 'active.json'), '{');
    const { stdout, stderr, exitCode } = await runPd(['version', '--json'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toBe('');
    const result = requireRecord(JSON.parse(stdout), 'corrupt version response');
    expect(result).toMatchObject({ ok: false, reason: 'state_corrupt' });
    expect(typeof result.nextAction).toBe('string');
  });

  it('pd runtime features --json on fresh workspace returns valid JSON with defaults', async () => {
    const workspace = makeWorkspace();
    const { stdout, exitCode } = await runPd([
      'runtime',
      'features',
      '--workspace',
      workspace,
      '--json',
    ]);
    expect(exitCode).toBe(0);
    // EP-04 Rule 1: --json stdout must be exactly one parseable JSON object
    const parsed: unknown = JSON.parse(stdout);
    const result = requireRecord(parsed, 'runtime features output');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('source');
    expect(result).toHaveProperty('features');
    expect(Array.isArray(result.features)).toBe(true);
    expect(result).toHaveProperty('enabledMvpChannels');
    expect(Array.isArray(result.enabledMvpChannels)).toBe(true);
    // Fresh workspace with no .pd/config.yaml falls back to defaults
    expect(result.source).toBe('defaults');
  });

  it('pd runtime activation list --json on fresh workspace returns empty list and bootstraps .pd/', async () => {
    const workspace = makeWorkspace();
    const { stdout, exitCode } = await runPd([
      'runtime',
      'activation',
      'list',
      '--workspace',
      workspace,
      '--json',
    ]);
    expect(exitCode).toBe(0);
    // EP-04 Rule 1: --json stdout must be exactly one parseable JSON object
    const parsed: unknown = JSON.parse(stdout);
    const result = requireRecord(parsed, 'activation list output');
    expect(result).toHaveProperty('activations');
    const activations = result.activations;
    expect(Array.isArray(activations)).toBe(true);
    expect(activations).toEqual([]);
    // SqliteConnection constructor creates .pd/ and state.db on first access
    expect(fs.existsSync(path.join(workspace, '.pd'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.pd', 'state.db'))).toBe(true);
  });

  it('pd <invalid-command> exits non-zero with non-empty stderr', async () => {
    const { stderr, exitCode } = await runPd([
      'this-command-does-not-exist',
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr).toContain('unknown command');
  });
});
