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
  // `pd runtime init` bootstraps the sink; recording never creates it.
  fs.mkdirSync(path.join(workspace, '.pd', 'telemetry'), { recursive: true });
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
  it('records the resolved command path and the caller-provided source', () => {
    const result = runPd(['version', '--json'], { PD_INVOCATION_SOURCE: 'companion' });
    expect(result.status, String(result.stderr)).toBe(0);

    const records = readRecords(workspace);
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({ command: 'version', exitCode: 0, source: 'companion' });
  });

  it('records a human invocation when no spawn point declares a source', () => {
    const result = runPd(['version', '--json'], { PD_INVOCATION_SOURCE: undefined });
    expect(result.status).toBe(0);
    expect(readRecords(workspace)[0]?.payload).toMatchObject({ command: 'version', source: 'human' });
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
    const result = spawnSync(process.execPath, [getBuiltPdCliPath(), 'version', '--json'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PD_WORKSPACE_DIR: fresh },
    });
    expect(result.status).toBe(0);
    expect(fs.readdirSync(fresh)).toEqual([]);
  });

  it('keeps the command exit code when the sink cannot be written', () => {
    const fileAsWorkspace = path.join(tmpRoot, 'not-a-directory');
    fs.writeFileSync(fileAsWorkspace, 'x', 'utf8');
    const result = spawnSync(process.execPath, [getBuiltPdCliPath(), 'version', '--json'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PD_WORKSPACE_DIR: fileAsWorkspace, PD_INVOCATION_SOURCE: 'installer' },
    });
    expect(result.status, String(result.stderr)).toBe(0);
    expect(fs.existsSync(path.join(fileAsWorkspace, '.pd'))).toBe(false);
  });
});
