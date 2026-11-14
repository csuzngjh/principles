/**
 * CLI invocation record — unit contract.
 *
 * The durable line is the only source that can answer "which pd command ran,
 * from where, and did it fail". These tests pin the parts an operator can rely
 * on: the registered event type, the payload fields, the source resolution
 * rules, and the promise that recording NEVER throws (a failed write must not
 * change the command's exit code).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CLI_INVOCATION_EVENT_TYPE,
  UNKNOWN,
  invocationLogPath,
  recordCliInvocation,
  resolveInvocationSource,
  resolveRecordedWorkspace,
} from '../src/services/cli-invocation-log.js';

let tmpRoot: string;
let workspace: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-invocation-'));
  workspace = path.join(tmpRoot, 'workspace');
  // Simulate a workspace that `pd runtime init` has bootstrapped.
  fs.mkdirSync(path.dirname(invocationLogPath(workspace)), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.PD_WORKSPACE_DIR;
});

function readRecords(dir: string): Record<string, unknown>[] {
  const file = invocationLogPath(dir);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('recordCliInvocation', () => {
  it('writes one line per process with the registered event type and payload', () => {
    const written = recordCliInvocation({
      workspaceDir: workspace,
      command: 'pain record',
      exitCode: 0,
      rawSource: 'companion',
      now: new Date('2026-11-14T03:00:00.000Z'),
    });

    expect(written).toBe(invocationLogPath(workspace));
    const records = readRecords(workspace);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      eventType: CLI_INVOCATION_EVENT_TYPE,
      timestamp: '2026-11-14T03:00:00.000Z',
      agentId: 'pd-cli',
      payload: { command: 'pain record', exitCode: 0, source: 'companion' },
    });
  });

  it('records an undeterminable exit code as UNKNOWN instead of 0', () => {
    recordCliInvocation({ workspaceDir: workspace, command: 'console open', exitCode: null, rawSource: undefined });
    const [record] = readRecords(workspace);
    expect(record?.payload).toMatchObject({ exitCode: UNKNOWN, source: 'human' });
  });

  it('defaults a missing command to UNKNOWN', () => {
    recordCliInvocation({ workspaceDir: workspace, command: null, exitCode: 1, rawSource: undefined });
    const [record] = readRecords(workspace);
    expect(record?.payload).toMatchObject({ command: UNKNOWN, exitCode: 1 });
  });

  it('appends rather than overwriting, so invocations accumulate', () => {
    recordCliInvocation({ workspaceDir: workspace, command: 'health', exitCode: 0, rawSource: undefined });
    recordCliInvocation({ workspaceDir: workspace, command: 'task show', exitCode: 1, rawSource: undefined });
    expect(readRecords(workspace).map((r) => r.payload)).toMatchObject([
      { command: 'health' },
      { command: 'task show' },
    ]);
  });

  it('never throws when the workspace is not a writable directory', () => {
    const notADirectory = path.join(tmpRoot, 'file-as-workspace');
    fs.writeFileSync(notADirectory, 'x', 'utf8');
    expect(() =>
      recordCliInvocation({ workspaceDir: notADirectory, command: 'version', exitCode: 0, rawSource: undefined }),
    ).not.toThrow();
    expect(recordCliInvocation({ workspaceDir: null, command: 'version', exitCode: 0, rawSource: undefined })).toBeNull();
  });
});

describe('resolveInvocationSource', () => {
  it('treats an absent or blank variable as a human invocation', () => {
    expect(resolveInvocationSource(undefined)).toBe('human');
    expect(resolveInvocationSource('   ')).toBe('human');
  });

  it('keeps a known spawn point verbatim (lowercased)', () => {
    expect(resolveInvocationSource('console')).toBe('console');
    expect(resolveInvocationSource('Plugin-Script')).toBe('plugin-script');
  });

  it('keeps an unregistered value visible instead of relabelling it', () => {
    expect(resolveInvocationSource('some-new-host')).toBe('some-new-host');
  });

  it('bounds the recorded value', () => {
    expect(resolveInvocationSource('x'.repeat(200))).toHaveLength(40);
  });
});

describe('resolveRecordedWorkspace', () => {
  it('prefers the explicit --workspace flag, resolved to an absolute path', () => {
    process.env.PD_WORKSPACE_DIR = path.join(tmpRoot, 'from-env');
    expect(resolveRecordedWorkspace(path.join(workspace, '.', ''))).toBe(workspace);
  });

  it('falls back to PD_WORKSPACE_DIR when the command declares no --workspace', () => {
    process.env.PD_WORKSPACE_DIR = workspace;
    expect(resolveRecordedWorkspace(undefined)).toBe(workspace);
  });

  it('resolves a declared target even before it exists', () => {
    const notYetCreated = path.join(tmpRoot, 'fresh-workspace');
    expect(resolveRecordedWorkspace(notYetCreated)).toBe(notYetCreated);
  });

  it('writes nothing until the sink directory has been bootstrapped by runtime init', () => {
    const fresh = path.join(tmpRoot, 'fresh-workspace');
    expect(recordCliInvocation({ workspaceDir: fresh, command: 'task list', exitCode: 0, rawSource: undefined })).toBeNull();
    expect(fs.existsSync(path.join(fresh, '.pd'))).toBe(false);

    fs.mkdirSync(path.dirname(invocationLogPath(fresh)), { recursive: true });
    expect(recordCliInvocation({ workspaceDir: fresh, command: 'task list', exitCode: 0, rawSource: undefined })).toBe(
      invocationLogPath(fresh),
    );
  });
});
