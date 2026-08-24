/**
 * PRI-566: governance audit integration tests for the deactivate/promote CLI
 * handlers.
 *
 * Uses a REAL temp workspace (no '/fake/workspace') so the real
 * `appendGovernanceAction` implementation writes real files we can assert on.
 *
 * Covers:
 *   - successful deactivate appends a 'deactivate' record (operator=cli)
 *   - --reason is carried into the audit record
 *   - --json stdout stays exactly one parseable object (EP-04 cli-1) even
 *     while the audit write happens
 *   - NEGATIVE CONTROLS:
 *       · not-found / already-deactivated path writes NO audit record
 *       · no events_*.jsonl file is created by the audit writer (it must
 *         never touch the runtime event stream — ERR-024 dormant-wiring guard)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const mockClose = vi.fn().mockResolvedValue(undefined);
const mockDeactivate = vi.fn().mockResolvedValue(true);

let tmpWorkspace: string;

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn(),
}));

vi.mock('@principles/core/runtime-v2', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    RuntimeStateManager: vi.fn().mockImplementation(function () {
      return {
        initialize: vi.fn().mockResolvedValue(undefined),
        close: mockClose,
        connection: {
          getDb: () => ({
            prepare: () => ({
              get: () => undefined,
              all: () => [],
            }),
          }),
        },
      };
    }),
    SqliteActivationStateStore: vi.fn().mockImplementation(function () {
      return {
        deactivateActivation: mockDeactivate,
        listPromptActivations: vi.fn().mockResolvedValue([]),
        listCodeToolHookActivations: vi.fn().mockResolvedValue([]),
        listAllActivations: vi.fn().mockResolvedValue([]),
      };
    }),
  };
});

import { handleRuntimeActivationDeactivate } from '../../src/commands/runtime-activation.js';
import { resolveWorkspaceDir } from '../../src/resolve-workspace.js';

function auditLogPath(): string {
  return path.join(tmpWorkspace, '.state', 'governance_actions.jsonl');
}

beforeEach(() => {
  tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pri566-audit-'));
  vi.mocked(resolveWorkspaceDir).mockReturnValue(tmpWorkspace);
});

afterEach(() => {
  fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  vi.clearAllMocks();
  process.exitCode = 0;
});

describe('deactivate handler × governance audit log (PRI-566)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('successful deactivate appends an operator=cli record', async () => {
    await handleRuntimeActivationDeactivate({
      workspace: tmpWorkspace,
      activationId: 'act-audit-1',
      json: true,
    });

    expect(fs.existsSync(auditLogPath())).toBe(true);
    const lines = fs.readFileSync(auditLogPath(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(rec['action']).toBe('deactivate');
    expect(rec['activationId']).toBe('act-audit-1');
    expect(rec['operator']).toBe('cli');
  });

  it('audit record carries activationId and operator=cli with correct shape', async () => {
    await handleRuntimeActivationDeactivate({
      workspace: tmpWorkspace,
      activationId: 'act-audit-2',
      json: true,
    });

    const lines = fs.readFileSync(auditLogPath(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(rec['action']).toBe('deactivate');
    expect(rec['activationId']).toBe('act-audit-2');
    expect(rec['operator']).toBe('cli');
    expect(rec['reason']).toBeNull();
    expect(typeof rec['actionId']).toBe('string');
    expect(typeof rec['createdAt']).toBe('string');
  });

  it('--reason flows into the audit record', async () => {
    await handleRuntimeActivationDeactivate({
      workspace: tmpWorkspace,
      activationId: 'act-audit-3',
      reason: 'owner requested rollback',
      json: true,
    });

    const rec = JSON.parse(fs.readFileSync(auditLogPath(), 'utf-8').trim()) as Record<string, unknown>;
    expect(rec['reason']).toBe('owner requested rollback');
  });

  it('--json stdout remains exactly one parseable JSON object (cli-1)', async () => {
    await handleRuntimeActivationDeactivate({
      workspace: tmpWorkspace,
      activationId: 'act-audit-4',
      json: true,
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed).toMatchObject({ ok: true, activationId: 'act-audit-4' });
  });
});

describe('negative controls (PRI-566)', () => {
  it('not-found path writes NO audit record', async () => {
    mockDeactivate.mockResolvedValueOnce(false);

    const errSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleRuntimeActivationDeactivate({
      workspace: tmpWorkspace,
      activationId: 'act-gone',
      json: true,
    });
    errSpy.mockRestore();

    expect(mockDeactivate).toHaveBeenCalled();
    expect(fs.existsSync(auditLogPath())).toBe(false);
  });

  it('audit writer never touches events_*.jsonl (dormant-wiring guard, ERR-024)', async () => {
    await handleRuntimeActivationDeactivate({
      workspace: tmpWorkspace,
      activationId: 'act-audit-5',
      json: true,
    });

    const logsDir = path.join(tmpWorkspace, '.state', 'logs');
    if (fs.existsSync(logsDir)) {
      const files = fs.readdirSync(logsDir).filter((f) => f.startsWith('events_'));
      expect(files).toEqual([]);
    }
    // and the only .state artifact is our audit log
    const stateFiles = fs.readdirSync(path.join(tmpWorkspace, '.state')).filter((f) => !f.endsWith('-shm') && !f.endsWith('-wal'));
    expect(stateFiles.filter((f) => f !== 'governance_actions.jsonl' && f !== 'logs')).toEqual([]);
  });
});
