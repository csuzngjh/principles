/**
 * CLI Full-Flow E2E — drives the real compiled pd binary (Task 11).
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
 *
 * Note: pd-cli has no `pd init` command. `runtime activation list` is the
 * closest production path that bootstraps `.pd/state.db` on a fresh workspace
 * (SqliteConnection constructor creates the directory and DB file).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const execFileAsync = promisify(execFile);
const PD_BIN = path.resolve(__dirname, '../../dist/index.js');

const WORKSPACES: string[] = [];

afterEach(() => {
  while (WORKSPACES.length > 0) {
    const ws = WORKSPACES.pop();
    if (ws) {
      try {
        fs.rmSync(ws, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
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

async function runPd(
  args: string[],
  options: { timeout?: number } = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [PD_BIN, ...args], {
      timeout: options.timeout ?? 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? 1,
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
    const { stdout, exitCode } = await runPd(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
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
    const result = JSON.parse(stdout);
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
    const result = JSON.parse(stdout);
    expect(result).toHaveProperty('activations');
    expect(Array.isArray(result.activations)).toBe(true);
    expect(result.activations).toHaveLength(0);
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
