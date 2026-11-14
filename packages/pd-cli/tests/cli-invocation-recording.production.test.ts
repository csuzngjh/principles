/**
 * CLI invocation recording — production entry contract.
 *
 * These tests spawn the BUILT `dist/index.js` (the real process entry, the same
 * shape the installer and hosts execute), so the preAction hook, the exit hook
 * and the sink write are all exercised end to end. They pin the two properties
 * that matter:
 *
 *   1. one durable line per process, carrying command / exitCode / source;
 *   2. recording failure never changes the command's exit code.
 *
 * Entry choice matters: `pd version --json` is NOT a success path in a
 * development checkout — `buildVersionReport()` returns `not_installed` and
 * `runVersion()` exits 1 by its own contract. Using it as the "success" fixture
 * would assert a behaviour the command deliberately does not have, so the
 * success cases run a real read-only command (`pd runtime usage report --json`)
 * and the workspace-independent cases use top-level `pd --version`, whose
 * development-checkout fallback exits 0.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBuiltPdCliPath } from './helpers/pd-cli-path.js';

let tmpRoot: string;
let workspace: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-recording-'));
  workspace = path.join(tmpRoot, 'workspace');
  // A workspace that `pd runtime init` has bootstrapped: the directory AND the
  // empty sink exist. Recording only ever appends to an existing sink; it never
  // creates the directory or the file.
  const telemetryDir = path.join(workspace, '.pd', 'telemetry');
  fs.mkdirSync(telemetryDir, { recursive: true });
  fs.writeFileSync(path.join(telemetryDir, 'critical-events.jsonl'), '', 'utf8');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function runPd(args: string[], extraEnv: Record<string, string | undefined>): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { ...process.env, PD_WORKSPACE_DIR: workspace };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return spawnSync(process.execPath, [getBuiltPdCliPath(), ...args], { encoding: 'utf8', timeout: 60_000, env });
}

function readRecords(dir: string): Record<string, unknown>[] {
  const file = path.join(dir, '.pd', 'telemetry', 'critical-events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.eventType === 'cli_invocation');
}

describe('pd CLI invocation recording (built entry)', () => {
  it('appends one record for a read-only command when the sink already exists', () => {
    // Characterization for the "already bootstrapped" case that pain-recall
    // golden fixtures do NOT cover (their materialized workspace has no sink).
    // The empty workspace refuses recall with principle_id_required, but
    // recording is process-level: exactly one line is appended with the real
    // exit code, and no new file or directory appears.
    const result = runPd(['pain', 'recall', '--json'], { PD_INVOCATION_SOURCE: undefined });
    expect(result.status).toBe(1);

    const records = readRecords(workspace);
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({ command: 'pain recall', exitCode: 1, source: 'human' });
    expect(fs.readdirSync(path.join(workspace, '.pd', 'telemetry'))).toEqual(['critical-events.jsonl']);
  });

  it('records the resolved command path and the caller-provided source', () => {
    const result = runPd(['runtime', 'usage', 'report', '--json'], { PD_INVOCATION_SOURCE: 'companion' });
    expect(result.status, String(result.stderr)).toBe(0);

    const records = readRecords(workspace);
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({ command: 'runtime usage report', exitCode: 0, source: 'companion' });
  });

  it('records a human invocation when no spawn point declares a source', () => {
    const result = runPd(['runtime', 'usage', 'report', '--json'], { PD_INVOCATION_SOURCE: undefined });
    expect(result.status).toBe(0);
    expect(readRecords(workspace)[0]?.payload).toMatchObject({ command: 'runtime usage report', source: 'human' });
  });

  it('records a failed (unknown) command with its real exit code', () => {
    const result = runPd(['principle', 'list'], { PD_INVOCATION_SOURCE: 'plugin-script' });
    expect(result.status).toBe(1);

    const records = readRecords(workspace);
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({ command: 'UNKNOWN', exitCode: 1, source: 'plugin-script' });
  });

  it('does not mutate an unbootstrapped workspace (strict read-only contract)', () => {
    const fresh = path.join(tmpRoot, 'fresh');
    fs.mkdirSync(fresh, { recursive: true });
    // `--version` is the workspace-independent success path: a development
    // checkout prints the CLI package version instead of refusing.
    const result = spawnSync(process.execPath, [getBuiltPdCliPath(), '--version'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PD_WORKSPACE_DIR: fresh },
    });
    expect(result.status, String(result.stderr)).toBe(0);
    expect(fs.readdirSync(fresh)).toEqual([]);
  });

  it('does not record a help-only invocation (no command usage to report)', () => {
    const result = runPd(['--help'], { PD_INVOCATION_SOURCE: 'companion' });
    expect(result.status).toBe(0);
    expect(readRecords(workspace)).toHaveLength(0);
  });

  it('keeps the command exit code when the sink cannot be written', () => {
    const fileAsWorkspace = path.join(tmpRoot, 'not-a-directory');
    fs.writeFileSync(fileAsWorkspace, 'x', 'utf8');
    // `--version` itself never touches the workspace, so exit 0 proves the
    // recorder's failed write was swallowed rather than promoted.
    const result = spawnSync(process.execPath, [getBuiltPdCliPath(), '--version'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PD_WORKSPACE_DIR: fileAsWorkspace, PD_INVOCATION_SOURCE: 'installer' },
    });
    expect(result.status, String(result.stderr)).toBe(0);
    expect(fs.existsSync(path.join(fileAsWorkspace, '.pd'))).toBe(false);
  });
});
